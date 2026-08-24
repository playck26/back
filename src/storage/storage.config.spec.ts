import { ConfigService } from '@nestjs/config';
import {
  carregarStorageConfig,
  ConfiguracaoDeStorageInvalida,
  VARIAVEIS_DE_STORAGE,
} from './storage.config';

// SPEC-017/TASK-001 — as seis variáveis do Spaces (ADR-015).

const VALIDAS: Record<string, string> = {
  SPACES_REGION: 'nyc3',
  SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
  SPACES_BUCKET: 'playck-media',
  SPACES_CDN_URL: 'https://playck-media.nyc3.cdn.digitaloceanspaces.com',
  SPACES_KEY: 'chave-de-teste',
  SPACES_SECRET: 'segredo-de-teste',
};

function configCom(sobrescritas: Record<string, string | undefined>) {
  const valores = { ...VALIDAS, ...sobrescritas };
  return {
    get: (nome: string) => valores[nome],
  } as unknown as ConfigService;
}

function capturar(acao: () => unknown): Error | null {
  try {
    acao();
    return null;
  } catch (erro) {
    return erro as Error;
  }
}

describe('carregarStorageConfig', () => {
  it('carrega as seis variáveis', () => {
    const config = carregarStorageConfig(configCom({}));

    expect(config).toEqual({
      region: 'nyc3',
      endpoint: 'https://nyc3.digitaloceanspaces.com',
      bucket: 'playck-media',
      cdnUrl: 'https://playck-media.nyc3.cdn.digitaloceanspaces.com',
      key: 'chave-de-teste',
      secret: 'segredo-de-teste',
    });
  });

  it.each(VARIAVEIS_DE_STORAGE)('recusa o boot sem %s', (variavel) => {
    expect(() =>
      carregarStorageConfig(configCom({ [variavel]: undefined })),
    ).toThrow(ConfiguracaoDeStorageInvalida);
  });

  it.each(VARIAVEIS_DE_STORAGE)('recusa %s vazia ou em branco', (variavel) => {
    expect(() =>
      carregarStorageConfig(configCom({ [variavel]: '   ' })),
    ).toThrow(ConfiguracaoDeStorageInvalida);
  });

  it('não ecoa o valor da variável na mensagem de erro (segredo em log de boot)', () => {
    expect(() =>
      carregarStorageConfig(
        configCom({ SPACES_ENDPOINT: 'http://nyc3.digitaloceanspaces.com' }),
      ),
    ).toThrow(/SPACES_ENDPOINT precisa ser https/);

    const erro = capturar(() =>
      carregarStorageConfig(configCom({ SPACES_CDN_URL: 'nao-e-url' })),
    );
    expect(erro).toBeInstanceOf(ConfiguracaoDeStorageInvalida);
    expect(erro?.message).not.toContain('nao-e-url');
  });

  it('recusa endpoint que já traz o bucket na frente', () => {
    // O painel da DigitalOcean mostra o endpoint assim; copiar de lá com
    // virtual-host style produz host duplicado que só falha em runtime.
    expect(() =>
      carregarStorageConfig(
        configCom({
          SPACES_ENDPOINT: 'https://playck-media.nyc3.digitaloceanspaces.com',
        }),
      ),
    ).toThrow(/endpoint regional/);
  });

  it('recusa endpoint com caminho', () => {
    expect(() =>
      carregarStorageConfig(
        configCom({
          SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com/playck-media',
        }),
      ),
    ).toThrow(/não pode ter caminho/);
  });

  it('recusa endpoint e CDN fora de https', () => {
    expect(() =>
      carregarStorageConfig(
        configCom({ SPACES_CDN_URL: 'http://cdn.exemplo.com' }),
      ),
    ).toThrow(/SPACES_CDN_URL precisa ser https/);
  });

  it('recusa nome de bucket inválido', () => {
    expect(() =>
      carregarStorageConfig(configCom({ SPACES_BUCKET: 'Playck Media' })),
    ).toThrow(/nome de bucket válido/);
  });

  it('tira a barra final do CDN (duas barras viram outra chave no S3)', () => {
    const config = carregarStorageConfig(
      configCom({ SPACES_CDN_URL: 'https://cdn.exemplo.com///' }),
    );
    expect(config.cdnUrl).toBe('https://cdn.exemplo.com');
  });

  it('normaliza o endpoint para protocolo + host', () => {
    const config = carregarStorageConfig(
      configCom({ SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com/' }),
    );
    expect(config.endpoint).toBe('https://nyc3.digitaloceanspaces.com');
  });
});
