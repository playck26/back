import {
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from './students.service';
import { gerarSenhaTemporaria } from '../common/utils/senha-temporaria';

// TEST-003 (SPEC-003): unit tests de MOD-003 (alunos) com Prisma mockado.

interface TxMock {
  usuario: { create: jest.Mock; update: jest.Mock };
  aluno: { create: jest.Mock; update: jest.Mock };
  // SPEC-009: `regenerarSenhaTemporaria` revoga sessões na mesma transação.
  refreshToken: { updateMany: jest.Mock };
}

function buildPrismaMock() {
  const tx: TxMock = {
    usuario: { create: jest.fn(), update: jest.fn() },
    aluno: { create: jest.fn(), update: jest.fn() },
    refreshToken: { updateMany: jest.fn() },
  };
  const prisma = {
    usuario: { findUnique: jest.fn() },
    aluno: {
      findMany: jest.fn(),
      count: jest.fn(),
      findFirst: jest.fn(),
      update: jest.fn(),
    },
    // DEF-027 — `findMany` entrou porque `update` passou a olhar
    // compromisso futuro antes de desligar. `[]` como padrao e o caso
    // "nao tem nada marcado", que e o dos outros testes deste arquivo.
    ocupacaoQuadra: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    turmaAluno: { count: jest.fn() },
    nivel: { findFirst: jest.fn() },
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

describe('StudentsService', () => {
  let prisma: PrismaService;
  let tx: TxMock;
  let service: StudentsService;

  beforeEach(() => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    tx = built.tx;
    service = new StudentsService(prisma);
  });

  describe('list', () => {
    it('escopa por company_id e mapeia dado de usuario+aluno (REQ-001, REQ-006)', async () => {
      (prisma.aluno.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'a1',
          nivelId: null,
          status: 'ativo',
          usuario: { nome: 'Aluno 1', email: 'aluno1@x.com', telefone: null },
        },
      ]);
      (prisma.aluno.count as jest.Mock).mockResolvedValue(1);

      const result = await service.list('c1', { page: 1, pageSize: 20 });

      expect(prisma.aluno.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { companyId: 'c1' } }),
      );
      // SPEC-036 — a resposta cresceu, e a LISTA cresceu junto de proposito:
      // com `cadastro` aqui, a tela do gestor consegue marcar quem esta
      // incompleto sem uma ida por aluno. O custo sao sete campos anulaveis
      // por linha.
      //
      // **`nome` e `email` preenchidos e o resto vazio da 29%**, que e o piso
      // real (AC-011) — nao 0%.
      expect(result.data).toEqual([
        {
          id: 'a1',
          nome: 'Aluno 1',
          email: 'aluno1@x.com',
          telefone: null,
          nivelId: null,
          status: 'ativo',
          dataNascimento: null,
          emergenciaNome: null,
          emergenciaTelefone: null,
          endereco: null,
          cidade: null,
          uf: null,
          observacoesSaude: null,
          cadastro: {
            percentual: 29,
            faltam: [
              'telefone',
              'dataNascimento',
              'emergenciaNome',
              'emergenciaTelefone',
              'nivelId',
            ],
          },
        },
      ]);
    });
  });

  describe('create', () => {
    const dto = { nome: 'Novo Aluno', email: 'novo@x.com' };

    it('rejeita email já cadastrado com 409', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(service.create('c1', dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejeita nivelId de outra empresa com 404', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.nivel.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.create('c1', { ...dto, nivelId: 'n-outra-empresa' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cria usuario (role aluno, senha aleatória) + perfil aluno numa transação', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
      tx.aluno.create.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'ativo',
        usuario: { nome: dto.nome, email: dto.email, telefone: null },
      });

      const result = await service.create('c1', dto);

      expect(tx.usuario.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            email: dto.email,
            role: 'aluno',
            companyId: 'c1',
          }),
        }),
      );
      expect(tx.aluno.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ usuarioId: 'u1', companyId: 'c1' }),
        }),
      );
      expect(result.email).toBe(dto.email);
      expect(JSON.stringify(result)).not.toMatch(/senhaHash|hash/i);
    });
  });

  describe('findOne', () => {
    it('lança 404 quando não existe ou é de outra empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('c1', 'a1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(prisma.aluno.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({ where: { id: 'a1', companyId: 'c1' } }),
      );
    });
  });

  describe('update', () => {
    it('propaga 404 se o aluno não existe na empresa', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('c1', 'a1', { nome: 'Novo' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('atualiza usuario e aluno na mesma transação', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      tx.aluno.update.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'ativo',
        usuario: { nome: 'Atualizado', email: 'x@x.com', telefone: null },
      });

      const result = await service.update('c1', 'a1', { nome: 'Atualizado' });

      expect(tx.usuario.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { nome: 'Atualizado', telefone: undefined },
      });
      expect(result.nome).toBe('Atualizado');
    });

    // SPEC-013/DEF-001. Ate 2026-08-22 `status` era gravado so em `alunos`
    // e o `usuarios` da pessoa nem era tocado — como nenhuma rota lia
    // `usuarios.status`, inativar nao tirava acesso de ninguem. Estes dois
    // testes sao o par: sem propagacao, as travas de INV-013 existem e
    // nunca disparam.
    it('inativar aluno propaga para o usuario e derruba as sessoes (INV-013)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      tx.aluno.update.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'inativo',
        usuario: { nome: 'X', email: 'x@x.com', telefone: null },
      });

      await service.update('c1', 'a1', { status: 'inativo' });

      expect(tx.usuario.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { status: 'inativo' },
      });
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    // =================================================================
    // DEF-027 — desligar com compromisso marcado
    // =================================================================

    it('**recusa desligar quem tem horario marcado, com 409 e a lista**', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'o1',
          data: new Date('2026-10-01T00:00:00.000Z'),
          horaInicio: new Date('1970-01-01T09:00:00.000Z'),
          horaFim: new Date('1970-01-01T10:00:00.000Z'),
          origemTipo: 'AVULSO',
        },
      ]);
      (prisma.ocupacaoQuadra.count as jest.Mock).mockResolvedValue(3);

      await expect(
        service.update('c1', 'a1', { status: 'inativo' }),
      ).rejects.toMatchObject({
        response: {
          statusCode: 409,
          code: 'ALUNO_COM_COMPROMISSOS',
          total: 3,
        },
      });

      // **A recusa vem ANTES da escrita.** Sem esta assercao o teste passaria
      // com um servico que grava e depois reclama — que e meia inativacao,
      // exatamente o que o comentario de INV-013 diz ser pior que nenhuma.
      expect(tx.aluno.update).not.toHaveBeenCalled();
      expect(tx.usuario.update).not.toHaveBeenCalled();
    });

    it('a amostra nomeia o horario, e nao so a contagem', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'o1',
          data: new Date('2026-10-01T00:00:00.000Z'),
          horaInicio: new Date('1970-01-01T09:00:00.000Z'),
          horaFim: new Date('1970-01-01T10:00:00.000Z'),
          origemTipo: 'TURMA',
        },
      ]);
      (prisma.ocupacaoQuadra.count as jest.Mock).mockResolvedValue(1);

      // "Tem 1 horario marcado" sem dizer QUAL obriga o gestor a procurar na
      // agenda dia a dia. O DEF-026 ja tinha pago essa licao na quadra.
      await expect(
        service.update('c1', 'a1', { status: 'inativo' }),
      ).rejects.toMatchObject({
        response: {
          amostra: [
            {
              ocupacaoId: 'o1',
              data: '2026-10-01',
              horaInicio: '09:00',
              horaFim: '10:00',
              origemTipo: 'TURMA',
            },
          ],
        },
      });
    });

    it('**REATIVAR nunca e recusado, mesmo com ocupacao marcada**', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      // A mesma ocupacao do caso acima. Se a checagem nao olhasse o valor de
      // `status`, um aluno desligado com ocupacao legada ficaria preso fora do
      // clube — sem caminho de volta pela unica rota que o traria.
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'o1',
          data: new Date('2026-10-01T00:00:00.000Z'),
          horaInicio: new Date('1970-01-01T09:00:00.000Z'),
          horaFim: new Date('1970-01-01T10:00:00.000Z'),
          origemTipo: 'AVULSO',
        },
      ]);
      tx.aluno.update.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'ativo',
        usuario: { nome: 'X', email: 'x@x.com', telefone: null },
      });

      await expect(
        service.update('c1', 'a1', { status: 'ativo' }),
      ).resolves.toBeDefined();
    });

    // Reativar devolve o acesso, mas nao ressuscita sessao nenhuma: quem
    // foi desligado e voltou entra de novo pela porta da frente.
    it('reativar propaga status e nao revoga tokens (INV-013)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        id: 'a1',
        usuarioId: 'u1',
      });
      tx.aluno.update.mockResolvedValue({
        id: 'a1',
        nivelId: null,
        status: 'ativo',
        usuario: { nome: 'X', email: 'x@x.com', telefone: null },
      });

      await service.update('c1', 'a1', { status: 'ativo' });

      expect(tx.usuario.update).toHaveBeenCalledWith({
        where: { id: 'u1' },
        data: { status: 'ativo' },
      });
      expect(tx.refreshToken.updateMany).not.toHaveBeenCalled();
    });
  });

  // =====================================================================
  // SPEC-009/REQ-008, REQ-009 — vínculo do aluno (INV-010)
  // =====================================================================

  describe('vínculo (SPEC-009)', () => {
    const alunoBase = {
      id: 'a1',
      companyId: 'c1',
      usuario: { nome: 'Fulano', email: 'f@x.com', telefone: null },
      status: 'ativo',
      nivelId: null,
      createdAt: new Date(),
    };

    it('garantirVinculoAprovado bloqueia pendente com 403 VINCULO_PENDENTE', () => {
      expect(() =>
        service.garantirVinculoAprovado({ vinculo: 'pendente' }),
      ).toThrow(ForbiddenException);
    });

    it('garantirVinculoAprovado bloqueia recusado também', () => {
      expect(() =>
        service.garantirVinculoAprovado({ vinculo: 'recusado' }),
      ).toThrow(ForbiddenException);
    });

    it('garantirVinculoAprovado deixa passar aprovado', () => {
      expect(() =>
        service.garantirVinculoAprovado({ vinculo: 'aprovado' }),
      ).not.toThrow();
    });

    it('aprovar move pendente para aprovado (AC-015)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'pendente',
      });
      (prisma.aluno.update as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'aprovado',
      });

      await service.decidirVinculo('c1', 'a1', 'aprovado');

      expect(prisma.aluno.update).toHaveBeenCalledWith({
        where: { id: 'a1' },
        data: { vinculo: 'aprovado' },
        include: { usuario: true },
      });
    });

    it('aprovar duas vezes é idempotente e não escreve de novo (AC-015)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'aprovado',
      });

      await service.decidirVinculo('c1', 'a1', 'aprovado');

      expect(prisma.aluno.update).not.toHaveBeenCalled();
    });

    // Recusar aluno já aprovado seria um jeito silencioso de desligar
    // alguém que já opera — isso é `status = inativo`, outra operação.
    it('recusar aluno já aprovado retorna 409, não desliga por vias transversas', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'aprovado',
      });

      await expect(
        service.decidirVinculo('c1', 'a1', 'recusado'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.aluno.update).not.toHaveBeenCalled();
    });

    it('recusar com reserva pendurada retorna 409 em vez de cancelar sozinho', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        ...alunoBase,
        vinculo: 'pendente',
      });
      (prisma.ocupacaoQuadra.count as jest.Mock).mockResolvedValue(2);
      (prisma.turmaAluno.count as jest.Mock).mockResolvedValue(0);

      await expect(
        service.decidirVinculo('c1', 'a1', 'recusado'),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.aluno.update).not.toHaveBeenCalled();
    });

    it('exigirAlunoOperante carrega do banco e bloqueia pendente (MOD-005)', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        vinculo: 'pendente',
        status: 'ativo',
      });

      await expect(
        service.exigirAlunoOperante('c1', 'a1'),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    // DEF-027 — vinculo aprovado e status inativo: a segunda metade da trava.
    // Antes dela, `garantirAlunoOperante` nem existia e este caso passava
    // direto para a escrita.
    it('**e bloqueia o DESLIGADO, com vinculo aprovado**', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        vinculo: 'aprovado',
        status: 'inativo',
      });

      await expect(
        service.exigirAlunoOperante('c1', 'a1'),
      ).rejects.toMatchObject({
        response: { statusCode: 422, code: 'ALUNO_INATIVO' },
      });
    });

    // **A ordem, e ela nao e arbitraria:** quem esta `pendente` nunca chegou a
    // operar, entao "ainda em analise" descreve melhor o estado do que "esta
    // inativo". Sem este caso, inverter a ordem passaria despercebido.
    it('com os DOIS errados, o vinculo responde primeiro', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue({
        vinculo: 'pendente',
        status: 'inativo',
      });

      await expect(
        service.exigirAlunoOperante('c1', 'a1'),
      ).rejects.toMatchObject({
        response: { code: 'VINCULO_PENDENTE' },
      });
    });
  });

  // =====================================================================
  // SPEC-009/REQ-003, REQ-005 — senha temporária (AC-006, AC-007, AC-010)
  // =====================================================================

  describe('senha temporária (SPEC-009)', () => {
    const alunoCriado = {
      id: 'a1',
      nivelId: null,
      status: 'ativo',
      usuarioId: 'u1',
      usuario: { nome: 'Fulano', email: 'f@x.com', telefone: null },
    };

    it('AC-006: create devolve a senha temporária e marca a conta', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
      tx.aluno.create.mockResolvedValue(alunoCriado);

      const res = await service.create('c1', {
        nome: 'Fulano',
        email: 'f@x.com',
      });

      // Legível de propósito: vai ser lida em voz alta ou copiada de um
      // print, sem os pares que se confundem (0/O, 1/I/L, 5/S, 2/Z, 8/B).
      expect(res.senhaTemporaria).toMatch(
        /^pck-[ACDEFGHJKMNPQRTUVWXY34679]{6}$/,
      );

      const [dadosUsuario] = tx.usuario.create.mock.calls[0] as [
        { data: { senhaTemporaria: boolean; senhaTemporariaExpiraEm: Date } },
      ];
      expect(dadosUsuario.data.senhaTemporaria).toBe(true);
      const dias =
        (dadosUsuario.data.senhaTemporariaExpiraEm.getTime() - Date.now()) /
        86_400_000;
      expect(dias).toBeGreaterThan(6.9);
      expect(dias).toBeLessThan(7.1);
    });

    it('AC-006: a senha vai só na resposta, nunca em claro no banco', async () => {
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
      tx.aluno.create.mockResolvedValue(alunoCriado);

      const res = await service.create('c1', {
        nome: 'Fulano',
        email: 'f@x.com',
      });

      const [dados] = tx.usuario.create.mock.calls[0] as [
        { data: { senhaHash: string } },
      ];
      expect(dados.data.senhaHash).not.toBe(res.senhaTemporaria);
      expect(dados.data.senhaHash.startsWith('$2')).toBe(true);
    });

    // AC-007: se a senha vazasse por findOne/list, o "uma única vez" da
    // spec seria decorativo.
    it('AC-007: findOne não devolve senha temporária', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(alunoCriado);

      const res = await service.findOne('c1', 'a1');

      expect(res).not.toHaveProperty('senhaTemporaria');
    });

    it('AC-010: regenerar devolve senha nova, remarca a conta e derruba sessões', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(alunoCriado);
      tx.usuario.update.mockResolvedValue({});
      tx.refreshToken.updateMany.mockResolvedValue({});

      const res = await service.regenerarSenhaTemporaria('c1', 'a1');

      expect(res.senhaTemporaria).toMatch(/^pck-/);
      const [upd] = tx.usuario.update.mock.calls[0] as [
        { where: { id: string }; data: { senhaTemporaria: boolean } },
      ];
      expect(upd.where.id).toBe('u1');
      expect(upd.data.senhaTemporaria).toBe(true);
      // Se a senha anterior vazou, sessão antiga viva anularia o gesto.
      expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
        where: { usuarioId: 'u1', revokedAt: null },
        data: { revokedAt: expect.any(Date) },
      });
    });

    it('AC-011: regenerar aluno de outra empresa retorna 404', async () => {
      (prisma.aluno.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.regenerarSenhaTemporaria('c1', 'a-de-outra-empresa'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('duas senhas geradas em sequência não se repetem', () => {
      const senhas = new Set(
        Array.from({ length: 20 }, () => gerarSenhaTemporaria()),
      );
      expect(senhas.size).toBe(20);
    });
  });
});
