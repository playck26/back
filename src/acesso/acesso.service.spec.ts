import { createHash } from 'node:crypto';
import {
  ConflictException,
  GoneException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { BCRYPT_COST } from '../common/utils/senha-temporaria';
import type { ConfiguracaoDosModelos } from '../email/email.config';
import { MemoriaProvedorDeEmail } from '../email/memoria-provedor-de-email';
import { VALIDADE_DO_CONVITE_EM_DIAS } from '../email/modelos/convite-de-acesso';
import type {
  MensagemDeEmail,
  ResultadoDoEnvio,
} from '../email/provedor-de-email';
import type { PrismaService } from '../prisma/prisma.service';
import {
  AcessoService,
  derivarSituacao,
  LINK_INVALIDO,
  prepararConvite,
  primeiroNome,
  type ConviteVivo,
} from './acesso.service';

/**
 * SPEC-083/TASK-004 (parte A) — o `AcessoService` sem banco.
 *
 * **O que só se prova aqui:** a forma do token e da impressão, a tabela da
 * situação inteira, o corpo único do `410`, e a ORDEM dos passos (o bcrypt
 * antes da transação; o e-mail depois do commit). O que depende de trava, de
 * `now()` do banco e de constraint fica no e2e contra o Postgres
 * (`test/acesso.e2e-spec.ts`) e no FIT-056.
 */

// O bcrypt é dublado no módulo que o serviço importa: é ele que registra a
// ordem "hash antes da transação", e custo 12 de verdade tornaria a suíte
// lenta sem provar nada a mais.
jest.mock('bcrypt', () => ({
  hash: jest.fn(() => Promise.resolve('$2b$12$senha-nova-do-link')),
}));

const hashDoBcrypt = bcrypt.hash as unknown as jest.Mock;

const sha256 = (valor: string) =>
  createHash('sha256').update(valor).digest('hex');

const MODELOS: ConfiguracaoDosModelos = {
  remetente: 'nao-responda@playck.com.br',
  responderPara: 'suporte@playck.com.br',
  urlCliente: 'https://cliente.teste.local',
};

const SENHA_HASH_ATUAL = '$2b$12$senha-temporaria-de-hoje';
const DIA_MS = 24 * 60 * 60 * 1000;

/** O provedor memória de verdade, anotando QUANDO o envio acontece. */
class MemoriaQueAnota extends MemoriaProvedorDeEmail {
  constructor(private readonly ordem: string[]) {
    super();
  }

  enviar(mensagem: MensagemDeEmail): Promise<ResultadoDoEnvio> {
    this.ordem.push('envio');
    return super.enviar(mensagem);
  }
}

interface Tx {
  $queryRaw: jest.Mock;
  $executeRaw: jest.Mock;
  conviteDeAcesso: {
    findUnique: jest.Mock;
    updateMany: jest.Mock;
    create: jest.Mock;
  };
  usuario: { update: jest.Mock };
  refreshToken: { updateMany: jest.Mock };
}

function montar() {
  const ordem: string[] = [];
  const tx: Tx = {
    $queryRaw: jest.fn(),
    $executeRaw: jest.fn(() => Promise.resolve(1)),
    conviteDeAcesso: {
      findUnique: jest.fn(),
      updateMany: jest.fn(() => Promise.resolve({ count: 0 })),
      create: jest.fn(() => Promise.resolve({ id: 'convite-novo' })),
    },
    usuario: { update: jest.fn(() => Promise.resolve({})) },
    refreshToken: { updateMany: jest.fn(() => Promise.resolve({ count: 2 })) },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: (t: Tx) => Promise<unknown>) => {
      ordem.push('transacao:inicio');
      const r = await cb(tx);
      ordem.push('commit');
      return r;
    }),
    conviteDeAcesso: {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      updateMany: jest.fn(() => {
        ordem.push('grava-resultado');
        return Promise.resolve({ count: 1 });
      }),
    },
    usuario: { findFirst: jest.fn() },
    aluno: { findFirst: jest.fn() },
  };
  const provedor = new MemoriaQueAnota(ordem);
  hashDoBcrypt.mockClear();
  hashDoBcrypt.mockImplementation(() => {
    ordem.push('bcrypt');
    return Promise.resolve('$2b$12$senha-nova-do-link');
  });
  const service = new AcessoService(
    prisma as unknown as PrismaService,
    provedor,
    MODELOS,
  );
  return { service, prisma, tx, provedor, ordem };
}

/** O texto cru das instruções de um `$queryRaw`/`$executeRaw` dublado. */
function sqlDe(mock: jest.Mock, chamada = 0): string {
  const [partes] = mock.mock.calls[chamada] as [readonly string[]];
  return partes.join('?').replace(/\s+/g, ' ');
}

/** Extrai o token do link do e-mail capturado. */
function tokenDoEmail(provedor: MemoriaProvedorDeEmail): string {
  const achado = /\/ativar\/([A-Za-z0-9_-]{43})\n/.exec(
    provedor.enviados[0].text,
  );
  if (!achado) throw new Error('o e-mail não traz o link');
  return achado[1];
}

async function recusa(promessa: Promise<unknown>): Promise<unknown> {
  return promessa.then(
    () => {
      throw new Error('deveria ter recusado');
    },
    (e: unknown) => e,
  );
}

describe('SPEC-083 — prepararConvite (D6)', () => {
  it('token de 32 bytes em base64url; no banco, só o sha256 dele', () => {
    const p = prepararConvite({ senhaHash: SENHA_HASH_ATUAL });
    expect(p.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(p.token, 'base64url')).toHaveLength(32);
    expect(p.tokenHash).toBe(sha256(p.token));
    expect(p.tokenHash).not.toContain(p.token);
  });

  it('a impressão é o sha256 de `usuarios.senha_hash` (INV-083c)', () => {
    const p = prepararConvite({ senhaHash: SENHA_HASH_ATUAL });
    expect(p.impressaoCredencial).toBe(sha256(SENHA_HASH_ATUAL));
    expect(
      prepararConvite({ senhaHash: '$2b$12$outra' }).impressaoCredencial,
    ).not.toBe(p.impressaoCredencial);
  });

  it('expira em agora + VALIDADE_DO_CONVITE_EM_DIAS (7), exatamente', () => {
    const agora = new Date('2026-10-03T12:00:00.000Z');
    const p = prepararConvite({ senhaHash: SENHA_HASH_ATUAL }, agora);
    expect(VALIDADE_DO_CONVITE_EM_DIAS).toBe(7);
    expect(p.expiraEm.toISOString()).toBe('2026-10-10T12:00:00.000Z');
  });

  it('cada chamada é um token novo (aleatório, e não derivado da conta)', () => {
    const a = prepararConvite({ senhaHash: SENHA_HASH_ATUAL });
    const b = prepararConvite({ senhaHash: SENHA_HASH_ATUAL });
    expect(a.token).not.toBe(b.token);
    expect(a.impressaoCredencial).toBe(b.impressaoCredencial);
  });
});

describe('SPEC-083 — derivarSituacao, a tabela da D9', () => {
  const agora = new Date('2026-10-03T12:00:00.000Z');
  const conta = { senhaTemporaria: true, senhaHash: SENHA_HASH_ATUAL };
  const enviadoEm = new Date('2026-10-02T12:00:00.000Z');
  const vivo = (outro: Partial<ConviteVivo> = {}): ConviteVivo => ({
    impressaoCredencial: sha256(SENHA_HASH_ATUAL),
    expiraEm: new Date(agora.getTime() + DIA_MS),
    emailResultado: 'enviado',
    emailMotivo: null,
    emailEm: enviadoEm,
    ...outro,
  });

  it('sem conta (professor sem usuarioId) → sem_conta, tudo nulo', () => {
    expect(derivarSituacao(null, null, null, agora)).toEqual({
      situacao: 'sem_conta',
      em: null,
      expiraEm: null,
      motivo: null,
    });
  });

  it('senha própria → ativado, com o instante da ativação quando houver', () => {
    const usadoEm = new Date('2026-10-01T10:00:00.000Z');
    const ativado = { senhaTemporaria: false, senhaHash: SENHA_HASH_ATUAL };
    expect(derivarSituacao(ativado, vivo(), usadoEm, agora)).toEqual({
      situacao: 'ativado',
      em: usadoEm,
      expiraEm: null,
      motivo: null,
    });
    // Pela troca da `pck-`: não há instante, e não se inventa um.
    expect(derivarSituacao(ativado, null, null, agora).em).toBeNull();
  });

  it('nenhum convite vivo → nao_enviado', () => {
    expect(derivarSituacao(conta, null, null, agora)).toEqual({
      situacao: 'nao_enviado',
      em: null,
      expiraEm: null,
      motivo: null,
    });
  });

  it('vivo, mas a impressão é de outra senha (a senha mudou depois) → nao_enviado', () => {
    const outraSenha = { senhaTemporaria: true, senhaHash: '$2b$12$regerada' };
    expect(derivarSituacao(outraSenha, vivo(), null, agora).situacao).toBe(
      'nao_enviado',
    );
  });

  it('vivo, no prazo, aceito → enviado, com o instante do envio e a validade', () => {
    expect(derivarSituacao(conta, vivo(), null, agora)).toEqual({
      situacao: 'enviado',
      em: enviadoEm,
      expiraEm: vivo().expiraEm,
      motivo: null,
    });
  });

  it('vivo, no prazo, recusado → falhou, com o motivo gravado', () => {
    expect(
      derivarSituacao(
        conta,
        vivo({ emailResultado: 'falhou', emailMotivo: 'cota' }),
        null,
        agora,
      ),
    ).toEqual({
      situacao: 'falhou',
      em: enviadoEm,
      expiraEm: vivo().expiraEm,
      motivo: 'cota',
    });
  });

  it('vivo, no prazo, sem resultado → falhou com sem_confirmacao, e `em` nulo', () => {
    expect(
      derivarSituacao(
        conta,
        vivo({ emailResultado: null, emailEm: null }),
        null,
        agora,
      ),
    ).toEqual({
      situacao: 'falhou',
      em: null,
      expiraEm: vivo().expiraEm,
      motivo: 'sem_confirmacao',
    });
  });

  it('vivo e vencido → expirado, inclusive se o envio tinha falhado', () => {
    const vencido = vivo({
      expiraEm: new Date(agora.getTime() - 1),
      emailResultado: 'falhou',
      emailMotivo: 'indisponivel',
    });
    expect(derivarSituacao(conta, vencido, null, agora)).toEqual({
      situacao: 'expirado',
      em: enviadoEm,
      expiraEm: vencido.expiraEm,
      motivo: null,
    });
  });

  it('vence NO instante: expirado — a ativação exige `expira_em > now()`', () => {
    expect(
      derivarSituacao(conta, vivo({ expiraEm: agora }), null, agora).situacao,
    ).toBe('expirado');
  });
});

describe('SPEC-083 — primeiroNome', () => {
  it.each([
    ['Maria Souza', 'Maria'],
    ['  Ana   Paula  Lima ', 'Ana'],
    ['Beto', 'Beto'],
  ])('%j → %j', (nome, esperado) => {
    expect(primeiroNome(nome)).toBe(esperado);
  });
});

describe('SPEC-083 — consultarPublico (D7)', () => {
  const TOKEN = 'a'.repeat(43);
  const emDia = () => ({
    impressaoCredencial: sha256(SENHA_HASH_ATUAL),
    expiraEm: new Date(Date.now() + DIA_MS),
    usadoEm: null as Date | null,
    revogadoEm: null as Date | null,
    usuario: {
      nome: 'Maria Souza',
      senhaHash: SENHA_HASH_ATUAL,
      senhaTemporaria: true,
      status: 'ativo',
      empresa: { nome: 'Clube Exemplo', status: 'ativa' } as {
        nome: string;
        status: string;
      } | null,
    },
  });

  it('válido → o primeiro nome e o clube; e nada é escrito', async () => {
    const { service, prisma, tx } = montar();
    prisma.conviteDeAcesso.findUnique.mockResolvedValue(emDia());
    await expect(service.consultarPublico(TOKEN)).resolves.toEqual({
      primeiroNome: 'Maria',
      empresa: { nome: 'Clube Exemplo' },
    });
    const [args] = prisma.conviteDeAcesso.findUnique.mock.calls[0] as [
      { where: { tokenHash: string } },
    ];
    expect(args.where.tokenHash).toBe(sha256(TOKEN));
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.conviteDeAcesso.updateMany).not.toHaveBeenCalled();
    expect(tx.$executeRaw).not.toHaveBeenCalled();
  });

  const casos: [string, (c: ReturnType<typeof emDia>) => unknown][] = [
    ['inexistente', () => null],
    ['usado', (c) => ({ ...c, usadoEm: new Date() })],
    ['revogado', (c) => ({ ...c, revogadoEm: new Date() })],
    ['expirado', (c) => ({ ...c, expiraEm: new Date(Date.now() - 1) })],
    [
      'senha trocada depois da emissão',
      (c) => ({ ...c, usuario: { ...c.usuario, senhaHash: '$2b$12$nova' } }),
    ],
    [
      'senha própria (senha_temporaria falsa)',
      (c) => ({ ...c, usuario: { ...c.usuario, senhaTemporaria: false } }),
    ],
    [
      'usuário inativo',
      (c) => ({ ...c, usuario: { ...c.usuario, status: 'inativo' } }),
    ],
    [
      'empresa inativa',
      (c) => ({
        ...c,
        usuario: {
          ...c.usuario,
          empresa: { nome: 'Clube Exemplo', status: 'inativa' },
        },
      }),
    ],
  ];

  it.each(casos)(
    '%s → 410 com o corpo único LINK_INVALIDO',
    async (_nome, estado) => {
      const { service, prisma } = montar();
      prisma.conviteDeAcesso.findUnique.mockResolvedValue(estado(emDia()));
      const erro = await recusa(service.consultarPublico(TOKEN));
      expect(erro).toBeInstanceOf(GoneException);
      expect(JSON.stringify((erro as GoneException).getResponse())).toBe(
        JSON.stringify(LINK_INVALIDO),
      );
    },
  );

  it.each([
    ['vazio', ''],
    ['curto', 'abc'],
    ['44 caracteres', 'a'.repeat(44)],
    ['com caractere fora do base64url', `${'a'.repeat(42)}+`],
    ['com preenchimento', `${'a'.repeat(42)}=`],
  ])('malformado (%s) → o mesmo 410, sem ir ao banco', async (_nome, token) => {
    const { service, prisma } = montar();
    const erro = await recusa(service.consultarPublico(token));
    expect(JSON.stringify((erro as GoneException).getResponse())).toBe(
      JSON.stringify(LINK_INVALIDO),
    );
    expect(prisma.conviteDeAcesso.findUnique).not.toHaveBeenCalled();
  });

  it('o corpo é o da D7: 410, LINK_INVALIDO, e o texto da página (D11)', () => {
    expect(LINK_INVALIDO).toEqual({
      statusCode: 410,
      code: 'LINK_INVALIDO',
      message: 'Este link não vale mais. Peça um novo convite ao seu clube.',
    });
    expect(Object.isFrozen(LINK_INVALIDO)).toBe(true);
  });
});

describe('SPEC-083 — ativar (D7)', () => {
  const TOKEN = 'b'.repeat(43);
  const conviteAchado = {
    id: 'convite-1',
    usuarioId: 'usuario-1',
    impressaoCredencial: sha256(SENHA_HASH_ATUAL),
  };
  const contaEmDia = {
    senha_hash: SENHA_HASH_ATUAL,
    senha_temporaria: true,
    status: 'ativo',
    empresa_status: 'ativa',
  };

  function pronto() {
    const ctx = montar();
    ctx.tx.conviteDeAcesso.findUnique.mockResolvedValue(conviteAchado);
    ctx.tx.$queryRaw.mockResolvedValue([contaEmDia]);
    return ctx;
  }

  it('os passos da D7, na ordem: bcrypt ANTES da transação; localizar; travar; reivindicar; senha; sessões', async () => {
    const { service, tx, ordem } = pronto();
    await service.ativar(TOKEN, 'senha-nova-forte');

    expect(ordem.slice(0, 2)).toEqual(['bcrypt', 'transacao:inicio']);
    expect(hashDoBcrypt).toHaveBeenCalledWith('senha-nova-forte', BCRYPT_COST);

    const passos = [
      tx.conviteDeAcesso.findUnique,
      tx.$queryRaw,
      tx.$executeRaw,
      tx.usuario.update,
      tx.refreshToken.updateMany,
    ].map((m) => m.mock.invocationCallOrder[0]);
    expect(passos).toEqual([...passos].sort((a, b) => a - b));

    expect(sqlDe(tx.$queryRaw)).toContain('FOR UPDATE OF u');
    const reivindicacao = sqlDe(tx.$executeRaw);
    expect(reivindicacao).toContain('SET usado_em = now()');
    expect(reivindicacao).toContain(
      'AND usado_em IS NULL AND revogado_em IS NULL AND expira_em > now()',
    );

    expect(tx.usuario.update).toHaveBeenCalledWith({
      where: { id: 'usuario-1' },
      data: {
        senhaHash: '$2b$12$senha-nova-do-link',
        senhaTemporaria: false,
        senhaTemporariaExpiraEm: null,
      },
    });
    expect(tx.refreshToken.updateMany).toHaveBeenCalledWith({
      where: { usuarioId: 'usuario-1', revokedAt: null },
      data: { revokedAt: expect.any(Date) as Date },
    });
  });

  const recusas: [string, (ctx: ReturnType<typeof pronto>) => void][] = [
    [
      'inexistente',
      (c) => c.tx.conviteDeAcesso.findUnique.mockResolvedValue(null),
    ],
    [
      'usuário inativo',
      (c) =>
        c.tx.$queryRaw.mockResolvedValue([
          { ...contaEmDia, status: 'inativo' },
        ]),
    ],
    [
      'senha própria',
      (c) =>
        c.tx.$queryRaw.mockResolvedValue([
          { ...contaEmDia, senha_temporaria: false },
        ]),
    ],
    [
      'empresa inativa',
      (c) =>
        c.tx.$queryRaw.mockResolvedValue([
          { ...contaEmDia, empresa_status: 'inativa' },
        ]),
    ],
    [
      'senha trocada depois da emissão (impressão não bate)',
      (c) =>
        c.tx.$queryRaw.mockResolvedValue([
          { ...contaEmDia, senha_hash: '$2b$12$regerada' },
        ]),
    ],
    [
      'usado, revogado ou expirado (a reivindicação não pega linha)',
      (c) => c.tx.$executeRaw.mockResolvedValue(0),
    ],
  ];

  it.each(recusas)(
    '%s → 410 LINK_INVALIDO, e a senha não muda',
    async (_nome, preparar) => {
      const ctx = pronto();
      preparar(ctx);
      const erro = await recusa(ctx.service.ativar(TOKEN, 'senha-nova-forte'));
      expect(JSON.stringify((erro as GoneException).getResponse())).toBe(
        JSON.stringify(LINK_INVALIDO),
      );
      expect(ctx.tx.usuario.update).not.toHaveBeenCalled();
      expect(ctx.tx.refreshToken.updateMany).not.toHaveBeenCalled();
    },
  );

  it('malformado → 410 sem bcrypt e sem transação', async () => {
    const { service, prisma } = montar();
    const erro = await recusa(service.ativar('curto', 'senha-nova-forte'));
    expect(JSON.stringify((erro as GoneException).getResponse())).toBe(
      JSON.stringify(LINK_INVALIDO),
    );
    expect(hashDoBcrypt).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('SPEC-083 — emitir (D9) e o envio depois do commit (D8)', () => {
  const travado = {
    id: 'usuario-1',
    email: 'maria@teste.local',
    nome: 'Maria Souza',
    senha_hash: SENHA_HASH_ATUAL,
    senha_temporaria: true,
    empresa_nome: 'Clube Exemplo',
  };

  function pronto() {
    const ctx = montar();
    ctx.tx.$queryRaw.mockResolvedValue([travado]);
    return ctx;
  }

  it('trava o usuário, revoga o vivo, insere o novo — e só DEPOIS do commit envia e grava o resultado', async () => {
    const { service, tx, prisma, provedor, ordem } = pronto();
    const resultado = await service.emitirParaUsuario(
      'empresa-1',
      'usuario-1',
      'gestor-1',
    );
    expect(resultado.ok).toBe(true);

    expect(ordem).toEqual([
      'transacao:inicio',
      'commit',
      'envio',
      'grava-resultado',
    ]);
    expect(sqlDe(tx.$queryRaw)).toContain('FOR UPDATE OF u');
    const [travar, revogar, inserir] = [
      tx.$queryRaw,
      tx.conviteDeAcesso.updateMany,
      tx.conviteDeAcesso.create,
    ].map((m) => m.mock.invocationCallOrder[0]);
    expect(travar).toBeLessThan(revogar);
    expect(revogar).toBeLessThan(inserir);
    expect(tx.conviteDeAcesso.updateMany).toHaveBeenCalledWith({
      where: { usuarioId: 'usuario-1', usadoEm: null, revogadoEm: null },
      data: { revogadoEm: expect.any(Date) as Date },
    });

    // O que foi ao banco: o hash do token que saiu no e-mail, a impressão da
    // senha lida sob a trava — e nunca o token.
    const token = tokenDoEmail(provedor);
    const [{ data }] = tx.conviteDeAcesso.create.mock.calls[0] as [
      { data: Record<string, unknown> },
    ];
    expect(data).toMatchObject({
      companyId: 'empresa-1',
      usuarioId: 'usuario-1',
      criadoPorId: 'gestor-1',
      tokenHash: sha256(token),
      impressaoCredencial: sha256(SENHA_HASH_ATUAL),
    });
    expect(JSON.stringify(data)).not.toContain(token);

    expect(provedor.enviados[0]).toMatchObject({
      to: 'maria@teste.local',
      chaveDeIdempotencia: 'convite-de-acesso/convite-novo',
    });
    expect(prisma.conviteDeAcesso.updateMany).toHaveBeenCalledWith({
      where: { id: 'convite-novo' },
      data: {
        emailResultado: 'enviado',
        emailMotivo: null,
        emailEm: expect.any(Date) as Date,
      },
    });
  });

  it('provedor recusa → grava falhou com o motivo, e avisa no log sem token nem link', async () => {
    const { service, prisma, provedor } = pronto();
    provedor.falharCom('cota');
    const aviso = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      await expect(
        service.emitirParaUsuario('empresa-1', 'usuario-1', 'gestor-1'),
      ).resolves.toEqual({ ok: false, motivo: 'cota' });
      expect(prisma.conviteDeAcesso.updateMany).toHaveBeenCalledWith({
        where: { id: 'convite-novo' },
        data: {
          emailResultado: 'falhou',
          emailMotivo: 'cota',
          emailEm: expect.any(Date) as Date,
        },
      });
      expect(aviso).toHaveBeenCalledWith({
        evento: 'convite_de_acesso_nao_enviado',
        conviteId: 'convite-novo',
        motivo: 'cota',
      });
    } finally {
      aviso.mockRestore();
    }
  });

  it('conta com senha própria → 409 CONTA_JA_ATIVADA, nada emitido e nada enviado', async () => {
    const { service, tx, provedor } = pronto();
    tx.$queryRaw.mockResolvedValue([{ ...travado, senha_temporaria: false }]);
    const erro = await recusa(
      service.emitirParaUsuario('empresa-1', 'usuario-1', 'gestor-1'),
    );
    expect(erro).toBeInstanceOf(ConflictException);
    expect((erro as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'CONTA_JA_ATIVADA',
    });
    expect(tx.conviteDeAcesso.updateMany).not.toHaveBeenCalled();
    expect(tx.conviteDeAcesso.create).not.toHaveBeenCalled();
    expect(provedor.blocos).toHaveLength(0);
  });

  it('conta fora da empresa (a trava não acha a linha) → 404', async () => {
    const { service, tx } = pronto();
    tx.$queryRaw.mockResolvedValue([]);
    await expect(
      service.emitirParaUsuario('outra-empresa', 'usuario-1', 'gestor-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(tx.conviteDeAcesso.create).not.toHaveBeenCalled();
  });

  it('P2002 do índice parcial (medido: ConviteDeAcesso, [usuario_id]) → 409 CONVITE_EM_EMISSAO, sem envio', async () => {
    const { service, tx, provedor } = pronto();
    tx.conviteDeAcesso.create.mockRejectedValue({
      code: 'P2002',
      meta: { modelName: 'ConviteDeAcesso', target: ['usuario_id'] },
    });
    const erro = await recusa(
      service.emitirParaUsuario('empresa-1', 'usuario-1', 'gestor-1'),
    );
    expect((erro as ConflictException).getResponse()).toMatchObject({
      statusCode: 409,
      code: 'CONVITE_EM_EMISSAO',
    });
    expect(provedor.blocos).toHaveLength(0);
  });

  it.each([
    [
      'o UNIQUE do token',
      { modelName: 'ConviteDeAcesso', target: ['token_hash'] },
    ],
    ['o e-mail da conta', { modelName: 'Usuario', target: ['email'] }],
  ])('outro P2002 (%s) sobe sem tradução', async (_nome, meta) => {
    const { service, tx } = pronto();
    const original = { code: 'P2002', meta };
    tx.conviteDeAcesso.create.mockRejectedValue(original);
    await expect(
      service.emitirParaUsuario('empresa-1', 'usuario-1', 'gestor-1'),
    ).rejects.toBe(original);
  });
});

describe('SPEC-083 — a ficha do aluno e a situação', () => {
  it('aluno de outra empresa → 404, sem transação e sem envio', async () => {
    const { service, prisma, provedor } = montar();
    prisma.aluno.findFirst.mockResolvedValue(null);
    await expect(
      service.enviarParaAluno('empresa-1', 'aluno-x', 'gestor-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.situacaoDoAluno('empresa-1', 'aluno-x'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const [args] = prisma.aluno.findFirst.mock.calls[0] as [
      { where: Record<string, string> },
    ];
    expect(args.where).toEqual({ id: 'aluno-x', companyId: 'empresa-1' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(provedor.blocos).toHaveLength(0);
  });

  it('situacao(null) é o professor sem conta: sem_conta, sem ir ao banco', async () => {
    const { service, prisma } = montar();
    await expect(service.situacao('empresa-1', null)).resolves.toMatchObject({
      situacao: 'sem_conta',
    });
    expect(prisma.usuario.findFirst).not.toHaveBeenCalled();
  });

  it('a conta é lida NA empresa: usuário de outra → 404', async () => {
    const { service, prisma } = montar();
    prisma.usuario.findFirst.mockResolvedValue(null);
    await expect(
      service.situacao('empresa-1', 'usuario-1'),
    ).rejects.toBeInstanceOf(NotFoundException);
    const [args] = prisma.usuario.findFirst.mock.calls[0] as [
      { where: Record<string, string> },
    ];
    expect(args.where).toEqual({ id: 'usuario-1', companyId: 'empresa-1' });
  });

  it('o vivo é procurado como o índice parcial o define: nem usado nem revogado', async () => {
    const { service, prisma } = montar();
    prisma.usuario.findFirst.mockResolvedValue({
      senhaTemporaria: true,
      senhaHash: SENHA_HASH_ATUAL,
    });
    await expect(
      service.situacao('empresa-1', 'usuario-1'),
    ).resolves.toMatchObject({ situacao: 'nao_enviado' });
    const [args] = prisma.conviteDeAcesso.findFirst.mock.calls[0] as [
      { where: Record<string, unknown> },
    ];
    expect(args.where).toEqual({
      usuarioId: 'usuario-1',
      usadoEm: null,
      revogadoEm: null,
    });
  });
});
