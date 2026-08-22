import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { StudentsService } from '../people/students.service';
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
    ocupacaoQuadra: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      create: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
    },
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

  beforeEach(() => {
    prisma = buildPrismaMock();
    studentsService = buildStudentsMock();
    service = new CourtsService(prisma, studentsService);
  });

  describe('create/list/update', () => {
    it('cria quadra escopada à empresa', async () => {
      (prisma.quadra.create as jest.Mock).mockResolvedValue(QUADRA_ATIVA);

      const result = await service.create('c1', {
        nome: 'Quadra 1',
        esporte: 'tenis',
        precoHora: 100,
      });

      expect(prisma.quadra.create).toHaveBeenCalledWith({
        data: {
          companyId: 'c1',
          nome: 'Quadra 1',
          esporte: 'tenis',
          precoHora: 100,
        },
      });
      expect(result.precoHora).toBe(100);
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

      expect(result.id).toBe('o1');
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
      expect(result.statusPagamento).toBe('pendente_pagamento');
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
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);
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

    it('rejeita com 409 e não insere nada se qualquer ocorrência colide (AC-001)', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: 'o-existente', origemTipo: 'AVULSO' });

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
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);
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
});
