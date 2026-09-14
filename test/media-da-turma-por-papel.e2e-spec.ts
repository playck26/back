import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { MeClassesController } from '../src/classes/me-classes.controller';
import { ClassesService } from '../src/classes/classes.service';
import { MatriculaDoAlunoService } from '../src/classes/matricula-do-aluno.service';
import { AvaliacaoDeAulaService } from '../src/classes/avaliacao-de-aula.service';
import { FaltaAvisadaService } from '../src/classes/falta-avisada.service';
import { JwtAccessStrategy } from '../src/auth/strategies/jwt-access.strategy';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * SPEC-052/AC-010 — **quem lê a média da turma, por HTTP.**
 *
 * A SPEC-025 abriu `GET /me/classes/:id/avaliacao` para `aluno` e `professor`.
 * A decisão 7 do Israel (2026-09-14) fecha para o professor: ele deixa de ver
 * nota de avaliação. O mecanismo é **só aplicação** — `@Roles('aluno')` e o
 * `RolesGuard` (INV-130) —, e decorator não se prova lendo o decorator: prova-se
 * mandando o token e olhando o status.
 *
 * O serviço é dublê: a média em si tem prova própria no `fit-012`, contra
 * Postgres real. Aqui o que está em julgamento é **quem chega ao serviço**.
 * Por isso a asserção do `403` inclui **zero chamadas** ao serviço: um `403`
 * devolvido depois de calcular a média ainda teria lido o dado.
 */

const SEGREDO = 'segredo-de-teste-media-por-papel';
const EMPRESA = '11111111-1111-4111-8111-111000520001';
const TURMA = '33333333-3333-4333-8333-333000520003';

describe('média da turma por papel (e2e) — SPEC-052/AC-010', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const mediaDaTurma = jest.fn();

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SEGREDO;

    const prisma = {
      usuario: {
        // O `JwtAuthGuard` lê o banco a cada requisição (INV-008/INV-013).
        findUnique: () =>
          Promise.resolve({ senhaTemporaria: false, status: 'ativo' }),
      },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }]),
        PassportModule,
        JwtModule.register({ secret: SEGREDO }),
      ],
      controllers: [MeClassesController],
      providers: [
        JwtAccessStrategy,
        { provide: ClassesService, useValue: {} },
        { provide: MatriculaDoAlunoService, useValue: {} },
        { provide: AvaliacaoDeAulaService, useValue: { mediaDaTurma } },
        { provide: FaltaAvisadaService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // Idêntico ao `main.ts`, pela mesma razão do `classes.e2e-spec.ts`.
    app.useGlobalPipes(
      new ValidationPipe({
        whitelist: true,
        transform: true,
        forbidNonWhitelisted: true,
      }),
    );
    jwt = moduleRef.get(JwtService);
    await app.init();
  });

  beforeEach(() => {
    mediaDaTurma.mockReset();
    mediaDaTurma.mockResolvedValue({ media: 4.5, avaliacoes: 3 });
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (role: string) =>
    jwt.sign(
      { sub: 'u1', role, companyId: EMPRESA },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  const ler = (role: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/me/classes/${TURMA}/avaliacao`)
      .set('Authorization', `Bearer ${token(role)}`);

  it('professor recebe 403, e o serviço nem é chamado', async () => {
    await ler('professor').expect(403);
    expect(mediaDaTurma).not.toHaveBeenCalled();
  });

  it('aluno continua recebendo a média', async () => {
    const res = await ler('aluno').expect(200);
    expect(res.body).toEqual({ media: 4.5, avaliacoes: 3 });
    expect(mediaDaTurma).toHaveBeenCalledWith(EMPRESA, TURMA);
  });

  it('gestor não passa a ter a rota por consequência', async () => {
    // A lista com autoria e comentário é outra rota (`GET /classes/:id/avaliacoes`).
    // Fechar para o professor não pode abrir esta para o `company_admin`.
    await ler('company_admin').expect(403);
    expect(mediaDaTurma).not.toHaveBeenCalled();
  });
});
