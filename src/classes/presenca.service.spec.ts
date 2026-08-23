import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { PresencaService } from './presenca.service';

// TEST (SPEC-014): unit tests de `presencas` com Prisma mockado.
//
// ATENÇÃO ao ler estes testes: mock **não tem constraint**. INV-015 (par
// único) e a metade de INV-016 que proíbe presença em reserva avulsa são
// impostas pelo banco (UNIQUE, CHECK e FK composta) e provadas por
// violação no dry-run da migration, não aqui. O que se prova aqui é a
// lógica que o banco não pode expressar: janela de datas, versão, escopo
// do professor e composição da chamada.

interface TxMock {
  presenca: { findMany: jest.Mock; upsert: jest.Mock };
}

function buildMocks() {
  const tx: TxMock = {
    presenca: { findMany: jest.fn().mockResolvedValue([]), upsert: jest.fn() },
  };
  const prisma = {
    professor: { findFirst: jest.fn() },
    turma: { findFirst: jest.fn() },
    ocupacaoQuadra: { findFirst: jest.fn(), findMany: jest.fn() },
    turmaAluno: { findMany: jest.fn() },
    presenca: { findMany: jest.fn().mockResolvedValue([]) },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

function diaRelativo(dias: number): Date {
  const hoje = new Date();
  const base = Date.UTC(
    hoje.getUTCFullYear(),
    hoje.getUTCMonth(),
    hoje.getUTCDate(),
  );
  return new Date(base + dias * 24 * 60 * 60 * 1000);
}

function ocupacao(overrides: Record<string, unknown> = {}) {
  return {
    id: 'oc1',
    origemTurmaId: 't1',
    origemTipo: 'TURMA',
    statusPagamento: 'pendente_pagamento',
    data: diaRelativo(0),
    horaInicio: new Date('1970-01-01T09:00:00.000Z'),
    horaFim: new Date('1970-01-01T10:00:00.000Z'),
    ...overrides,
  };
}

describe('PresencaService (SPEC-014)', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let service: PresencaService;

  beforeEach(() => {
    const b = buildMocks();
    prisma = b.prisma;
    tx = b.tx;
    service = new PresencaService(prisma);
    (prisma.professor.findFirst as jest.Mock).mockResolvedValue({ id: 'p1' });
    (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
      { alunoId: 'a1' },
      { alunoId: 'a2' },
    ]);
  });

  const salvar = (
    itens: {
      alunoId: string;
      status: 'presente' | 'ausente' | 'justificado';
    }[] = [{ alunoId: 'a1', status: 'presente' }],
  ) => service.salvarChamada('c1', 'u1', 'oc1', '0', itens);

  describe('INV-018 — quem escreve', () => {
    it('recusa usuário com papel de professor mas sem ficha na empresa', async () => {
      (prisma.professor.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(salvar()).rejects.toBeInstanceOf(ForbiddenException);
    });

    // O `professorId` entra no WHERE. Ocorrência de colega devolve 404, não
    // 403 — 403 confirmaria que ela existe, e o professor mapearia a grade
    // dos colegas por tentativa e erro.
    it('ocorrência de turma de colega devolve 404', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(salvar()).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.ocupacaoQuadra.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            origemTurma: { professorId: 'p1' },
          }),
        }),
      );
    });
  });

  describe('INV-017 — a janela', () => {
    it('recusa aula futura (o toque na linha errada da grade)', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao({ data: diaRelativo(1) }),
      );

      await expect(salvar()).rejects.toMatchObject({
        response: { code: 'AULA_FUTURA' },
      });
    });

    it('aceita a aula de hoje', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao(),
      );

      await expect(salvar()).resolves.toMatchObject({ total: 1 });
    });

    it('aceita aula de 7 dias atrás e recusa a de 8', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao({ data: diaRelativo(-7) }),
      );
      await expect(salvar()).resolves.toMatchObject({ total: 1 });

      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao({ data: diaRelativo(-8) }),
      );
      await expect(salvar()).rejects.toMatchObject({
        response: { code: 'AULA_ANTIGA' },
      });
    });
  });

  describe('INV-016 — a metade que é regra de escrita', () => {
    it('recusa chamada em aula cancelada', async () => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao({ statusPagamento: 'cancelado' }),
      );

      await expect(salvar()).rejects.toMatchObject({
        response: { code: 'AULA_CANCELADA' },
      });
    });
  });

  describe('AC-006 — só aluno alocado', () => {
    beforeEach(() => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao(),
      );
    });

    // "nada é gravado": a chamada inteira falha. Gravar os válidos e
    // recusar o resto deixaria a aula meio marcada, e o professor sem saber
    // qual metade valeu.
    it('recusa a chamada inteira e não grava nada', async () => {
      await expect(
        salvar([
          { alunoId: 'a1', status: 'presente' },
          { alunoId: 'intruso', status: 'presente' },
        ]),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
      expect(tx.presenca.upsert).not.toHaveBeenCalled();
    });

    it('recusa o mesmo aluno duas vezes no corpo', async () => {
      await expect(
        salvar([
          { alunoId: 'a1', status: 'presente' },
          { alunoId: 'a1', status: 'ausente' },
        ]),
      ).rejects.toMatchObject({ response: { code: 'ALUNO_REPETIDO' } });
    });

    // A decisão registrada na spec: alocação é o único requisito.
    // `alunos.status` e `vinculo` não bloqueiam — quem assistiu segunda e
    // foi desligado terça esteve lá na segunda.
    it('não consulta status nem vínculo do aluno', async () => {
      await salvar();

      expect(prisma.turmaAluno.findMany).toHaveBeenCalledWith({
        where: { turmaId: 't1' },
        select: { alunoId: true },
      });
    });
  });

  describe('INV-019 — versão otimista', () => {
    beforeEach(() => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao(),
      );
    });

    it('recusa com 409 quando a chamada mudou desde a leitura', async () => {
      tx.presenca.findMany.mockResolvedValueOnce([
        { updatedAt: new Date(1_700_000_000_000) },
      ]);

      await expect(salvar()).rejects.toBeInstanceOf(ConflictException);
      expect(tx.presenca.upsert).not.toHaveBeenCalled();
    });

    // A conferência acontece **dentro** da transação. Fora dela sobraria a
    // janela entre ler e gravar, que é a corrida que este controle existe
    // para fechar.
    it('confere a versão dentro da transação', async () => {
      await salvar();

      expect(prisma.$transaction).toHaveBeenCalled();
      expect(tx.presenca.findMany).toHaveBeenCalled();
    });

    it('devolve versão nova depois de gravar', async () => {
      tx.presenca.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ updatedAt: new Date(1_700_000_000_000) }]);

      await expect(salvar()).resolves.toMatchObject({
        versao: '1:1700000000000',
      });
    });
  });

  describe('INV-020 — a chamada salva é o retrato da turma', () => {
    beforeEach(() => {
      (prisma.ocupacaoQuadra.findFirst as jest.Mock).mockResolvedValue(
        ocupacao(),
      );
    });

    // O caso que a validação cruzada expôs: aula na terça, aluno novo entra
    // na quarta, professor lança a chamada na quinta. Sem esta regra, o
    // aluno novo apareceria como se estivesse lá na terça.
    it('chamada já salva ignora quem entrou na turma depois', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Aluno Um' } },
        },
      ]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a1', aluno: { usuario: { nome: 'Aluno Um' } } },
        { alunoId: 'a9', aluno: { usuario: { nome: 'Entrou Depois' } } },
      ]);

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos.map((a) => a.alunoId)).toEqual(['a1']);
      expect(res.versao).toBe('1:1700000000000');
    });

    // AC-010 — removido depois da chamada não some do histórico, mas fica
    // sinalizado.
    it('mantém quem saiu da turma, marcado como fora dela', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([
        {
          alunoId: 'a1',
          status: 'presente',
          updatedAt: new Date(1_700_000_000_000),
          aluno: { usuario: { nome: 'Saiu Depois' } },
        },
      ]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([]);

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos[0]).toMatchObject({ naTurmaHoje: false });
    });

    it('chamada ainda não salva lista a turma atual', async () => {
      (prisma.presenca.findMany as jest.Mock).mockResolvedValue([]);
      (prisma.turmaAluno.findMany as jest.Mock).mockResolvedValue([
        { alunoId: 'a2', aluno: { usuario: { nome: 'Zeca' } } },
        { alunoId: 'a1', aluno: { usuario: { nome: 'Ana' } } },
      ]);

      const res = await service.chamada('c1', 'u1', 'oc1');

      expect(res.alunos.map((a) => a.nome)).toEqual(['Ana', 'Zeca']);
      expect(res.versao).toBe('0');
      expect(res.alunos.every((a) => a.status === null)).toBe(true);
    });
  });
});
