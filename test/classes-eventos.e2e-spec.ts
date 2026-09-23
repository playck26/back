import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClassesController } from '../src/classes/classes.controller';
import { ClassesService } from '../src/classes/classes.service';
import { FrequenciaService } from '../src/frequencia/frequencia.service';
import { AvaliacaoDeAulaService } from '../src/classes/avaliacao-de-aula.service';
import { PresencaService } from '../src/classes/presenca.service';
import { JwtAccessStrategy } from '../src/auth/strategies/jwt-access.strategy';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * SPEC-069/AC-007 — **o extrato administrativo não vaza para o aluno.**
 *
 * ## Por que esta prova é HTTP, e não de serviço
 *
 * A INV-069e é sustentada pelo `CompanyAdminGuard` do topo do
 * `ClassesController` — **só aplicação**, como a matriz de falha da spec diz
 * com todas as letras. Guard não roda quando alguém chama o serviço direto:
 * uma prova de serviço mediria o serviço, que nunca foi o mecanismo.
 *
 * O serviço aqui é dublê **de propósito**, e é isso que torna a prova
 * honesta: se a requisição do aluno chegasse ao serviço, o dublê responderia
 * `200` com o extrato. O que se afirma, então, não é só o código — é que o
 * serviço **não foi chamado**.
 *
 * ## O que ela não prova
 *
 * O 404 cross-empresa. Esse é do `{ id, companyId }` do serviço (D7), e está
 * em `test/banco/spec-069-eventos-de-turma.db-spec.ts` com banco de verdade.
 * Trocar o guard da classe por `RolesGuard` — a única forma conhecida de
 * contornar isto — abriria **as outras rotas** do controller, que não têm
 * `@Roles`; está na matriz de falha da spec.
 */

const SEGREDO = 'segredo-de-teste-eventos-069';
const EMPRESA = '11111111-1111-4111-8111-111000690001';
const TURMA = '33333333-3333-4333-8333-333000690003';

const EXTRATO = [
  {
    tipo: 'professor_alterado',
    em: '2026-09-23T12:00:00.000Z',
    acao: 'turma_professor_alterado',
    motivo: null,
    autor: { id: '44444444-4444-4444-8444-444000690004', nome: 'Admin' },
  },
];

describe('GET /classes/:id/eventos (e2e) — SPEC-069', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let eventosDaTurma: jest.Mock;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SEGREDO;
    eventosDaTurma = jest.fn();

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
      controllers: [ClassesController],
      providers: [
        JwtAccessStrategy,
        { provide: ClassesService, useValue: { eventosDaTurma } },
        { provide: PresencaService, useValue: {} },
        { provide: FrequenciaService, useValue: {} },
        { provide: AvaliacaoDeAulaService, useValue: {} },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
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
    eventosDaTurma.mockReset();
    eventosDaTurma.mockResolvedValue(EXTRATO);
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (role: string) =>
    jwt.sign(
      { sub: 'u1', role, companyId: EMPRESA },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  const pedir = (role: string) =>
    request(app.getHttpServer())
      .get(`/api/v1/classes/${TURMA}/eventos`)
      .set('Authorization', `Bearer ${token(role)}`);

  it('o gestor recebe 200 e o extrato como o serviço o devolveu', async () => {
    const resposta = await pedir('company_admin').expect(200);

    expect(resposta.body).toEqual(EXTRATO);
    expect(eventosDaTurma).toHaveBeenCalledWith(EMPRESA, TURMA);
  });

  it('AC-007: o aluno recebe 403, e o serviço NÃO é chamado', async () => {
    await pedir('aluno').expect(403);
    expect(eventosDaTurma).not.toHaveBeenCalled();
  });

  it('AC-007: o professor recebe 403, e o serviço NÃO é chamado', async () => {
    await pedir('professor').expect(403);
    expect(eventosDaTurma).not.toHaveBeenCalled();
  });

  it('sem token, 401 — e a rota não é exceção da classe', async () => {
    await request(app.getHttpServer())
      .get(`/api/v1/classes/${TURMA}/eventos`)
      .expect(401);
    expect(eventosDaTurma).not.toHaveBeenCalled();
  });
});
