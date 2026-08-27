import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import { ClassesController } from '../src/classes/classes.controller';
import { MeTeacherClassesController } from '../src/classes/me-teacher-classes.controller';
import { ClassesService } from '../src/classes/classes.service';
import { FrequenciaService } from '../src/frequencia/frequencia.service';
import { PresencaService } from '../src/classes/presenca.service';
import { JwtAccessStrategy } from '../src/auth/strategies/jwt-access.strategy';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * SPEC-019/TASK-002 — o contrato de turma por HTTP.
 *
 * ## Este arquivo nasceu de um vão, e o vão é que ele não existia
 *
 * Ao terminar a TASK-002, a suíte e2e passou **174/174 sem uma linha
 * alterada** — depois de eu quebrar de propósito o contrato de cinco rotas de
 * turma. Fui conferir: **nenhuma e2e tocava `/api/v1/classes`.** A camada HTTP
 * da rota que esta spec inteira existe para mudar nunca tinha sido testada.
 *
 * Suíte que continua verde depois de uma quebra intencional não está
 * aprovando a mudança; está dizendo que não olha para ela.
 *
 * ## O que SÓ aparece aqui
 *
 * **Que a validação aninhada roda de verdade.** `encontros[]` é validado por
 * `@ValidateNested` + `@Type`, e isso **só funciona com `transform: true`** no
 * `ValidationPipe`. Sem ele, o array chega como objeto cru, os decorators de
 * `EncontroDto` não rodam, e `diaSemana: 99` entra sem reclamar — a turma
 * seria criada e geraria zero ocupações.
 *
 * Por isso o pipe aqui é **idêntico ao do `main.ts`**, e não o
 * `{ whitelist: true }` que outras e2e usam. Um teste que valida com pipe
 * diferente do de produção prova o pipe do teste.
 *
 * **E que a quebra é limpa.** Mandar o formato ANTIGO
 * (`diaSemana`/`horaInicio`/`horaFim` soltos) tem de ser recusado, não
 * ignorado em silêncio — `forbidNonWhitelisted` é o que separa "o cliente
 * antigo recebe erro" de "o cliente antigo cria turma sem recorrência".
 *
 * O serviço é dublê de propósito: as regras têm prova própria em
 * `classes.service.spec.ts` e `encontros.spec.ts`. O que se prova aqui é o
 * que chega ao serviço, e o que o cliente recebe de volta.
 */

const SEGREDO = 'segredo-de-teste-classes';
const EMPRESA = '11111111-1111-4111-8111-111000190001';
const QUADRA = '22222222-2222-4222-8222-222000190002';
const TURMA = '33333333-3333-4333-8333-333000190003';

const ENCONTRO_VALIDO = {
  diaSemana: 2,
  horaInicio: '18:00',
  horaFim: '19:00',
};

describe('turmas (e2e) — SPEC-019', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  let classesMock: {
    create: jest.Mock;
    update: jest.Mock;
    list: jest.Mock;
    findOne: jest.Mock;
    allocateStudent: jest.Mock;
    removeStudent: jest.Mock;
    listPresencas: jest.Mock;
    myTeachingClasses: jest.Mock;
    myTeachingClassDetail: jest.Mock;
  };

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SEGREDO;

    classesMock = {
      create: jest.fn(),
      update: jest.fn(),
      list: jest.fn(),
      findOne: jest.fn(),
      allocateStudent: jest.fn(),
      removeStudent: jest.fn(),
      listPresencas: jest.fn(),
      myTeachingClasses: jest.fn(),
      myTeachingClassDetail: jest.fn(),
    };

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
      controllers: [ClassesController, MeTeacherClassesController],
      providers: [
        JwtAccessStrategy,
        { provide: ClassesService, useValue: classesMock },
        { provide: PresencaService, useValue: { listar: jest.fn() } },
        { provide: FrequenciaService, useValue: { relatorio: jest.fn() } },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    // **IDÊNTICO ao `main.ts`.** Ver o cabeçalho: `transform: true` é o que
    // faz `@ValidateNested` rodar, e `forbidNonWhitelisted` é o que recusa o
    // formato antigo em vez de ignorá-lo.
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
    Object.values(classesMock).forEach((m) => m.mockReset());
    classesMock.create.mockResolvedValue({ id: TURMA });
    classesMock.update.mockResolvedValue({ id: TURMA });
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (role: string) =>
    jwt.sign(
      { sub: 'u1', role, companyId: EMPRESA },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  const criar = (corpo: Record<string, unknown>) =>
    request(app.getHttpServer())
      .post('/api/v1/classes')
      .set('Authorization', `Bearer ${token('company_admin')}`)
      .send(corpo);

  const CORPO_BASE = {
    nome: 'Turma A',
    quadraId: QUADRA,
    capacidade: 6,
  };

  describe('POST /classes — o formato novo', () => {
    it('aceita UM encontro', async () => {
      await criar({ ...CORPO_BASE, encontros: [ENCONTRO_VALIDO] }).expect(201);

      const dto = (classesMock.create.mock.calls[0] as unknown[])[1] as {
        encontros: unknown[];
      };
      expect(dto.encontros).toHaveLength(1);
    });

    it('aceita TRÊS encontros, e chegam ao serviço na ordem enviada', async () => {
      // É o pedido que originou a spec: a turma treina em mais de um dia.
      const encontros = [
        { diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' },
        { diaSemana: 3, horaInicio: '18:00', horaFim: '19:30' },
        { diaSemana: 6, horaInicio: '09:00', horaFim: '10:00' },
      ];

      await criar({ ...CORPO_BASE, encontros }).expect(201);

      expect((classesMock.create.mock.calls[0] as unknown[])[1]).toMatchObject({
        encontros,
      });
    });
  });

  describe('a quebra de contrato é LIMPA', () => {
    it('o formato ANTIGO é recusado, não ignorado', async () => {
      // Sem `forbidNonWhitelisted`, estes três campos seriam descartados em
      // silêncio e a requisição cairia em "encontros ausente" — o cliente
      // antigo receberia um erro sobre um campo que ele nem sabe que existe.
      const res = await criar({
        ...CORPO_BASE,
        diaSemana: 2,
        horaInicio: '18:00',
        horaFim: '19:00',
      });

      expect(res.status).toBe(400);
      expect(classesMock.create).not.toHaveBeenCalled();
    });

    it('e o erro NOMEIA os campos que saíram', async () => {
      // Um 400 genérico faria o dono do cliente antigo abrir o código do
      // servidor para descobrir o que mudou.
      const res = await criar({ ...CORPO_BASE, diaSemana: 2 });

      expect(JSON.stringify(res.body)).toContain('diaSemana');
    });
  });

  describe('a validação ANINHADA roda de verdade', () => {
    it('dia fora do intervalo é recusado', async () => {
      // **Este é o teste que prova `transform: true`.** Sem ele, o array
      // chega como objeto cru, os decorators de `EncontroDto` não rodam, e
      // `diaSemana: 9` entra — a turma seria criada e geraria ZERO
      // ocupações, aparecendo como "a aula não existe na agenda".
      const res = await criar({
        ...CORPO_BASE,
        encontros: [{ ...ENCONTRO_VALIDO, diaSemana: 9 }],
      });

      expect(res.status).toBe(400);
      expect(classesMock.create).not.toHaveBeenCalled();
    });

    it('hora fora do formato HH:mm é recusada', async () => {
      const res = await criar({
        ...CORPO_BASE,
        encontros: [{ ...ENCONTRO_VALIDO, horaInicio: '18h' }],
      });

      expect(res.status).toBe(400);
    });

    it('e o encontro INVÁLIDO no meio da lista também é pego', async () => {
      // `{ each: true }` valida todos, não só o primeiro. Sem ele, uma lista
      // com o primeiro bom passaria inteira.
      const res = await criar({
        ...CORPO_BASE,
        encontros: [
          ENCONTRO_VALIDO,
          { ...ENCONTRO_VALIDO, diaSemana: 42 },
          ENCONTRO_VALIDO,
        ],
      });

      expect(res.status).toBe(400);
    });

    it('campo a mais DENTRO do encontro é recusado', async () => {
      const res = await criar({
        ...CORPO_BASE,
        encontros: [{ ...ENCONTRO_VALIDO, duracao: 60 }],
      });

      expect(res.status).toBe(400);
    });
  });

  describe('PATCH /classes/:id', () => {
    it('sem `encontros` o serviço recebe `undefined`, e não uma lista', async () => {
      // Renomear não pode regerar oito ocupações.
      //
      // **Armadilha que este teste descobriu:** com `transform: true` o
      // `class-transformer` instancia o DTO, e as propriedades opcionais
      // passam a EXISTIR com valor `undefined`. A primeira versão deste teste
      // usava `not.toHaveProperty('encontros')` e falhou — a chave está lá.
      //
      // Por isso o serviço compara `dto.encontros !== undefined`, e não
      // `'encontros' in dto`. A segunda forma diria "mudou a recorrência" em
      // toda edição de nome.
      await request(app.getHttpServer())
        .patch(`/api/v1/classes/${TURMA}`)
        .set('Authorization', `Bearer ${token('company_admin')}`)
        .send({ nome: 'Novo nome' })
        .expect(200);

      const dto = (classesMock.update.mock.calls[0] as unknown[])[2] as {
        encontros?: unknown;
      };
      expect(dto.encontros).toBeUndefined();
    });

    it('lista VAZIA chega ao serviço — é ele quem recusa, com código', async () => {
      // AC-003. A quantidade mínima NÃO é `@ArrayMinSize`: a INV-051 tem
      // código próprio (`TURMA_SEM_ENCONTRO`), e o pipe devolveria 400
      // genérico onde a spec pede 422 com código.
      //
      // **É o caminho real de chegar a zero:** remover o último encontro pela
      // tela manda uma lista vazia.
      await request(app.getHttpServer())
        .patch(`/api/v1/classes/${TURMA}`)
        .set('Authorization', `Bearer ${token('company_admin')}`)
        .send({ encontros: [] })
        .expect(200);

      expect((classesMock.update.mock.calls[0] as unknown[])[2]).toMatchObject({
        encontros: [],
      });
    });
  });

  describe('GET /me/teacher/classes/:id — a rota do BLOQUEADOR 1', () => {
    it('existe, e devolve o que o serviço deu', async () => {
      // A 1ª versão da SPEC-019 esquecia esta rota no contrato. A lista do
      // professor seria atualizada e o detalhe continuaria devolvendo campos
      // removidos — tela branca no app do professor.
      classesMock.myTeachingClassDetail.mockResolvedValue({
        id: TURMA,
        nome: 'Infantil A',
        encontros: [ENCONTRO_VALIDO],
        quadraNome: 'Quadra 1',
        nivelNome: null,
        capacidade: 6,
        alunos: [],
      });

      const res = await request(app.getHttpServer())
        .get(`/api/v1/me/teacher/classes/${TURMA}`)
        .set('Authorization', `Bearer ${token('professor')}`)
        .expect(200);

      const corpo = res.body as { encontros: unknown[] };
      expect(corpo.encontros).toEqual([ENCONTRO_VALIDO]);
      expect(res.body).not.toHaveProperty('diaSemana');
    });
  });
});
