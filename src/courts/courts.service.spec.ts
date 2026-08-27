import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StudentsService } from '../people/students.service';
import { formatTimeOnly, parseDateOnly, parseTimeOnly } from './date-time.util';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import type { ImagemDaQuadraService } from './imagem-da-quadra.service';
import { PrismaService } from '../prisma/prisma.service';
import { CourtsService } from './courts.service';

// TEST-005 (SPEC-004): unit tests de MOD-005 com Prisma mockado. FIT-001
// (concorrência real, INV-001) exige banco vivo — validado à parte via
// GitHub Actions (ver STATUS.md/TEST_PLAN.md), não reproduzível aqui.

function buildPrismaMock() {
  return {
    quadra: {
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    aluno: {
      findFirst: jest.fn(),
    },
    // SPEC-020/TASK-003: a quadra passou a referenciar o catálogo, e o
    // serviço confere a opção antes de gravar.
    esporteDeQuadra: { findFirst: jest.fn() },
    categoriaDeQuadra: { findFirst: jest.fn() },
    ocupacaoQuadra: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
    // SPEC-011: a criação passou a ser transacional — um pedido pode gerar
    // vários blocos, e metade criada seria pior que nenhum.
    pedidoReserva: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    $transaction: jest.fn(),
  } as unknown as PrismaService;
}

const QUADRA_ATIVA = {
  id: 'q1',
  companyId: 'c1',
  nome: 'Quadra 1',
  esporte: 'tenis',
  precoHora: new Prisma.Decimal(100),
  status: 'ativa',
  createdAt: new Date(),
};

// SPEC-009/INV-010: MOD-004 e MOD-005 perguntam a MOD-003 se o aluno está
// aprovado. O mock devolve "aprovado" por padrão; os testes de vínculo
// sobrescrevem para provar o bloqueio.
// SPEC-010: por padrão, quadra aberta 06:00–22:00 — o mesmo comportamento
// de antes da spec, para que os testes existentes continuem descrevendo o
// que descreviam. Os testes de horário sobrescrevem.
function buildHorariosMock() {
  const real = new HorarioFuncionamentoService({} as unknown as PrismaService);
  const abertoPadrao = {
    estado: 'aberto' as const,
    horaInicio: parseTimeOnly('06:00'),
    horaFim: parseTimeOnly('22:00'),
  };
  return {
    resolver: jest.fn().mockResolvedValue(abertoPadrao),
    resolverParaData: jest.fn().mockResolvedValue(abertoPadrao),
    // DEF-013: `registerClassOccupancy` deixou de perguntar por ocorrência e
    // passou a carregar as linhas uma vez. Sem linha nenhuma, a rede de
    // segurança de `resolverDeLinhas` devolve 06:00–22:00 — o mesmo
    // `abertoPadrao` de antes, agora pela regra real em vez de por um dublê.
    carregarLinhas: jest.fn().mockResolvedValue([]),
    // Geração de slots, herança e checagem de borda são puras: usa-se a
    // implementação real, senão o teste provaria o mock, não o código.
    gerarSlots: real.gerarSlots.bind(real),
    resolverDeLinhas: real.resolverDeLinhas.bind(real),
    dentroDoExpediente: real.dentroDoExpediente.bind(real),
  } as unknown as HorarioFuncionamentoService;
}

/**
 * SPEC-011: `createBooking` devolve objeto quando o pedido veio no formato
 * antigo (uma hora) e `{ reservas: [...] }` quando veio `slots`. Este
 * helper deixa os testes do formato antigo continuarem legíveis, em vez de
 * espalhar `as` por eles.
 */
function comoReserva(resultado: unknown) {
  return resultado as { id: string; statusPagamento: string };
}

function buildStudentsMock() {
  return {
    garantirVinculoAprovado: jest.fn(),
    exigirVinculoAprovado: jest.fn().mockResolvedValue(undefined),
  } as unknown as StudentsService;
}

describe('CourtsService', () => {
  let prisma: PrismaService;
  let service: CourtsService;
  let studentsService: StudentsService;
  let horarios: HorarioFuncionamentoService;
  let imagens: ImagemDaQuadraService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    // O `tx` é o próprio mock: os testes conferem as chamadas em
    // `prisma.ocupacaoQuadra.create`, dentro ou fora da transação.
    (prisma.$transaction as unknown as jest.Mock).mockImplementation(
      (cb: (tx: PrismaService) => unknown) => cb(prisma),
    );
    studentsService = buildStudentsMock();
    horarios = buildHorariosMock();
    // SPEC-018/TASK-005: o resolvedor de imagem entra como dublê. Estes
    // testes são de agenda/reserva, não de mídia — o que eles precisam é
    // que `toQuadraResponse` consiga responder, e a prova da resolução
    // mora em `imagem-da-quadra.service.spec.ts`.
    imagens = {
      resolver: jest.fn(() => ({ imagemUrl: null })),
    } as unknown as ImagemDaQuadraService;
    service = new CourtsService(prisma, studentsService, horarios, imagens);
  });

  describe('create/list/update', () => {
    it('cria quadra escopada à empresa', async () => {
      const ESPORTE = '11111111-1111-4111-8111-111000200099';
      (prisma.esporteDeQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: ESPORTE,
        nome: 'tenis',
      });
      (prisma.quadra.create as jest.Mock).mockResolvedValue(QUADRA_ATIVA);

      const result = await service.create('c1', {
        nome: 'Quadra 1',
        esporteId: ESPORTE,
        precoHora: 100,
      });

      const chamadas = (prisma.quadra.create as jest.Mock).mock.calls as [
        { data: Record<string, unknown> },
      ][];
      const chamada = chamadas[0][0];

      expect(chamada.data).toMatchObject({
        companyId: 'c1',
        nome: 'Quadra 1',
        esporteId: ESPORTE,
        precoHora: 100,
      });
      // **Este teste inverteu na TASK-004.** Ele guardava a escrita dupla:
      // `quadras.esporte` era NOT NULL, e parar de escrevê-la quebraria a
      // criação na primeira requisição. A contract derrubou a coluna, e
      // agora escrever nela é que quebraria — o Prisma recusa argumento
      // desconhecido.
      expect(chamada.data).not.toHaveProperty('esporte');
      expect(result.precoHora).toBe(100);
    });

    it('a RESPOSTA traz esporte e categoria como OBJETO, não texto', async () => {
      // **Este teste nasceu de uma sabotagem que passou.** Trocar
      // `quadra.esporteRef ?? null` por `quadra.esporte` — ou seja, voltar
      // a devolver o texto cru — deixava os 43 testes verdes. Nada olhava
      // para a forma da resposta, que é justamente o que esta task muda e
      // o que os três clientes vão consumir.
      const ESPORTE = '11111111-1111-4111-8111-111000200099';
      (prisma.esporteDeQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: ESPORTE,
        nome: 'tenis',
      });
      (prisma.quadra.create as jest.Mock).mockResolvedValue({
        ...QUADRA_ATIVA,
        esporteRef: { id: ESPORTE, nome: 'tenis' },
        categoriaRef: { id: 'cat-1', nome: 'Saibro' },
      });

      const r = await service.create('c1', {
        nome: 'Q',
        esporteId: ESPORTE,
        precoHora: 100,
      });

      expect(r.esporte).toEqual({ id: ESPORTE, nome: 'tenis' });
      expect(r.categoria).toEqual({ id: 'cat-1', nome: 'Saibro' });
      // E o texto cru NÃO sai: montar filtro a partir dele é o defeito que
      // a SPEC-020 veio desfazer.
      expect(typeof r.esporte).not.toBe('string');
    });

    it('quadra sem categoria devolve `null`, não o campo ausente', async () => {
      // `null` é o estado normal — nem todo clube classifica piso. Campo
      // ausente obrigaria cada cliente a decidir o que fazer com
      // `undefined`.
      const ESPORTE = '11111111-1111-4111-8111-111000200099';
      (prisma.esporteDeQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: ESPORTE,
        nome: 'tenis',
      });
      (prisma.quadra.create as jest.Mock).mockResolvedValue({
        ...QUADRA_ATIVA,
        esporteRef: { id: ESPORTE, nome: 'tenis' },
        categoriaRef: null,
      });

      const r = await service.create('c1', {
        nome: 'Q',
        esporteId: ESPORTE,
        precoHora: 100,
      });

      expect(r.categoria).toBeNull();
    });

    it('a LISTAGEM pede os catálogos — sem o `include`, a quadra perde o esporte', async () => {
      // Outra sabotagem que passava: tirar o `include` do `findMany` fazia
      // `esporteRef` chegar `undefined` e a resposta virar
      // `esporte: null` — a quadra some do filtro do aluno sem erro nenhum.
      (prisma.quadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.quadra.count as jest.Mock).mockResolvedValue(0);

      await service.list('c1');

      const chamadas = (prisma.quadra.findMany as jest.Mock).mock.calls as [
        Record<string, unknown>,
      ][];
      expect(chamadas[0][0]).toHaveProperty('include');
    });

    it('a busca da opção é ESCOPADA à empresa', async () => {
      // A terceira sabotagem que passava: tirar `companyId` do `where`
      // deixava o clube A usar o esporte do clube B. O banco recusaria pela
      // FK composta (INV-054), mas com "violates foreign key constraint" —
      // e a checagem existe justamente para a mensagem ser útil.
      const ESPORTE = '11111111-1111-4111-8111-111000200099';
      (prisma.esporteDeQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: ESPORTE,
        nome: 'tenis',
      });
      (prisma.quadra.create as jest.Mock).mockResolvedValue(QUADRA_ATIVA);

      await service.create('c1', {
        nome: 'Q',
        esporteId: ESPORTE,
        precoHora: 100,
      });

      const chamadas = (prisma.esporteDeQuadra.findFirst as jest.Mock).mock
        .calls as [{ where: Record<string, unknown> }][];
      expect(chamadas[0][0].where).toEqual({ id: ESPORTE, companyId: 'c1' });
    });

    it('422 com esporte de OUTRA empresa, e nada é gravado', async () => {
      // O banco também recusa (FK composta, INV-054). Este 422 existe para
      // a mensagem dizer qual campo está errado.
      (prisma.esporteDeQuadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create('c1', {
          nome: 'Q',
          esporteId: '99999999-9999-4999-8999-999000200099',
          precoHora: 100,
        }),
      ).rejects.toMatchObject({ response: { code: 'ESPORTE_INVALIDO' } });

      expect(prisma.quadra.create).not.toHaveBeenCalled();
    });

    it('update propaga 404 cross-tenant', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('c1', 'q1', { nome: 'Nova' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('availability', () => {
    it('lança 404 se a quadra não é da empresa', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.availability('c1', 'q1', '2026-08-20'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('monta a grade com slots livres e ocupados (REQ-002)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          horaInicio: new Date('1970-01-01T14:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
          origemTipo: 'AVULSO',
        },
      ]);

      const result = await service.availability('c1', 'q1', '2026-08-20');

      const slot14 = result.slots.find((s) => s.slot === '14:00-15:00');
      const slot10 = result.slots.find((s) => s.slot === '10:00-11:00');
      expect(slot14?.status).toBe('ocupado_avulso');
      expect(slot10?.status).toBe('livre');
    });
  });

  describe('createBooking', () => {
    const dto = {
      quadraId: 'q1',
      data: '2026-08-20',
      horaInicio: '14:00',
      horaFim: '15:00',
      alunoId: 'a1',
    };

    it('rejeita horaFim <= horaInicio com 422', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);

      await expect(
        service.createBooking('c1', {
          ...dto,
          horaInicio: '15:00',
          horaFim: '14:00',
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });

    it('idempotência: reenvio com o mesmo client_request_id retorna a ocupação já criada (AC-004)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: 'o1',
        companyId: 'c1',
        quadraId: 'q1',
        data: new Date('2026-08-20T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
        origemTipo: 'AVULSO',
        alunoId: null,
        statusPagamento: 'pendente_pagamento',
      });

      const result = await service.createBooking('c1', dto, 'req-123');

      expect(comoReserva(result).id).toBe('o1');
      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });

    // SPEC-009/INV-010: reserva ocupa horário real numa quadra real
    // (INV-001). Sem esta trava, qualquer pessoa com o link público de
    // auto-cadastro bloquearia a agenda da empresa de graça.
    it('bloqueia reserva de aluno com vínculo pendente antes de tocar a quadra (INV-010)', async () => {
      // A quadra existe e está ativa: o que barra aqui é o vínculo, não
      // um 404 de recurso — a ordem do serviço valida a quadra primeiro,
      // então o teste precisa passar por essa etapa para provar a trava.
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (studentsService.exigirVinculoAprovado as jest.Mock).mockRejectedValue(
        new ForbiddenException({ code: 'VINCULO_PENDENTE' }),
      );

      await expect(
        service.createBooking('c1', { ...dto, alunoId: 'a1' }, 'req-999'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });

    it('pré-checagem de conflito retorna 409 com conflictWith (REQ-004)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: 'o-existente',
        origemTipo: 'TURMA',
      });

      await expect(service.createBooking('c1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });

    it('cria ocupação AVULSO com status_pagamento pendente (REQ-003)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.ocupacaoQuadra.create as jest.Mock).mockResolvedValue({
        id: 'o1',
        companyId: 'c1',
        quadraId: 'q1',
        data: new Date('2026-08-20T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
        origemTipo: 'AVULSO',
        alunoId: null,
        statusPagamento: 'pendente_pagamento',
      });

      const result = await service.createBooking('c1', dto);

      expect(prisma.ocupacaoQuadra.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          companyId: 'c1',
          quadraId: 'q1',
          origemTipo: 'AVULSO',
        }),
      });
      expect(comoReserva(result).statusPagamento).toBe('pendente_pagamento');
    });

    it('corrida perdida na constraint EXCLUDE vira 409 (INV-001, mesma lógica do FIT-001)', async () => {
      // A violação da EXCLUDE constraint (código Postgres 23P01) não tem
      // P-código dedicado no Prisma, então chega como
      // PrismaClientUnknownRequestError — não PrismaClientKnownRequestError.
      // Achado real via FIT-001 rodando contra o Neon (18/20 execuções
      // vazavam como 500 antes desta correção).
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findFirst as jest.Mock)
        .mockResolvedValueOnce(null) // pré-checagem: sem conflito no momento da leitura
        .mockResolvedValueOnce({ id: 'o-concorrente', origemTipo: 'AVULSO' }); // conflito real após a corrida
      (prisma.ocupacaoQuadra.create as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError(
          'conflicting key value violates exclusion constraint "no_overlap_por_quadra"',
          {
            clientVersion: '6.19.3',
          },
        ),
      );

      await expect(service.createBooking('c1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  describe('registerClassOccupancy', () => {
    // SPEC-010/AC-018 — a ocorrência inválida fica **no meio** da lista de
    // propósito. Uma implementação que confere só a primeira passaria por
    // este teste se ele colocasse a inválida na frente, e gravaria as
    // demais fora do expediente sem ninguém notar.
    //
    // DEF-013 mudou os dados deste teste, não o que ele prova. Antes as três
    // ocorrências eram três segundas-feiras e o dublê de `resolverParaData`
    // fechava a segunda **por posição** — impossível na vida real, porque o
    // expediente só depende do dia da semana. Agora a lista é a da SPEC-019:
    // uma turma de segunda e sábado, com o sábado fechado. É o caso que o
    // produto passou a permitir, e a ocorrência inválida continua no meio.
    it('AC-018: recusa quando UMA ocorrência do meio cai fora do expediente', async () => {
      const SEGUNDA = new Date('2026-08-24T00:00:00.000Z');
      const SABADO = new Date('2026-08-29T00:00:00.000Z');
      const tres = [
        {
          data: SEGUNDA,
          horaInicio: parseTimeOnly('09:00'),
          horaFim: parseTimeOnly('10:00'),
        },
        {
          data: SABADO,
          horaInicio: parseTimeOnly('09:00'),
          horaFim: parseTimeOnly('10:00'),
        },
        {
          data: new Date('2026-08-31T00:00:00.000Z'),
          horaInicio: parseTimeOnly('09:00'),
          horaFim: parseTimeOnly('10:00'),
        },
      ];
      expect([SEGUNDA.getUTCDay(), SABADO.getUTCDay()]).toEqual([1, 6]);
      (horarios.carregarLinhas as jest.Mock).mockResolvedValue([
        {
          quadraId: null,
          diaSemana: 1,
          fechado: false,
          horaInicio: parseTimeOnly('06:00'),
          horaFim: parseTimeOnly('22:00'),
        },
        {
          quadraId: null,
          diaSemana: 6,
          fechado: true,
          horaInicio: null,
          horaFim: null,
        },
      ]);

      await expect(
        service.registerClassOccupancy(
          prisma as unknown as Prisma.TransactionClient,
          'c1',
          'q1',
          't1',
          tres,
        ),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      // Nada gravado: a turma inteira é recusada, não parcialmente criada.
      expect(prisma.ocupacaoQuadra.createMany).not.toHaveBeenCalled();
    });

    // Chamado por MOD-004 (ClassesService) dentro de sua própria transação
    // (por isso `prisma` aqui faz o papel do `tx` recebido) — ver
    // TARGET_ARCHITECTURE.md seção 6 (MOD-005 continua dono exclusivo da
    // tabela, evita o ciclo MOD-004↔MOD-005).
    const ocorrencias = [
      {
        data: new Date('2026-08-25T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
      },
      {
        data: new Date('2026-09-01T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
      },
    ];

    it('gera as ocupações via createMany numa única chamada quando não há conflito (NFR-002)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.ocupacaoQuadra.createMany as jest.Mock).mockResolvedValue({
        count: 2,
      });

      await service.registerClassOccupancy(
        prisma,
        'c1',
        'q1',
        't1',
        ocorrencias,
      );

      expect(prisma.ocupacaoQuadra.createMany).toHaveBeenCalledTimes(1);
      expect(prisma.ocupacaoQuadra.createMany).toHaveBeenCalledWith({
        data: ocorrencias.map((ocorrencia) => ({
          companyId: 'c1',
          quadraId: 'q1',
          data: ocorrencia.data,
          horaInicio: ocorrencia.horaInicio,
          horaFim: ocorrencia.horaFim,
          origemTipo: 'TURMA',
          origemTurmaId: 't1',
        })),
      });
    });

    /**
     * DEF-013 — **a busca de conflito virou uma consulta só**, e por isso a
     * prova de "qualquer ocorrência, não só a primeira" mudou de lugar:
     * antes ela armava a segunda chamada do `findFirst`, agora ela confere
     * que o `OR` enviado ao banco cobre **todas** as ocorrências. Sem esta
     * asserção, uma implementação que consultasse só a primeira data
     * passaria — que é exatamente o erro que a AC-001 existe para barrar.
     */
    it('julga todas as ocorrências numa consulta só (AC-001)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.ocupacaoQuadra.createMany as jest.Mock).mockResolvedValue({
        count: 2,
      });

      await service.registerClassOccupancy(
        prisma,
        'c1',
        'q1',
        't1',
        ocorrencias,
      );

      expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledTimes(1);
      const [args] = (prisma.ocupacaoQuadra.findMany as jest.Mock).mock
        .calls[0] as [Prisma.OcupacaoQuadraFindManyArgs];
      expect(args.where?.OR).toEqual(
        ocorrencias.map((ocorrencia) => ({
          data: ocorrencia.data,
          horaInicio: { lt: ocorrencia.horaFim },
          horaFim: { gt: ocorrencia.horaInicio },
        })),
      );
    });

    it('rejeita com 409 e não insere nada se qualquer ocorrência colide (AC-001)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        { id: 'o-existente', origemTipo: 'AVULSO' },
      ]);

      await expect(
        service.registerClassOccupancy(
          prisma as unknown as Prisma.TransactionClient,
          'c1',
          'q1',
          't1',
          ocorrencias,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.ocupacaoQuadra.createMany).not.toHaveBeenCalled();
    });

    it('corrida perdida na constraint EXCLUDE durante createMany vira 409 (INV-001)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.ocupacaoQuadra.createMany as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientUnknownRequestError(
          'conflicting key value violates exclusion constraint "no_overlap_por_quadra"',
          { clientVersion: '6.19.3' },
        ),
      );

      await expect(
        service.registerClassOccupancy(
          prisma as unknown as Prisma.TransactionClient,
          'c1',
          'q1',
          't1',
          ocorrencias,
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    /**
     * DEF-013 — **o outro lado da tradução acima.** Transação expirada não é
     * corrida perdida: sair daqui como 409 diz ao gestor que a quadra está
     * ocupada quando ela está livre, e ele desiste de uma turma que só
     * precisava de menos idas ao banco. Tem de continuar sendo 500.
     */
    it('P2028 durante createMany NÃO vira 409 (DEF-013)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.ocupacaoQuadra.createMany as jest.Mock).mockRejectedValue(
        new Prisma.PrismaClientKnownRequestError(
          'Transaction already closed: A query cannot be executed on an expired transaction.',
          {
            code: 'P2028',
            clientVersion: '6.19.3',
            meta: { modelName: 'OcupacaoQuadra' },
          },
        ),
      );

      await expect(
        service.registerClassOccupancy(
          prisma as unknown as Prisma.TransactionClient,
          'c1',
          'q1',
          't1',
          ocorrencias,
        ),
      ).rejects.toMatchObject({ code: 'P2028' });
    });
  });

  describe('cancelFutureClassOccupancies', () => {
    it('marca como cancelado só as ocupações futuras de TURMA ainda não canceladas', async () => {
      (prisma.ocupacaoQuadra.updateMany as jest.Mock).mockResolvedValue({
        count: 3,
      });

      const aPartirDe = new Date('2026-08-20T00:00:00.000Z');
      await service.cancelFutureClassOccupancies(prisma, 'c1', 't1', aPartirDe);

      expect(prisma.ocupacaoQuadra.updateMany).toHaveBeenCalledWith({
        where: {
          companyId: 'c1',
          origemTipo: 'TURMA',
          origemTurmaId: 't1',
          statusPagamento: { not: 'cancelado' },
          data: { gte: aPartirDe },
        },
        data: { statusPagamento: 'cancelado' },
      });
    });
  });

  describe('listBookings (SPEC-005)', () => {
    it('sem alunoIdScope, lista tudo da empresa (comportamento de company_admin)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.ocupacaoQuadra.count as jest.Mock).mockResolvedValue(0);

      await service.listBookings('c1', {});

      expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { companyId: 'c1' } }),
      );
    });

    it('com alunoIdScope, escopa a listagem só ao próprio aluno (REQ-005)', async () => {
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.ocupacaoQuadra.count as jest.Mock).mockResolvedValue(0);

      await service.listBookings('c1', {}, 'a1');

      expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { companyId: 'c1', alunoId: 'a1' },
        }),
      );
    });
  });

  describe('cancelBooking', () => {
    it('lança 404 cross-tenant', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.cancelBooking('c1', 'o1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('marca status_pagamento como cancelado (AC-003)', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: 'o1',
        companyId: 'c1',
      });
      (prisma.ocupacaoQuadra.update as jest.Mock).mockResolvedValue({});

      await service.cancelBooking('c1', 'o1');

      expect(prisma.ocupacaoQuadra.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { statusPagamento: 'cancelado' },
      });
    });

    it('com alunoIdScope, rejeita cancelar reserva de outro aluno (REQ-005)', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: 'o1',
        companyId: 'c1',
        alunoId: 'outro-aluno',
      });

      await expect(
        service.cancelBooking('c1', 'o1', 'a1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });

    it('com alunoIdScope, cancela a própria reserva normalmente', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: 'o1',
        companyId: 'c1',
        alunoId: 'a1',
      });
      (prisma.ocupacaoQuadra.update as jest.Mock).mockResolvedValue({});

      await service.cancelBooking('c1', 'o1', 'a1');

      expect(prisma.ocupacaoQuadra.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { statusPagamento: 'cancelado' },
      });
    });
  });

  describe('updatePaymentStatus (SPEC-006, CON-006.3)', () => {
    it('lança 404 cross-tenant', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updatePaymentStatus('c1', 'o1', 'pago'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('marca como pago (REQ-003)', async () => {
      const base = {
        id: 'o1',
        companyId: 'c1',
        quadraId: 'q1',
        data: new Date('2026-08-25T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T09:00:00.000Z'),
        horaFim: new Date('1970-01-01T10:00:00.000Z'),
        origemTipo: 'AVULSO',
        alunoId: 'a1',
      };
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        ...base,
        statusPagamento: 'pendente_pagamento',
      });
      (prisma.ocupacaoQuadra.update as jest.Mock).mockResolvedValue({
        ...base,
        statusPagamento: 'pago',
      });

      const result = await service.updatePaymentStatus('c1', 'o1', 'pago');

      expect(prisma.ocupacaoQuadra.update).toHaveBeenCalledWith({
        where: { id: 'o1' },
        data: { statusPagamento: 'pago' },
      });
      expect(result.statusPagamento).toBe('pago');
    });

    it('marcar o mesmo status 2x é idempotente, não gera update supérfluo (AC-002)', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        id: 'o1',
        companyId: 'c1',
        quadraId: 'q1',
        data: new Date('2026-08-25T00:00:00.000Z'),
        horaInicio: new Date('1970-01-01T09:00:00.000Z'),
        horaFim: new Date('1970-01-01T10:00:00.000Z'),
        origemTipo: 'AVULSO',
        alunoId: 'a1',
        statusPagamento: 'pago',
      });

      const result = await service.updatePaymentStatus('c1', 'o1', 'pago');

      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
      expect(result.statusPagamento).toBe('pago');
    });
  });

  describe('findAlunoDoUsuario', () => {
    it('lança 403 se o usuário não tem aluno vinculado na empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.findAlunoDoUsuario('c1', 'u1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('retorna o aluno vinculado ao usuário na empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
        companyId: 'c1',
      });

      const aluno = await service.findAlunoDoUsuario('c1', 'u1');

      expect(prisma.aluno.findFirst).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', companyId: 'c1' },
      });
      expect(aluno.id).toBe('a1');
    });
  });

  // =====================================================================
  // SPEC-010 — horário de funcionamento (REQ-004, INV-011, REQ-010)
  // =====================================================================
  describe('horário de funcionamento (SPEC-010)', () => {
    const fechado = { estado: 'fechado' as const };
    const aberto = (inicio: string, fim: string) => ({
      estado: 'aberto' as const,
      horaInicio: parseTimeOnly(inicio),
      horaFim: parseTimeOnly(fim),
    });

    it('AC-007: a grade vem do horário efetivo, não de constante', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (horarios.resolverParaData as jest.Mock).mockResolvedValue(
        aberto('08:00', '11:00'),
      );

      const res = await service.availability('c1', 'q1', '2026-08-24');

      expect(res.estado).toBe('aberto');
      expect(res.slots.map((s) => s.slot)).toEqual([
        '08:00-09:00',
        '09:00-10:00',
        '10:00-11:00',
      ]);
    });

    it('AC-008: dia fechado devolve estado fechado e nenhum slot', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([]);
      (horarios.resolverParaData as jest.Mock).mockResolvedValue(fechado);

      const res = await service.availability('c1', 'q1', '2026-08-23');

      expect(res.estado).toBe('fechado');
      expect(res.slots).toEqual([]);
    });

    // AC-022 — o caso que separa as duas semânticas: a ocupação 10:00–11:00
    // não conflita com o slot 09:00–10:00 (conflito é semiaberto), mas está
    // fora de um expediente que fecha às 10:00.
    it('AC-022: ocupação que começa no fechamento não ocupa o último slot', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          horaInicio: parseTimeOnly('10:00'),
          horaFim: parseTimeOnly('11:00'),
          origemTipo: 'AVULSO',
        },
      ]);
      (horarios.resolverParaData as jest.Mock).mockResolvedValue(
        aberto('06:00', '10:00'),
      );

      const res = await service.availability('c1', 'q1', '2026-08-24');

      expect(res.slots.at(-1)).toEqual({
        slot: '09:00-10:00',
        status: 'livre',
      });
    });

    it('AC-009: reserva fora do expediente devolve 422 e não toca a agenda', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      (horarios.resolverParaData as jest.Mock).mockResolvedValue(
        aberto('06:00', '10:00'),
      );

      const erro = (await service
        .createBooking(
          'c1',
          {
            quadraId: 'q1',
            data: '2026-08-24',
            horaInicio: '10:00',
            horaFim: '11:00',
          },
          'req-fora',
        )
        .catch((e: Error) => e)) as { response?: { code?: string } };

      expect((erro as unknown) instanceof UnprocessableEntityException).toBe(
        true,
      );
      expect(erro.response?.code).toBe('FORA_DO_EXPEDIENTE');
      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // SPEC-012:TASK-000 — transições de status que estavam abertas
  // =====================================================================
  describe('transições de status (SPEC-012:TASK-000)', () => {
    const avulsaPendente = {
      id: 'o1',
      companyId: 'c1',
      quadraId: 'q1',
      origemTipo: 'AVULSO' as const,
      statusPagamento: 'pendente_pagamento' as const,
      data: new Date('2026-08-24T00:00:00.000Z'),
      horaInicio: parseTimeOnly('09:00'),
      horaFim: parseTimeOnly('10:00'),
      alunoId: 'a1',
    };

    // O buraco mais grave: a constraint EXCLUDE ignora linhas canceladas,
    // então cancelar libera o slot de verdade. Marcar a cancelada como
    // paga tenta recolocá-la na linha do tempo — com o slot reocupado,
    // vira violação de constraint; sem, a reserva ressuscita em silêncio.
    it('AC-012: marcar como pago uma reserva cancelada devolve 422, não ressuscita', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        ...avulsaPendente,
        statusPagamento: 'cancelado',
      });

      const erro = (await service
        .updatePaymentStatus('c1', 'o1', 'pago')
        .catch((e: Error) => e)) as { response?: { code?: string } };

      expect((erro as unknown) instanceof UnprocessableEntityException).toBe(
        true,
      );
      expect(erro.response?.code).toBe('RESERVA_CANCELADA');
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });

    it('AC-011: marcar como pago ocupação de turma devolve 422', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        ...avulsaPendente,
        origemTipo: 'TURMA',
        alunoId: null,
      });

      const erro = (await service
        .updatePaymentStatus('c1', 'o1', 'pago')
        .catch((e: Error) => e)) as { response?: { code?: string } };

      expect(erro.response?.code).toBe('OCUPACAO_DE_TURMA');
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });

    it('cancelar ocupação de turma devolve 422 (GAP-008)', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        ...avulsaPendente,
        origemTipo: 'TURMA',
        alunoId: null,
      });

      await expect(service.cancelBooking('c1', 'o1')).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });

    it('marcar pago segue funcionando para reserva avulsa pendente', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        avulsaPendente,
      );
      (prisma.ocupacaoQuadra.update as jest.Mock).mockResolvedValue({
        ...avulsaPendente,
        statusPagamento: 'pago',
      });

      const r = await service.updatePaymentStatus('c1', 'o1', 'pago');

      expect(r.statusPagamento).toBe('pago');
    });

    // Repetir a ação não é engano do usuário: é rede instável.
    it('cancelar o que já está cancelado é idempotente, sem escrita nem erro', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue({
        ...avulsaPendente,
        statusPagamento: 'cancelado',
      });

      await expect(service.cancelBooking('c1', 'o1')).resolves.toBeUndefined();
      expect(prisma.ocupacaoQuadra.update).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // SPEC-011 — múltiplos horários, valor e idempotência de pedido
  // =====================================================================
  describe('múltiplos horários (SPEC-011)', () => {
    const QUADRA_COM_PRECO = {
      id: 'q1',
      companyId: 'c1',
      status: 'ativa',
      precoHora: 80,
    };

    function prepararCriacao() {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(
        QUADRA_COM_PRECO,
      );
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);
      (prisma.pedidoReserva.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.pedidoReserva.create as jest.Mock).mockResolvedValue({
        id: 'p1',
      });
      (prisma.ocupacaoQuadra.create as jest.Mock).mockImplementation(
        ({ data }: { data: Record<string, unknown> }) =>
          Promise.resolve({
            id: `o-${String(data.horaInicio)}`,
            companyId: 'c1',
            quadraId: 'q1',
            data: data.data,
            horaInicio: data.horaInicio,
            horaFim: data.horaFim,
            origemTipo: 'AVULSO',
            alunoId: null,
            statusPagamento: 'pendente_pagamento',
          }),
      );
    }

    it('AC-001/AC-003: 2 horas seguidas viram 1 reserva, com valor somado', async () => {
      prepararCriacao();

      const r = (await service.createBooking('c1', {
        quadraId: 'q1',
        data: '2026-08-24',
        slots: [
          { horaInicio: '09:00', horaFim: '10:00' },
          { horaInicio: '10:00', horaFim: '11:00' },
        ],
      })) as { reservas: unknown[] };

      expect(r.reservas).toHaveLength(1);
      expect(prisma.ocupacaoQuadra.create).toHaveBeenCalledTimes(1);
      const [args] = (prisma.ocupacaoQuadra.create as jest.Mock).mock
        .calls[0] as [
        { data: { valor: { toString(): string }; horaFim: Date } },
      ];
      // 2 horas × R$ 80 — congelado agora, não recalculado depois.
      expect(args.data.valor.toString()).toBe('160');
      expect(formatTimeOnly(args.data.horaFim)).toBe('11:00');
    });

    it('AC-002: horas separadas viram 2 reservas independentes', async () => {
      prepararCriacao();

      const r = (await service.createBooking('c1', {
        quadraId: 'q1',
        data: '2026-08-24',
        slots: [
          { horaInicio: '09:00', horaFim: '10:00' },
          { horaInicio: '15:00', horaFim: '16:00' },
        ],
      })) as { reservas: unknown[] };

      expect(r.reservas).toHaveLength(2);
      expect(prisma.ocupacaoQuadra.create).toHaveBeenCalledTimes(2);
    });

    // AC-005: o pedido é atômico. Um bloco fora do expediente derruba o
    // pedido inteiro — 3 blocos com 1 inválido não podem deixar 2 criados.
    it('AC-005: um bloco fora do expediente recusa o pedido inteiro', async () => {
      prepararCriacao();
      (horarios.resolverParaData as jest.Mock).mockResolvedValue({
        estado: 'aberto',
        horaInicio: parseTimeOnly('06:00'),
        horaFim: parseTimeOnly('10:00'),
      });

      await expect(
        service.createBooking('c1', {
          quadraId: 'q1',
          data: '2026-08-24',
          slots: [
            { horaInicio: '09:00', horaFim: '10:00' },
            { horaInicio: '10:00', horaFim: '11:00' },
          ],
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });

    it('AC-006: mesma chave e mesmo payload devolve o pedido original, sem criar', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(
        QUADRA_COM_PRECO,
      );
      (prisma.pedidoReserva.findUnique as jest.Mock).mockResolvedValue({
        id: 'p1',
        fingerprint: 'q1|2026-08-24|09:00-10:00',
        ocupacoes: [
          {
            id: 'o1',
            companyId: 'c1',
            quadraId: 'q1',
            data: parseDateOnly('2026-08-24'),
            horaInicio: parseTimeOnly('09:00'),
            horaFim: parseTimeOnly('10:00'),
            origemTipo: 'AVULSO',
            alunoId: null,
            statusPagamento: 'pendente_pagamento',
          },
        ],
      });

      const r = (await service.createBooking(
        'c1',
        {
          quadraId: 'q1',
          data: '2026-08-24',
          slots: [{ horaInicio: '09:00', horaFim: '10:00' }],
        },
        'chave-1',
      )) as { reservas: { id: string }[] };

      expect(r.reservas[0].id).toBe('o1');
      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });

    // AC-010 — o caso que a validação cruzada apontou: "encaixar" uma
    // seleção diferente numa chave antiga produziria um pedido que ninguém
    // fez.
    it('AC-010: mesma chave com seleção diferente devolve 422, sem escrita', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(
        QUADRA_COM_PRECO,
      );
      (prisma.pedidoReserva.findUnique as jest.Mock).mockResolvedValue({
        id: 'p1',
        fingerprint: 'q1|2026-08-24|09:00-10:00',
        ocupacoes: [],
      });

      const erro = (await service
        .createBooking(
          'c1',
          {
            quadraId: 'q1',
            data: '2026-08-24',
            slots: [{ horaInicio: '15:00', horaFim: '16:00' }],
          },
          'chave-1',
        )
        .catch((e: Error) => e)) as { response?: { code?: string } };

      expect(erro.response?.code).toBe('IDEMPOTENCY_KEY_REUSED');
      expect(prisma.ocupacaoQuadra.create).not.toHaveBeenCalled();
    });

    // Compatibilidade: os frontends em produção ainda mandam o formato
    // antigo, e o `back` sobe antes das telas.
    // AC-004 — a razão de `valor` existir como coluna. Se a resposta
    // recalculasse pelo preço atual, reajustar a hora mudaria o valor de
    // reservas antigas, inclusive já pagas.
    it('AC-004: o valor devolvido é o congelado, não o recalculado pelo preço atual', async () => {
      const ocupacaoAntiga = {
        id: 'o1',
        companyId: 'c1',
        quadraId: 'q1',
        data: parseDateOnly('2026-08-01'),
        horaInicio: parseTimeOnly('09:00'),
        horaFim: parseTimeOnly('11:00'),
        origemTipo: 'AVULSO',
        alunoId: null,
        statusPagamento: 'pago',
        // Reservada quando a hora custava R$ 80.
        valor: 160,
      };
      // A quadra hoje custa R$ 100 — se o valor fosse derivado, viraria 200.
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue({
        ...QUADRA_COM_PRECO,
        precoHora: 100,
      });
      (prisma.pedidoReserva.findUnique as jest.Mock).mockResolvedValue({
        id: 'p1',
        fingerprint: 'q1|2026-08-01|09:00-10:00,10:00-11:00',
        ocupacoes: [ocupacaoAntiga],
      });

      const r = (await service.createBooking(
        'c1',
        {
          quadraId: 'q1',
          data: '2026-08-01',
          slots: [
            { horaInicio: '09:00', horaFim: '10:00' },
            { horaInicio: '10:00', horaFim: '11:00' },
          ],
        },
        'chave-antiga',
      )) as { reservas: { valor: number }[] };

      expect(r.reservas[0].valor).toBe(160);
    });

    it('formato antigo continua funcionando e recebe objeto, não lista', async () => {
      prepararCriacao();

      const r = await service.createBooking('c1', {
        quadraId: 'q1',
        data: '2026-08-24',
        horaInicio: '09:00',
        horaFim: '10:00',
      });

      expect(comoReserva(r).id).toBeDefined();
      expect((r as { reservas?: unknown[] }).reservas).toBeUndefined();
    });
  });
});
