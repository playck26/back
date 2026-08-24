import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { S3StorageProvider } from './s3-storage.provider';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage-provider.interface';
import {
  ConfiguracaoDeStorageInvalida,
  STORAGE_CONFIG,
  VARIAVEIS_DE_STORAGE,
} from './storage.config';
import { StorageModule } from './storage.module';

// SPEC-017/TASK-001 — a fiação. O que este arquivo prova é que a validação
// da config roda no BOOT: sem as seis variáveis, o módulo não instancia.
// Config validada só no primeiro upload seria descobrir endpoint errado
// com uma foto de aluno na mão.

const VALIDAS: Record<string, string> = {
  SPACES_REGION: 'nyc3',
  SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
  SPACES_BUCKET: 'playck-media',
  SPACES_CDN_URL: 'https://playck-media.nyc3.cdn.digitaloceanspaces.com',
  SPACES_KEY: 'chave-de-teste',
  SPACES_SECRET: 'segredo-de-teste',
};

function compilarCom(valores: Record<string, string | undefined>) {
  return Test.createTestingModule({
    // Mesmo arranjo do AppModule: ConfigModule global + StorageModule.
    imports: [
      ConfigModule.forRoot({
        isGlobal: true,
        ignoreEnvFile: true,
        load: [() => valores],
      }),
      StorageModule,
    ],
  }).compile();
}

describe('StorageModule', () => {
  // `ConfigService` cai em `process.env` quando a chave não está na config
  // carregada. Sem esta limpeza, a máquina de quem tem as variáveis
  // exportadas no shell passaria no teste de ausência sem provar nada.
  const ambienteOriginal = { ...process.env };

  beforeEach(() => {
    for (const variavel of VARIAVEIS_DE_STORAGE) {
      delete process.env[variavel];
    }
  });

  afterEach(() => {
    process.env = { ...ambienteOriginal };
  });

  it('resolve a porta STORAGE_PROVIDER com as seis variáveis presentes', async () => {
    const modulo = await compilarCom(VALIDAS);

    const provider = modulo.get<StorageProvider>(STORAGE_PROVIDER);
    expect(provider).toBeInstanceOf(S3StorageProvider);
    expect(modulo.get(STORAGE_CONFIG)).toMatchObject({
      bucket: 'playck-media',
    });

    await modulo.close();
  });

  it('não sobe sem SPACES_SECRET — fail-fast no boot', async () => {
    await expect(
      compilarCom({ ...VALIDAS, SPACES_SECRET: undefined }),
    ).rejects.toBeInstanceOf(ConfiguracaoDeStorageInvalida);
  });
});
