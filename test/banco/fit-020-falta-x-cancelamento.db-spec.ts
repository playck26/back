/**
 * SPEC-031/REQ-006 — **FIT-020: `DELETE /falta` × cancelamento da ocorrência.**
 *
 * ## O que se prova é LINEARIZAÇÃO, e são dois desfechos — os dois corretos
 *
 * | Quem pega o lock primeiro | Estado final exigido |
 * |---|---|
 * | o `DELETE` | falta apagada, aula cancelada em seguida. **`204`**, e é válido |
 * | o cancelamento | `DELETE` acorda com `cancelado` ⇒ **`409`**, e a falta **permanece** |
 *
 * **A v4 da spec exigia o estado impossível** — dizia que o final "não pode
 * ser aula cancelada sem o registro de eu avisei", em *todas* as ordens.
 * `FOR UPDATE` **serializa, não escolhe vencedor**: com o `DELETE` chegando
 * primeiro, a linha some legitimamente e o cancelamento depois produz
 * exatamente o estado que ela proibia — numa execução serial perfeitamente
 * válida. Um FIT escrito daquele jeito falharia metade das vezes sem defeito
 * nenhum no código, e ensinaria a ignorar o vermelho.
 *
 * ## Como cada ordem é forçada, e por que não por `sleep`
 *
 * Ordem por tempo é ordem por sorte: numa máquina mais lenta ela inverte, e o
 * teste passa a provar o contrário do que diz. As duas ordens aqui são
 * forçadas por **lock**, e a barreira observa `pg_blocking_pids` até ver a
 * espera real.
 *
 * - **Cancelamento primeiro**: a transação do cancelamento fica aberta; o
 *   `DELETE` trava no `FOR UPDATE`; só então ela commita.
 * - **`DELETE` primeiro**: um terceiro cliente segura
 *   `config_operacao_empresa` em `ACCESS EXCLUSIVE`. O `DELETE` passa pelo
 *   `FOR UPDATE` da ocupação (passo 3) e **para no passo 4**, a leitura da
 *   configuração — já segurando o lock da ocupação. O cancelamento entra e
 *   trava. Aí a mesa é liberada.
 *
 *   `ACCESS EXCLUSIVE` e não `FOR UPDATE` de linha: a leitura da configuração
 *   é um `SELECT` simples, e sob MVCC um `SELECT` não espera por linha
 *   travada. Travar a linha não seguraria nada — e a barreira estouraria por
 *   tempo, parecendo defeito do produto.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import { FaltaAvisadaService } from '../../src/classes/falta-avisada.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);

exigirBancoLocal();

const EMPRESA = 'f0200000-0000-4000-8000-000000000001';
const QUADRA = 'f0200000-0000-4000-8000-000000000002';
const ESPORTE = 'f0200000-0000-4000-8000-000000000003';
const TURMA = 'f0200000-0000-4000-8000-000000000004';
const UPROF = 'f0200000-0000-4000-8000-000000000006';
const PROF = 'f0200000-0000-4000-8000-000000000007';
const UALUNO = 'f0200000-0000-4000-8000-000000000008';
const ALUNO = 'f0200000-0000-4000-8000-000000000009';

/**
 * Cinco conexões, e cada papel tem a sua — barreira entre clientes só é
 * barreira se os clientes forem mesmo distintos.
 */
const dbFalta = new PrismaClient();
const dbCancel = new PrismaClient();
const dbMesa = new PrismaClient();
const observador = new PrismaClient();
const semear = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);
const faltas = new FaltaAvisadaService(
  dbFalta as unknown as PrismaService,
  new ConfigOperacaoService(dbFalta as unknown as PrismaService),
);

async function semearFixture(): Promise<string> {
  await limparEmpresa(semear, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-020','fit-020',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,company_id,nome,email,senha_hash,role,status,updated_at) VALUES
       ('${UPROF}','${EMPRESA}','P','prof-f020@x.test','x','professor','ativo',now()),
       ('${UALUNO}','${EMPRESA}','A','aluno-f020@x.test','x','aluno','ativo',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','P','${UPROF}')`,
  );
  await q(
    `INSERT INTO alunos (id,company_id,usuario_id,status,vinculo) VALUES ('${ALUNO}','${EMPRESA}','${UALUNO}','ativo','aprovado')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','T','${QUADRA}','${PROF}',20,'ativa')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}')`,
  );

  const [oc] = await semear.$queryRawUnsafe<{ id: string }[]>(`
    INSERT INTO ocupacoes_quadra
      (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
    VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','2099-06-01','19:00','19:50','TURMA','${TURMA}','pendente_pagamento',now())
    RETURNING id`);

  // A falta já existe: é ela que o `DELETE` disputa com o cancelamento.
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${oc.id}','${ALUNO}',now())`,
  );
  return oc.id;
}

/**
 * A barreira. **A 3ª rodada derrubou a primeira versão desta consulta**, que
 * procurava `pg_locks.granted = false` numa relação: espera por LINHA não
 * aparece assim — quem espera por linha travada espera num `transactionid`,
 * não numa lock de relação, e a consulta nunca casava.
 *
 * O que vale é o par: `pg_blocking_pids` não vazio **e** a consulta em curso
 * sendo a que se espera. Amarrar ao texto da query é o que impede a barreira
 * de liberar por uma espera qualquer, em outra tabela.
 */
async function alguemEsperando(trechos: string[]): Promise<boolean> {
  const filtros = trechos
    .map((t) => `AND a.query ILIKE '%${t}%'`)
    .join('\n       ');
  const [r] = await observador.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n
      FROM pg_stat_activity a
     WHERE a.wait_event_type = 'Lock'
       AND cardinality(pg_blocking_pids(a.pid)) > 0
       ${filtros}
  `);
  return Number(r.n) > 0;
}

async function esperarAte(
  cond: () => Promise<boolean>,
  limiteMs: number,
  oQue: string,
): Promise<void> {
  const fim = Date.now() + limiteMs;
  while (Date.now() < fim) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  // A mensagem diz o que NÃO aconteceu. Sem o `FOR UPDATE`, ninguém espera —
  // e é assim que a sabotagem S5 aparece: barreira estourada, não asserção.
  throw new Error(`Barreira estourou: ninguem ficou esperando ${oQue}.`);
}

/**
 * **Ou alguém espera, ou o que passou reto se explica.**
 *
 * A barreira sozinha falha por TEMPO, e "estourou em 20s" é a mesma mensagem
 * para "o lock sumiu" e para "a máquina estava lenta" — quem lê a evidência
 * não consegue distinguir. Correndo a barreira contra a operação que deveria
 * ter travado, o vermelho passa a dizer **o que aconteceu no lugar**: a
 * operação terminou, com este código, enquanto a outra segurava a linha.
 *
 * É a diferença entre "não observei a espera" e "observei a não-espera".
 */
async function esperarOuDenunciar(
  cond: () => Promise<boolean>,
  oQue: string,
  passouReto: Promise<string>,
  comoSeria: string,
): Promise<void> {
  const barreira = esperarAte(cond, 20_000, oQue).then(() => null);
  const denuncia = passouReto.then((codigo) => codigo);
  const r = await Promise.race([barreira, denuncia]);
  if (r !== null) {
    throw new Error(
      `Ninguem esperou ${oQue}: a operacao terminou com "${r}" enquanto a ` +
        `outra segurava a linha. ${comoSeria}`,
    );
  }
}

/**
 * **A mesa precisa estar POSTA antes de o `DELETE` sair.**
 *
 * A primeira versão disparava os dois juntos e esperava pela espera — e a
 * barreira estourou: o `DELETE` chegava ao passo 4 **antes** de o `LOCK TABLE`
 * ser concedido, terminava inteiro, e ninguém nunca esperou. O erro parecia
 * do produto e era da montagem. Aqui a lock concedida é conferida no
 * `pg_locks` antes de qualquer outra coisa começar.
 */
async function mesaPostaNoBanco(): Promise<boolean> {
  const [r] = await observador.$queryRawUnsafe<{ n: bigint }[]>(`
    SELECT count(*) AS n
      FROM pg_locks l
      JOIN pg_class c ON c.oid = l.relation
     WHERE c.relname = 'config_operacao_empresa'
       AND l.mode = 'AccessExclusiveLock'
       AND l.granted
  `);
  return Number(r.n) > 0;
}

const codigoDe = (p: Promise<unknown>) =>
  p
    .then(() => 'aceito')
    .catch((e: { getResponse?: () => { code?: string } }) => {
      const r = e.getResponse?.();
      return r?.code ?? 'erro';
    });

const estado = async (ocupacaoId: string) => {
  const [oc] = await semear.$queryRawUnsafe<{ status_pagamento: string }[]>(
    `SELECT status_pagamento FROM ocupacoes_quadra WHERE id = '${ocupacaoId}'`,
  );
  return {
    status: oc.status_pagamento,
    faltas: await semear.faltaAvisada.count({ where: { ocupacaoId } }),
  };
};

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbFalta.$disconnect(),
    dbCancel.$disconnect(),
    dbMesa.$disconnect(),
    observador.$disconnect(),
    semear.$disconnect(),
  ]);
});

describe('FIT-020 — DELETE /falta x cancelamento (SPEC-031/D19)', () => {
  it('cancelamento primeiro: 409 OCUPACAO_CANCELADA, e a falta PERMANECE', async () => {
    const aula = await semearFixture();

    let liberar!: () => void;
    const mesaPosta = new Promise<void>((r) => (liberar = r));

    // O cancelamento abre e SEGURA — a ocupação fica travada por ele.
    const cancelamento = dbCancel.$transaction(
      async (tx) => {
        await cancelarOcupacaoNaFixture(tx, {
          companyId: EMPRESA,
          ocupacaoId: aula,
          autorId: UPROF,
        });
        await mesaPosta;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );

    // O DELETE chega e trava no `FOR UPDATE` da ocupação.
    const remocao = codigoDe(faltas.retirar(EMPRESA, UALUNO, TURMA, aula));

    try {
      await esperarOuDenunciar(
        () => alguemEsperando(['ocupacoes_quadra', 'FOR UPDATE']),
        'o lock da ocupacao',
        remocao,
        'Sem o FOR UPDATE, o DELETE decide sobre a linha que leu ANTES do ' +
          'cancelamento — e apaga a falta de uma aula que sera cancelada.',
      );
    } finally {
      liberar();
      await cancelamento;
    }

    // Ele acorda vendo `cancelado` — e é ESSA linha que ele julga, não a que
    // leu antes de esperar.
    expect(await remocao).toBe('OCUPACAO_CANCELADA');

    const fim = await estado(aula);
    expect(fim.status).toBe('cancelado');
    // O aviso sobrevive: é ele que responde "eu avisei, por que fui cobrado?".
    expect(fim.faltas).toBe(1);
  });

  it('DELETE primeiro: 204, falta apagada, e a aula cancelada em seguida', async () => {
    const aula = await semearFixture();

    let liberarMesa!: () => void;
    const mesaLiberada = new Promise<void>((r) => (liberarMesa = r));

    // A mesa: segura a leitura da configuração (passo 4), NÃO a ocupação.
    const mesa = dbMesa.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(
          'LOCK TABLE config_operacao_empresa IN ACCESS EXCLUSIVE MODE',
        );
        await mesaLiberada;
      },
      { timeout: 60_000, maxWait: 60_000 },
    );

    await esperarAte(mesaPostaNoBanco, 20_000, 'a mesa ser posta');

    // O DELETE avança até o passo 4 — já segurando o lock da ocupação.
    const remocao = codigoDe(faltas.retirar(EMPRESA, UALUNO, TURMA, aula));

    // Falha de barreira aqui deixaria a mesa aberta por 60s e travaria a
    // suíte inteira atrás dela — o `finally` solta antes de propagar.
    let cancelamento: Promise<void>;
    try {
      await esperarAte(
        () => alguemEsperando(['config_operacao_empresa']),
        20_000,
        'a leitura da configuracao',
      );

      // Agora o cancelamento entra e trava na ocupação, que o DELETE segura.
      cancelamento = cancelarOcupacaoNaFixture(dbCancel, {
        companyId: EMPRESA,
        ocupacaoId: aula,
        autorId: UPROF,
      });
      await esperarOuDenunciar(
        () => alguemEsperando(['ocupacoes_quadra']),
        'o cancelamento atras da ocupacao',
        cancelamento.then(() => 'cancelou sem esperar'),
        'Sem o FOR UPDATE do DELETE, o cancelamento nao encontra lock nenhum ' +
          'e as duas escritas deixam de ser serializadas.',
      );
    } finally {
      liberarMesa();
      await mesa;
    }

    // O DELETE termina primeiro, e legitimamente.
    expect(await remocao).toBe('aceito');
    await cancelamento;

    const fim = await estado(aula);
    expect(fim.status).toBe('cancelado');
    // **Aula cancelada sem o registro de "eu avisei" — e está certo.** Era
    // este estado que a v4 chamava de impossível.
    expect(fim.faltas).toBe(0);
  });
});
