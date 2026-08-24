import { Module, ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { request as requisicaoCrua } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  STORAGE_PROVIDER,
  type ObjetoParaGravar,
  type StorageProvider,
} from '../src/storage/storage-provider.interface';
import { StorageService } from '../src/storage/storage.service';
import {
  CAMPO_DO_ARQUIVO,
  TAMANHO_MAXIMO_BYTES,
} from '../src/storage/upload-de-midia';
import {
  EMPRESA_FIXTURE,
  FixtureUploadController,
  RECURSO_FIXTURE,
} from './storage/fixture-upload.controller';

/**
 * SPEC-017/TASK-002b — o contrato CON-017.1 exercitado por HTTP de verdade.
 *
 * **O que esta suíte prova que nenhum teste unitário provaria:** a ORDEM.
 * 413 antes do parse, 422 depois; campo `arquivo`; e nada gravado quando
 * recusa. A ordem é decidida pelo framework (guard → interceptor → handler),
 * e a spec foi reescrita na 3ª rodada justamente porque a v4 afirmava uma
 * ordem interna que o Nest não deixa prometer. Aqui o resultado é medido, não
 * afirmado.
 *
 * O provider é falso: o que fala com o bucket real é o FIT-006 (TASK-007).
 */

const CORPUS = join(__dirname, 'fixtures', 'webp');
const ler = (nome: string) => readFileSync(join(CORPUS, nome));

const rota = (tipo: string) => `/api/v1/fixture/${tipo}`;

interface CorpoDaResposta {
  key?: string;
  largura?: number;
  altura?: number;
  url?: string;
  code?: string;
}

/** `body` do Supertest é `any`; isto é o único ponto que assume a forma. */
const corpo = (resposta: { body: unknown }): CorpoDaResposta =>
  resposta.body as CorpoDaResposta;

describe('CON-017.1 — upload de mídia (fixture)', () => {
  let app: INestApplication<App>;
  let gravados: ObjetoParaGravar[];
  let provider: StorageProvider;

  beforeEach(async () => {
    gravados = [];
    provider = {
      gravar: (objeto) => {
        gravados.push(objeto);
        return Promise.resolve();
      },
      apagar: () => Promise.resolve(),
      metadados: () => Promise.resolve(null),
      urlPublica: (key) => `https://cdn.exemplo/${key}`,
      urlAssinada: (key) => Promise.resolve(`https://assinada.exemplo/${key}`),
    };

    @Module({
      controllers: [FixtureUploadController],
      providers: [
        { provide: STORAGE_PROVIDER, useValue: provider },
        StorageService,
      ],
    })
    class ModuloDeFixture {}

    const moduleRef = await Test.createTestingModule({
      imports: [ModuloDeFixture],
    }).compile();

    app = moduleRef.createNestApplication<INestApplication<App>>();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(
      new ValidationPipe({ whitelist: true, transform: true }),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  describe('o caminho feliz', () => {
    it('aceita WebP válido, devolve a chave do CONTEÚDO e grava uma vez', async () => {
      const resposta = await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'foto.webp')
        .expect(200);

      expect(corpo(resposta)).toMatchObject({ largura: 64, altura: 48 });
      expect(corpo(resposta).key).toMatch(
        new RegExp(
          `^empresas/${EMPRESA_FIXTURE}/quadra/${RECURSO_FIXTURE}/[0-9a-f]{64}\\.webp$`,
        ),
      );
      expect(gravados).toHaveLength(1);
      expect(gravados[0].visibilidade).toBe('publico');
      expect(gravados[0].contentType).toBe('image/webp');
    });

    it('mesmo arquivo 3x: mesma chave, 3 gravações do MESMO objeto (AC-008)', async () => {
      // A chave é o conteúdo, então o retry é inofensivo: reescreve byte a
      // byte o mesmo objeto. É o que torna a foto tirada na quadra, com o
      // sinal ruim da SPEC-014, um caso normal e não excepcional.
      const chaves = new Set<string>();
      for (let i = 0; i < 3; i++) {
        const r = await request(app.getHttpServer())
          .put(rota('quadra'))
          .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'foto.webp')
          .expect(200);
        chaves.add(corpo(r).key as string);
      }
      expect(chaves.size).toBe(1);
      expect(new Set(gravados.map((g) => g.key)).size).toBe(1);
    });

    it('foto de pessoa é gravada como PRIVADA, sem o chamador escolher', async () => {
      await request(app.getHttpServer())
        .put(rota('perfil'))
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'foto.webp')
        .expect(200);

      expect(gravados[0].visibilidade).toBe('privado');
    });
  });

  describe('AC-006 — 413, e nada gravado', () => {
    it('recusa 3 MB COM Content-Length ANTES de ler o corpo inteiro', async () => {
      // Este é o único teste do arquivo que não usa Supertest, e a razão é
      // o próprio comportamento sob prova: o servidor responde 413 e fecha
      // **enquanto o cliente ainda está enviando**, então a escrita do
      // cliente morre com ECONNRESET antes de o Supertest ler a resposta.
      //
      // Isso não é defeito — é o que a AC-006 pede, e é o que o nginx faz
      // com `client_max_body_size`. Mas provar isso exige medir: quantos
      // bytes o cliente conseguiu escrever até a resposta chegar. Se o
      // servidor estivesse bufferizando os 3 MB, o número seria 3 MB.
      await app.listen(0);
      const servidor = app.getHttpServer() as { address(): AddressInfo };
      const { port } = servidor.address();
      const medida = await enviarSemEsperarFim(port, 3 * 1024 * 1024);

      expect(medida.status).toBe(413);
      expect(medida.body.code).toBe('CORPO_GRANDE_DEMAIS');
      // A prova de que não consumiu o stream. Medido nesta máquina: ~393 KB
      // de 3 MB, ou seja, respondeu com 13% do corpo transferido — o resto é
      // buffer de socket, que varia por sistema. A barra é o próprio teto de
      // 2 MB: **recusou antes de trafegar sequer o tamanho máximo
      // permitido**. Se o servidor bufferizasse o corpo, este número seria
      // 3 MB inteiros.
      expect(medida.bytesEscritos).toBeLessThan(TAMANHO_MAXIMO_BYTES);
      expect(gravados).toHaveLength(0);
    });

    it('recusa 3 MB SEM Content-Length (chunked), pelo limite do Multer', async () => {
      // O outro cenário, e nenhum dos dois portões cobre o outro: aqui não há
      // `Content-Length` para o guard ler, e quem recusa é o
      // `limits.fileSize` durante o streaming. Sem a tradução do MulterError
      // isto seria 500 — servidor "quebrado" em vez de servidor que recusou.
      const stream = Readable.from(
        (function* () {
          for (let i = 0; i < 24; i++) {
            yield Buffer.alloc(128 * 1024, 0x41);
          }
        })(),
      );

      const resposta = await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach(CAMPO_DO_ARQUIVO, stream as unknown as Buffer, 'grande.webp')
        .expect(413);

      expect(corpo(resposta).code).toBe('CORPO_GRANDE_DEMAIS');
      expect(gravados).toHaveLength(0);
    });

    it('aceita o que está logo abaixo do teto, se for WebP válido', async () => {
      // A fronteira do tamanho não pode recusar arquivo legítimo: o corpo
      // multipart tem cabeçalho além do arquivo, então o teto é do arquivo.
      expect(ler('valido-2500px-no-limite.webp').length).toBeLessThan(
        TAMANHO_MAXIMO_BYTES,
      );
      await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach(CAMPO_DO_ARQUIVO, ler('valido-2500px-no-limite.webp'), 'g.webp')
        .expect(200);
    });
  });

  describe('AC-001 a 005 — 422 do validador, pela rota', () => {
    it.each([
      ['jpeg-disfarcado-de.webp', 'TIPO_NAO_SUPORTADO'],
      ['png-valido.png', 'TIPO_NAO_SUPORTADO'],
      ['webp-com-exif.webp', 'IMAGEM_COM_METADADOS'],
      ['webp-com-chunk-desconhecido.webp', 'IMAGEM_COM_METADADOS'],
      ['webp-carga-em-vp8l-extra.webp', 'IMAGEM_COM_METADADOS'],
      ['webp-vp8x-bit-de-animacao.webp', 'IMAGEM_COM_METADADOS'],
      ['webp-2501px-largura.webp', 'IMAGEM_GRANDE_DEMAIS'],
      ['webp-truncado-no-meio.webp', 'TIPO_NAO_SUPORTADO'],
      ['webp-vazio.webp', 'TIPO_NAO_SUPORTADO'],
    ])('recusa %s com 422 %s, e NÃO grava', async (nome, code) => {
      const resposta = await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach(CAMPO_DO_ARQUIVO, ler(nome), nome)
        .expect(422);

      expect(corpo(resposta).code).toBe(code);
      expect(gravados).toHaveLength(0);
    });
  });

  describe('o campo é `arquivo`', () => {
    it('recusa campo com outro nome', async () => {
      const resposta = await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach('imagem', ler('valido-vp8-lossy.webp'), 'foto.webp')
        .expect(400);

      expect(corpo(resposta).code).toBe('CAMPO_INESPERADO');
      expect(gravados).toHaveLength(0);
    });

    it('recusa requisição sem arquivo nenhum', async () => {
      const resposta = await request(app.getHttpServer())
        .put(rota('quadra'))
        .field('outra', 'coisa')
        .expect(400);

      expect(corpo(resposta).code).toBe('CAMPO_INESPERADO');
    });

    it('recusa dois arquivos no mesmo envio', async () => {
      await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'a.webp')
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8l-lossless.webp'), 'b.webp')
        .expect(400);

      expect(gravados).toHaveLength(0);
    });
  });

  describe('leitura — o regime sai do tipo, e chave alheia é 404', () => {
    it('quadra devolve URL de CDN, sem assinatura', async () => {
      const enviada = await request(app.getHttpServer())
        .put(rota('quadra'))
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'f.webp')
        .expect(200);

      const leitura = await request(app.getHttpServer())
        .get(rota('quadra'))
        .query({ key: corpo(enviada).key })
        .expect(200);

      expect(corpo(leitura).url).toBe(
        `https://cdn.exemplo/${corpo(enviada).key}`,
      );
    });

    it('perfil devolve URL assinada', async () => {
      const enviada = await request(app.getHttpServer())
        .put(rota('perfil'))
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'f.webp')
        .expect(200);

      const leitura = await request(app.getHttpServer())
        .get(rota('perfil'))
        .query({ key: corpo(enviada).key })
        .expect(200);

      expect(corpo(leitura).url).toContain('assinada.exemplo');
    });

    it.each([
      [
        'chave de outra empresa',
        `empresas/aaaaaaaa-0000-4000-8000-000000000001/quadra/${RECURSO_FIXTURE}/${'a'.repeat(64)}.webp`,
      ],
      [
        'chave de outro tipo',
        `empresas/${EMPRESA_FIXTURE}/perfil/${RECURSO_FIXTURE}/${'a'.repeat(64)}.webp`,
      ],
      ['travessia de caminho', `empresas/${EMPRESA_FIXTURE}/quadra/../x.webp`],
      ['chave corrompida', 'lixo'],
      ['sem chave', undefined],
    ])('%s devolve 404, nunca 403', async (_rotulo, key) => {
      const resposta = await request(app.getHttpServer())
        .get(rota('quadra'))
        .query(key === undefined ? {} : { key })
        .expect(404);

      expect(corpo(resposta).code).toBe('OBJETO_NAO_ENCONTRADO');
    });
  });

  describe('a configuração vem da MESMA fonte que as rotas reais (INV-048)', () => {
    it('o fixture não define limite nem nome de campo próprios', () => {
      // A garantia é estrutural, não de runtime: o controller aplica
      // `@UploadDeMidia()` e não conhece `TAMANHO_MAXIMO_BYTES`. Se alguém
      // montar um `FileInterceptor` à mão numa rota real, este teste não
      // pega — mas o grep que ele documenta, sim.
      const fonte = readFileSync(
        join(__dirname, 'storage', 'fixture-upload.controller.ts'),
        'utf8',
      );
      expect(fonte).toContain('@UploadDeMidia()');
      expect(fonte).not.toContain('FileInterceptor');
      expect(fonte).not.toContain('limits');
      expect(fonte).not.toContain('fileSize');
    });
  });
});

/**
 * Envia um corpo multipart grande com `Content-Length` declarado e resolve
 * assim que a resposta chega — sem esperar a escrita terminar. Devolve
 * também quantos bytes o cliente conseguiu escrever até lá.
 */
function enviarSemEsperarFim(
  porta: number,
  tamanho: number,
): Promise<{ status: number; body: { code?: string }; bytesEscritos: number }> {
  const limite = '----playckfixture';
  const cabecalho = Buffer.from(
    `--${limite}\r\n` +
      `Content-Disposition: form-data; name="${CAMPO_DO_ARQUIVO}"; filename="grande.webp"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  const rodape = Buffer.from(`\r\n--${limite}--\r\n`);
  const total = cabecalho.length + tamanho + rodape.length;

  return new Promise((resolve, reject) => {
    let bytesEscritos = 0;
    let respondido = false;

    const req = requisicaoCrua(
      {
        port: porta,
        method: 'PUT',
        path: '/api/v1/fixture/quadra',
        headers: {
          'content-type': `multipart/form-data; boundary=${limite}`,
          'content-length': String(total),
        },
      },
      (res) => {
        let texto = '';
        res.on('data', (p: Buffer) => (texto += p.toString()));
        res.on('end', () => {
          respondido = true;
          req.destroy();
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(texto || '{}') as { code?: string },
            bytesEscritos,
          });
        });
      },
    );

    // ECONNRESET aqui é ESPERADO: o servidor fechou porque já respondeu.
    req.on('error', (erro) => {
      if (!respondido) reject(erro);
    });

    req.write(cabecalho);
    bytesEscritos += cabecalho.length;

    const pedaco = Buffer.alloc(64 * 1024, 0x41);
    let restante = tamanho;
    const escrever = () => {
      while (restante > 0 && !respondido) {
        const n = Math.min(pedaco.length, restante);
        const ok = req.write(pedaco.subarray(0, n));
        bytesEscritos += n;
        restante -= n;
        if (!ok) {
          req.once('drain', escrever);
          return;
        }
      }
      if (!respondido) {
        req.end(rodape);
      }
    };
    escrever();
  });
}
