// Mock de PrismaService compartilhado pelas suítes e2e (TEST-001,
// TEST-002) — mesmo espírito dos mocks usados nos testes unitários
// (ex. courts.service.spec.ts), mas abrangendo os modelos que a camada
// HTTP completa (guards + controllers + services) pode tocar numa
// requisição real via Supertest. `tx` representa o client dentro de
// `$transaction(async (tx) => ...)`, usado por AuthService.registerAluno
// e CompaniesService.create.

export interface TxMock {
  // `findUnique` entrou com SPEC-009: o aceite de convite checa e-mail
  // duplicado **dentro** da transação, para a claim do convite voltar
  // atrás junto se o cadastro não puder ser concluído.
  usuario: { create: jest.Mock; update: jest.Mock; findUnique: jest.Mock };
  aluno: { create: jest.Mock };
  // SPEC-009: `trocarSenha` revoga as sessões dentro da transação.
  refreshToken: { updateMany: jest.Mock };
  // SPEC-009/INV-009: o aceite reivindica a linha do convite e só então
  // cria a conta — as duas escritas na mesma transação.
  conviteAluno: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  // `findUnique` entrou em SPEC-009:TASK-000: `CompaniesService.create`
  // gera `slug` único e checa colisão dentro da própria transação.
  empresa: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  // SPEC-010: empresa nova nasce com o horário padrão dos 7 dias, na mesma
  // transação da criação.
  horarioFuncionamento: { createMany: jest.Mock };
  // SPEC-020/TASK-008: editar a empresa sincroniza o catálogo de esportes
  // DENTRO da transação — sincronizar e gravar acontecem juntos ou não
  // acontecem.
  esporteDeQuadra: {
    findMany: jest.Mock;
    create: jest.Mock;
    deleteMany: jest.Mock;
  };
  quadra: { findMany: jest.Mock };
}

export interface PrismaMock {
  usuario: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    // SPEC-016: a busca do gestor amarra id + empresa + papel no WHERE, e
    // devolve null (404) em vez de confirmar que o id existe.
    findFirst: jest.Mock;
    findMany: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  empresa: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
    // DEF-004: o interruptor de auto-cadastro escreve por `updateMany`
    // filtrando pelo company_id do token, nunca por id vindo do cliente.
    updateMany: jest.Mock;
  };
  refreshToken: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  aluno: {
    create: jest.Mock;
  };
  // SPEC-012: a agenda é leitura agregada sobre estes modelos.
  ocupacaoQuadra: {
    groupBy: jest.Mock;
    findMany: jest.Mock;
    // SPEC-041 — `count` entrou porque `GET /bookings` nunca tinha sido
    // exercitada por e2e: a rota pagina desde a SPEC-027, e a contagem é
    // metade do que ela promete.
    count: jest.Mock;
    findFirst: jest.Mock;
    update: jest.Mock;
  };
  quadra: { findMany: jest.Mock; findFirst: jest.Mock };
  horarioFuncionamento: { findMany: jest.Mock };
  conviteAluno: {
    create: jest.Mock;
    findUnique: jest.Mock;
  };
  tx: TxMock;
  $transaction: jest.Mock;
}

export function buildPrismaMock(): PrismaMock {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn(), findUnique: jest.fn() },
    aluno: { create: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
    conviteAluno: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    horarioFuncionamento: {
      createMany: jest.fn().mockResolvedValue({ count: 7 }),
    },
    empresa: {
      create: jest.fn(),
      // Padrão: nenhum slug colidindo.
      findUnique: jest.fn().mockResolvedValue(null),
      // SPEC-020/TASK-008 — a resposta de empresa deriva `esportes` da
      // relação, e o serviço não tolera a relação ausente de propósito.
      update: jest.fn().mockResolvedValue({ esportesQuadra: [] }),
    },
    // Padrão: catálogo vazio e nenhuma quadra usando nada. Quem testa
    // remoção ou uso sobrescreve.
    esporteDeQuadra: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    quadra: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const mock: PrismaMock = {
    usuario: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    empresa: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    conviteAluno: {
      create: jest.fn(),
      findUnique: jest.fn(),
    },
    ocupacaoQuadra: {
      groupBy: jest.fn().mockResolvedValue([]),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    quadra: {
      findMany: jest.fn().mockResolvedValue([{ id: 'q1' }]),
      findFirst: jest.fn(),
    },
    horarioFuncionamento: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    aluno: {
      create: jest.fn(),
    },
    tx,
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };

  return mock;
}
