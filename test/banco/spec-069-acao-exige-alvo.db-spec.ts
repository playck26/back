import { PrismaClient } from '@prisma/client';
import { comAcao } from './acao-com-efeito';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

/**
 * SPEC-069/TASK-005 — **ação sem alvo deixa de ser possível.**
 *
 * ## O que este arquivo prova, e por que só existe agora
 *
 * O `acao_exige_alvo` é o Deploy 2. Escrever estas provas antes dele existir
 * seria escrevê-las contra um banco **sem** o mecanismo: a ação nua commitaria
 * e as duas ficariam verdes provando nada. É o achado 5 da 2ª rodada de
 * validação, e é por isso que a spec manda a TASK-005 **rodar** as provas, e
 * não só instalar o trigger.
 *
 * ## Os dois lados, e nenhum basta sozinho
 *
 * | | |
 * |---|---|
 * | **AC-003** | ação nua é recusada — e em **três tipos diferentes**, porque um trigger que só reprovasse o tipo do teste passaria com um caso só |
 * | **AC-004** | ação **com** efeito commita — em **quatro** casos, um por tabela, porque um trigger que reconhecesse só uma tabela passaria com um caso só |
 *
 * A AC-003 sozinha aceitaria um trigger que recusa tudo. A AC-004 sozinha
 * aceitaria um trigger que não recusa nada.
 *
 * ## Por que o erro aparece no COMMIT, e não no INSERT
 *
 * `DEFERRABLE INITIALLY DEFERRED`. O efeito aponta para a ação, então a ação é
 * gravada primeiro; um trigger imediato reprovaria toda escrita legítima. A
 * consequência para a prova é que **ela tem de envolver a transação inteira**
 * — um teste que esperasse exceção no `INSERT` passaria sem provar nada, e a
 * spec lista isso entre os riscos para a FIT.
 */
jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'f0691000-0000-4000-8000-000000000001';
const UADMIN = 'f0691000-0000-4000-8000-000000000002';
const UALUNO = 'f0691000-0000-4000-8000-000000000003';
const ALUNO = 'f0691000-0000-4000-8000-000000000004';
const ESPORTE = 'f0691000-0000-4000-8000-000000000005';
const QUADRA = 'f0691000-0000-4000-8000-000000000006';
const TURMA = 'f0691000-0000-4000-8000-000000000007';
const OCUPACAO = 'f0691000-0000-4000-8000-000000000008';

async function semear() {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-069 trigger','spec-069-trigger',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES
       ('${UADMIN}','spec069-trigger-admin@x.test','x','Admin','company_admin','${EMPRESA}',now()),
       ('${UALUNO}','spec069-trigger-aluno@x.test','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade) VALUES ('${TURMA}','${EMPRESA}','T1','${QUADRA}',20)`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,aluno_id,valor)
     VALUES ('${OCUPACAO}','${EMPRESA}','${QUADRA}',DATE '2037-01-01',TIME '09:00',TIME '10:00','AVULSO',now(),'${ALUNO}',80)`,
  );
}

/** A ação NUA, dentro de uma transação — o `COMMIT` é quem julga. */
const acaoNua = (tipo: string) =>
  db.$transaction((tx) =>
    tx.$executeRawUnsafe(
      `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
       VALUES (gen_random_uuid(),'${EMPRESA}','${tipo}','${UADMIN}')`,
    ),
  );

const contaAcoes = async () =>
  Number(
    (
      await db.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*) AS n FROM acoes_administrativas WHERE company_id = '${EMPRESA}'`,
      )
    )[0].n,
  );

beforeEach(semear);

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-069/INV-069a — ação sem alvo não commita', () => {
  it('o trigger existe, é CONSTRAINT e é diferido', async () => {
    // A pré-condição das duas ACs abaixo. Sem ela, a AC-003 vermelha seria
    // ambígua: "o trigger não funciona" ou "o trigger não está aqui"?
    const [linha] = await db.$queryRawUnsafe<
      { tgname: string; tgconstraint: boolean; tgdeferrable: boolean }[]
    >(
      `SELECT tgname, tgconstraint <> 0 AS tgconstraint, tgdeferrable
         FROM pg_trigger WHERE tgname = 'acao_exige_alvo'`,
    );
    expect(linha).toBeDefined();
    expect(linha.tgconstraint).toBe(true);
    expect(linha.tgdeferrable).toBe(true);
  });

  /**
   * AC-003 — **três tipos**, e a razão está na spec: um trigger que só
   * recusasse o tipo do teste passaria com um caso só.
   *
   * **Por que a asserção é a MENSAGEM, e não o `23514`.** Medido: erro
   * levantado no `COMMIT` de uma transação interativa chega ao Prisma como
   * `PrismaClientUnknownRequestError`, **sem `code` e sem `meta`** — o
   * SQLSTATE se perde no caminho. A mensagem, essa, nomeia a invariante
   * (`commitada sem efeito (SPEC-069/INV-069a)`), o que é mais específico do
   * que um código genérico de CHECK.
   *
   * O `23514` que a AC nomeia é provado no caso seguinte, pelo caminho que o
   * expõe.
   */
  it.each([
    ['reserva_criada'],
    ['credito_lancado'],
    ['turma_professor_alterado'],
  ])('AC-003: ação nua do tipo %s é recusada no COMMIT', async (tipo) => {
    await expect(acaoNua(tipo)).rejects.toThrow(/commitada sem efeito/);
    await expect(acaoNua(tipo)).rejects.toThrow(/SPEC-069\/INV-069a/);
    // E não sobrou nada: a recusa é do COMMIT, então a transação inteira volta.
    expect(await contaAcoes()).toBe(0);
  });

  /**
   * AC-003, a outra metade — **o SQLSTATE, com o nome que a AC usa**.
   *
   * `SET CONSTRAINTS ... IMMEDIATE` é o idioma que este repositório já usa
   * para diferidas (ver o `SET_NOMEADO` do `creditos-reserva`): ele força a
   * checagem ali, ainda dentro do statement, e aí o Prisma entrega
   * `P2010` com `meta.code`.
   *
   * **Ele não substitui o caso acima**: o caminho de produção é o diferido, e
   * é o de cima que mede o que o gestor sentiria. Este aqui pina o código.
   */
  it('AC-003: o código do banco é 23514, pelo caminho que o expõe', async () => {
    const erro: unknown = await db
      .$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','reserva_criada','${UADMIN}')`,
        );
        await tx.$executeRawUnsafe(
          `SET CONSTRAINTS "acao_exige_alvo" IMMEDIATE`,
        );
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(erro).not.toBeNull();
    expect((erro as { code?: string }).code).toBe('P2010');
    expect((erro as { meta?: { code?: string } }).meta?.code).toBe('23514');
    expect(await contaAcoes()).toBe(0);
  });

  /**
   * AC-004 — **quatro casos, um por tabela de efeito**. Sem os quatro, um
   * trigger que reconhecesse só uma tabela passaria.
   */
  it('AC-004: com efeito de OCUPAÇÃO, commita', async () => {
    await comAcao(
      db,
      { companyId: EMPRESA, tipo: 'reserva_criada', autorId: UADMIN },
      (tx, acaoId) =>
        tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${OCUPACAO}','criada',gen_random_uuid())`,
        ),
    );
    expect(await contaAcoes()).toBe(1);
  });

  it('AC-004: com efeito de MATRÍCULA, commita', async () => {
    await comAcao(
      db,
      { companyId: EMPRESA, tipo: 'turma_aluno_removido', autorId: UADMIN },
      (tx, acaoId) =>
        tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_matricula (id,company_id,acao_id,turma_id,aluno_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${TURMA}','${ALUNO}')`,
        ),
    );
    expect(await contaAcoes()).toBe(1);
  });

  it('AC-004: com efeito de CRÉDITO, commita', async () => {
    await comAcao(
      db,
      { companyId: EMPRESA, tipo: 'credito_lancado', autorId: UADMIN },
      (tx, acaoId) =>
        tx.$executeRawUnsafe(
          `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
           VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO}','entrada',5000,'aporte da AC-004','${UADMIN}','${acaoId}')`,
        ),
    );
    expect(await contaAcoes()).toBe(1);
  });

  it('AC-004: com efeito de TURMA, commita', async () => {
    await comAcao(
      db,
      {
        companyId: EMPRESA,
        tipo: 'turma_professor_alterado',
        autorId: UADMIN,
      },
      (tx, acaoId) =>
        tx.$executeRawUnsafe(
          `INSERT INTO eventos_de_turma (id,company_id,acao_id,turma_id,tipo)
           VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${TURMA}','professor_alterado')`,
        ),
    );
    expect(await contaAcoes()).toBe(1);
  });

  /**
   * **A pergunta do 5º gate para esta task:** o que passa na AC-003 e na
   * AC-004 e ainda assim quebra?
   *
   * **O efeito que chega DEPOIS.** As duas ACs medem transações que nascem
   * certas ou erradas de uma vez; nenhuma pergunta o que acontece quando a
   * ação commita sozinha e o efeito vem na transação seguinte — que é
   * exatamente o que uma fixture em autocommit faz, e o que 19 arquivos de
   * teste faziam antes da TASK-004.
   *
   * A resposta é que **é tarde**: o `COMMIT` já julgou. O trigger não é uma
   * varredura noturna que perdoa quem se acertar depois, e essa diferença é a
   * razão de `comAcao` existir.
   *
   * *(A primeira versão deste caso tentava provar outra coisa — que um efeito
   * de OUTRA empresa não satisfaz a ação. Não é construtível: a FK composta
   * de cada tabela de efeito já exige que o par `(company_id, acao_id)`
   * exista, então efeito cross-tenant não chega a ser gravado. O `company_id`
   * dentro do `EXISTS` é mecanismo de ÍNDICE, não de tenant — quem o discrimina
   * é a **AC-013**, com o plano, e não um teste de comportamento.)*
   */
  it('INV-069a: efeito na transação SEGUINTE é tarde — o COMMIT já julgou', async () => {
    const acaoId = 'f0691000-0000-4000-8000-0000000000c2';

    // Primeira transação: só a ação. É aqui que o trigger reprova.
    await expect(
      db.$transaction((tx) =>
        tx.$executeRawUnsafe(
          `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
           VALUES ('${acaoId}','${EMPRESA}','turma_professor_alterado','${UADMIN}')`,
        ),
      ),
    ).rejects.toThrow(/commitada sem efeito/);

    // E a ação não existe, então o efeito "de depois" nem tem onde se apoiar:
    // a FK recusa antes de qualquer discussão sobre o trigger.
    expect(await contaAcoes()).toBe(0);
    await expect(
      q(
        `INSERT INTO eventos_de_turma (id,company_id,acao_id,turma_id,tipo)
         VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${TURMA}','professor_alterado')`,
      ),
    ).rejects.toThrow(/23503/);
  });
});
