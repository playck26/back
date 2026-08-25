import {
  Controller,
  Module,
  Param,
  ParseUUIDPipe,
  Put,
  UploadedFile,
  ValidationPipe,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { request as requisicaoCrua } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import request from 'supertest';
import { validarWebp } from '../src/storage/webp.validator';
import type { App } from 'supertest/types';
import {
  STORAGE_PROVIDER,
  type ObjetoParaGravar,
  type StorageProvider,
} from '../src/storage/storage-provider.interface';
import { StorageService } from '../src/storage/storage.service';
import {
  LIMITE_DE_UPLOADS,
  ThrottlerPorUsuario,
} from '../src/storage/limite-de-upload';
import {
  CAMPO_DO_ARQUIVO,
  exigirArquivo,
  TAMANHO_MAXIMO_BYTES,
  UploadDeMidia,
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
      medirUso: () => Promise.resolve({ objetos: 0, bytes: 0, completo: true }),
    };

    @Module({
      // O `@UploadDeMidia()` traz o limite de abuso junto (TASK-006), e o
      // limite precisa do `ThrottlerModule`. O fixture espelha o `AppModule`
      // de propósito — inclusive o guard global por IP — porque a INV-048
      // existe justamente para o fixture não provar o que a produção não faz.
      imports: [
        ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
      ],
      controllers: [FixtureUploadController],
      providers: [
        { provide: STORAGE_PROVIDER, useValue: provider },
        StorageService,
        { provide: APP_GUARD, useClass: ThrottlerPorUsuario },
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

  describe('NFR-001 — concorrência', () => {
    it('3 uploads em paralelo: todos completam, e cada um vira seu objeto', async () => {
      // O que este teste prova é que a concorrência não corrompe estado —
      // três requisições simultâneas não embaralham corpo, chave nem
      // visibilidade.
      //
      // **O que ele NÃO prova é memória de container**, e vale dizer em vez
      // de fingir: os fixtures têm poucos KB, então medir RSS aqui seria
      // teatro. A prova de memória é outra, e está no harness — o processo
      // sobe com **91 MB** num container de 512 MB, e o caminho de decode
      // simplesmente não existe (INV-033: o servidor lê cabeçalho, nunca
      // decodifica).
      const arquivos = [
        'valido-vp8-lossy.webp',
        'valido-vp8l-lossless.webp',
        'valido-vp8x-com-alpha.webp',
      ];

      const respostas = await Promise.all(
        arquivos.map((nome) =>
          request(app.getHttpServer())
            .put(rota('quadra'))
            .attach(CAMPO_DO_ARQUIVO, ler(nome), nome),
        ),
      );

      expect(respostas.map((r) => r.status)).toEqual([200, 200, 200]);
      expect(gravados).toHaveLength(3);
      // Chaves distintas: cada corpo produziu a sua, sem mistura.
      expect(new Set(gravados.map((g) => g.key)).size).toBe(3);
      // E cada objeto guardou o corpo que lhe pertencia.
      for (const gravado of gravados) {
        expect(validarWebp(gravado.corpo).valido).toBe(true);
      }
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
      // 30 MB, e o tamanho é escolhido para a prova ser ROBUSTA: quanto
      // maior o corpo, menor a fração que o buffer de socket representa.
      // A primeira versão mandava 3 MB e comparava com o teto de 2 MB —
      // passava na minha máquina (393 KB escritos) e reprovava no runner do
      // CI (2,69 MB), porque buffer de socket varia por sistema. A
      // afirmação estava certa e a barra é que era arbitrária.
      const CORPO = 30 * 1024 * 1024;
      const medida = await enviarSemEsperarFim(port, CORPO);

      expect(medida.status).toBe(413);
      expect(medida.body.code).toBe('CORPO_GRANDE_DEMAIS');
      // A prova de que não consumiu o stream: respondeu com menos de um
      // terço do corpo transferido. O número exato é buffer de socket e
      // varia por sistema (393 KB aqui, 2,7 MB no runner do CI); o que não
      // varia é a ordem de grandeza — se o servidor bufferizasse o corpo,
      // seriam 30 MB inteiros.
      expect(medida.bytesEscritos).toBeLessThan(CORPO / 3);
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

  describe('TASK-006 — o limite de abuso vem junto com o decorator', () => {
    it(`recusa o ${LIMITE_DE_UPLOADS + 1}º envio da mesma janela com 429`, async () => {
      // O `@UploadDeMidia()` traz o limite junto, e é de propósito: limite
      // que a rota pode esquecer de pedir é limite que uma rota nova não vai
      // ter. Aqui o fixture não pede nada além do decorator.
      const enviar = () =>
        request(app.getHttpServer())
          .put(rota('quadra'))
          .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'f.webp');

      for (let i = 0; i < LIMITE_DE_UPLOADS; i++) {
        await enviar().expect(200);
      }

      const barrado = await enviar().expect(429);
      expect(corpo(barrado).code).toBe('REQUISICOES_DEMAIS');

      // O que passou, passou: o limite recusa o excedente, não desfaz o
      // trabalho já aceito.
      expect(gravados).toHaveLength(LIMITE_DE_UPLOADS);
    });
  });

  describe('o upload NÃO mascara o erro da própria rota', () => {
    // Achado da 2ª validação cruzada, reproduzido antes de corrigir: o
    // decorator usava um filtro de rota, e filtro de rota captura por TIPO —
    // no escopo da rota, `BadRequestException` significa qualquer coisa.
    // Um id inválido virava "Envie o arquivo no campo arquivo".
    //
    // O fixture sozinho nunca pegaria isto: ele não valida parâmetro. É
    // preciso uma rota que recuse por conta própria, e é o que este bloco
    // monta — a rota real da SPEC-018 vai ter exatamente essa forma.
    let appComPipe: INestApplication<App>;

    beforeEach(async () => {
      @Controller('comPipe')
      class RotaComPipe {
        @Put(':id')
        @UploadDeMidia()
        subir(
          @Param('id', ParseUUIDPipe) id: string,
          @UploadedFile() arquivo?: Express.Multer.File,
        ) {
          exigirArquivo(arquivo);
          return { id };
        }
      }

      @Module({
        imports: [
          ThrottlerModule.forRoot([
            { name: 'default', ttl: 60_000, limit: 100 },
          ]),
        ],
        controllers: [RotaComPipe],
        providers: [{ provide: APP_GUARD, useClass: ThrottlerPorUsuario }],
      })
      class ModuloComPipe {}

      const ref = await Test.createTestingModule({
        imports: [ModuloComPipe],
      }).compile();
      appComPipe = ref.createNestApplication<INestApplication<App>>();
      appComPipe.setGlobalPrefix('api/v1');
      await appComPipe.init();
    });

    afterEach(async () => {
      await appComPipe.close();
    });

    it('id inválido devolve o erro do PIPE, não o do upload', async () => {
      const resposta = await request(appComPipe.getHttpServer())
        .put('/api/v1/comPipe/nao-e-uuid')
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'f.webp')
        .expect(400);

      expect(corpo(resposta).code).toBeUndefined();
      expect(JSON.stringify(resposta.body)).toMatch(/uuid/i);
    });

    it('e o erro DE upload continua traduzido na mesma rota', async () => {
      const resposta = await request(appComPipe.getHttpServer())
        .put('/api/v1/comPipe/f1c70000-0000-4000-8000-000000000002')
        .attach('campo-errado', ler('valido-vp8-lossy.webp'), 'f.webp')
        .expect(400);

      expect(corpo(resposta).code).toBe('CAMPO_INESPERADO');
    });

    it('id válido com arquivo válido passa', async () => {
      const resposta = await request(appComPipe.getHttpServer())
        .put('/api/v1/comPipe/f1c70000-0000-4000-8000-000000000002')
        .attach(CAMPO_DO_ARQUIVO, ler('valido-vp8-lossy.webp'), 'f.webp')
        .expect(200);

      expect(resposta.body).toMatchObject({
        id: 'f1c70000-0000-4000-8000-000000000002',
      });
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
