import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import { PassportModule } from '@nestjs/passport';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MeFotoController } from '../src/auth/me-foto.controller';
import { FotoDePerfilService } from '../src/auth/foto-de-perfil.service';
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
 * SPEC-018/TASK-003 — `/me/foto` por HTTP de verdade.
 *
 * **O que esta suíte prova e o unitário não provaria:** que a fiação está
 * certa — guard aplicado, interceptor de upload no lugar, campo `arquivo`
 * chegando, e o 403 da AC-022 saindo com `code` estável em vez de 500.
 *
 * E prova a AC-004 do jeito mais forte que existe: **não há rota que aceite
 * id de usuário.** A asserção é sobre o roteador, não sobre uma comparação
 * que alguém poderia esquecer de escrever.
 */

const SEGREDO = 'segredo-de-teste-me-foto';
const EMPRESA = '11111111-1111-4111-8111-111000180001';
const ALUNO = '33333333-3333-4333-8333-333000180003';
const SUPER = '44444444-4444-4444-8444-444000180004';

/** Um WebP válido de 1x1, para o validador real ter o que aprovar. */
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

describe('/me/foto (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const gravados: string[] = [];
  const linhas = new Map<
    string,
    { companyId: string | null; fotoKey: string | null }
  >();

  beforeAll(async () => {
    // A estratégia lê `JWT_ACCESS_SECRET` do ConfigService, não do
    // JwtModule — quem assina e quem confere têm de olhar para o mesmo
    // lugar, senão a suíte inteira devolve 401 e parece bug de guard.
    process.env.JWT_ACCESS_SECRET = SEGREDO;

    linhas.set(ALUNO, { companyId: EMPRESA, fotoKey: null });
    linhas.set(SUPER, { companyId: null, fotoKey: null });

    const prisma = {
      usuario: {
        findUniqueOrThrow: ({ where }: { where: { id: string } }) =>
          Promise.resolve({ id: where.id, ...linhas.get(where.id) }),
        // O `JwtAuthGuard` lê o BANCO a cada requisição autenticada, para
        // INV-008 (senha temporária) e INV-013 (conta inativa) valerem na
        // hora, e não quando o token expirar. Sem isto aqui, a suíte
        // devolve 500 e parece defeito da rota.
        findUnique: ({ where }: { where: { id: string } }) =>
          Promise.resolve(
            linhas.has(where.id)
              ? { senhaTemporaria: false, status: 'ativo' }
              : null,
          ),
      },
      $transaction: (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          usuario: {
            update: ({
              where,
              data,
            }: {
              where: { id: string };
              data: { fotoKey: string | null };
            }) => {
              linhas.get(where.id)!.fotoKey = data.fotoKey;
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
      urlAssinada: (key) => Promise.resolve(`https://assinada/${key}`),
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 1_000 }]),
        PassportModule,
        JwtModule.register({ secret: SEGREDO }),
      ],
      controllers: [MeFotoController],
      providers: [
        FotoDePerfilService,
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

  const token = (sub: string, role: string, companyId: string | null) =>
    jwt.sign({ sub, role, companyId }, { secret: SEGREDO, expiresIn: '5m' });

  it('sem token: 401 — a foto é privada antes de qualquer outra coisa', async () => {
    await request(app.getHttpServer()).get('/api/v1/me/foto').expect(401);
  });

  it('AC-022 — super_admin recebe 403 com code estável, NUNCA 500', async () => {
    // O 500 é o cenário que esta suíte existe para impedir: sem a guarda, o
    // caminho chegaria ao `UPDATE` e o CHECK do banco estouraria.
    const resposta = await request(app.getHttpServer())
      .put('/api/v1/me/foto')
      .set('Authorization', `Bearer ${token(SUPER, 'super_admin', null)}`)
      .attach(CAMPO_DO_ARQUIVO, webpValido(), 'foto.webp')
      .expect(403);

    expect(resposta.body).toMatchObject({ code: 'PERFIL_SEM_EMPRESA' });
    // E nada foi gravado no bucket a caminho do 403.
    expect(gravados).toHaveLength(0);
  });

  it('sobe, devolve URL assinada, e a chave é privada', async () => {
    const resposta = await request(app.getHttpServer())
      .put('/api/v1/me/foto')
      .set('Authorization', `Bearer ${token(ALUNO, 'aluno', EMPRESA)}`)
      .attach(CAMPO_DO_ARQUIVO, webpValido(), 'foto.webp')
      .expect(200);

    expect(gravados).toHaveLength(1);
    expect(gravados[0]).toMatch(
      new RegExp(`^empresas/${EMPRESA}/perfil/${ALUNO}/[0-9a-f]{64}\\.webp$`),
    );
    // Assinada, não CDN: foto de pessoa nunca é URL permanente.
    const corpo = resposta.body as { url: string };
    expect(corpo.url).toContain('assinada');
  });

  it('recusa corpo que não é WebP, e nada é gravado', async () => {
    const antes = gravados.length;
    await request(app.getHttpServer())
      .put('/api/v1/me/foto')
      .set('Authorization', `Bearer ${token(ALUNO, 'aluno', EMPRESA)}`)
      .attach(CAMPO_DO_ARQUIVO, Buffer.from('isto não é webp'), 'x.webp')
      .expect(422);
    expect(gravados).toHaveLength(antes);
  });

  it('remove e devolve 204; ler depois devolve url nula', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/me/foto')
      .set('Authorization', `Bearer ${token(ALUNO, 'aluno', EMPRESA)}`)
      .expect(204);

    const resposta = await request(app.getHttpServer())
      .get('/api/v1/me/foto')
      .set('Authorization', `Bearer ${token(ALUNO, 'aluno', EMPRESA)}`)
      .expect(200);
    expect(resposta.body).toEqual({ url: null });
  });

  it('remover de novo continua 204 — idempotente, não 404', async () => {
    await request(app.getHttpServer())
      .delete('/api/v1/me/foto')
      .set('Authorization', `Bearer ${token(ALUNO, 'aluno', EMPRESA)}`)
      .expect(204);
  });

  it('AC-004 — NÃO existe rota que aceite id de usuário', async () => {
    // A prova mais forte da AC-004: um usuário não sobe a foto de outro
    // porque não há caminho pelo qual outro id chegue ao servidor. Guarda
    // que compara `params.id` com `token.sub` é guarda que alguém pode
    // esquecer de escrever na rota seguinte.
    const outro = '99999999-9999-4999-8999-999000180009';
    for (const caminho of [
      `/api/v1/me/foto/${outro}`,
      `/api/v1/users/${outro}/foto`,
      `/api/v1/me/${outro}/foto`,
    ]) {
      await request(app.getHttpServer())
        .put(caminho)
        .set('Authorization', `Bearer ${token(ALUNO, 'aluno', EMPRESA)}`)
        .expect(404);
    }
  });
});
