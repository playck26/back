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
 * SPEC-057/TASK-002/D12/AC-017 — **a média da turma saiu do aluno, e a rota
 * saiu depois.**
 *
 * Histórico, para quem chegar aqui pelo nome do arquivo: a SPEC-025 abriu
 * `GET /me/classes/:id/avaliacao` para aluno e professor; a SPEC-052/D6 fechou
 * para o professor; a SPEC-057/TASK-002 tirou a nota da tela do aluno e, pela
 * ordem de uma contração, **só removeu a rota depois que o Cliente que parou de
 * pedi-la estava no ar** (publicado em 2026-09-17, conferido pelo bundle).
 *
 * A AC-017 pede **ausência e 404**, e não 403 de rota mantida: um `@Roles`
 * vazio deixaria o contrato publicado prometendo uma rota que ninguém pode
 * chamar. E pede também que o `PUT` de avaliar continue: o aluno avalia, o
 * gestor lê pela lista dele.
 */

const SEGREDO = 'segredo-de-teste-media-por-papel';
const EMPRESA = '11111111-1111-4111-8111-111000520001';
const TURMA = '33333333-3333-4333-8333-333000520003';
const AULA = '44444444-4444-4444-8444-444000520004';

describe('média da turma removida do aluno (e2e) — SPEC-057/AC-017', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  const avaliar = jest.fn();

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
        { provide: AvaliacaoDeAulaService, useValue: { avaliar } },
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
    avaliar.mockReset();
    avaliar.mockResolvedValue({
      nota: 5,
      comentario: null,
      updatedAt: new Date('2026-09-17T12:00:00.000Z'),
    });
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (role: string) =>
    jwt.sign(
      { sub: 'u1', role, companyId: EMPRESA },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  it.each(['aluno', 'professor', 'company_admin'])(
    'AC-017: GET da média responde 404 para %s — a rota não existe mais',
    async (role) => {
      await request(app.getHttpServer())
        .get(`/api/v1/me/classes/${TURMA}/avaliacao`)
        .set('Authorization', `Bearer ${token(role)}`)
        .expect(404);
    },
  );

  it('AC-017: o PUT de avaliar a aula continua sendo do aluno', async () => {
    await request(app.getHttpServer())
      .put(`/api/v1/me/classes/aulas/${AULA}/avaliacao`)
      .set('Authorization', `Bearer ${token('aluno')}`)
      .send({ nota: 5 })
      .expect(200);

    expect(avaliar).toHaveBeenCalledWith(EMPRESA, 'u1', AULA, {
      nota: 5,
      comentario: undefined,
    });
  });
});
