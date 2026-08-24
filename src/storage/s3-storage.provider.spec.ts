import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { S3StorageProvider } from './s3-storage.provider';
import { FalhaDeStorage } from './storage-provider.interface';
import {
  CACHE_CONTROL_PRIVADO,
  CACHE_CONTROL_PUBLICO,
  EXPIRACAO_URL_ASSINADA_SEGUNDOS,
  type StorageConfig,
} from './storage.config';

// SPEC-017/TASK-001 — adaptador S3. Aqui o SDK é mockado, e o que este
// teste consegue reprovar é a TRADUÇÃO: comando certo, ACL certa, erro
// traduzido. Que o Spaces aceite o comando é prova do FIT-006, contra o
// bucket real — mock não tem bucket, nem ACL, nem assinatura que expira.

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: jest.fn(),
}));

const CONFIG: StorageConfig = {
  region: 'nyc3',
  endpoint: 'https://nyc3.digitaloceanspaces.com',
  bucket: 'playck-media',
  cdnUrl: 'https://playck-media.nyc3.cdn.digitaloceanspaces.com',
  key: 'chave',
  secret: 'segredo',
};

const KEY = `empresas/emp-1/quadra/quadra-9/${'a'.repeat(64)}.webp`;

describe('S3StorageProvider', () => {
  let enviar: jest.SpyInstance;
  let provider: S3StorageProvider;

  beforeEach(() => {
    jest.clearAllMocks();
    enviar = jest
      .spyOn(S3Client.prototype, 'send')
      .mockResolvedValue(undefined as never);
    provider = new S3StorageProvider(CONFIG);
  });

  afterEach(() => {
    enviar.mockRestore();
  });

  function comandoEnviado<T>(): T {
    const [[comando]] = enviar.mock.calls as unknown as [[T]];
    return comando;
  }

  describe('gravar', () => {
    it('grava objeto público com ACL public-read e cache de 1 hora', async () => {
      await provider.gravar({
        key: KEY,
        corpo: Buffer.from('conteudo'),
        contentType: 'image/webp',
        visibilidade: 'publico',
      });

      const comando = comandoEnviado<PutObjectCommand>();
      expect(comando).toBeInstanceOf(PutObjectCommand);
      expect(comando.input).toMatchObject({
        Bucket: 'playck-media',
        Key: KEY,
        ContentType: 'image/webp',
        ContentLength: 8,
        ACL: 'public-read',
        CacheControl: CACHE_CONTROL_PUBLICO,
      });
    });

    it('grava objeto privado com ACL private e cache privado', async () => {
      await provider.gravar({
        key: KEY,
        corpo: Buffer.from('conteudo'),
        contentType: 'image/webp',
        visibilidade: 'privado',
      });

      const comando = comandoEnviado<PutObjectCommand>();
      expect(comando.input.ACL).toBe('private');
      expect(comando.input.CacheControl).toBe(CACHE_CONTROL_PRIVADO);
    });

    it('traduz falha do SDK para FalhaDeStorage (INV-031: o domínio nunca vê o SDK)', async () => {
      enviar.mockRejectedValue(new Error('AccessDenied'));

      await expect(
        provider.gravar({
          key: KEY,
          corpo: Buffer.alloc(1),
          contentType: 'image/webp',
          visibilidade: 'publico',
        }),
      ).rejects.toBeInstanceOf(FalhaDeStorage);
    });
  });

  describe('apagar', () => {
    it('envia DeleteObject da chave pedida', async () => {
      await provider.apagar(KEY);

      const comando = comandoEnviado<DeleteObjectCommand>();
      expect(comando).toBeInstanceOf(DeleteObjectCommand);
      expect(comando.input).toMatchObject({ Bucket: 'playck-media', Key: KEY });
    });

    it('traduz a falha com operação e chave — é o que vira `ultimo_erro` na fila (AC-012)', async () => {
      enviar.mockRejectedValue(new Error('SignatureDoesNotMatch'));

      const erro = await provider.apagar(KEY).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(FalhaDeStorage);
      expect((erro as FalhaDeStorage).operacao).toBe('apagar');
      expect((erro as FalhaDeStorage).key).toBe(KEY);
      expect((erro as Error).message).toContain('SignatureDoesNotMatch');
    });
  });

  describe('metadados', () => {
    it('devolve os metadados do HeadObject', async () => {
      enviar.mockResolvedValue({
        ContentLength: 1234,
        ContentType: 'image/webp',
        CacheControl: CACHE_CONTROL_PUBLICO,
        ETag: '"abc"',
      });

      const metadados = await provider.metadados(KEY);

      expect(comandoEnviado<HeadObjectCommand>()).toBeInstanceOf(
        HeadObjectCommand,
      );
      expect(metadados).toEqual({
        tamanhoBytes: 1234,
        contentType: 'image/webp',
        cacheControl: CACHE_CONTROL_PUBLICO,
        etag: '"abc"',
      });
    });

    it('devolve null quando o objeto não existe — ausência não é falha', async () => {
      enviar.mockRejectedValue(
        Object.assign(new Error('Not Found'), { name: 'NotFound' }),
      );

      await expect(provider.metadados(KEY)).resolves.toBeNull();
    });

    it('devolve null também no 404 sem nome conhecido', async () => {
      enviar.mockRejectedValue(
        Object.assign(new Error('404'), { $metadata: { httpStatusCode: 404 } }),
      );

      await expect(provider.metadados(KEY)).resolves.toBeNull();
    });

    it('propaga falha que não é ausência — 403 não pode virar "não existe"', async () => {
      // Se 403 virasse `null`, o worker da TASK-005 leria permissão retirada
      // como objeto já apagado, e riscaria a linha da fila sem ter apagado
      // nada (INV-036).
      enviar.mockRejectedValue(
        Object.assign(new Error('Forbidden'), {
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403 },
        }),
      );

      await expect(provider.metadados(KEY)).rejects.toBeInstanceOf(
        FalhaDeStorage,
      );
    });
  });

  describe('urlPublica', () => {
    it('monta a URL pelo CDN, sem passar pela API (NFR-002/AC-009)', () => {
      expect(provider.urlPublica(KEY)).toBe(`${CONFIG.cdnUrl}/${KEY}`);
    });

    it('codifica por segmento, preservando a hierarquia da chave', () => {
      // A barra separa segmento e sobrevive; o resto é codificado. Recusar
      // chave malformada NÃO é papel daqui — é do parser da TASK-003
      // (AC-018/AC-019), que roda antes e é quem devolve 404.
      expect(provider.urlPublica('empresas/emp 1/a b/c.webp')).toBe(
        `${CONFIG.cdnUrl}/empresas/emp%201/a%20b/c.webp`,
      );
      expect(provider.urlPublica('empresas/e?1/x#y.webp')).toBe(
        `${CONFIG.cdnUrl}/empresas/e%3F1/x%23y.webp`,
      );
    });
  });

  describe('urlAssinada', () => {
    it('assina um GetObject com 15 minutos por padrão (AC-010)', async () => {
      (getSignedUrl as jest.Mock).mockResolvedValue('https://assinada.exemplo');

      const url = await provider.urlAssinada(KEY);

      expect(url).toBe('https://assinada.exemplo');
      const [, comando, opcoes] = (getSignedUrl as jest.Mock).mock.calls[0] as [
        unknown,
        GetObjectCommand,
        { expiresIn: number },
      ];
      expect(comando).toBeInstanceOf(GetObjectCommand);
      expect(comando.input).toMatchObject({ Bucket: 'playck-media', Key: KEY });
      expect(opcoes.expiresIn).toBe(EXPIRACAO_URL_ASSINADA_SEGUNDOS);
      expect(EXPIRACAO_URL_ASSINADA_SEGUNDOS).toBe(900);
    });

    it('aceita expiração menor quando pedida', async () => {
      (getSignedUrl as jest.Mock).mockResolvedValue('https://assinada.exemplo');

      await provider.urlAssinada(KEY, 60);

      const [, , opcoes] = (getSignedUrl as jest.Mock).mock.calls[0] as [
        unknown,
        unknown,
        { expiresIn: number },
      ];
      expect(opcoes.expiresIn).toBe(60);
    });

    it('a falha de assinatura não carrega assinatura nenhuma (INV-032/AC-011)', async () => {
      (getSignedUrl as jest.Mock).mockRejectedValue(
        new Error('credencial inválida'),
      );

      const erro = await provider.urlAssinada(KEY).catch((e: unknown) => e);
      expect(erro).toBeInstanceOf(FalhaDeStorage);
      expect((erro as Error).message).not.toContain('X-Amz-Signature');
      expect((erro as Error).message).not.toContain(CONFIG.secret);
    });
  });
});
