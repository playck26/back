import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CompanyLogoController } from '../src/companies/company-logo.controller';
import { LogoDaEmpresaService } from '../src/companies/logo-da-empresa.service';
import { JwtAccessStrategy } from '../src/auth/strategies/jwt-access.strategy';
import { PrismaService } from '../src/prisma/prisma.service';
import { StorageService } from '../src/storage/storage.service';
import { FilaDeExclusao } from '../src/storage/fila-de-exclusao.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../src/storage/storage-provider.interface';
import { CAMPO_DO_ARQUIVO } from '../src/storage/upload-de-midia';

/**
 * SPEC-018/TASK-006 — `/companies/:id/logo` por HTTP.
 *
 * **O que só aparece aqui:** que o `RolesGuard` deixa `company_admin` e
 * `super_admin` entrarem — e mais ninguém —, e que o escopo por empresa
 * responde **404**, não 403, quando um gestor pede a logo de outra.
 */

const SEGREDO = 'segredo-de-teste-logo';
const EMPRESA_A = '11111111-1111-4111-8111-111000180001';
const EMPRESA_B = '22222222-2222-4222-8222-222000180002';
const CDN = 'https://cdn.exemplo/';

function webpValido(): Buffer {
  const frame = Buffer.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
  const chunk = Buffer.alloc(8 + frame.length);
  chunk.write('VP8 ', 0, 'ascii');
  chunk.writeUInt32LE(frame.length, 4);
  frame.copy(chunk, 8);
  const riff = Buffer.alloc(12 + chunk.length);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write('WEBP', 8, 'ascii');
  chunk.copy(riff, 12);
  return riff;
}

describe('/companies/:id/logo (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const gravados: string[] = [];
  const empresas = new Map<
    string,
    { id: string; logoKey: string | null; logoUrl: string | null }
  >();

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SEGREDO;
    empresas.set(EMPRESA_A, {
      id: EMPRESA_A,
      logoKey: null,
      logoUrl: 'https://clube.antigo/logo.png',
    });

    const prisma = {
      usuario: {
        // O `JwtAuthGuard` lê o banco a cada requisição (INV-008/INV-013).
        findUnique: () =>
          Promise.resolve({ senhaTemporaria: false, status: 'ativo' }),
      },
      empresa: {
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(empresas.get(where.id) ?? null),
      },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          empresa: {
            update: ({
              where,
              data,
            }: {
              where: { id: string };
              data: { logoKey: string | null };
            }) => {
              empresas.get(where.id)!.logoKey = data.logoKey;
              return Promise.resolve({});
            },
          },
        }),
    };

    const provider: Partial<StorageProvider> = {
      gravar: (objeto) => {
        gravados.push(objeto.key);
        return Promise.resolve();
      },
      urlPublica: (key) => CDN + key,
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1_000 }]),
        PassportModule,
        JwtModule.register({ secret: SEGREDO }),
      ],
      controllers: [CompanyLogoController],
      providers: [
        LogoDaEmpresaService,
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

  const token = (role: string, companyId: string | null) =>
    jwt.sign(
      { sub: 'u1', role, companyId },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  const subir = (id: string, papel: string, empresaDoToken: string | null) =>
    request(app.getHttpServer())
      .put(`/api/v1/companies/${id}/logo`)
      .set('Authorization', `Bearer ${token(papel, empresaDoToken)}`)
      .attach(CAMPO_DO_ARQUIVO, webpValido(), 'logo.webp');

  it('sem token: 401', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/companies/${EMPRESA_A}/logo`)
      .expect(401);
  });

  it('aluno não entra — o RolesGuard barra antes de qualquer escopo', async () => {
    await subir(EMPRESA_A, 'aluno', EMPRESA_A).expect(403);
    expect(gravados).toHaveLength(0);
  });

  it('AC-014 — gestor de OUTRA empresa recebe 404, não 403', async () => {
    // 403 aqui diria "existe, mas não é sua", que é justamente a pergunta
    // que o 404 esconde.
    await subir(EMPRESA_A, 'company_admin', EMPRESA_B).expect(404);
    expect(gravados).toHaveLength(0);
  });

  it('id malformado é 400 antes de qualquer consulta', async () => {
    await subir('nao-e-uuid', 'super_admin', null).expect(400);
  });

  it('o gestor da empresa sobe, e a resposta traz a URL de CDN', async () => {
    const resposta = await subir(EMPRESA_A, 'company_admin', EMPRESA_A).expect(
      200,
    );
    expect(gravados).toHaveLength(1);
    expect(gravados[0]).toMatch(
      new RegExp(
        `^empresas/${EMPRESA_A}/logo/${EMPRESA_A}/[0-9a-f]{64}\\.webp$`,
      ),
    );
    const corpo = resposta.body as { logoUrl: string };
    // Pública, sem assinatura: material corporativo.
    expect(corpo.logoUrl).toBe(CDN + gravados[0]);
  });

  it('remover devolve a `logo_url` antiga — AC-013 na resposta', async () => {
    // O detalhe que diferencia esta rota do `DELETE /me/foto`: remover a
    // logo pode não deixar a tela vazia.
    const resposta = await request(app.getHttpServer())
      .delete(`/api/v1/companies/${EMPRESA_A}/logo`)
      .set('Authorization', `Bearer ${token('company_admin', EMPRESA_A)}`)
      .expect(200);

    expect(resposta.body).toEqual({ logoUrl: 'https://clube.antigo/logo.png' });
  });

  it('super_admin alcança empresa que não é dele', async () => {
    await subir(EMPRESA_A, 'super_admin', null).expect(200);
  });
});
