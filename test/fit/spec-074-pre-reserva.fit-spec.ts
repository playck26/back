/**
 * SPEC-074/TASK-004 — **FIT-054: a pré-reserva sob concorrência real, e na
 * composição que produção monta.**
 *
 * ## Por que sequencial não prova nada aqui
 *
 * Os db-specs rodam numa conexão só, e o Prisma serializa: quem chega depois
 * lê o estado já escrito, **sem que nenhum lock tenha sido exercitado**. Este
 * arquivo abre **conexões independentes** — e é o único lugar em que as quatro
 * peças de "um aviso só" (D7) são provadas UMA A UMA, como redundância
 * declarada:
 *
 * | AC | Peça | O que só ela faz |
 * |---|---|---|
 * | AC-024 | `FOR UPDATE SKIP LOCKED` | a segunda réplica PULA, não espera |
 * | AC-025 | a transição com `RETURNING` | só quem ela MUDOU recebe aviso |
 * | AC-026 | `ON CONFLICT … DO NOTHING` | a duplicata não aborta a transação |
 * | AC-010 | as quatro juntas | duas réplicas, um aviso por pedido |
 *
 * E mais três: **AC-021** (o varredor não trava `ocupacoes_quadra`), **AC-029**
 * (o pedido cancelado no meio do ciclo) e **AC-030** (a composição do
 * `AppModule` usa o seletor real).
 *
 * ## O `lock_timeout` vai na URL da conexão
 *
 * `options=-c lock_timeout=1s` — **medido antes de escrever este arquivo**: o
 * Prisma instalado o aplica a toda conexão do cliente (`SHOW lock_timeout` →
 * `1s`). Esperar por lock vira **erro `55P03`**, e não um tempo medido no
 * relógio: a prova é determinística.
 */
import type { INestApplication } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PrismaClient } from '@prisma/client';
import { VarredorDaPreReservaService } from '../../src/pre-reserva/varredor-da-pre-reserva.service';
import { SeletorDoLote } from '../../src/pre-reserva/seletor-do-lote';
import { PreReservaService } from '../../src/pre-reserva/pre-reserva.service';
import { TIPO_PRE_RESERVA } from '../../src/pre-reserva/aviso-da-pre-reserva';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { StudentsService } from '../../src/people/students.service';
import {
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
  parseDateOnly,
  parseTimeOnly,
} from '../../src/courts/date-time.util';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = 'f0540000-0000-4000-8000-000000000001';
const QUADRA = 'f0540000-0000-4000-8000-000000000002';

function urlComLockTimeout(): string {
  const base = process.env.DATABASE_URL as string;
  return `${base}${base.includes('?') ? '&' : '?'}options=-c%20lock_timeout%3D1s`;
}

/** Uma para semear, e as que correm. Com um cliente só, a corrida vira fila. */
const semear = new PrismaClient();
const dbA = new PrismaClient();
const dbC = new PrismaClient();
/** A conexão SOB TESTE: esperar por lock nela é `55P03` em 1 s. */
const dbB = new PrismaClient({
  datasources: { db: { url: urlComLockTimeout() } },
});

const q = (sql: string) => semear.$executeRawUnsafe(sql);

function configCom(lote: number): ConfigService {
  return {
    get: (chave: string) =>
      chave === 'PRE_RESERVA_LOTE' ? String(lote) : undefined,
  } as unknown as ConfigService;
}
const seletor = (c: PrismaClient, lote = 200) =>
  new SeletorDoLote(c as unknown as PrismaService, configCom(lote));
const varredor = (c: PrismaClient, sel = seletor(c)) => {
  const p = c as unknown as PrismaService;
  return new VarredorDaPreReservaService(
    p,
    sel,
    new HorarioFuncionamentoService(p),
  );
};

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Um lado da corrida, sem derrubar os outros. */
async function desfecho<T>(
  p: Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; erro: unknown }> {
  try {
    return { ok: true, valor: await p };
  } catch (erro) {
    return { ok: false, erro };
  }
}

function codigoDo(erro: unknown): string {
  const e = erro as { message?: string; meta?: { code?: string } };
  return `${e?.meta?.code ?? ''} ${String(e?.message ?? '')}`;
}

/**
 * **Segura um lock numa transação de outra conexão**, até `soltar()`. O
 * `timeout` da transação é longo de propósito: quem a encerra é o teste, não o
 * Prisma.
 */
async function segurar(
  cliente: PrismaClient,
  sql: string,
): Promise<{ soltar: () => Promise<void> }> {
  let liberar!: () => void;
  const liberado = new Promise<void>((r) => (liberar = r));
  let travou!: () => void;
  const travado = new Promise<void>((r) => (travou = r));
  const fim = cliente.$transaction(
    async (tx) => {
      await tx.$queryRawUnsafe(sql);
      travou();
      await liberado;
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  await travado;
  return {
    soltar: async () => {
      liberar();
      await fim;
    },
  };
}

let seq = 0;
async function aluno(
  status: 'ativo' | 'inativo' = 'ativo',
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(4, '0');
  const usuarioId = `f0540000-0000-4000-8000-10000000${s}`;
  const alunoId = `f0540000-0000-4000-8000-20000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit054.${seq}@x.com','h','A','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','${status}')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function avulsa(alunoId: string, dia: string, hora = '10:00') {
  ocSeq += 1;
  const id = `f0540000-0000-4000-8000-30000000${String(ocSeq).padStart(4, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${dia}','${hora}','${fim}','AVULSO','${alunoId}',80,'pendente_pagamento',now())`,
  );
  return id;
}

let pedSeq = 0;
async function pedido(opcoes: {
  alunoId: string;
  dia: string;
  hora?: string;
  criadaSegundosAtras?: number;
  verificadaSegundosAtras?: number;
}): Promise<string> {
  pedSeq += 1;
  const id = `f0540000-0000-4000-8000-40000000${String(pedSeq).padStart(4, '0')}`;
  const hora = opcoes.hora ?? '10:00';
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  const inicioEm = instanteNoFusoDoClube(
    parseDateOnly(opcoes.dia),
    parseTimeOnly(hora),
  ).toISOString();
  await q(
    `INSERT INTO pre_reservas (id,company_id,aluno_id,quadra_id,data,hora_inicio,hora_fim,inicio_em,criada_em,verificada_em)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}','${QUADRA}','${opcoes.dia}','${hora}','${fim}','${inicioEm}',
             now() - interval '${opcoes.criadaSegundosAtras ?? 0} seconds',
             ${
               opcoes.verificadaSegundosAtras === undefined
                 ? 'NULL'
                 : `now() - interval '${opcoes.verificadaSegundosAtras} seconds'`
             })`,
  );
  return id;
}

const estado = async (id: string) =>
  (await semear.preReserva.findUniqueOrThrow({ where: { id } })).estado;
const avisos = (origemId: string) =>
  semear.notificacao.count({ where: { origemId, tipo: TIPO_PRE_RESERVA } });

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-054','fit-054-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
}

beforeEach(async () => {
  await limparEmpresa(semear, EMPRESA);
  await montar();
});

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  for (const c of [semear, dbA, dbB, dbC]) await c.$disconnect();
});

describe('FIT-054 — a pré-reserva sob concorrência', () => {
  it('AC-010 — duas réplicas ao mesmo tempo, dois slots com um pedido cada: EXATAMENTE dois avisos, e nenhum ciclo em erro', async () => {
    const p1 = await pedido({
      alunoId: (await aluno()).alunoId,
      dia: emDias(3),
    });
    const p2 = await pedido({
      alunoId: (await aluno()).alunoId,
      dia: emDias(4),
    });

    const [a, c] = await Promise.all([
      desfecho(varredor(dbA).executarCiclo()),
      desfecho(varredor(dbC).executarCiclo()),
    ]);

    expect(a.ok).toBe(true);
    expect(c.ok).toBe(true);
    expect(await avisos(p1)).toBe(1);
    expect(await avisos(p2)).toBe(1);
    expect(await estado(p1)).toBe('avisada');
    expect(await estado(p2)).toBe('avisada');
  });

  it('AC-021 — o varredor NÃO espera por lock em `ocupacoes_quadra`', async () => {
    const dono = await aluno();
    const eu = await aluno();
    const reserva = await avulsa(dono.alunoId, emDias(3));
    const meu = await pedido({ alunoId: eu.alunoId, dia: emDias(3) });
    // Outra conexão segura a ocupação que cobre o slot — como um
    // cancelamento ou um movimento em andamento.
    const trava = await segurar(
      dbA,
      `SELECT id FROM ocupacoes_quadra WHERE id = '${reserva}' FOR UPDATE`,
    );
    try {
      const r = await desfecho(varredor(dbB).executarCiclo());
      if (!r.ok)
        throw new Error(`o ciclo esperou por lock: ${codigoDo(r.erro)}`);
      expect(await estado(meu)).toBe('aguardando');
    } finally {
      await trava.soltar();
    }
  });

  it('AC-024 — a AQUISIÇÃO: com os pedidos de S travados por outra réplica, o ciclo não espera, pula S e avisa T', async () => {
    const s = await pedido({
      alunoId: (await aluno()).alunoId,
      dia: emDias(3),
    });
    const t = await pedido({
      alunoId: (await aluno()).alunoId,
      dia: emDias(4),
    });
    const trava = await segurar(
      dbA,
      `SELECT id FROM pre_reservas WHERE id = '${s}' FOR UPDATE`,
    );
    try {
      const r = await desfecho(varredor(dbB).executarCiclo());
      if (!r.ok)
        throw new Error(`o ciclo esperou por lock: ${codigoDo(r.erro)}`);
      expect(await estado(t)).toBe('avisada');
    } finally {
      await trava.soltar();
    }
    expect(await estado(s)).toBe('aguardando');
    expect(await avisos(s)).toBe(0);
  });

  it('AC-025 — a TRANSIÇÃO: no mesmo slot, o aluno que deixou de operar é adquirido, encerrado, e NÃO recebe aviso', async () => {
    const operante = await aluno();
    const desligado = await aluno('inativo');
    const doOperante = await pedido({
      alunoId: operante.alunoId,
      dia: emDias(3),
    });
    const doDesligado = await pedido({
      alunoId: desligado.alunoId,
      dia: emDias(3),
    });

    await varredor(dbA).executarCiclo();

    expect(await estado(doOperante)).toBe('avisada');
    expect(await avisos(doOperante)).toBe(1);
    expect(await estado(doDesligado)).toBe('encerrada');
    expect(await avisos(doDesligado)).toBe(0);
  });

  it('AC-026 — pelo comando do VARREDOR, o aviso que já existe vira contagem zero: sem erro, e a transação comita a transição', async () => {
    const eu = await aluno();
    const meu = await pedido({ alunoId: eu.alunoId, dia: emDias(3) });
    await q(
      `INSERT INTO notificacoes (id,company_id,destinatario_id,origem_id,tipo,titulo,corpo)
       VALUES (gen_random_uuid(),'${EMPRESA}','${eu.usuarioId}','${meu}','${TIPO_PRE_RESERVA}','Horário livre','já existia')`,
    );

    const r = await desfecho(varredor(dbA).executarCiclo());

    if (!r.ok) throw new Error(`o ciclo abortou: ${codigoDo(r.erro)}`);
    expect(r.valor.avisadas).toBe(0);
    // A transição COMITOU: a mesma transação do INSERT que não inseriu nada.
    expect(await estado(meu)).toBe('avisada');
    expect(await avisos(meu)).toBe(1);
  });

  it('AC-029 — o pedido CANCELADO entre o lote e a aquisição não recebe aviso; o outro do slot, sim', async () => {
    const donoDeP = await aluno();
    const donoDeQ = await aluno();
    const p = await pedido({ alunoId: donoDeP.alunoId, dia: emDias(3) });
    const q2 = await pedido({ alunoId: donoDeQ.alunoId, dia: emDias(3) });
    const real = seletor(dbA);
    const pc = dbC as unknown as PrismaService;
    const cancelando = new PreReservaService(
      pc,
      new HorarioFuncionamentoService(pc),
      new StudentsService(pc),
    );
    // A costura (D7): o seletor REAL seleciona, e antes de devolver o lote
    // o pedido P é cancelado PELO SERVIÇO, em outra conexão, e comita.
    const envolvido = {
      selecionar: async () => {
        const lote = await real.selecionar();
        await cancelando.cancelar(EMPRESA, donoDeP.usuarioId, p);
        return lote;
      },
    } as unknown as SeletorDoLote;

    const r = await desfecho(varredor(dbA, envolvido).executarCiclo());

    if (!r.ok) throw new Error(`o ciclo falhou: ${codigoDo(r.erro)}`);
    expect(await estado(p)).toBe('cancelada');
    expect(await avisos(p)).toBe(0);
    expect(await estado(q2)).toBe('avisada');
    expect(await avisos(q2)).toBe(1);
  });
});

describe('FIT-054 / AC-030 — a composição de produção usa o seletor real', () => {
  let app: INestApplication | undefined;
  const anterior = process.env.PRE_RESERVA_LOTE;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('pelo `AppModule` de verdade, com lote 1 pela CONFIGURAÇÃO: o 1º ciclo avisa S, o 2º avisa T', async () => {
    // Com o agendador armado, um ciclo automático correria junto com o do
    // teste (R-01 da 6ª rodada).
    expect(process.env.NODE_ENV).toBe('test');

    const a = await aluno();
    const b = await aluno();
    const c = await aluno();
    // O cenário da AC-027/2: S = pedido de A verificado em t0 + pedido de B
    // criado em t2; T = pedido de C criado em t1; t0 < t1 < t2; e o
    // `inicio_em` de T vem ANTES do de S.
    const sA = await pedido({
      alunoId: a.alunoId,
      dia: emDias(5),
      criadaSegundosAtras: 60,
      verificadaSegundosAtras: 30,
    });
    const sB = await pedido({
      alunoId: b.alunoId,
      dia: emDias(5),
      criadaSegundosAtras: 10,
    });
    const tC = await pedido({
      alunoId: c.alunoId,
      dia: emDias(4),
      criadaSegundosAtras: 20,
    });

    process.env.PRE_RESERVA_LOTE = '1';
    try {
      app = await subirAppReal();
      // O que produção monta, sem nada construído à mão — a configuração é a
      // ÚNICA diferença.
      const doApp = app.get(VarredorDaPreReservaService);

      await doApp.executarCiclo();
      expect(await estado(sA)).toBe('avisada');
      expect(await estado(sB)).toBe('avisada');
      expect(await estado(tC)).toBe('aguardando');

      await doApp.executarCiclo();
      expect(await estado(tC)).toBe('avisada');
    } finally {
      // Num `finally`, e distinguindo ausente de presente: a variável é do
      // processo, e os FITs seguintes no mesmo worker rodariam com lote 1
      // (R-01 da 7ª rodada).
      if (anterior === undefined) delete process.env.PRE_RESERVA_LOTE;
      else process.env.PRE_RESERVA_LOTE = anterior;
    }
  });
});
