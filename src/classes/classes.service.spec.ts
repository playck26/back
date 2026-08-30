import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { CourtsService } from '../courts/courts.service';
import {
  gerarDatasSemanaisFuturas,
  parseTimeOnly,
} from '../courts/date-time.util';
import type { StudentsService } from '../people/students.service';
import { PrismaService } from '../prisma/prisma.service';
import { ClassesService } from './classes.service';

// TEST-004 (SPEC-003, fatia de turmas): unit tests de MOD-004 com Prisma e
// CourtsService (MOD-005) mockados. A garantia física de INV-001 (sem
// overbooking) já é provada por TEST-005/FIT-001 em MOD-005 — aqui só
// verificamos que MOD-004 chama o método público certo e propaga o 409.

interface TxMock {
  turma: { create: jest.Mock; update: jest.Mock };
  $queryRaw: jest.Mock;
  aluno: { findFirst: jest.Mock };
  turmaAluno: {
    findFirst: jest.Mock;
    count: jest.Mock;
    create: jest.Mock;
    delete: jest.Mock;
  };
}

function buildMocks() {
  const tx: TxMock = {
    turma: { create: jest.fn(), update: jest.fn() },
    $queryRaw: jest.fn(),
    aluno: { findFirst: jest.fn() },
    turmaAluno: {
      findFirst: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      delete: jest.fn(),
    },
  };
  const prisma = {
    turma: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
    },
    // SPEC-019/TASK-002 — a recorrencia vem daqui quando o dto nao a manda
    // (ex.: trocar so de quadra). O padrao e UM encontro, igual ao dto base.
    turmaEncontro: {
      findMany: jest.fn().mockResolvedValue([
        {
          diaSemana: 2,
          horaInicio: new Date('1970-01-01T14:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
        },
      ]),
    },
    quadra: { findFirst: jest.fn() },
    nivel: { findFirst: jest.fn() },
    professor: { findFirst: jest.fn() },
    aluno: { findFirst: jest.fn() },
    turmaAluno: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      delete: jest.fn(),
    },
    ocupacaoQuadra: { findMany: jest.fn() },
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };
  const courtsService = {
    registerClassOccupancy: jest.fn(),
    cancelFutureClassOccupancies: jest.fn(),
  };
  // SPEC-015/INV-029 — `removeStudent` passou a abrir transação e travar a
  // linha da turma, então ele lê e apaga por `tx`, não mais por `prisma`.
  // Delegar mantém os testes armando um lugar só.
  tx.turmaAluno.findFirst = jest.fn(
    (...args: unknown[]): unknown =>
      prisma.turmaAluno.findFirst(...args) as unknown,
  );
  tx.turmaAluno.delete = jest.fn(
    (...args: unknown[]): unknown =>
      prisma.turmaAluno.delete(...args) as unknown,
  );
  return {
    prisma: prisma as unknown as PrismaService,
    tx,
    courtsService: courtsService as unknown as CourtsService,
    courtsServiceMock: courtsService,
  };
}

const QUADRA_ATIVA = { id: 'q1', companyId: 'c1' };

// SPEC-009/INV-010: MOD-004 e MOD-005 perguntam a MOD-003 se o aluno está
// aprovado. O mock devolve "aprovado" por padrão; os testes de vínculo
// sobrescrevem para provar o bloqueio.
function buildStudentsMock() {
  return {
    garantirVinculoAprovado: jest.fn(),
    exigirVinculoAprovado: jest.fn().mockResolvedValue(undefined),
  } as unknown as StudentsService;
}

describe('ClassesService', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let courtsService: CourtsService;
  let courtsServiceMock: {
    registerClassOccupancy: jest.Mock;
    cancelFutureClassOccupancies: jest.Mock;
  };
  let service: ClassesService;
  let studentsService: StudentsService;

  // SPEC-019/TASK-002 — os três campos soltos viraram `encontros[]`.
  const dto = {
    nome: 'Turma A',
    quadraId: 'q1',
    encontros: [{ diaSemana: 2, horaInicio: '14:00', horaFim: '15:00' }],
    capacidade: 4,
  };

  beforeEach(() => {
    const built = buildMocks();
    prisma = built.prisma;
    tx = built.tx;
    courtsService = built.courtsService;
    courtsServiceMock = built.courtsServiceMock;
    studentsService = buildStudentsMock();
    service = new ClassesService(prisma, courtsService, studentsService);
  });

  describe('create', () => {
    it('rejeita horaFim <= horaInicio com 422 (AC-005)', async () => {
      await expect(
        service.create('c1', {
          ...dto,
          encontros: [{ diaSemana: 2, horaInicio: '15:00', horaFim: '14:00' }],
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('AC-003 — lista de encontros VAZIA é recusada, e nada é aberto', async () => {
      // INV-051. A transação nem começa: julgar a recorrência depois de abrir
      // transação seria abrir transação para descobrir que não havia o que
      // gravar.
      await expect(
        service.create('c1', { ...dto, encontros: [] }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('AC-006 — encontros sobrepostos entre si são recusados antes de tocar o banco', async () => {
      await expect(
        service.create('c1', {
          ...dto,
          encontros: [
            { diaSemana: 2, horaInicio: '18:00', horaFim: '19:00' },
            { diaSemana: 2, horaInicio: '18:30', horaFim: '19:30' },
          ],
        }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('lança 404 se a quadra não é da empresa', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.create('c1', dto)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('cria turma e gera 8 ocorrências futuras via registerClassOccupancy (REQ-002/003, NFR-002)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      tx.turma.create.mockResolvedValue({
        id: 't1',
        companyId: 'c1',
        nome: dto.nome,
        nivelId: null,
        professorId: null,
        quadraId: 'q1',
        diaSemana: 2,
        horaInicio: new Date('1970-01-01T14:00:00.000Z'),
        horaFim: new Date('1970-01-01T15:00:00.000Z'),
        capacidade: 4,
        status: 'ativa',
        encontros: [
          {
            diaSemana: 2,
            horaInicio: new Date('1970-01-01T14:00:00.000Z'),
            horaFim: new Date('1970-01-01T15:00:00.000Z'),
          },
        ],
      });

      const result = await service.create('c1', dto);

      const ocorrenciasEsperadas = gerarDatasSemanaisFuturas(
        dto.encontros[0].diaSemana,
      ).map((data) => ({
        data,
        horaInicio: parseTimeOnly(dto.encontros[0].horaInicio),
        horaFim: parseTimeOnly(dto.encontros[0].horaFim),
      }));
      expect(ocorrenciasEsperadas).toHaveLength(8);
      expect(courtsServiceMock.registerClassOccupancy).toHaveBeenCalledWith(
        tx,
        'c1',
        'q1',
        't1',
        ocorrenciasEsperadas,
      );
      expect(result.id).toBe('t1');
      expect(result.alunosAlocados).toBe(0);
    });

    it('propaga o 409 de registerClassOccupancy e não retorna turma (AC-001, NFR-001)', async () => {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      tx.turma.create.mockResolvedValue({ id: 't1' });
      courtsServiceMock.registerClassOccupancy.mockRejectedValue(
        new ConflictException({
          message:
            'Conflito de horário com ocupação existente na quadra (INV-001)',
          conflicts: [{ ocupacaoId: 'o1', origemTipo: 'AVULSO' }],
        }),
      );

      await expect(service.create('c1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });
  });

  /**
   * SPEC-019/FIT-008 — a aritmética de ocupações com N encontros.
   *
   * **É o núcleo do que esta spec faz**, e não tinha prova nenhuma até a
   * TASK-006: os testes existentes cobriam turma de UM encontro, que é o caso
   * que já funcionava antes da spec.
   */
  describe('as ocorrências de N encontros (FIT-008)', () => {
    function prontoParaCriar() {
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
      tx.turma.create.mockResolvedValue({
        id: 't1',
        companyId: 'c1',
        nome: 'T',
        nivelId: null,
        professorId: null,
        quadraId: 'q1',
        capacidade: 4,
        status: 'ativa',
        encontros: [],
      });
    }

    function ocorrenciasRegistradas(): {
      data: Date;
      horaInicio: Date;
      horaFim: Date;
    }[] {
      const chamada = courtsServiceMock.registerClassOccupancy.mock
        .calls[0] as unknown[];
      return chamada[4] as { data: Date; horaInicio: Date; horaFim: Date }[];
    }

    it('três encontros geram TRÊS janelas — 24 ocupações, não 8', async () => {
      // A NFR-002 dizia "o triplo de hoje" em abstrato; a 1ª rodada de dúvida
      // trocou por número. A janela é de 8 semanas, então 3 × 8 = 24.
      prontoParaCriar();

      await service.create('c1', {
        ...dto,
        encontros: [
          { diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' },
          { diaSemana: 3, horaInicio: '18:00', horaFim: '19:30' },
          { diaSemana: 6, horaInicio: '09:00', horaFim: '10:00' },
        ],
      });

      expect(ocorrenciasRegistradas()).toHaveLength(24);
    });

    it('AC-004 — cada ocorrência leva a hora DO SEU encontro', async () => {
      // O defeito que este teste pega: gerar as datas dos três dias e aplicar
      // a hora do primeiro em todas. Passaria na contagem e estaria errado.
      prontoParaCriar();

      await service.create('c1', {
        ...dto,
        encontros: [
          { diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' },
          { diaSemana: 3, horaInicio: '18:00', horaFim: '19:30' },
        ],
      });

      const porDia = new Map<number, Set<string>>();
      for (const o of ocorrenciasRegistradas()) {
        const dia = o.data.getUTCDay();
        const faixa = `${o.horaInicio.toISOString()}–${o.horaFim.toISOString()}`;
        if (!porDia.has(dia)) porDia.set(dia, new Set());
        porDia.get(dia)!.add(faixa);
      }

      // Segunda só tem a faixa da segunda; quarta só a da quarta.
      expect(porDia.get(1)?.size).toBe(1);
      expect(porDia.get(3)?.size).toBe(1);
      expect([...porDia.get(1)!][0]).not.toBe([...porDia.get(3)!][0]);
    });

    it('e todas vão na MESMA chamada — uma transação, não três', async () => {
      // INV-001/AC-002: conflito em qualquer encontro aborta tudo. Três
      // chamadas separadas permitiriam a primeira gravar e a segunda falhar,
      // deixando a turma com metade da recorrência no ar.
      prontoParaCriar();

      await service.create('c1', {
        ...dto,
        encontros: [
          { diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' },
          { diaSemana: 3, horaInicio: '18:00', horaFim: '19:30' },
        ],
      });

      expect(courtsServiceMock.registerClassOccupancy).toHaveBeenCalledTimes(1);
    });

    it('conflito em UM dos encontros derruba a criação inteira (INV-001)', async () => {
      prontoParaCriar();
      courtsServiceMock.registerClassOccupancy.mockRejectedValueOnce(
        new ConflictException('conflito'),
      );

      await expect(
        service.create('c1', {
          ...dto,
          encontros: [
            { diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' },
            { diaSemana: 3, horaInicio: '18:00', horaFim: '19:30' },
          ],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    const existente = {
      id: 't1',
      companyId: 'c1',
      quadraId: 'q1',
      diaSemana: 2,
      horaInicio: new Date('1970-01-01T14:00:00.000Z'),
      horaFim: new Date('1970-01-01T15:00:00.000Z'),
    };

    it('lança 404 se a turma não é da empresa', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('c1', 't1', { nome: 'Nova' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    /**
     * SPEC-019/FIT-008 — AC-008/AC-009 nas três formas de mexer na
     * recorrência: **acrescentar, remover e trocar**.
     *
     * A validação cruzada apontou que a tabela de provas original só cobria
     * "2 para 3" — nunca a remoção nem a troca. São caminhos diferentes no
     * código, e o de remoção é o único que pode chegar a zero.
     */
    describe('editar a recorrência (AC-008, AC-009)', () => {
      function prontoParaEditar(
        encontrosAtuais: {
          diaSemana: number;
          horaInicio: Date;
          horaFim: Date;
        }[],
      ) {
        (prisma.turma.findFirst as jest.Mock)
          .mockResolvedValueOnce(existente)
          .mockResolvedValueOnce({
            ...existente,
            nome: 'T',
            nivelId: null,
            professorId: null,
            capacidade: 4,
            status: 'ativa',
            alunos: [],
            encontros: encontrosAtuais,
            _count: { alunos: 0 },
          });
        (prisma.turmaEncontro.findMany as jest.Mock).mockResolvedValue(
          encontrosAtuais,
        );
        // `mudouHorario` sempre confere a quadra — inclusive quando so os
        // encontros mudaram, porque a nova recorrencia vai para a mesma.
        (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);
        tx.turma.update.mockResolvedValue({ id: 't1' });
      }

      function ocorrenciasGeradas(): { data: Date }[] {
        const chamada = courtsServiceMock.registerClassOccupancy.mock
          .calls[0] as unknown[];
        return chamada[4] as { data: Date }[];
      }

      const DOIS = [
        {
          diaSemana: 1,
          horaInicio: new Date('1970-01-01T07:00:00.000Z'),
          horaFim: new Date('1970-01-01T08:00:00.000Z'),
        },
        {
          diaSemana: 3,
          horaInicio: new Date('1970-01-01T18:00:00.000Z'),
          horaFim: new Date('1970-01-01T19:00:00.000Z'),
        },
      ];

      it('de 2 para 3: cancela as futuras e gera 24', async () => {
        prontoParaEditar(DOIS);

        await service.update('c1', 't1', {
          encontros: [
            { diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' },
            { diaSemana: 3, horaInicio: '18:00', horaFim: '19:00' },
            { diaSemana: 6, horaInicio: '09:00', horaFim: '10:00' },
          ],
        });

        expect(
          courtsServiceMock.cancelFutureClassOccupancies,
        ).toHaveBeenCalledTimes(1);
        expect(ocorrenciasGeradas()).toHaveLength(24);
      });

      it('REMOVENDO 1 de 2: sobra a janela do que ficou, e só ela', async () => {
        prontoParaEditar(DOIS);

        await service.update('c1', 't1', {
          encontros: [{ diaSemana: 1, horaInicio: '07:00', horaFim: '08:00' }],
        });

        const dias = new Set(
          ocorrenciasGeradas().map((o) => o.data.getUTCDay()),
        );
        expect(ocorrenciasGeradas()).toHaveLength(8);
        expect([...dias]).toEqual([1]);
      });

      it('TROCANDO o dia: as novas caem no dia novo, nenhuma no antigo', async () => {
        // O defeito que este teste pega: regerar a partir da recorrência
        // ANTIGA em vez da nova. O cancelamento aconteceria, as novas
        // ocupações voltariam para o mesmo dia, e a edição não teria efeito
        // nenhum — sem erro em lugar nenhum.
        prontoParaEditar(DOIS);

        await service.update('c1', 't1', {
          encontros: [{ diaSemana: 5, horaInicio: '20:00', horaFim: '21:00' }],
        });

        const dias = new Set(
          ocorrenciasGeradas().map((o) => o.data.getUTCDay()),
        );
        expect([...dias]).toEqual([5]);
      });

      it('e passar SÓ a quadra regera a partir do que está gravado', async () => {
        // Trocar de quadra sem mexer nos encontros também precisa regerar —
        // as ocupações antigas apontam para a quadra antiga. A recorrência
        // vem do banco, e é por isso que ela é validada mesmo assim.
        prontoParaEditar(DOIS);

        await service.update('c1', 't1', { quadraId: 'q2' });

        expect(prisma.turmaEncontro.findMany).toHaveBeenCalled();
        expect(ocorrenciasGeradas()).toHaveLength(16);
      });
    });

    it('atualização sem mudança de horário não regenera ocupações', async () => {
      (prisma.turma.findFirst as jest.Mock)
        .mockResolvedValueOnce(existente) // check de existência
        .mockResolvedValueOnce({
          // findOne no final do update
          ...existente,
          nome: 'Nova',
          nivelId: null,
          professorId: null,
          capacidade: 4,
          status: 'ativa',
          alunos: [],
          // SPEC-019 — a resposta deriva `encontros[]`, e o servico NAO tolera
          // a relacao ausente de proposito: tolerar esconderia um include
          // esquecido, e o sintoma seria uma turma sem dia nenhum na tela.
          encontros: [],
          _count: { alunos: 0 },
        });
      tx.turma.update.mockResolvedValue({ id: 't1' });

      await service.update('c1', 't1', { nome: 'Nova' });

      expect(
        courtsServiceMock.cancelFutureClassOccupancies,
      ).not.toHaveBeenCalled();
      expect(courtsServiceMock.registerClassOccupancy).not.toHaveBeenCalled();
    });

    it('mudança de horário cancela ocupações futuras e gera novas (NFR-001)', async () => {
      (prisma.turma.findFirst as jest.Mock)
        .mockResolvedValueOnce(existente)
        .mockResolvedValueOnce({
          ...existente,
          nome: 'Turma A',
          nivelId: null,
          professorId: null,
          capacidade: 4,
          status: 'ativa',
          alunos: [],
          // SPEC-019 — a resposta deriva `encontros[]`, e o servico NAO tolera
          // a relacao ausente de proposito: tolerar esconderia um include
          // esquecido, e o sintoma seria uma turma sem dia nenhum na tela.
          encontros: [],
          _count: { alunos: 0 },
        });
      tx.turma.update.mockResolvedValue({ id: 't1' });
      (prisma.quadra.findFirst as jest.Mock).mockResolvedValue(QUADRA_ATIVA);

      await service.update('c1', 't1', {
        encontros: [{ diaSemana: 2, horaInicio: '16:00', horaFim: '17:00' }],
      });

      expect(
        courtsServiceMock.cancelFutureClassOccupancies,
      ).toHaveBeenCalledWith(tx, 'c1', 't1', expect.any(Date));
      expect(courtsServiceMock.registerClassOccupancy).toHaveBeenCalledWith(
        tx,
        'c1',
        'q1',
        't1',
        expect.any(Array),
      );
    });
  });

  describe('allocateStudent', () => {
    it('lança 404 se a turma não existe na empresa', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      await expect(
        service.allocateStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lança 404 se o aluno não existe na empresa', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue(null);

      await expect(
        service.allocateStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    // SPEC-009/INV-010: vaga de turma é recurso finito da empresa
    // (INV-003). Cadastro não aprovado não ocupa.
    it('bloqueia alocação de aluno com vínculo pendente (INV-010)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a1', vinculo: 'pendente' });
      (studentsService.garantirVinculoAprovado as jest.Mock).mockImplementation(
        () => {
          throw new ForbiddenException({ code: 'VINCULO_PENDENTE' });
        },
      );

      await expect(
        service.allocateStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(tx.turmaAluno.create).not.toHaveBeenCalled();
    });

    it('re-adicionar o mesmo aluno é idempotente (não recria)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a1' });
      tx.turmaAluno.findFirst.mockResolvedValue({
        id: 'ta1',
        turmaId: 't1',
        alunoId: 'a1',
      });

      const result = await service.allocateStudent('c1', 't1', 'a1');

      expect(tx.turmaAluno.create).not.toHaveBeenCalled();
      expect(result).toEqual({ id: 'ta1', turmaId: 't1', alunoId: 'a1' });
    });

    it('rejeita alocar o N+1-ésimo aluno numa turma de capacidade N com 409 (AC-002, INV-003)', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a3' });
      tx.turmaAluno.findFirst.mockResolvedValue(null);
      tx.turmaAluno.count.mockResolvedValue(2);

      await expect(
        service.allocateStudent('c1', 't1', 'a3'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.turmaAluno.create).not.toHaveBeenCalled();
    });

    it('aloca aluno quando há vaga disponível', async () => {
      tx.$queryRaw.mockResolvedValue([{ id: 't1', capacidade: 2 }]);
      tx.aluno.findFirst.mockResolvedValue({ id: 'a1' });
      tx.turmaAluno.findFirst.mockResolvedValue(null);
      tx.turmaAluno.count.mockResolvedValue(1);
      tx.turmaAluno.create.mockResolvedValue({
        id: 'ta1',
        turmaId: 't1',
        alunoId: 'a1',
      });

      const result = await service.allocateStudent('c1', 't1', 'a1');

      expect(tx.turmaAluno.create).toHaveBeenCalledWith({
        data: { turmaId: 't1', alunoId: 'a1' },
      });
      expect(result).toEqual({ id: 'ta1', turmaId: 't1', alunoId: 'a1' });
    });
  });

  describe('removeStudent', () => {
    it('lança 404 se a turma não é da empresa', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removeStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lança 404 se o aluno não está alocado na turma', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
      (prisma.turmaAluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.removeStudent('c1', 't1', 'a1'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('remove a alocação (REQ-005)', async () => {
      (prisma.turma.findFirst as jest.Mock).mockResolvedValue({ id: 't1' });
      (prisma.turmaAluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'ta1',
      });

      await service.removeStudent('c1', 't1', 'a1');

      expect(prisma.turmaAluno.delete).toHaveBeenCalledWith({
        where: { id: 'ta1' },
      });
    });
  });

  describe('myUpcomingClasses (CON-004.5, SPEC-005)', () => {
    it('lança 403 se o usuário não tem aluno vinculado na empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.myUpcomingClasses('c1', 'u1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('retorna lista vazia se o aluno não está alocado em nenhuma turma', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({ id: 'a1' });
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([]);

      const result = await service.myUpcomingClasses('c1', 'u1');

      expect(result).toEqual([]);
      expect(prisma.ocupacaoQuadra.findMany).not.toHaveBeenCalled();
    });

    it('escopa por aluno_id (via turma_alunos), não só por company_id (AC-002)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({ id: 'a1' });
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { turmaId: 't1' },
      ]);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'o1',
          origemTurmaId: 't1',
          origemTurma: { nome: 'Turma A' },
          quadraId: 'q1',
          quadra: { nome: 'Quadra 1' },
          // SPEC-030 — o `include` passou a trazer o cabeçalho, e o mock
          // precisa espelhar a query. Mock que devolve menos do que o
          // serviço lê produz `undefined` silencioso: aqui ele estourou na
          // hora, mas a mesma omissão em outro campo passaria a medir outra
          // coisa em silêncio.
          chamadas: [],
          data: new Date('2026-08-25T00:00:00.000Z'),
          horaInicio: new Date('1970-01-01T14:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
        },
      ]);

      const result = await service.myUpcomingClasses('c1', 'u1');

      expect(prisma.turmaAluno.findMany).toHaveBeenCalledWith({
        where: { alunoId: 'a1' },
        select: { turmaId: true },
      });
      expect(prisma.ocupacaoQuadra.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            companyId: 'c1',
            origemTipo: 'TURMA',
            origemTurmaId: { in: ['t1'] },
          }),
        }),
      );
      expect(result).toEqual([
        {
          ocupacaoId: 'o1',
          turmaId: 't1',
          turmaNome: 'Turma A',
          quadraId: 'q1',
          quadraNome: 'Quadra 1',
          data: '2026-08-25',
          horaInicio: '14:00',
          horaFim: '15:00',
          // SPEC-030 — o aluno passou a saber que a aula não aconteceu. A
          // asserção é `toEqual` (não `objectContaining`), então ela cobra
          // campo novo no contrato — e é isso que se quer aqui: o DEF-012
          // nasceu de resposta que ganhou/perdeu campo sem nada acender.
          naoRealizada: false,
        },
      ]);
    });

    // SPEC-030 / achado 2 da validação cruzada — o par positivo. Sem ele,
    // `naoRealizada: false` fixo passaria na prova acima.
    it('marca `naoRealizada` quando o cabeçalho diz `nao_houve`', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({ id: 'a1' });
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { turmaId: 't1' },
      ]);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'o1',
          origemTurmaId: 't1',
          origemTurma: { nome: 'Turma A' },
          quadraId: 'q1',
          quadra: { nome: 'Quadra 1' },
          chamadas: [{ completude: 'nao_houve' }],
          data: new Date('2026-08-25T00:00:00.000Z'),
          horaInicio: new Date('1970-01-01T14:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
        },
      ]);

      const result = await service.myUpcomingClasses('c1', 'u1');

      expect(result[0].naoRealizada).toBe(true);
    });

    it('chamada normal NÃO marca `naoRealizada`', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({ id: 'a1' });
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { turmaId: 't1' },
      ]);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'o1',
          origemTurmaId: 't1',
          origemTurma: { nome: 'Turma A' },
          quadraId: 'q1',
          quadra: { nome: 'Quadra 1' },
          chamadas: [{ completude: 'completa' }],
          data: new Date('2026-08-25T00:00:00.000Z'),
          horaInicio: new Date('1970-01-01T14:00:00.000Z'),
          horaFim: new Date('1970-01-01T15:00:00.000Z'),
        },
      ]);

      const result = await service.myUpcomingClasses('c1', 'u1');

      expect(result[0].naoRealizada).toBe(false);
    });
  });
});

// =======================================================================
// SPEC-013/INV-012 — o professor le so as proprias turmas
// =======================================================================
describe('ClassesService — visao do professor (SPEC-013)', () => {
  let prisma: PrismaService;
  let service: ClassesService;

  beforeEach(() => {
    const built = buildMocks();
    prisma = built.prisma;
    service = new ClassesService(
      prisma,
      built.courtsService,
      buildStudentsMock(),
    );
  });

  // A checagem que sustenta INV-012: o professor vem do **banco**, pelo
  // usuario autenticado. Um token de professor cuja ficha nao existe mais
  // naquela empresa nao le nada — claim antigo nao vira permissao.
  it('recusa quem tem papel de professor mas nao tem ficha na empresa', async () => {
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(service.myTeachingClasses('c1', 'u9')).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('filtra por professor_id no WHERE, nao depois de buscar', async () => {
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.turma.findMany as jest.Mock).mockResolvedValue([]);

    await service.myTeachingClasses('c1', 'u9');

    expect(prisma.turma.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 'c1', professorId: 'p1', status: 'ativa' },
      }),
    );
  });

  // 404 e nao 403 de proposito: 403 confirmaria que a turma existe, e o
  // professor descobriria a grade dos colegas por tentativa e erro.
  it('turma de colega devolve 404, nao 403', async () => {
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue(null);

    await expect(
      service.myTeachingClassDetail('c1', 'u9', 't-do-colega'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  // AC-008 — o professor precisa saber quem esta na quadra, nao a ficha
  // financeira nem o contato de ninguem.
  it('detalhe traz nome e nivel do aluno, e nada de contato ou dinheiro', async () => {
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.turma.findFirst as jest.Mock).mockResolvedValue({
      id: 't1',
      nome: 'Infantil A',
      diaSemana: 2,
      horaInicio: parseTimeOnly('09:00'),
      horaFim: parseTimeOnly('10:00'),
      capacidade: 6,
      encontros: [
        {
          diaSemana: 2,
          horaInicio: parseTimeOnly('09:00'),
          horaFim: parseTimeOnly('10:00'),
        },
      ],
      quadra: { nome: 'Quadra 1' },
      nivel: { nome: 'Iniciante' },
      alunos: [
        {
          aluno: {
            id: 'a1',
            usuario: { nome: 'Aluno Um', telefone: '11999999999' },
            nivel: { nome: 'Iniciante' },
          },
        },
      ],
    });

    const res = await service.myTeachingClassDetail('c1', 'u9', 't1');

    expect(res.alunos).toEqual([
      { id: 'a1', nome: 'Aluno Um', nivelNome: 'Iniciante' },
    ]);
    expect(JSON.stringify(res)).not.toMatch(/11999999999/);
    expect(JSON.stringify(res)).not.toMatch(/valor|pagamento|preco/i);
  });
});
