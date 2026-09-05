/**
 * SPEC-031/D22 — **a limpeza com as três tabelas novas POVOADAS.**
 *
 * ## Por que a cobertura por `information_schema` não bastava
 *
 * `limpar-empresa-cobertura.db-spec.ts` confere se toda tabela com
 * `company_id` está **na lista**. É necessário e não é suficiente: estar na
 * lista não diz **em que posição**, e a ordem é o que faz a limpeza passar. As
 * quatro FKs de `faltas_avisadas` são `RESTRICT`; posta depois de qualquer um
 * dos três pais, ela aparece na cobertura e quebra na execução.
 *
 * Este arquivo é a outra metade: povoa as três tabelas e roda `limparEmpresa`
 * **até o fim**. O critério do D22 é literal — *"o bloco rodar de ponta a
 * ponta, com as três tabelas novas povoadas, até o `COMMIT`, sem `23503`,
 * `23001` nem `23514`"*.
 *
 * ## A história que justifica o rigor
 *
 * Cinco rodadas de validação cruzada acharam **um pai faltando por vez** —
 * `faltas → ocupacoes`, `config_operacao → empresas`, `faltas → alunos`,
 * `quadras_esporte_fkey` e o `23514` de `usuarios`. As duas últimas só
 * apareceram porque alguém rodou o banco; nenhuma leitura as teria achado. E a
 * 12ª rodada achou a sexta: o D22 mandava apagar `turma_alunos`, que **não tem
 * `company_id`** — teria morrido em `42703` na primeira execução.
 *
 * É sintoma de listar em vez de ordenar, e este teste é o que troca a lista
 * pela execução.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa, TABELAS_DA_EMPRESA } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA = 'f0310000-0000-4000-8000-000000000001';
const QUADRA = 'f0310000-0000-4000-8000-000000000002';
const ESPORTE = 'f0310000-0000-4000-8000-000000000003';
const TURMA = 'f0310000-0000-4000-8000-000000000004';
const UADMIN = 'f0310000-0000-4000-8000-000000000005';
const UALUNO = 'f0310000-0000-4000-8000-000000000006';
const ALUNO = 'f0310000-0000-4000-8000-000000000007';
const OCUPACAO = 'f0310000-0000-4000-8000-000000000008';
const ACAO = 'f0310000-0000-4000-8000-000000000009';

async function semear() {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-031','spec-031-limpeza',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES
       ('${UADMIN}','admin-031@x.test','x','Admin','company_admin','${EMPRESA}',now()),
       ('${UALUNO}','aluno-031@x.test','x','Aluno','aluno','${EMPRESA}',now())`,
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
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${OCUPACAO}','${EMPRESA}','${QUADRA}',DATE '2026-12-01',TIME '09:00',TIME '10:00','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
  await q(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id,criado_em) VALUES ('${ACAO}','${EMPRESA}','turma_aluno_removido','${UADMIN}',now())`,
  );

  // As TRÊS tabelas desta spec, povoadas — é o ponto do arquivo.
  await q(
    `INSERT INTO config_operacao_empresa
       (id,company_id,prazo_cancelamento_aula_horas,prazo_cancelamento_reserva_horas,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}',2,4,now())`,
  );
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${OCUPACAO}','${ALUNO}',now())`,
  );
  await q(
    `INSERT INTO eventos_de_matricula (id,company_id,acao_id,turma_id,aluno_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ACAO}','${TURMA}','${ALUNO}')`,
  );
}

const conta = (tabela: string) =>
  db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM ${tabela} WHERE company_id = '${EMPRESA}'`,
  );

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-031/D22 — a limpeza com as tres tabelas novas povoadas', () => {
  it('as tres entram em TABELAS_DA_EMPRESA, e ANTES dos pais delas', () => {
    const pos = (t: string) => TABELAS_DA_EMPRESA.indexOf(t as never);

    // `faltas_avisadas` antes dos TRÊS pais. `empresas` não está na lista —
    // é apagada fora do laço, por último —, então basta ordenar contra os
    // dois que estão.
    expect(pos('faltas_avisadas')).toBeGreaterThanOrEqual(0);
    expect(pos('faltas_avisadas')).toBeLessThan(pos('ocupacoes_quadra'));
    expect(pos('faltas_avisadas')).toBeLessThan(pos('alunos'));

    // `eventos_de_matricula` antes de `turmas`, `alunos` e as ações.
    expect(pos('eventos_de_matricula')).toBeLessThan(pos('turmas'));
    expect(pos('eventos_de_matricula')).toBeLessThan(pos('alunos'));
    expect(pos('eventos_de_matricula')).toBeLessThan(
      pos('acoes_administrativas'),
    );

    // `config_operacao_empresa` só precisa vir antes de `empresas`, e tudo na
    // lista vem. Estar na lista É o requisito dela.
    expect(pos('config_operacao_empresa')).toBeGreaterThanOrEqual(0);

    // E `turma_alunos` NÃO entra: não tem `company_id`, e o `DELETE` da
    // limpeza é `WHERE company_id = $1`. O D22 mandava incluí-la até a v13.
    expect(pos('turma_alunos')).toBe(-1);
  });

  it('D22: limparEmpresa vai ate o fim, sem 23503, 23001 nem 23514', async () => {
    await semear();

    // Antes: as três têm linha.
    expect(Number((await conta('config_operacao_empresa'))[0].n)).toBe(1);
    expect(Number((await conta('faltas_avisadas'))[0].n)).toBe(1);
    expect(Number((await conta('eventos_de_matricula'))[0].n)).toBe(1);

    // O critério do D22, literal: roda até o fim.
    await expect(limparEmpresa(db, EMPRESA)).resolves.toBeUndefined();

    for (const t of [
      'config_operacao_empresa',
      'faltas_avisadas',
      'eventos_de_matricula',
      'ocupacoes_quadra',
      'acoes_administrativas',
    ]) {
      expect(Number((await conta(t))[0].n)).toBe(0);
    }
    const empresas = await db.$queryRawUnsafe<{ n: bigint }[]>(
      `SELECT count(*) AS n FROM empresas WHERE id = '${EMPRESA}'`,
    );
    expect(Number(empresas[0].n)).toBe(0);
  });

  /**
   * `eventos_de_matricula` é append-only por trigger, como as duas da
   * SPEC-032. Sem a válvula, o `DELETE` é recusado com `23514` — e é por isso
   * que estar em `TABELAS_DA_EMPRESA` não basta: tem de estar **também** no
   * conjunto `APPEND_ONLY`, que é outro conjunto.
   */
  it('D22/1: o DELETE cru em eventos_de_matricula e recusado pela trigger', async () => {
    await semear();
    await expect(
      q(`DELETE FROM eventos_de_matricula WHERE company_id = '${EMPRESA}'`),
    ).rejects.toThrow(/append-only/);
    // E a limpeza, que abre a válvula, passa.
    await expect(limparEmpresa(db, EMPRESA)).resolves.toBeUndefined();
  });
});
