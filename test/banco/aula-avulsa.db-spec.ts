/**
 * SPEC-039/TASK-001 — **o que o banco garante sozinho sobre a aula particular.**
 *
 * ## O caso que este arquivo existe para provar
 *
 * A demanda diz *"reusa a trava que impede reserva dupla"*. **Essa trava não
 * cobre o professor:** `no_overlap_por_quadra` exclui por `quadra_id`, então
 * duas aulas do MESMO professor, no mesmo horário, em quadras DIFERENTES
 * passariam as duas — e o clube descobriria com o professor em dois lugares.
 *
 * A `no_overlap_por_professor` é a trava que faltava, e o caso "quadras
 * diferentes" é o único que distingue as duas. Um teste que colocasse as duas
 * aulas na mesma quadra ficaria verde pela trava ERRADA.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA_A = 'a0390000-0000-4000-8000-000000000001';
const EMPRESA_B = 'a0390000-0000-4000-8000-000000000002';
const PROF_A = 'a0390000-0000-4000-8000-000000000003';
const PROF_B = 'a0390000-0000-4000-8000-000000000004';
const QUADRA_1 = 'a0390000-0000-4000-8000-000000000005';
const QUADRA_2 = 'a0390000-0000-4000-8000-000000000006';
const UADMIN = 'a0390000-0000-4000-8000-000000000007';
const UALUNO = 'a0390000-0000-4000-8000-000000000008';
const ALUNO = 'a0390000-0000-4000-8000-000000000009';
const TURMA = 'a0390000-0000-4000-8000-00000000000a';

let seq = 0;
const proximo = () =>
  'a0390000-0000-4000-9000-' + String(++seq).padStart(12, '0');

/**
 * Uma ocupação avulsa. `professor` nulo = reserva de quadra comum, que é a
 * esmagadora maioria e o caso que o índice parcial NÃO pode alcançar.
 */
function ocupar(
  quadra: string,
  hora: string,
  professor: string | null,
  opcoes: { status?: string; empresa?: string } = {},
) {
  const empresa = opcoes.empresa ?? EMPRESA_A;
  const p = professor === null ? 'NULL' : `'${professor}'`;
  const fim = String(Number(hora.slice(0, 2)) + 1).padStart(2, '0') + ':00';
  return q(
    `INSERT INTO ocupacoes_quadra
       (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
        aluno_id, professor_id, valor, status_pagamento, updated_at)
     VALUES ('${proximo()}','${empresa}','${quadra}','2035-06-01','${hora}','${fim}',
             'AVULSO','${ALUNO}',${p},120,'${opcoes.status ?? 'pago'}',now())`,
  );
}

async function empresa(id: string, sufixo: string) {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at)
     VALUES ('${id}','Clube ${sufixo}','clube-039-${sufixo}',now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await empresa(EMPRESA_A, 'a');
  await empresa(EMPRESA_B, 'b');

  // Professor sem conta dos dois lados: `usuario_id` é nulável (INV-014) e é
  // o estado normal. A aula particular não pode exigir login do professor.
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_A}','${EMPRESA_A}','Prof A','ativo')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_B}','${EMPRESA_B}','Prof B','ativo')`,
  );

  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UADMIN}','admin039@teste.local','x','Admin','company_admin','${EMPRESA_A}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','aluno039@teste.local','x','Aluno','aluno','${EMPRESA_A}',now())`,
  );
  await q(
    // `alunos` NAO tem `updated_at` -- conferido no schema depois de a
    // primeira versao morrer com 42703. Supor coluna e o erro mais barato de
    // evitar e o mais caro de depurar num INSERT de nove colunas.
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA_A}')`,
  );

  // Quadra exige esporte da MESMA empresa (FK composta, SPEC-020).
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA_A}','Tenis',0,now())`,
  );
  for (const [id, nome] of [
    [QUADRA_1, 'Q1'],
    [QUADRA_2, 'Q2'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
       VALUES ('${id}','${EMPRESA_A}','${nome}',
               (SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA_A}' AND nome='Tenis'),120)`,
    );
  }
  await q(
    // `dia_semana`, `hora_inicio` e `hora_fim` SAIRAM de `turmas` na SPEC-019
    // -- a recorrencia virou `encontros`. E nao ha `updated_at`.
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade)
     VALUES ('${TURMA}','${EMPRESA_A}','T1','${QUADRA_1}',10)`,
  );
});

afterEach(async () => {
  await q(`DELETE FROM ocupacoes_quadra WHERE company_id = '${EMPRESA_A}'`);
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

describe('SPEC-039 — a aula particular no banco', () => {
  it('o caminho feliz: aula AVULSO com professor, e sem professor continua valendo', async () => {
    await ocupar(QUADRA_1, '10:00', PROF_A);
    await ocupar(QUADRA_2, '15:00', null);
    const [linha] = await db.$queryRawUnsafe<
      { com: number; sem: number }[]
    >(`SELECT count(*) FILTER (WHERE professor_id IS NOT NULL)::int AS com,
              count(*) FILTER (WHERE professor_id IS NULL)::int     AS sem
         FROM ocupacoes_quadra WHERE company_id = '${EMPRESA_A}'`);
    expect(linha).toEqual({ com: 1, sem: 1 });
  });

  it('INV-104 — a aula NÃO cruza empresa (FK composta, DEF-024)', async () => {
    // `(EMPRESA_A, PROF_B)`: a empresa existe, o professor existe, e o par
    // não. É o vazamento que uma FK simples de `professor_id` permitiria.
    await expect(ocupar(QUADRA_1, '11:00', PROF_B)).rejects.toThrow(
      /ocupacoes_professor_fkey/,
    );
  });

  it('INV-106 — professor em ocupação de TURMA é recusado', async () => {
    // A ocorrência de turma já sabe do professor PELA TURMA. Dois caminhos
    // para o mesmo fato divergem no primeiro dia em que alguém editar um.
    await expect(
      q(`INSERT INTO ocupacoes_quadra
           (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
            origem_turma_id, professor_id, updated_at)
         VALUES ('${proximo()}','${EMPRESA_A}','${QUADRA_1}','2035-06-02','07:00','08:00',
                 'TURMA','${TURMA}','${PROF_A}',now())`),
    ).rejects.toThrow(/ocupacoes_professor_so_em_avulso/);
  });

  it('INV-105 — o mesmo professor em horários DIFERENTES é ACEITO', async () => {
    // **O caso que faltava, e a revisao adversarial achou.** Sem ele, uma
    // `EXCLUDE` que recusasse TODA segunda linha do mesmo professor -- sem
    // olhar a hora nenhuma -- passaria neste arquivo inteiro: todos os outros
    // casos so provam RECUSA. A dimensao de TEMPO nao tinha prova.
    //
    // E um professor que da tres aulas no mesmo dia e o caso NORMAL do
    // produto, nao uma borda.
    await ocupar(QUADRA_1, '08:00', PROF_A);
    await ocupar(QUADRA_2, '09:00', PROF_A);
    await ocupar(QUADRA_1, '10:00', PROF_A);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra
        WHERE company_id = '${EMPRESA_A}' AND professor_id = '${PROF_A}'`,
    );
    expect(n).toBe(3);
  });

  it('INV-105 — o MESMO professor em QUADRAS DIFERENTES, mesmo horário: recusado', async () => {
    // **Este é o caso que distingue as duas travas.** Na mesma quadra, a
    // `no_overlap_por_quadra` já recusaria — e o teste ficaria verde pela
    // trava errada, provando algo que a SPEC-039 não construiu.
    await ocupar(QUADRA_1, '14:00', PROF_A);
    await expect(ocupar(QUADRA_2, '14:00', PROF_A)).rejects.toThrow(
      /no_overlap_por_professor/,
    );
  });

  it('INV-105 — sobreposição PARCIAL também é recusada', async () => {
    // `tsrange … WITH &&` é sobreposição, não igualdade: 14–15 e 14:30–15:30
    // colidem. Um teste só com horários idênticos passaria com um índice de
    // igualdade simples, que não é o que a spec pede.
    await ocupar(QUADRA_1, '14:00', PROF_A);
    await expect(
      q(`INSERT INTO ocupacoes_quadra
           (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
            aluno_id, professor_id, valor, status_pagamento, updated_at)
         VALUES ('${proximo()}','${EMPRESA_A}','${QUADRA_2}','2035-06-01','14:30','15:30',
                 'AVULSO','${ALUNO}','${PROF_A}',120,'pago',now())`),
    ).rejects.toThrow(/no_overlap_por_professor/);
  });

  it('aula CANCELADA libera o horário do professor', async () => {
    // Copia a semântica da trava da quadra: cancelamento libera. Sem isto,
    // cancelar e remarcar a mesma aula seria impossível.
    await ocupar(QUADRA_1, '16:00', PROF_A, { status: 'cancelado' });
    await ocupar(QUADRA_2, '16:00', PROF_A);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra
        WHERE professor_id = '${PROF_A}' AND status_pagamento <> 'cancelado'`,
    );
    expect(n).toBe(1);
  });

  it('reservas SEM professor nunca colidem -- e isso e do Postgres, nao do nosso WHERE', async () => {
    // **Medido, e derrubou o que eu tinha escrito na migration.** Eu afirmei
    // que sem o `WHERE professor_id IS NOT NULL` duas reservas comuns
    // passariam a colidir. Nao passam: numa `EXCLUDE`, NULL nunca e igual a
    // NULL -- a restricao simplesmente nao se aplica a linha com NULL.
    //
    // O `WHERE` continua certo, por outro motivo: ele mantem o indice pequeno,
    // carregando so as linhas que podem conflitar. E argumento de TAMANHO, nao
    // de correcao, e a diferenca esta agora escrita na migration.
    await ocupar(QUADRA_1, '18:00', null);
    await ocupar(QUADRA_2, '18:00', null);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      // **`company_id` no WHERE, e nao e detalhe.** Sem ele este contador varre
      // o banco inteiro: isolado passava, e na suite completa recebeu 15 --
      // linhas de outras suites. O mesmo descuido que a limpeza por empresa
      // existe para impedir do outro lado.
      `SELECT count(*)::int AS n FROM ocupacoes_quadra
        WHERE company_id = '${EMPRESA_A}' AND professor_id IS NULL`,
    );
    expect(n).toBe(2);
  });

  it('INV-107 — apagar professor com aula é RECUSADO (RESTRICT)', async () => {
    await ocupar(QUADRA_1, '19:00', PROF_A);
    // Aula prestada e paga com crédito não some porque alguém apagou uma
    // ficha. Difere de `disponibilidades_professor`, que é CASCADE por ser
    // configuração.
    await expect(
      q(`DELETE FROM professores WHERE id = '${PROF_A}'`),
    ).rejects.toThrow(/ocupacoes_professor_fkey/);
  });

  it('LIM-039f: a ocupacao de TURMA e INVISIVEL para a trava -- lacuna DECLARADA', async () => {
    // **Este caso nao celebra um acerto: ele fixa uma lacuna conhecida**, e a
    // revisao adversarial foi quem a apontou.
    //
    // A ocorrencia de turma sabe do professor pela TURMA, e o
    // `ocupacoes_professor_so_em_avulso` proibe `professor_id` na linha dela.
    // Logo a EXCLUDE nao a enxerga: o mesmo professor cabe numa aula de turma
    // e numa aula particular ao mesmo tempo. **Ensaiado contra o banco, nao
    // deduzido.**
    //
    // Quem fecha isto e o gate da TASK-002, na aplicacao. **O dia em que
    // alguem fechar no BANCO, este teste fica vermelho** -- e e assim que ele
    // avisa que a LIM-039f caiu e a spec precisa mudar junto.
    await q(
      `UPDATE turmas SET professor_id = '${PROF_A}' WHERE id = '${TURMA}'`,
    );
    await q(
      `INSERT INTO ocupacoes_quadra
         (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
          origem_turma_id, updated_at)
       VALUES ('${proximo()}','${EMPRESA_A}','${QUADRA_1}','2035-06-01','22:00','23:00',
               'TURMA','${TURMA}',now())`,
    );
    await ocupar(QUADRA_2, '22:00', PROF_A);

    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM ocupacoes_quadra
        WHERE company_id = '${EMPRESA_A}' AND hora_inicio = '22:00'`,
    );
    expect(n).toBe(2);
  });

  it('SABOTAGEM: sem a `no_overlap_por_professor`, o professor fica em duas quadras', async () => {
    // **A prova de que a prova funciona**, e a segunda versao dela: a
    // primeira sabotava o `WHERE` parcial e ficava verde por acidente,
    // porque NULL nao colide de qualquer jeito. Esta derruba a constraint
    // inteira, que e o mecanismo que a INV-105 promete.
    //
    // Dentro de uma transacao que SEMPRE volta atras -- DDL e transacional, e
    // uma sabotagem vazada deixaria as suites seguintes sem a trava.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE ocupacoes_quadra DROP CONSTRAINT no_overlap_por_professor`,
        );
        const aula = (quadra: string) =>
          tx.$executeRawUnsafe(
            `INSERT INTO ocupacoes_quadra
               (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
                aluno_id, professor_id, valor, status_pagamento, updated_at)
             VALUES ('${proximo()}','${EMPRESA_A}','${quadra}','2035-06-01','20:00','21:00',
                     'AVULSO','${ALUNO}','${PROF_A}',120,'pago',now())`,
          );
        await aula(QUADRA_1);
        // Sem a trava, o mesmo professor em duas quadras ao mesmo tempo passa.
        // A `no_overlap_por_quadra` nao impede: as quadras sao diferentes.
        await aula(QUADRA_2);
        const [{ n }] = await tx.$queryRawUnsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ocupacoes_quadra
            WHERE professor_id = '${PROF_A}' AND hora_inicio = '20:00'`,
        );
        expect(n).toBe(2);
        throw new Error('SABOTAGEM_OK');
      }),
    ).rejects.toThrow('SABOTAGEM_OK');

    // E a trava continua la para o proximo teste.
    await ocupar(QUADRA_1, '20:00', PROF_A);
    await expect(ocupar(QUADRA_2, '20:00', PROF_A)).rejects.toThrow(
      /no_overlap_por_professor/,
    );
  });
});
