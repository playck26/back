/**
 * DEF-041 — **a lista de reposição oferecia aula de hoje que já começou.**
 *
 * Relato da Smart Tennis (2026-11-12, 17h38): remarcando a aula das 20h, a
 * lista mostrava aulas "desde as 7h da manhã de hoje". Reproduzido com o
 * relógio às 18h38: a lista trazia 07h e 18h de hoje, e o `POST` recusava as
 * duas com `PRAZO_DE_CANCELAMENTO` ("Esta aula já começou"). Num clube com
 * prazo de 2h, a das 19h também vinha, recusada com "exige 2h".
 *
 * O que este arquivo prova é a **igualdade**: o conjunto que a lista oferece
 * é exatamente o conjunto que o `POST` aceita — com e sem prazo —, e o corte
 * acontece antes do `take: 200`.
 *
 * Só o `Date` é falso (18h38 do dia de hoje no fuso do clube): os timers são
 * os reais, para o Prisma funcionar.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import {
  formatDateOnly,
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
  parseTimeOnly,
} from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { comNivelDaFixture, primeiroNivelSql } from './nivel-da-fixture';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04100000-0000-4000-8000-000000000001';
const QUADRA = '04100000-0000-4000-8000-000000000002';
const QUADRA_2 = '04100000-0000-4000-8000-000000000003';
const TURMA_DELE = '04100000-0000-4000-8000-00000000000a';
const OUTRA = '04100000-0000-4000-8000-00000000000b';
const USUARIO = '04100000-0000-4000-8000-100000000001';
const ALUNO = '04100000-0000-4000-8000-200000000001';
const FALTA = '04100000-0000-4000-8000-400000000001';

// Lido ANTES de o relógio ser trocado: o dia real, no fuso do clube.
const DIA = hojeNoFusoDoClube();
const HOJE = formatDateOnly(DIA);
const AMANHA = formatDateOnly(new Date(DIA.getTime() + 86_400_000));
const AGORA = instanteNoFusoDoClube(DIA, parseTimeOnly('18:38'));

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const servico = () => {
  const p = db as unknown as PrismaService;
  return new ReposicaoService(p, new ConfigOperacaoService(p));
};

let ocSeq = 0;
async function ocorrencia(data: string, hora: string, quadra = QUADRA) {
  ocSeq += 1;
  const id = `04100000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${quadra}','${data}','${hora}','${fim}','TURMA','${OUTRA}','pendente_pagamento',now())`,
  );
  return id;
}

/** Tenta marcar cada ocorrência e devolve as que o `POST` aceitou. */
async function aceitasPeloPost(ids: string[]): Promise<string[]> {
  const aceitas: string[] = [];
  for (const id of ids) {
    try {
      await servico().marcar(EMPRESA, USUARIO, FALTA, id);
      aceitas.push(id);
      await q(`DELETE FROM reposicoes_de_aula WHERE falta_id='${FALTA}'`);
    } catch (e) {
      const code = (
        e as { getResponse?: () => { code?: string } }
      ).getResponse?.()?.code;
      // Só a recusa por hora é esperada aqui; qualquer outra é defeito do
      // cenário, e precisa aparecer em vez de passar por "recusada".
      expect(code).toBe('PRAZO_DE_CANCELAMENTO');
    }
  }
  return aceitas;
}

const destinos: Record<string, string> = {};

beforeAll(async () => {
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  await limparEmpresa(db, EMPRESA);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','DEF-041','def-041-${EMPRESA}',now())`,
    ),
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  for (const [id, nome] of [
    [QUADRA, 'Quadra'],
    [QUADRA_2, 'Quadra 2'],
  ]) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${id}','${EMPRESA}','${nome}','${esporte.id}',80,'ativa')`,
    );
  }
  for (const [id, nome] of [
    [TURMA_DELE, 'Turma dele'],
    [OUTRA, 'Outra turma'],
  ]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}',10,'ativa',${primeiroNivelSql(`'${EMPRESA}'`)})`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','def041@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA_DELE}','${ALUNO}',now())`,
  );

  // A aula dele hoje às 20h, na quadra 2, que ele remarca: o crédito.
  ocSeq += 1;
  const aula20h = `04100000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${aula20h}','${EMPRESA}','${QUADRA_2}','${HOJE}','20:00','21:00','TURMA','${TURMA_DELE}','pendente_pagamento',now())`,
  );
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${FALTA}','${EMPRESA}','${aula20h}','${ALUNO}',now())`,
  );

  // A outra turma: hoje às 7h e às 18h (já começaram), 19h, 20h e 21h; e
  // amanhã às 7h.
  for (const h of ['07:00', '18:00', '19:00', '20:00', '21:00']) {
    destinos[`hoje ${h}`] = await ocorrencia(HOJE, h);
  }
  destinos['amanha 07:00'] = await ocorrencia(AMANHA, '07:00');
  // As bordas de minuto, pelo Postgres real: 18:39 de hoje é o primeiro
  // minuto que se marca às 18:38; amanhã 18:37 e 18:38 separam o corte de
  // 24h, que cai no dia seguinte. Em quadras diferentes, para não colidirem.
  destinos['hoje 18:39'] = await ocorrencia(HOJE, '18:39', QUADRA_2);
  destinos['amanha 18:37'] = await ocorrencia(AMANHA, '18:37');
  destinos['amanha 18:38'] = await ocorrencia(AMANHA, '18:38', QUADRA_2);
});

/** Liga o prazo de aula do clube durante `corpo`, e desliga depois. */
async function comPrazo(horas: number, corpo: () => Promise<void>) {
  await q(
    `INSERT INTO config_operacao_empresa (id,company_id,prazo_cancelamento_aula_horas,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',${horas},now())`,
  );
  try {
    await corpo();
  } finally {
    await q(
      `DELETE FROM config_operacao_empresa WHERE company_id='${EMPRESA}'`,
    );
  }
}

const SEM_PRAZO_AS_18H38 = [
  'hoje 18:39',
  'hoje 19:00',
  'hoje 20:00',
  'hoje 21:00',
  'amanha 07:00',
  'amanha 18:37',
  'amanha 18:38',
];

afterAll(async () => {
  jest.useRealTimers();
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

const oferecidas = async () =>
  (await servico().oportunidades(EMPRESA, USUARIO, true)).map(
    (o) => `${o.data === HOJE ? 'hoje' : 'amanha'} ${o.horaInicio}`,
  );

describe('DEF-041 — a lista oferece só o que o POST aceita', () => {
  it('o relógio do serviço está às 18h38 do clube', () => {
    expect(new Date().getTime()).toBe(AGORA.getTime());
  });

  it('sem prazo: às 18h38, a das 7h e a das 18h de hoje saem da lista — a das 18h39 fica', async () => {
    expect(await oferecidas()).toEqual(SEM_PRAZO_AS_18H38);
  });

  it('sem prazo: a lista é EXATAMENTE o que o POST aceita', async () => {
    const lista = (await servico().oportunidades(EMPRESA, USUARIO, true)).map(
      (o) => o.ocupacaoId,
    );
    const aceitas = await aceitasPeloPost(Object.values(destinos));
    expect(lista.sort()).toEqual(aceitas.sort());
    // As duas recusas existem: a igualdade não é de dois conjuntos cheios.
    expect(aceitas).toHaveLength(Object.keys(destinos).length - 2);
  });

  it('com prazo de 2h: às 18h38, a das 19h e a das 20h também saem — e a lista segue igual ao POST', async () => {
    await comPrazo(2, async () => {
      expect(await oferecidas()).toEqual([
        'hoje 21:00',
        'amanha 07:00',
        'amanha 18:37',
        'amanha 18:38',
      ]);
      const lista = (await servico().oportunidades(EMPRESA, USUARIO, true)).map(
        (o) => o.ocupacaoId,
      );
      const aceitas = await aceitasPeloPost(Object.values(destinos));
      expect(lista.sort()).toEqual(aceitas.sort());
      expect(aceitas).toHaveLength(4);
    });
  });

  it('com prazo de 24h: o corte cai AMANHÃ às 18h38 — a das 18h37 sai, a das 18h38 fica', async () => {
    await comPrazo(24, async () => {
      expect(await oferecidas()).toEqual(['amanha 18:38']);
      const lista = (await servico().oportunidades(EMPRESA, USUARIO, true)).map(
        (o) => o.ocupacaoId,
      );
      const aceitas = await aceitasPeloPost(Object.values(destinos));
      expect(lista).toEqual(aceitas);
      expect(aceitas).toEqual([destinos['amanha 18:38']]);
    });
  });

  it('o corte vai no where, antes do take 200: 200 aulas que já passaram não escondem a das 21h', async () => {
    // 200 aulas de 5 minutos hoje, de 00:00 a 16:40 — todas já começaram às
    // 18h38, e todas ordenam antes da das 19h.
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
       SELECT gen_random_uuid(),'${EMPRESA}','${QUADRA_2}','${HOJE}',
              ('00:00'::time + g * interval '5 minutes'),
              ('00:05'::time + g * interval '5 minutes'),
              'TURMA','${OUTRA}','pendente_pagamento',now()
         FROM generate_series(0,199) g`,
    );
    const [n] = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM ocupacoes_quadra
        WHERE company_id='${EMPRESA}' AND origem_turma_id='${OUTRA}'
          AND data='${HOJE}' AND hora_inicio < '18:38'`,
    );
    expect(Number(n.n)).toBe(202);

    expect(await oferecidas()).toEqual(SEM_PRAZO_AS_18H38);
  });
});
