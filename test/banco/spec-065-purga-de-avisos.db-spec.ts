/**
 * SPEC-065/TASK-002 — **a purga, contra o banco de verdade.**
 *
 * É a única coisa desta spec que **apaga dado**, e por isso a prova é a mais
 * dura: o que ela não pode apagar importa mais que o que ela apaga.
 *
 * O que só o banco decide, e está aqui por isso:
 *
 *   (a) o **advisory lock** de verdade — duas conexões, e a segunda desiste
 *       sem esperar (AC-012). Nenhum dublê reproduz `pg_try_advisory_xact_lock`;
 *   (b) a **drenagem em lotes** (AC-021): com mais elegíveis que o teto, o
 *       ciclo repete até acabar. A v2 da spec apagava um lote e desistia, e
 *       isso era represa, não teto;
 *   (c) o `CHECK notificacoes_terminal_conclusao_chk` tornando
 *       `concluida_em IS NOT NULL` equivalente a "estado terminal" — é essa
 *       equivalência que deixa o predicado da purga ser tão simples.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import {
  CHAVE_DA_PURGA_DE_AVISOS,
  PurgaDeAvisosService,
  RETENCAO_DIAS,
  TETO_POR_LOTE,
} from '../../src/push/purga-de-avisos.service';
import { ChaveDeLock } from '../../src/common/lock/chave-de-lock';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = '065f0650-0000-4000-8000-000000000001';
const USUARIO = '065f0650-0000-4000-8000-000000000002';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const purga = (cliente: PrismaClient = db) =>
  new PurgaDeAvisosService(cliente as unknown as PrismaService);

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-065','spec-065-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${USUARIO}','purga065@teste.local','x','A','company_admin','${EMPRESA}',now())`,
  );
}

/**
 * Semeia `quantas` linhas de uma vez. Uma instrução, e não um laço: semear
 * 12.000 linhas a uma por vez levaria mais tempo que o teste inteiro.
 */
async function semear(opcoes: {
  quantas: number;
  diasAtras: number;
  terminal: boolean;
}): Promise<void> {
  const concluida = opcoes.terminal
    ? `now() - interval '${opcoes.diasAtras} days'`
    : 'NULL';
  const estado = opcoes.terminal ? 'aceita_pelo_servico' : 'pendente';
  await q(
    `INSERT INTO notificacoes
       (id, company_id, destinatario_id, origem_id, tipo, titulo, corpo,
        criada_em, estado, concluida_em)
     SELECT gen_random_uuid(), '${EMPRESA}', '${USUARIO}', gen_random_uuid(),
            'gesto', 'Sua aula', 'a' || g,
            now() - interval '${opcoes.diasAtras} days',
            '${estado}'::estado_da_notificacao, ${concluida}
       FROM generate_series(1, ${opcoes.quantas}) g`,
  );
}

const quantas = () => db.notificacao.count({ where: { companyId: EMPRESA } });

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-065/AC-010 — o que a purga apaga', () => {
  it('apaga terminal mais velho que a retenção, e NÃO toca no recente', async () => {
    await semear({ quantas: 5, diasAtras: RETENCAO_DIAS + 10, terminal: true });
    await semear({ quantas: 3, diasAtras: RETENCAO_DIAS - 10, terminal: true });

    const r = await purga().executarCiclo();

    expect(r.apagadas).toBe(5);
    expect(await quantas()).toBe(3);
  });

  /**
   * **A fronteira, e ela é `<`, não `<=`.** Um aviso com exatamente 90 dias
   * ainda está dentro da retenção.
   */
  it('a fronteira exata da retenção fica', async () => {
    await q(
      `INSERT INTO notificacoes
         (id,company_id,destinatario_id,origem_id,tipo,titulo,corpo,criada_em,estado,concluida_em)
       VALUES (gen_random_uuid(),'${EMPRESA}','${USUARIO}',gen_random_uuid(),
               'gesto','Sua aula','na fronteira',
               now() - interval '${RETENCAO_DIAS} days' + interval '1 minute',
               'aceita_pelo_servico', now())`,
    );

    const r = await purga().executarCiclo();

    expect(r.apagadas).toBe(0);
    expect(await quantas()).toBe(1);
  });
});

describe('SPEC-065/AC-011 — o que a purga NUNCA apaga', () => {
  /**
   * Linha `pendente` com 90 dias **não deveria existir** — o TTL máximo é 24 h.
   * Se existir, é defeito do tick. **Apagá-la esconderia o defeito.**
   */
  it('linha NÃO terminal antiga sobrevive, e é CONTADA', async () => {
    await semear({
      quantas: 4,
      diasAtras: RETENCAO_DIAS + 30,
      terminal: false,
    });
    await semear({ quantas: 2, diasAtras: RETENCAO_DIAS + 30, terminal: true });

    const r = await purga().executarCiclo();

    expect(r.apagadas).toBe(2);
    expect(r.naoTerminaisAntigas).toBe(4);
    expect(await quantas()).toBe(4);
  });

  it('sem linha velha não terminal, o contador é zero', async () => {
    await semear({ quantas: 2, diasAtras: RETENCAO_DIAS + 5, terminal: true });
    const r = await purga().executarCiclo();
    expect(r.naoTerminaisAntigas).toBe(0);
  });
});

describe('SPEC-065/AC-021 — a purga DRENA', () => {
  /**
   * **O caso que a v2 da spec falhava.** Ela apagava um lote e desistia, e o
   * resto esperava o dia seguinte — que trazia mais linhas novas. Represa,
   * não teto.
   *
   * O teto por lote existe para não segurar a tabela numa transação longa;
   * o laço existe para alcançar o atraso. Os dois juntos, e não um ou outro.
   */
  it('mais elegíveis que o teto: apaga TODAS, em lotes sucessivos', async () => {
    const total = TETO_POR_LOTE + 1_200;
    await semear({
      quantas: total,
      diasAtras: RETENCAO_DIAS + 1,
      terminal: true,
    });

    const r = await purga().executarCiclo();

    expect(r.apagadas).toBe(total);
    expect(r.lotes).toBeGreaterThan(1);
    expect(r.esgotouOOrcamento).toBe(false);
    expect(r.restantes).toBeNull();
    expect(await quantas()).toBe(0);
  });

  /**
   * **`restantes` só é contado quando o orçamento acaba** — é a única consulta
   * cara do worker, e roda só no caso interessante.
   */
  it('orçamento esgotado: registra restantes e não mente sobre ter drenado', async () => {
    await semear({
      quantas: TETO_POR_LOTE + 500,
      diasAtras: RETENCAO_DIAS + 1,
      terminal: true,
    });

    // Relógio que estoura o orçamento depois do primeiro lote. **Virtual de
    // propósito:** esperar 30 s de relógio de parede faria o teste medir a
    // máquina em vez da decisão.
    let chamadas = 0;
    const agora = () => (chamadas++ === 0 ? 0 : 999_999);

    const r = await purga().executarCiclo(agora);

    expect(r.esgotouOOrcamento).toBe(true);
    expect(r.restantes).not.toBeNull();
    expect(r.restantes).toBeGreaterThan(0);
    expect(await quantas()).toBeGreaterThan(0);
  });
});

describe('SPEC-065/AC-012 — duas réplicas não apagam em duplicata', () => {
  /**
   * **Duas conexões independentes, como duas réplicas do App Platform.** Uma
   * pool só serializaria o que deveria disputar, e o teste passaria dizendo
   * nada — a mesma armadilha que o FIT-001 documenta para o overbooking.
   *
   * **A chave vem do `ChaveDeLock`, e não de um `md5` reescrito no SQL.** A
   * primeira versão deste teste reimplementava o cálculo, e isso é exatamente
   * o que a INV-043 proíbe: dois trechos calculando `bigint` diferente para a
   * mesma string travariam coisas diferentes, e **nada falharia** — o teste
   * ficaria verde sobre um lock que não é o mesmo.
   */
  it('com o lock tomado, a purga DESISTE e não apaga nada', async () => {
    await semear({ quantas: 10, diasAtras: RETENCAO_DIAS + 1, terminal: true });

    const outra = new PrismaClient();
    try {
      let soltar: () => void = () => {};
      const segurando = new Promise<void>((resolve) => {
        soltar = resolve;
      });

      let tomou = false;
      const presa = outra.$transaction(
        async (tx) => {
          const linhas = await tx.$queryRaw<{ tomou: boolean }[]>`
            SELECT pg_try_advisory_xact_lock(${ChaveDeLock.deTexto(
              CHAVE_DA_PURGA_DE_AVISOS,
            )}::bigint) AS tomou`;
          tomou = linhas[0]?.tomou === true;
          await segurando;
        },
        { timeout: 60_000 },
      );

      // Espera a outra conexão TOMAR o lock de verdade, em vez de dormir um
      // tempo arbitrário: relógio de parede já derrubou FIT neste projeto.
      const ate = Date.now() + 15_000;
      while (!tomou && Date.now() < ate) {
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(tomou).toBe(true);

      const r = await purga().executarCiclo();

      // **A prova:** desistiu, e não apagou uma linha sequer.
      expect(r.lockOcupado).toBe(true);
      expect(r.apagadas).toBe(0);
      expect(r.lotes).toBe(0);
      expect(await quantas()).toBe(10);

      soltar();
      await presa;

      // E com o lock livre, o mesmo ciclo faz o trabalho.
      const depois = await purga().executarCiclo();
      expect(depois.lockOcupado).toBe(false);
      expect(depois.apagadas).toBe(10);
    } finally {
      await outra.$disconnect();
    }
  });
});
