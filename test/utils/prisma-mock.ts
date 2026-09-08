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
  // SPEC-033/TASK-004: a acao administrativa nasce DENTRO da transacao do
  // lancamento, antes do movimento — `movimentos_acao_fkey` a exige.
  acaoAdministrativa: { create: jest.Mock };
  movimentoDeCredito: { create: jest.Mock };
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
  /**
   * SPEC-031 — **duas famílias de leitura crua passam por aqui.**
   *
   * A falta avisada (REQ-006) trava `alunos` e a ocorrência por SQL cru; e
   * `cancelBooking`/`updatePaymentStatus` leem a ocupação com
   * `SELECT … FOR UPDATE`, que o query builder do Prisma não expressa — o
   * segundo ainda relê a linha inteira DENTRO da transação.
   *
   * É **um** `$queryRaw` para as duas, e ele decide pela FORMA da query. Os
   * dublês de `ocupacaoQuadra` **delegam ao `findFirst` de cima**, para os
   * testes continuarem armando um lugar só: com três lugares para armar, a
   * primeira divergência entre eles vira um teste que passa por acaso.
   */
  $queryRaw: jest.Mock;
  ocupacaoQuadra: { findFirstOrThrow: jest.Mock; update: jest.Mock };
  turmaAluno: { findFirst: jest.Mock };
  faltaAvisada: { createMany: jest.Mock; deleteMany: jest.Mock };
  configOperacaoEmpresa: { findUnique: jest.Mock };
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
  // SPEC-031/TASK-003: os dois prazos de cancelamento. `upsert` porque a
  // primeira gravacao cria a linha e as demais a substituem — `PUT` e
  // substituicao total.
  configOperacaoEmpresa: { findUnique: jest.Mock; upsert: jest.Mock };
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
    // SPEC-033: o extrato le o saldo (derivado pela trigger, D1) e a rota
    // de lancamento o rele depois de escrever.
    findFirst: jest.Mock;
    findUnique: jest.Mock;
  };
  movimentoDeCredito: { findMany: jest.Mock };
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
    acaoAdministrativa: {
      create: jest.fn().mockResolvedValue({ id: 'acao-credito' }),
    },
    movimentoDeCredito: {
      create: jest.fn().mockResolvedValue({ id: 'movimento-1' }),
    },
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
    // Padrão da falta avisada: aluno existe, está matriculado, a ocorrência
    // é de turma e não está cancelada. Quem testa a recusa sobrescreve.
    $queryRaw: jest.fn(),
    ocupacaoQuadra: { findFirstOrThrow: jest.fn(), update: jest.fn() },
    turmaAluno: { findFirst: jest.fn().mockResolvedValue({ id: 'm1' }) },
    faltaAvisada: {
      createMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    configOperacaoEmpresa: { findUnique: jest.fn().mockResolvedValue(null) },
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
    // SPEC-031: padrao e "empresa sem configuracao" — que e o estado da
    // maioria hoje, e o que a AC-003 descreve.
    configOperacaoEmpresa: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
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
      // Padrao: aluno existe, saldo zero. Quem testa saldo sobrescreve.
      findFirst: jest.fn().mockResolvedValue({ saldoCreditos: 0 }),
      findUnique: jest.fn().mockResolvedValue({ saldoCreditos: 0 }),
    },
    movimentoDeCredito: { findMany: jest.fn().mockResolvedValue([]) },
    tx,
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };

  /**
   * A ponte da leitura travada, montada DEPOIS de `mock` porque precisa dele.
   *
   * `updatePaymentStatus` e `cancelBooking` leem a ocupacao com
   * `SELECT … FOR UPDATE` (raw) e, no primeiro caso, releem a linha inteira
   * dentro da mesma transacao. Os testes continuam armando **so**
   * `prisma.ocupacaoQuadra.findFirst`, e estas duas linhas fazem o resto
   * derivar dali — sem isso, cada teste teria de armar tres lugares e a
   * primeira divergencia entre eles viraria um teste que passa por acaso.
   */
  tx.ocupacaoQuadra.findFirstOrThrow.mockImplementation(async () => {
    const linha: unknown = await mock.ocupacaoQuadra.findFirst();
    if (!linha) throw new Error('P2025');
    return linha;
  });
  tx.ocupacaoQuadra.update.mockImplementation(
    (args: { data?: unknown }): unknown =>
      mock.ocupacaoQuadra.update(args) as unknown,
  );

  tx.$queryRaw.mockImplementation(async (strings: TemplateStringsArray) => {
    const sql = strings.join('');
    /**
     * **DEF-VC031-02 — o mock NAO pode ramificar pelo predicado que a
     * sabotagem remove.**
     *
     * A versão anterior distinguia as duas famílias por `origem_turma_id`:
     * a de `courts` não menciona, a da falta menciona. Parecia esperto e era
     * armadilha — a sabotagem **S8** remove exatamente esse predicado, então
     * a consulta da falta caía no ramo de `courts`, devolvia outra linha, e o
     * e2e falhava com `404` onde esperava `204`.
     *
     * **O CI ficava vermelho pelo motivo errado**, e a evidência dizia
     * "turma A alcança a ocorrência de B" quando o que ela mostrava era o
     * mock trocando de ramo. Achado pela validação cruzada de 2026-09-06.
     *
     * O critério agora é a **comparação `origem_tipo = 'TURMA'`**, que só a
     * consulta da falta faz e que **nenhuma sabotagem desta spec remove** — a
     * S8 tira `origem_turma_id` e deixa `origem_tipo` de pé.
     *
     * Projetar `status_pagamento` não serve como critério: as DUAS famílias
     * projetam (foi a primeira tentativa deste conserto, e ela quebrou o e2e
     * da falta na hora).
     */
    const ehDaFaltaAvisada =
      sql.includes('origem_tipo') && sql.includes("'TURMA'");
    if (!ehDaFaltaAvisada && sql.includes('ocupacoes_quadra')) {
      const linha = (await mock.ocupacaoQuadra.findFirst()) as {
        id: string;
        companyId?: string;
        alunoId?: string | null;
        origemTipo?: string;
        statusPagamento?: string;
        data?: Date;
        horaInicio?: Date;
      } | null;
      return linha
        ? [
            {
              id: linha.id,
              company_id: linha.companyId ?? 'c1',
              aluno_id: linha.alunoId ?? null,
              origem_tipo: linha.origemTipo,
              status_pagamento: linha.statusPagamento,
              data: linha.data,
              hora_inicio: linha.horaInicio,
            },
          ]
        : [];
    }
    // A consulta da falta avisada: `alunos FOR KEY SHARE`, e a ocorrência
    // filtrada por `origem_turma_id` — que é o que a distingue da de cima.
    if (sql.includes('FROM alunos')) {
      return [{ id: 'aluno-1' }];
    }
    return [
      {
        id: 'oc-1',
        status_pagamento: 'pendente_pagamento',
        data: new Date('2099-01-01T00:00:00.000Z'),
        hora_inicio: new Date('1970-01-01T19:00:00.000Z'),
      },
    ];
  });

  return mock;
}
