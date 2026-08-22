// Mock de PrismaService compartilhado pelas suítes e2e (TEST-001,
// TEST-002) — mesmo espírito dos mocks usados nos testes unitários
// (ex. courts.service.spec.ts), mas abrangendo os modelos que a camada
// HTTP completa (guards + controllers + services) pode tocar numa
// requisição real via Supertest. `tx` representa o client dentro de
// `$transaction(async (tx) => ...)`, usado por AuthService.registerAluno
// e CompaniesService.create.

export interface TxMock {
  usuario: { create: jest.Mock; update: jest.Mock };
  aluno: { create: jest.Mock };
  // SPEC-009: `trocarSenha` revoga as sessões dentro da transação.
  refreshToken: { updateMany: jest.Mock };
  // `findUnique` entrou em SPEC-009:TASK-000: `CompaniesService.create`
  // gera `slug` único e checa colisão dentro da própria transação.
  empresa: { create: jest.Mock; findUnique: jest.Mock };
}

export interface PrismaMock {
  usuario: {
    findUnique: jest.Mock;
    findUniqueOrThrow: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  empresa: {
    findUnique: jest.Mock;
    findMany: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    update: jest.Mock;
  };
  refreshToken: {
    create: jest.Mock;
    findUnique: jest.Mock;
    updateMany: jest.Mock;
  };
  aluno: {
    create: jest.Mock;
  };
  tx: TxMock;
  $transaction: jest.Mock;
}

export function buildPrismaMock(): PrismaMock {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn() },
    aluno: { create: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
    empresa: {
      create: jest.fn(),
      // Padrão: nenhum slug colidindo.
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };

  const mock: PrismaMock = {
    usuario: {
      findUnique: jest.fn(),
      findUniqueOrThrow: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    empresa: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    refreshToken: {
      create: jest.fn(),
      findUnique: jest.fn(),
      updateMany: jest.fn(),
    },
    aluno: {
      create: jest.fn(),
    },
    tx,
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };

  return mock;
}
