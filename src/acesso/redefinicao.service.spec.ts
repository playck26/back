import { GoneException, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { LogoDaEmpresaService } from '../companies/logo-da-empresa.service';
import type { ConfiguracaoDosModelos } from '../email/email.config';
import { MemoriaProvedorDeEmail } from '../email/memoria-provedor-de-email';
import type { MotivoDaFalha } from '../email/provedor-de-email';
import type { PrismaService } from '../prisma/prisma.service';
import { EsqueciSenhaController } from './redefinicao-publica.controller';
import {
  destinoDoPedido,
  REDEFINICAO_INVALIDA,
  RedefinicaoService,
  TETO_DE_PEDIDOS_POR_HORA,
} from './redefinicao.service';

/**
 * SPEC-090/TASK-002 — **o `RedefinicaoService` e o controller do pedido, com
 * dublê do Prisma.** O que só o banco prova (o teto pelo relógio do banco, as
 * travas, a ordem das contas, a limpeza) está em `test/banco/spec-090-*`; aqui
 * fica a regra que o serviço decide sozinho:
 *
 * - AC-004: o controller não espera o serviço;
 * - D6 (AC-008, AC-009): o destino do link pelo papel, e a mistura que não
 *   emite;
 * - D3: sem conta, acima do teto e misturado não gravam nem enviam;
 * - AC-022: o envio falhando grava `falhou` e o motivo;
 * - AC-017: nenhum log com token, link, senha ou o e-mail pedido.
 */

const CONFIG: ConfiguracaoDosModelos = {
  remetente: 'nao-responda@playck.com.br',
  responderPara: 'suporte@playck.com.br',
  urlCliente: 'https://cliente.unit.teste.local',
  urlAdmin: 'https://admin.unit.teste.local',
};

const EMAIL = 'pessoa.pedida@exemplo.com.br';
const PEDIDO_ID = '00000000-0000-4000-8000-0000000090aa';

interface ContaFalsa {
  usuario_id: string;
  company_id: string;
  role: string;
  senha_hash: string;
}

/**
 * O dublê do Prisma: a transação chama o callback com um `tx` cujo `$queryRaw`
 * responde pela FORMA da instrução — as contas, a contagem do teto e o
 * `INSERT … RETURNING`. O resto é `jest.fn` para o teste conferir.
 */
function dublePrisma(opcoes: { contas: ContaFalsa[]; pedidosNaHora?: number }) {
  const instrucoes: string[] = [];
  const createMany = jest.fn().mockResolvedValue({ count: 0 });
  const tx = {
    $queryRaw: jest.fn((partes: TemplateStringsArray) => {
      const sql = partes.join('?');
      instrucoes.push(sql);
      if (/FROM usuarios u/.test(sql)) return Promise.resolve(opcoes.contas);
      if (/count\(\*\)/.test(sql)) {
        return Promise.resolve([{ pedidos: opcoes.pedidosNaHora ?? 0 }]);
      }
      if (/INSERT INTO pedidos_de_redefinicao/.test(sql)) {
        return Promise.resolve([{ id: PEDIDO_ID }]);
      }
      return Promise.reject(new Error(`instrução inesperada: ${sql}`));
    }),
    contaDaRedefinicao: { createMany },
  };
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const prisma = {
    $transaction: jest.fn((cb: (t: typeof tx) => Promise<unknown>) => cb(tx)),
    pedidoDeRedefinicao: { updateMany },
  };
  return { prisma, tx, createMany, updateMany, instrucoes };
}

function servico(
  prisma: unknown,
  provedor = new MemoriaProvedorDeEmail(),
): RedefinicaoService {
  const logos = {
    resolver: () => ({ logoUrl: null }),
  } as unknown as LogoDaEmpresaService;
  return new RedefinicaoService(
    prisma as PrismaService,
    provedor,
    CONFIG,
    logos,
  );
}

function aluno(n: number, role = 'aluno'): ContaFalsa {
  return {
    usuario_id: `00000000-0000-4000-8000-00000000010${n}`,
    company_id: `00000000-0000-4000-8000-00000000020${n}`,
    role,
    senha_hash: `$2b$04$hash-da-conta-${n}`,
  };
}

const METODOS_DO_LOGGER = ['log', 'warn', 'error', 'debug', 'verbose'] as const;
let espioes: jest.SpyInstance[];
beforeEach(() => {
  espioes = METODOS_DO_LOGGER.map((metodo) =>
    jest.spyOn(Logger.prototype, metodo).mockImplementation(() => undefined),
  );
});
afterEach(() => {
  jest.restoreAllMocks();
});

/** Tudo o que foi a log neste teste, como texto. */
function registrado(): string {
  return espioes
    .flatMap((espiao) => espiao.mock.calls as unknown[][])
    .map((argumentos) => JSON.stringify(argumentos))
    .join('\n');
}

describe('SPEC-090/AC-004 — o controller responde sem esperar o serviço (D1, S1)', () => {
  it('com um solicitar que só resolve quando o teste mandar, o handler já devolveu — e não devolveu promessa', async () => {
    let liberar!: () => void;
    const pendente = new Promise<void>((r) => (liberar = r));
    const solicitar = jest.fn(() => pendente);
    const controller = new EsqueciSenhaController({
      solicitar,
    } as unknown as RedefinicaoService);

    // Um handler com `await` seria `async` e devolveria uma promessa presa ao
    // `solicitar`: o `202` esperaria a consulta, o bcrypt e o envio.
    const devolvido: unknown = controller.esqueciSenha({ email: EMAIL });
    expect(devolvido).toBeUndefined();
    expect(solicitar).toHaveBeenCalledWith(EMAIL);

    liberar();
    await pendente;
  });

  it('a falha do serviço vai a log só como evento: sem o e-mail, sem o erro', async () => {
    const erro = new Error(`falhou com ${EMAIL} e o token abc`);
    const controller = new EsqueciSenhaController({
      solicitar: () => Promise.reject(erro),
    } as unknown as RedefinicaoService);

    controller.esqueciSenha({ email: EMAIL });
    await new Promise((r) => setImmediate(r));

    const log = registrado();
    expect(log).toContain('redefinicao_falhou');
    expect(log).not.toContain(EMAIL);
    expect(log).not.toContain('abc');
  });
});

describe('SPEC-090/D6 — o destino do link pelo papel das contas (AC-008, AC-009)', () => {
  it.each<[string, string[], 'admin' | 'cliente' | null]>([
    ['um gestor', ['company_admin'], 'admin'],
    ['um aluno', ['aluno'], 'cliente'],
    ['um professor', ['professor'], 'cliente'],
    ['aluno e professor', ['aluno', 'professor'], 'cliente'],
    ['três de Cliente', ['aluno', 'aluno', 'professor'], 'cliente'],
    ['gestor e aluno (misturados)', ['company_admin', 'aluno'], null],
    ['dois gestores', ['company_admin', 'company_admin'], null],
    ['super_admin', ['super_admin'], null],
    ['nenhuma', [], null],
  ])('%s → %s', (_rotulo, papeis, esperado) => {
    expect(destinoDoPedido(papeis)).toBe(esperado);
  });
});

describe('SPEC-090/D3 — quem entra no pedido, o teto e o envio', () => {
  it('sem conta: nada gravado, nada enviado, nem contagem de teto', async () => {
    const d = dublePrisma({ contas: [] });
    const memoria = new MemoriaProvedorDeEmail();
    await servico(d.prisma, memoria).solicitar(EMAIL);

    expect(d.instrucoes).toHaveLength(1);
    expect(d.createMany).not.toHaveBeenCalled();
    expect(memoria.blocos).toHaveLength(0);
    expect(d.updateMany).not.toHaveBeenCalled();
  });

  it('AC-007 — no teto (3 na hora): nada gravado, nada enviado', async () => {
    expect(TETO_DE_PEDIDOS_POR_HORA).toBe(3);
    const d = dublePrisma({
      contas: [aluno(1)],
      pedidosNaHora: TETO_DE_PEDIDOS_POR_HORA,
    });
    const memoria = new MemoriaProvedorDeEmail();
    await servico(d.prisma, memoria).solicitar(EMAIL);

    expect(
      d.instrucoes.some((sql) =>
        /INSERT INTO pedidos_de_redefinicao/.test(sql),
      ),
    ).toBe(false);
    expect(d.createMany).not.toHaveBeenCalled();
    expect(memoria.blocos).toHaveLength(0);
  });

  it('AC-007 — abaixo do teto (2 na hora): grava e envia', async () => {
    const d = dublePrisma({ contas: [aluno(1)], pedidosNaHora: 2 });
    const memoria = new MemoriaProvedorDeEmail();
    await servico(d.prisma, memoria).solicitar(EMAIL);
    expect(memoria.enviados).toHaveLength(1);
  });

  it('o teto é contado pela janela de 1 hora do relógio do banco (S11)', async () => {
    const d = dublePrisma({ contas: [aluno(1)] });
    await servico(d.prisma).solicitar(EMAIL);
    const contagem = d.instrucoes.find((sql) => /count\(\*\)/.test(sql));
    expect(contagem).toMatch(/criado_em > now\(\) - interval '1 hour'/);
  });

  it('AC-009 — papéis misturados: não grava, não envia, e o log é só o evento, sem o e-mail', async () => {
    const d = dublePrisma({
      contas: [aluno(1, 'company_admin'), aluno(2, 'aluno')],
    });
    const memoria = new MemoriaProvedorDeEmail();
    await servico(d.prisma, memoria).solicitar(EMAIL);

    expect(d.createMany).not.toHaveBeenCalled();
    expect(memoria.blocos).toHaveLength(0);
    expect(registrado()).toContain('redefinicao_papeis_misturados');
    expect(registrado()).not.toContain(EMAIL);
  });

  it('AC-005 — duas contas: uma linha por conta, com a impressão do senha_hash lido na transação, e um envio com a linha dos 2 clubes', async () => {
    const contas = [aluno(1, 'aluno'), aluno(2, 'professor')];
    const d = dublePrisma({ contas });
    const memoria = new MemoriaProvedorDeEmail();
    await servico(d.prisma, memoria).solicitar(EMAIL);

    const sha = (v: string) => createHash('sha256').update(v).digest('hex');
    expect(d.createMany).toHaveBeenCalledWith({
      data: contas.map((c) => ({
        pedidoId: PEDIDO_ID,
        companyId: c.company_id,
        usuarioId: c.usuario_id,
        impressaoCredencial: sha(c.senha_hash),
      })),
    });
    expect(memoria.enviados).toHaveLength(1);
    const [mensagem] = memoria.enviados;
    expect(mensagem.to).toBe(EMAIL);
    expect(mensagem.text).toContain('Seu e-mail tem conta em 2 clubes.');
    expect(mensagem.chaveDeIdempotencia).toBe(
      `redefinicao-de-senha/${PEDIDO_ID}`,
    );
    expect(d.updateMany).toHaveBeenCalledWith({
      where: { id: PEDIDO_ID },
      data: expect.objectContaining({
        emailResultado: 'enviado',
        emailMotivo: null,
      }) as unknown,
    });
  });

  it('AC-006 — a busca das contas não filtra senha temporária (I4, S10)', async () => {
    const d = dublePrisma({ contas: [aluno(1)] });
    await servico(d.prisma).solicitar(EMAIL);
    const busca = d.instrucoes.find((sql) => /FROM usuarios u/.test(sql));
    expect(busca).toBeDefined();
    expect(busca).not.toMatch(/senha_temporaria/);
  });

  it('AC-008 — aluno recebe link de URL_CLIENTE; gestor, de URL_ADMIN (S4)', async () => {
    const doAluno = new MemoriaProvedorDeEmail();
    await servico(
      dublePrisma({ contas: [aluno(1)] }).prisma,
      doAluno,
    ).solicitar(EMAIL);
    const doGestor = new MemoriaProvedorDeEmail();
    await servico(
      dublePrisma({ contas: [aluno(1, 'company_admin')] }).prisma,
      doGestor,
    ).solicitar(EMAIL);

    const link = (texto: string) =>
      /(https:\/\/[^/\s]+)\/redefinir-senha\/[A-Za-z0-9_-]{43}/.exec(
        texto,
      )?.[1];
    expect(link(doAluno.enviados[0].text)).toBe(CONFIG.urlCliente);
    expect(link(doGestor.enviados[0].text)).toBe(CONFIG.urlAdmin);
  });

  it.each<MotivoDaFalha>(['cota', 'indisponivel', 'tempo_esgotado'])(
    'AC-022 — envio falhando com %s: o pedido fica com falhou e o motivo; o log leva o id e o motivo, nunca o e-mail, o link ou o token (AC-017)',
    async (motivo) => {
      const d = dublePrisma({ contas: [aluno(1)] });
      const memoria = new MemoriaProvedorDeEmail();
      memoria.falharCom(motivo);
      // Para ler o token e o link que a falha não pode registrar.
      const enviar = jest.spyOn(memoria, 'enviar');
      await servico(d.prisma, memoria).solicitar(EMAIL);

      expect(d.updateMany).toHaveBeenCalledWith({
        where: { id: PEDIDO_ID },
        data: expect.objectContaining({
          emailResultado: 'falhou',
          emailMotivo: motivo,
        }) as unknown,
      });
      const mensagem = enviar.mock.calls[0][0];
      const link = /https:\/\/\S+\/redefinir-senha\/([A-Za-z0-9_-]{43})/.exec(
        mensagem.text,
      );
      expect(link).not.toBeNull();

      const log = registrado();
      expect(log).toContain('redefinicao_nao_enviada');
      expect(log).toContain(PEDIDO_ID);
      expect(log).toContain(motivo);
      expect(log).not.toContain(EMAIL);
      expect(log).not.toContain(link![0]);
      expect(log).not.toContain(link![1]);
    },
  );
});

describe('SPEC-090/D4 — o 410 é um corpo só, constante', () => {
  it('REDEFINICAO_INVALIDA é exatamente o da spec, e congelado', () => {
    expect(REDEFINICAO_INVALIDA).toEqual({
      statusCode: 410,
      code: 'LINK_INVALIDO',
      message: 'Este link não vale mais. Peça outro em "Esqueceu a senha?".',
    });
    expect(Object.isFrozen(REDEFINICAO_INVALIDA)).toBe(true);
  });

  it.each(['', 'curto', 'a'.repeat(44), `${'a'.repeat(42)}!`])(
    'token malformado (%j): 410 sem tocar o banco, no GET e no POST',
    async (token) => {
      const prisma = {
        pedidoDeRedefinicao: { findUnique: jest.fn() },
        $transaction: jest.fn(),
      };
      const s = servico(prisma);

      await expect(s.consultar(token)).rejects.toBeInstanceOf(GoneException);
      await expect(
        s.redefinir(
          token,
          '00000000-0000-4000-8000-000000000001',
          'senha-nova',
        ),
      ).rejects.toBeInstanceOf(GoneException);
      expect(prisma.pedidoDeRedefinicao.findUnique).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );
});
