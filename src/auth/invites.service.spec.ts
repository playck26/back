import {
  GoneException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../people/students.service';
import type { MatriculasService } from '../matriculas/matriculas.service';
import { InvitesService } from './invites.service';
import { ChaveDeLock } from '../common/lock/chave-de-lock';
import {
  cenariosDeAlunoOuProfessor,
  contaCasaComFiltro,
  filtroDaEmpresa,
  findFirstSobre,
  restaurarChaveDoEmailACadaTeste,
  wheresDasChamadas,
} from '../../test/utils/spec-086-contas-no-duble';

// TEST-009 (SPEC-009/REQ-002): convite de uso único, com a claim atômica
// de INV-009 e as respostas públicas indistinguíveis de REQ-011.

interface TxMock {
  conviteAluno: { updateMany: jest.Mock; findUniqueOrThrow: jest.Mock };
  usuario: { findFirst: jest.Mock; create: jest.Mock };
  $queryRaw: jest.Mock;
}

function build() {
  const tx: TxMock = {
    conviteAluno: { updateMany: jest.fn(), findUniqueOrThrow: jest.fn() },
    // SPEC-086 — a trava do e-mail (`$queryRaw`) e a conferência sob ela.
    usuario: { findFirst: jest.fn(), create: jest.fn() },
    $queryRaw: jest.fn().mockResolvedValue([]),
  };
  const prisma = {
    usuario: { findFirst: jest.fn() },
    conviteAluno: { create: jest.fn(), findUnique: jest.fn() },
    $transaction: jest.fn((cb: (tx: TxMock) => unknown) => cb(tx)),
  };
  const students = {
    hashSenha: jest.fn().mockResolvedValue('$2b$12$hash'),
    criarPerfilDeAluno: jest.fn().mockResolvedValue({ id: 'a1' }),
  } as unknown as StudentsService;
  /**
   * SPEC-037 — duble com `criarNoAceite` espionavel.
   *
   * **Nao e `{}`:** os casos abaixo precisam distinguir "o convite tinha
   * plano e a matricula nasceu" de "nao tinha plano". Um duble vazio faria a
   * chamada explodir com `is not a function` no caminho novo, e ficar verde
   * em todos os outros — que e o pior arranjo possivel.
   */
  const matriculas = {
    criarNoAceite: jest.fn().mockResolvedValue({ id: 'm1' }),
  } as unknown as MatriculasService;
  return {
    prisma: prisma as unknown as PrismaService,
    prismaRaw: prisma,
    tx,
    students,
    matriculas,
    service: new InvitesService(
      prisma as unknown as PrismaService,
      students,
      matriculas,
    ),
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
      ctx.prismaRaw.usuario.findFirst.mockResolvedValue({
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
      // SPEC-024: `contratoVersaoVigente` entrou no `select` de
      // `consultarPublico`. `null` aqui = clube sem contrato, que e o estado
      // de toda empresa existente.
      empresa: {
        nome: 'Empresa X',
        status: 'ativa',
        contratoVersaoVigente: null,
      },
    };

    it('devolve só nome da empresa e nome pré-preenchido — nunca e-mail, telefone ou nível (AC-025)', async () => {
      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue(conviteValido);

      const res = await ctx.service.consultarPublico('token-qualquer');

      // SPEC-024/REQ-007 acrescentou `contrato` a esta resposta — de
      // proposito e por pedido do Israel ("pode ir junto do convite"). O que
      // esta prova guarda continua sendo o mesmo: e-mail, telefone e nivel
      // NAO saem daqui. A lista cresceu; a regra nao mudou.
      expect(res).toEqual({
        empresa: { nome: 'Empresa X' },
        nome: 'Fulano',
        contrato: null,
      });
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
      const usado = (await ctx.service
        .consultarPublico('t')
        .catch((e: Error) => e)) as Error;

      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue({
        ...conviteValido,
        expiraEm: new Date(Date.now() - 1000),
      });
      const expirado = (await ctx.service
        .consultarPublico('t')
        .catch((e: Error) => e)) as Error;

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

    beforeEach(() => {
      // SPEC-086 — a prévia do convite, lida antes da transação para saber
      // qual e-mail travar.
      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue({
        email: conviteNoBanco.email,
      });
    });

    it('SPEC-086: trava o e-mail do CONVITE (não o do corpo) como primeira instrução, antes da claim', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findFirst.mockResolvedValue(null);
      ctx.tx.usuario.create.mockResolvedValue({ id: 'u1', email: 'f@x.com' });

      await ctx.service.aceitar({
        token: 't',
        senha: 'senha-forte-123',
        email: 'outro@x.com',
      });

      const [sql] = ctx.tx.$queryRaw.mock.calls[0] as [
        TemplateStringsArray,
        ...unknown[],
      ];
      expect(sql.join('?')).toContain('travar_emails_para_criar_conta');
      const [, chaves] = ctx.tx.$queryRaw.mock.calls[0] as [unknown, unknown];
      expect(chaves).toEqual([ChaveDeLock.deTexto('usuarios.email:f@x.com')]);
      expect(ctx.tx.$queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
        ctx.tx.conviteAluno.updateMany.mock.invocationCallOrder[0],
      );
    });

    it('SPEC-086/S26: o e-mail do convite reivindicado difere do travado → convite inválido, sem conta', async () => {
      ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue({
        email: 'antigo@x.com',
      });
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findFirst.mockResolvedValue(null);

      await expect(
        ctx.service.aceitar({ token: 't', senha: 'senha-forte-123' }),
      ).rejects.toBeInstanceOf(GoneException);
      expect(ctx.tx.usuario.create).not.toHaveBeenCalled();
    });

    it('AC-004: reivindica o convite ANTES de criar a conta', async () => {
      ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
      ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue(conviteNoBanco);
      ctx.tx.usuario.findFirst.mockResolvedValue(null);
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
      ctx.tx.usuario.findFirst.mockResolvedValue(null);
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
      ctx.tx.usuario.findFirst.mockResolvedValue(null);
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
      ctx.tx.usuario.findFirst.mockResolvedValue({ id: 'outro' });

      const erro = (await ctx.service
        .aceitar({ token: 't', senha: 'senha-forte-123' })
        .catch((e: Error) => e)) as Error;

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

/**
 * SPEC-086/E2 e E3 — o convite de aluno pelo FILTRO que passa ao Prisma
 * (AC-003, AC-017). A empresa alvo é a do CONVITE (`convite.companyId`), não
 * a de quem chama; o dublê avalia o filtro sobre contas, com a conta de outra
 * empresa criada antes (S1).
 */
describe('InvitesService — o e-mail por empresa (SPEC-086/E2, E3)', () => {
  const chave = restaurarChaveDoEmailACadaTeste();
  const EMAIL = 'spec086-e2@x.com';
  let ctx: ReturnType<typeof build>;

  beforeEach(() => {
    ctx = build();
  });

  const cenarios = cenariosDeAlunoOuProfessor(EMAIL, 'emp-do-convite').map(
    (c) => [c.nome, c] as const,
  );

  it.each(cenarios)('E2 (aceitar): %s', async (_nome, cenario) => {
    if (cenario.chave === 'ligada') chave.ligar();
    else chave.desligar();
    ctx.prismaRaw.conviteAluno.findUnique.mockResolvedValue({ email: EMAIL });
    ctx.tx.conviteAluno.updateMany.mockResolvedValue({ count: 1 });
    ctx.tx.conviteAluno.findUniqueOrThrow.mockResolvedValue({
      companyId: 'emp-do-convite',
      email: EMAIL,
      nome: 'Fulano',
      telefone: null,
      nivelId: null,
      planoId: null,
      criadoPorId: 'admin1',
      empresa: { status: 'ativa', contratoVersaoVigente: null },
    });
    const dentro = findFirstSobre(cenario.contas);
    ctx.tx.usuario.findFirst.mockImplementation(dentro);
    ctx.tx.usuario.create.mockResolvedValue({ id: 'u-novo', email: EMAIL });

    const r = await ctx.service
      .aceitar({ token: 't', senha: 'senha-forte-123' })
      .catch((e: Error) => e);

    const esperado =
      cenario.chave === 'ligada'
        ? filtroDaEmpresa(EMAIL, 'emp-do-convite')
        : { email: EMAIL };
    const wheres = wheresDasChamadas(dentro, ctx.prismaRaw.usuario.findFirst);
    expect(wheres).toHaveLength(1);
    expect(wheres[0]).toEqual(esperado);
    if (cenario.aceita) {
      expect(r).not.toBeInstanceOf(Error);
      expect(ctx.tx.usuario.create).toHaveBeenCalledTimes(1);
    } else {
      expect(r).toBeInstanceOf(UnprocessableEntityException);
      expect((r as Error).message).toBe(
        'Não foi possível concluir o cadastro com esses dados.',
      );
      expect(ctx.tx.usuario.create).not.toHaveBeenCalled();
    }
  });

  it.each(cenarios)('E3 (criar convite): %s', async (_nome, cenario) => {
    if (cenario.chave === 'ligada') chave.ligar();
    else chave.desligar();
    const fora = findFirstSobre(cenario.contas);
    ctx.prismaRaw.usuario.findFirst.mockImplementation(fora);
    ctx.prismaRaw.conviteAluno.create.mockResolvedValue({
      id: 'cv1',
      expiraEm: new Date(),
    });

    const r = await ctx.service
      .criar('emp-do-convite', 'admin1', { email: EMAIL })
      .catch((e: Error) => e);

    const esperado =
      cenario.chave === 'ligada'
        ? filtroDaEmpresa(EMAIL, 'emp-do-convite')
        : { email: EMAIL };
    const wheres = wheresDasChamadas(fora);
    expect(wheres).toEqual([esperado]);
    if (cenario.aceita) {
      expect(r).not.toBeInstanceOf(Error);
      expect(ctx.prismaRaw.conviteAluno.create).toHaveBeenCalledTimes(1);
    } else {
      expect(r).toBeInstanceOf(UnprocessableEntityException);
      expect((r as Error).message).toBe('Email já cadastrado');
      expect(ctx.prismaRaw.conviteAluno.create).not.toHaveBeenCalled();
    }
  });

  it('S1: com a chave ligada, um filtro só por e-mail acharia a conta de OUTRA empresa — o caso positivo ficaria vermelho', () => {
    const [positivo] = cenariosDeAlunoOuProfessor(EMAIL, 'emp-do-convite');
    expect(positivo.aceita).toBe(true);
    expect(
      positivo.contas.find((c) => contaCasaComFiltro(c, { email: EMAIL })),
    ).toBeDefined();
    expect(
      positivo.contas.find((c) =>
        contaCasaComFiltro(c, filtroDaEmpresa(EMAIL, 'emp-do-convite')),
      ),
    ).toBeUndefined();
  });
});
