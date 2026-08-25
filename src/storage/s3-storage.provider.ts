import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { Inject, Injectable } from '@nestjs/common';
import {
  CACHE_CONTROL_PRIVADO,
  CACHE_CONTROL_PUBLICO,
  TETO_EXPIRACAO_URL_ASSINADA_SEGUNDOS,
  STORAGE_CONFIG,
  type StorageConfig,
} from './storage.config';
import {
  FalhaDeStorage,
  type MetadadosDoObjeto,
  type ObjetoParaGravar,
  type StorageProvider,
  type UsoDoBucket,
} from './storage-provider.interface';

/**
 * SPEC-017/TASK-001 — adaptador S3 para o DigitalOcean Spaces (ADR-015).
 *
 * **Este é o único arquivo do projeto que pode importar o SDK** (INV-031).
 * Tudo que ele faz é traduzir a porta para comandos S3 e traduzir a falha
 * de volta para `FalhaDeStorage`.
 */
@Injectable()
export class S3StorageProvider implements StorageProvider {
  private readonly client: S3Client;

  constructor(@Inject(STORAGE_CONFIG) private readonly config: StorageConfig) {
    this.client = new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      credentials: {
        accessKeyId: config.key,
        secretAccessKey: config.secret,
      },
      // Virtual-host style (`playck-media.nyc3.digitaloceanspaces.com`), que
      // é como o CDN do Spaces serve. Por isso o endpoint é o regional, sem
      // o bucket — ver a checagem em `storage.config.ts`.
      forcePathStyle: false,
      // O SDK v3 recente calcula checksum CRC32 por padrão e embrulha o
      // corpo em `aws-chunked`. **Medido contra o bucket real em
      // 2026-08-24: o Spaces aceita as duas formas** — este ajuste NÃO
      // conserta falha observada, e escrever aqui que conserta seria
      // repetir o defeito que a CLAUDE.md chama de documentação que mente.
      //
      // Fica assim mesmo assim, por duas razões declaradas: o Spaces é S3
      // de terceiro, e transformação de corpo que ninguém pediu é
      // superfície a mais entre nós e o objeto; e default de SDK muda de
      // versão em versão — fixar o comportamento é o que faz um `pnpm up`
      // não virar defeito de upload. Se um dia precisar do checksum,
      // trocar aqui é uma linha, e o FIT-006 diz se passou.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    });
  }

  async gravar(objeto: ObjetoParaGravar): Promise<void> {
    const publico = objeto.visibilidade === 'publico';
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.config.bucket,
          Key: objeto.key,
          Body: objeto.corpo,
          ContentLength: objeto.corpo.length,
          ContentType: objeto.contentType,
          CacheControl: publico ? CACHE_CONTROL_PUBLICO : CACHE_CONTROL_PRIVADO,
          // Permissão por ARQUIVO, e não por política de bucket: a chave
          // Limited Access da ADR-015 é incompatível com `PutBucketPolicy`.
          // A limitação empurrou para o desenho certo — imagem de quadra
          // pública e foto de aluno privada convivem no mesmo bucket.
          ACL: publico ? 'public-read' : 'private',
        }),
      );
    } catch (causa) {
      throw new FalhaDeStorage('gravar', objeto.key, causa);
    }
  }

  async apagar(key: string): Promise<void> {
    try {
      await this.client.send(
        new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
    } catch (causa) {
      throw new FalhaDeStorage('apagar', key, causa);
    }
  }

  async metadados(key: string): Promise<MetadadosDoObjeto | null> {
    try {
      const resposta = await this.client.send(
        new HeadObjectCommand({ Bucket: this.config.bucket, Key: key }),
      );
      return {
        tamanhoBytes: resposta.ContentLength ?? 0,
        contentType: resposta.ContentType ?? null,
        cacheControl: resposta.CacheControl ?? null,
        etag: resposta.ETag ?? null,
      };
    } catch (causa) {
      if (naoEncontrado(causa)) {
        return null;
      }
      throw new FalhaDeStorage('metadados', key, causa);
    }
  }

  urlPublica(key: string): string {
    return `${this.config.cdnUrl}/${encodeKey(key)}`;
  }

  async urlAssinada(
    key: string,
    expiraEmSegundos: number = TETO_EXPIRACAO_URL_ASSINADA_SEGUNDOS,
  ): Promise<string> {
    // AC-010 é TETO, e a recusa é explícita: aparar em silêncio faria uma
    // chamada pedindo 24 h receber 15 min sem nunca saber disso, e a
    // diferença entre pedir errado e ser corrigido às escondidas é o que
    // separa um contrato de uma gentileza.
    if (
      !Number.isInteger(expiraEmSegundos) ||
      expiraEmSegundos <= 0 ||
      expiraEmSegundos > TETO_EXPIRACAO_URL_ASSINADA_SEGUNDOS
    ) {
      throw new FalhaDeStorage(
        'assinar',
        key,
        new Error(
          `expiração de ${expiraEmSegundos}s fora do teto de ` +
            `${TETO_EXPIRACAO_URL_ASSINADA_SEGUNDOS}s (AC-010)`,
        ),
      );
    }
    try {
      // O retorno é credencial de leitura: não logar, não persistir
      // (INV-032/AC-011). O `catch` abaixo carrega a chave, nunca a URL.
      return await getSignedUrl(
        this.client,
        new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
        { expiresIn: expiraEmSegundos },
      );
    } catch (causa) {
      throw new FalhaDeStorage('assinar', key, causa);
    }
  }

  async medirUso(maximoDePaginas: number): Promise<UsoDoBucket> {
    let objetos = 0;
    let bytes = 0;
    let token: string | undefined;
    let paginas = 0;

    try {
      do {
        const resposta = await this.client.send(
          new ListObjectsV2Command({
            Bucket: this.config.bucket,
            ContinuationToken: token,
          }),
        );
        for (const objeto of resposta.Contents ?? []) {
          objetos++;
          bytes += objeto.Size ?? 0;
        }
        token = resposta.NextContinuationToken;
        paginas++;
      } while (token && paginas < maximoDePaginas);
    } catch (causa) {
      // A `key` aqui não é de um objeto: a operação é sobre o bucket. Fica
      // explícito no lugar dela para o erro não mentir sobre o que falhou.
      throw new FalhaDeStorage(
        'metadados',
        `(bucket ${this.config.bucket})`,
        causa,
      );
    }

    // `completo: false` quando ainda havia página e o teto foi atingido. A
    // resposta parcial precisa dizer que é parcial — número que finge ser
    // total é pior que número nenhum.
    return { objetos, bytes, completo: !token };
  }
}

/**
 * A chave é montada por nós e só tem caracteres seguros (AC-007), mas
 * `urlPublica` é o ponto em que dado do banco vira URL — e a AC-018 existe
 * porque chave adulterada no banco é cenário previsto. Codificar por
 * segmento preserva a hierarquia e neutraliza o resto.
 */
function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function naoEncontrado(causa: unknown): boolean {
  if (typeof causa !== 'object' || causa === null) {
    return false;
  }
  const erro = causa as {
    name?: string;
    $metadata?: { httpStatusCode?: number };
  };
  // O `HeadObject` não tem corpo de resposta, então o SDK devolve `NotFound`
  // seco, sem o `NoSuchKey` que o `GetObject` daria. Aceitar os dois nomes,
  // e o 404, evita depender de qual deles a versão do SDK escolheu.
  return (
    erro.name === 'NotFound' ||
    erro.name === 'NoSuchKey' ||
    erro.$metadata?.httpStatusCode === 404
  );
}
