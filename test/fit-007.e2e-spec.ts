import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MeFotoController } from '../src/auth/me-foto.controller';
import { FotoDePerfilService } from '../src/auth/foto-de-perfil.service';
import { CompanyLogoController } from '../src/companies/company-logo.controller';
import { LogoDaEmpresaService } from '../src/companies/logo-da-empresa.service';
import { CourtImageController } from '../src/courts/court-image.controller';
import { ImagemDaQuadraService } from '../src/courts/imagem-da-quadra.service';
import { TeacherPhotoController } from '../src/people/teacher-photo.controller';
import { FotoDeProfessorService } from '../src/people/foto-de-professor.service';
import { JwtAccessStrategy } from '../src/auth/strategies/jwt-access.strategy';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { FilaDeExclusao } from '../src/storage/fila-de-exclusao.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../src/storage/storage-provider.interface';
import {
  CAMPO_DO_ARQUIVO,
  TAMANHO_MAXIMO_BYTES,
} from '../src/storage/upload-de-midia';

/**
 * **FIT-007 — os portões críticos, nas ROTAS REAIS** (SPEC-018/AC-018).
 *
 * ## Por que este arquivo existe, tendo `storage-upload.e2e-spec.ts`
 *
 * A SPEC-017 entregou um **controller de fixture** para o FIT-006 exercitar,
 * e ele prova que a configuração de upload funciona. **Não prova que as
 * rotas do produto a usam.** A spec foi explícita: *"o fixture da 017 não
 * prova isso (AC-018)"*.
 *
 * A INV-048 diz que a configuração é um **decorator** — `@UploadDeMidia()` —
 * justamente porque *"limite que a rota pode esquecer de pedir é limite que
 * uma rota nova não vai ter"*. Este arquivo é o que transforma essa frase em
 * teste: **a mesma tabela de portões, contra as quatro rotas de verdade.**
 *
 * ## O que ele pega que nenhum outro pega
 *
 * Uma rota de mídia nova que esqueça o decorator. Ela passaria em todos os
 * testes dela mesma — o serviço está certo, o validador está certo — e
 * aceitaria um corpo de 50 MB, ou um campo com outro nome, ou um PDF. Aqui,
 * ela cai: basta acrescentá-la à tabela `ROTAS`, e se ela não estiver na
 * tabela, o teste de cobertura no fim do arquivo reclama.
 *
 * ## Por que os quatro controllers no mesmo módulo
 *
 * Porque a pergunta é *"todas se comportam igual?"*, e comparar quatro
 * arquivos de teste separados não responde isso — cada um teria o próprio
 * conjunto de casos, e a diferença entre eles passaria por variação de
 * estilo.
 */

const SEGREDO = 'segredo-de-teste-fit-007';
const EMPRESA = '11111111-1111-4111-8111-111000180001';
const USUARIO = '22222222-2222-4222-8222-222000180002';
const QUADRA = '33333333-3333-4333-8333-333000180003';
const PROFESSOR = '44444444-4444-4444-8444-444000180004';

/** O menor VP8 válido — o caso feliz, para provar que a rota aceitaria. */
function webpValido(): Buffer {
  const frame = Buffer.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
  return montarRiff([{ fourcc: 'VP8 ', payload: frame }]);
}

/** Um WebP com `EXIF` — chunk fora da allowlist, e o que carrega GPS. */
function webpComExif(): Buffer {
  const vp8x = Buffer.alloc(10);
  vp8x[0] = 0x08; // flag EXIF: o container anunciando metadado
  return montarRiff([
    { fourcc: 'VP8X', payload: vp8x },
    { fourcc: 'EXIF', payload: Buffer.from([1, 2, 3, 4]) },
    {
      fourcc: 'VP8 ',
      payload: Buffer.from([0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a]),
    },
  ]);
}

function montarRiff(chunks: { fourcc: string; payload: Buffer }[]): Buffer {
  const partes: Buffer[] = [];
  for (const { fourcc, payload } of chunks) {
    const cab = Buffer.alloc(8);
    cab.write(fourcc, 0, 'ascii');
    cab.writeUInt32LE(payload.length, 4);
    partes.push(cab, payload);
    if (payload.length % 2 === 1) partes.push(Buffer.from([0]));
  }
  const corpo = Buffer.concat(partes);
  const riff = Buffer.alloc(12 + corpo.length);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + corpo.length, 4);
  riff.write('WEBP', 8, 'ascii');
  corpo.copy(riff, 12);
  return riff;
}

/**
 * **A tabela.** Toda rota de upload de mídia do produto entra aqui.
 *
 * `campos` são os campos de formulário que a rota exige **além** do arquivo
 * — hoje só a de quadra tem um, e é a confirmação da AC-007.
 */
const ROTAS = [
  {
    nome: 'PUT /me/foto',
    caminho: '/api/v1/me/foto',
    papel: 'aluno',
    campos: {} as Record<string, string>,
  },
  {
    nome: 'PUT /companies/:id/logo',
    caminho: `/api/v1/companies/${EMPRESA}/logo`,
    papel: 'company_admin',
    campos: {} as Record<string, string>,
  },
  {
    nome: 'PUT /courts/:id/imagem',
    caminho: `/api/v1/courts/${QUADRA}/imagem`,
    papel: 'company_admin',
    campos: { semPessoasIdentificaveis: 'true' },
  },
  {
    nome: 'PUT /teachers/:id/foto',
    caminho: `/api/v1/teachers/${PROFESSOR}/foto`,
    papel: 'company_admin',
    campos: {} as Record<string, string>,
  },
] as const;

describe('FIT-007 — os portões nas rotas reais (AC-018)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let gravados: string[];

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SEGREDO;
    gravados = [];

    const linha = {
      id: USUARIO,
      companyId: EMPRESA,
      fotoKey: null,
      logoKey: null,
      logoUrl: null,
      imagemKey: null,
      usuarioId: null,
      senhaTemporaria: false,
      status: 'ativo',
      usuario: null,
    };

    const prisma = {
      usuario: {
        findUnique: () => Promise.resolve(linha),
        findUniqueOrThrow: () => Promise.resolve(linha),
      },
      empresa: { findUnique: () => Promise.resolve({ ...linha, id: EMPRESA }) },
      quadra: { findFirst: () => Promise.resolve({ ...linha, id: QUADRA }) },
      professor: {
        findFirst: () => Promise.resolve({ ...linha, id: PROFESSOR }),
      },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          usuario: { update: () => Promise.resolve({}) },
          empresa: { update: () => Promise.resolve({}) },
          quadra: { update: () => Promise.resolve({}) },
          professor: { update: () => Promise.resolve({}) },
        }),
    };

    const provider: Partial<StorageProvider> = {
      gravar: (objeto) => {
        gravados.push(objeto.key);
        return Promise.resolve();
      },
      urlPublica: (key) => 'https://cdn.exemplo/' + key,
      urlAssinada: (key) => Promise.resolve('https://assinada/' + key),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }]),
        PassportModule,
        JwtModule.register({ secret: SEGREDO }),
      ],
      controllers: [
        MeFotoController,
        CompanyLogoController,
        CourtImageController,
        TeacherPhotoController,
      ],
      providers: [
        FotoDePerfilService,
        LogoDaEmpresaService,
        ImagemDaQuadraService,
        FotoDeProfessorService,
        StorageService,
        JwtAccessStrategy,
        { provide: PrismaService, useValue: prisma },
        { provide: STORAGE_PROVIDER, useValue: provider },
        {
          provide: FilaDeExclusao,
          useValue: { enfileirar: () => Promise.resolve('enfileirada') },
        },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    jwt = moduleRef.get(JwtService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    gravados.length = 0;
  });

  const token = (papel: string) =>
    jwt.sign(
      { sub: USUARIO, role: papel, companyId: EMPRESA },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  const enviar = (
    rota: (typeof ROTAS)[number],
    campo: string,
    corpo: Buffer,
  ) => {
    const req = request(app.getHttpServer())
      .put(rota.caminho)
      .set('Authorization', `Bearer ${token(rota.papel)}`);
    for (const [k, v] of Object.entries(rota.campos)) req.field(k, v);
    return req.attach(campo, corpo, 'imagem.webp');
  };

  describe.each(ROTAS)('$nome', (rota) => {
    it('aceita um WebP válido — o controle positivo', async () => {
      // **Sem isto, todos os testes abaixo passariam numa rota quebrada.**
      // Um 500 em qualquer caso daria "não é 200" e os portões pareceriam
      // funcionando. É a lição do dia: detector só vale depois de dar
      // positivo uma vez.
      const res = await enviar(rota, CAMPO_DO_ARQUIVO, webpValido());
      expect(res.status).toBeLessThan(300);
      expect(gravados).toHaveLength(1);
    });

    it('413 acima do teto, e NADA gravado', async () => {
      const gordo = Buffer.alloc(TAMANHO_MAXIMO_BYTES + 1024, 0x41);
      const res = await enviar(rota, CAMPO_DO_ARQUIVO, gordo);

      expect(res.status).toBe(413);
      expect(gravados).toHaveLength(0);
    });

    it('400 com o campo errado, e NADA gravado', async () => {
      // O nome do campo é contrato (CON-017.1). Errar dá 400, não 422 — a
      // requisição nem chega a ter um arquivo para validar.
      const res = await enviar(rota, 'foto', webpValido());

      expect(res.status).toBe(400);
      expect(gravados).toHaveLength(0);
    });

    it('422 se não for WebP, e NADA gravado', async () => {
      const res = await enviar(
        rota,
        CAMPO_DO_ARQUIVO,
        Buffer.from('%PDF-1.4 disfarcado de webp'),
      );

      expect(res.status).toBe(422);
      expect(gravados).toHaveLength(0);
    });

    it('422 se o WebP trouxer chunk de metadado (EXIF), e NADA gravado', async () => {
      // O caso que a allowlist existe para pegar: `EXIF` carrega GPS, e uma
      // foto de quadra com coordenada é dado que ninguém pediu para publicar.
      const res = await enviar(rota, CAMPO_DO_ARQUIVO, webpComExif());

      expect(res.status).toBe(422);
      expect(gravados).toHaveLength(0);
    });
  });

  describe('a cobertura da própria tabela', () => {
    it('toda rota de upload do produto está na tabela', () => {
      // **INV-048 virada em teste.** Uma rota de mídia nova que esqueça o
      // `@UploadDeMidia()` passaria nos testes dela mesma e aceitaria 50 MB.
      // Este teste não a acha sozinho — mas obriga quem a criar a declará-la
      // aqui, e o `describe.each` acima faz o resto.
      //
      // A lista vem do `openapi.json`, que é gerado do código: não é uma
      // segunda lista escrita à mão, que envelheceria.
      const openapi = JSON.parse(
        readFileSync(join(__dirname, '..', 'openapi.json'), 'utf8'),
      ) as { paths: Record<string, Record<string, unknown>> };

      const deUpload = Object.entries(openapi.paths)
        .filter(([, verbos]) => {
          const put = verbos.put as
            { requestBody?: { content?: Record<string, unknown> } } | undefined;
          return (
            put?.requestBody?.content !== undefined &&
            'multipart/form-data' in put.requestBody.content
          );
        })
        .map(([caminho]) => caminho);

      const naTabela = ROTAS.map((r) =>
        r.caminho
          .replace('/api/v1', '')
          .replace(EMPRESA, '{id}')
          .replace(QUADRA, '{id}')
          .replace(PROFESSOR, '{id}'),
      );

      const foraDaTabela = deUpload
        .map((c) => c.replace('/api/v1', ''))
        .filter((c) => !naTabela.includes(c));

      expect(foraDaTabela).toEqual([]);
      // Controle positivo: o `openapi.json` de fato tem rotas de upload.
      expect(deUpload.length).toBeGreaterThanOrEqual(ROTAS.length);
    });
  });
});
