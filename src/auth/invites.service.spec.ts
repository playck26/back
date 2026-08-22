import {
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../people/students.service';
import { InvitesService } from './invites.service';

// TEST-009 (SPEC-009/REQ-002): convite de uso único, com a claim atômica
// de INV-009 e as respostas públicas indistinguíveis de REQ-011.

interface TxMock {
  conviteAluno: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  usuario: { findUnique: jest.Mock; create: jest.Mock };
}

function build() {
  const tx: TxMock = {
    conviteAluno: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    usuario: { findUnique: jest.fn(), create: jest.fn() },
  };
  const prisma = {
    usuario: { findUnique: jest.fn() },
    conviteAluno: { create: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
  const students = {
    hashSenha: jest.fn().mockResolvedValue('$2b$12$hash'),
    criarPerfilDeAluno: jest.fn().mockResolvedValue({ id: 'a1' }),
  } as unknown as StudentsService;
  return {
    prisma: prisma as unknown as PrismaService,
    prismaRaw: prisma,
    tx,
    students,
    service: new InvitesService(prisma as unknown as PrismaService, students),
  };
}

describe('InvitesService (SPEC-009/REQ-002)', () => {
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  describe('criar', () => {
    it('AC-003: devolve o token uma única vez e guarda só o sha256', async () => {
      ctx.prismaRaw.conviteAluno.create.mockImplementation(
        (args: { data: { tokenHash: string } }) =>
          Promise.resolve({
            id: 'c1',
            expiraEm: new Date(),
            tokenHash: args.data.tokenHash,
          }),
      );

      const res = await ctx.service.criar('emp1', 'admin1', {});

      const [chamada] = ctx.prismaRaw.conviteAluno.create.mock.calls[0] as [
        { data: { tokenHash: string } },
      ];
      // O que vai para o banco é o hash, nunca o token.
      expect(chamada.data.tokenHash).not.toBe(res.token);
      expect(chamada.data.tokenHash).toBe(
        createHash('sha256').update(res.token).digest('hex'),
      );
      // Determinístico: é isso que torna a claim atômica implementável —
      // bcrypt, com salt por hash, não permitiria buscar por igualdade.
      expect(chamada.data.tokenHash).toHaveLength(64);
    });

    it('recusa convite para e-mail já cadastrado, com mensagem explícita (caminho autenticado)', async () => {
      ctx.prismaRaw.usuario.findUnique.mockResolvedValue({
        id: 'u1',
      });

      await expect(
        ctx.service.criar('emp1', 'admin1', { email: 'ja@existe.com' }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);
    });
  });

  describe('consultarPublico (AC-023, AC-024)', () => {
    const conviteValido = {
      nome: 'Fulano',
      email: 'f@x.com',
      telefone: '11999999999',
      nivelId: 'n1',
      usadoEm: null,
      expiraEm: new Date(Date.now() + 86_400_000),
      empresa: { nome: 'Empresa X', status: 'ativa' },
    };

    it('devolve só nome da empresa e nome pré-preenchido — nunca e-mail, telefone ou nível (AC-025)', async () => {
      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue(conviteValido);

      const res = await ctx.service.consultarPublico('token-qualquer');

      expect(res).toEqual({ empresa: { nome: 'Empresa X' }, nome: 'Fulano' });
      const serializado = JSON.stringify(res);
      expect(serializado).not.toContain('f@x.com');
      expect(serializado).not.toContain('11999999999');
      expect(serializado).not.toContain('n1');
    });

    it('convite usado e convite expirado devolvem o mesmo 410 (AC-023)', async () => {
      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue({
        ...conviteValido,
        usadoEm: new Date(),
      });
      const usado = await ctx.service
        .consultarPublico('t')
        .catch((e: Error) => e);

      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue({
        ...conviteValido,
        expiraEm: new Date(Date.now() - 1000),
      });
      const expirado = await ctx.service
        .consultarPublico('t')
        .catch((e: Error) => e);

      expect(usado).toBeInstanceOf(GoneException);
      expect(expirado).toBeInstanceOf(GoneException);
      // Indistinguíveis: quem tem o link não descobre se outra pessoa já o
      // usou ou se ele só venceu.
      expect(usado.message).toBe(expirado.message);
    });

    it('token inexistente devolve 404', async () => {
      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue(null);

      await expect(ctx.service.consultarPublico('nada')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('aceitar (INV-009)', () => {
    const conviteNoBanco = {
      companyId: 'emp1',
      email: 'f@x.com',
      nome: 'Fulano',
      telefone: null,
      nivelId: null,
      empresa: { status: 'ativa' },
    };

    it('AC-004: reivindica o convite ANTES de criar a conta', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findUnique.mockResolvedValue(null);
      ctx.tx.usuario.create.mockResolvedValue({ id: 'u1', email: 'f@x.com' });

      await ctx.service.aceitar({ token: 't', senha: 'senha-forte-123' });

      const ordemClaim =
        ctx.tx.conviteAluno.updateMany.mock.invocationCallOrder[0];
      const ordemCriacao = ctx.tx.usuario.create.mock.invocationCallOrder[0];
      expect(ordemClaim).toBeLessThan(ordemCriacao);

      // A claim é uma escrita só, com `usadoEm: null` no WHERE — não um
      // SELECT seguido de UPDATE, que sob READ COMMITTED deixaria duas
      // requisições simultâneas passarem.
      const [args] = ctx.tx.conviteAluno.updateMany.mock.calls[0] as [
        { where: { usadoEm: null; expiraEm: { gt: Date } } },
      ];
      expect(args.where.usadoEm).toBeNull();
      expect(args.where.expiraEm.gt).toBeInstanceOf(Date);
    });

    it('AC-005: quem perde a corrida recebe 410 e não cria conta', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 0 });

      await expect(
        ctx.service.aceitar({ token: 't', senha: 'senha-forte-123' }),
      ).rejects.toBeInstanceOf(GoneException);
      expect(ctx.tx.usuario.create).not.toHaveBeenCalled();
    });

    it('aluno de convite nasce aprovado — a iniciativa foi da empresa (AC-014)', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findUnique.mockResolvedValue(null);
      ctx.tx.usuario.create.mockResolvedValue({ id: 'u1', email: 'f@x.com' });

      await ctx.service.aceitar({ token: 't', senha: 'senha-forte-123' });

      expect(ctx.students.criarPerfilDeAluno).toHaveBeenCalledWith(
        ctx.tx,
        expect.objectContaining({ vinculo: 'aprovado' }),
      );
    });

    it('conta com senha própria não nasce com senha temporária', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findUnique.mockResolvedValue(null);
      ctx.tx.usuario.create.mockResolvedValue({ id: 'u1', email: 'f@x.com' });

      await ctx.service.aceitar({ token: 't', senha: 'senha-forte-123' });

      const [args] = ctx.tx.usuario.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      expect(args.data.senhaTemporaria).toBeUndefined();
    });

    it('e-mail já cadastrado devolve 422 genérico e desfaz a claim pela transação', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findUnique.mockResolvedValue({ id: 'outro' });

      const erro = await ctx.service
        .aceitar({ token: 't', senha: 'senha-forte-123' })
        .catch((e: Error) => e);

      expect(erro).toBeInstanceOf(UnprocessableEntityException);
      // Mensagem genérica: superfície pública não confirma existência de
      // e-mail (REQ-011/NFR-002).
      expect(erro.message).toBe(
        'Não foi possível concluir o cadastro com esses dados.',
      );
      expect(ctx.tx.usuario.create).not.toHaveBeenCalled();
    });
  });
});
