/**
 * SPEC-040/TASK-004 — **as garantias da disponibilidade contra Postgres real.**
 *
 * ## Por que db-spec e não unitário
 *
 * Tudo o que este arquivo prova mora no banco: três `CHECK`, um índice único e
 * uma FK composta. Um unitário com Prisma mockado provaria que o TypeScript
 * compila — nenhuma delas. E cada asserção nomeia **a constraint**, não só o
 * SQLSTATE: `23514` diz "algum CHECK recusou", e num dia em que dois deles
 * mudarem de sentido ao mesmo tempo isso passaria despercebido.
 *
 * O e2e irmão (`test/disponibilidade-professor.e2e-spec.ts`) prova as recusas
 * da APLICAÇÃO, com código e `422`. As duas redes existem de propósito: a de
 * cima dá mensagem útil, a de baixo garante que nenhum caminho futuro escape
 * dela — inclusive `psql` na mão.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const EMPRESA_A = 'd0400000-0000-4000-8000-000000000001';
const EMPRESA_B = 'd0400000-0000-4000-8000-000000000002';
const PROF_A = 'd0400000-0000-4000-8000-000000000003';
const PROF_B = 'd0400000-0000-4000-8000-000000000004';

let seq = 0;
const proximo = () =>
  'd0400000-0000-4000-9000-' + String(++seq).padStart(12, '0');

/** Uma linha de agenda, com os defeitos que o caso quiser. */
function inserir(
  professorId: string,
  companyId: string,
  dia: number | string,
  inicio: string | null,
  fim: string | null,
) {
  const v = (x: string | null) => (x === null ? 'NULL' : `'${x}'`);
  return q(
    `INSERT INTO disponibilidades_professor
       (id, company_id, professor_id, dia_semana, hora_inicio, hora_fim, updated_at)
     VALUES ('${proximo()}','${companyId}','${professorId}',${dia},${v(inicio)},${v(fim)},now())`,
  );
}

async function empresa(id: string, sufixo: string) {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at)
     VALUES ('${id}','Clube ${sufixo}','clube-040-${sufixo}',now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await empresa(EMPRESA_A, 'a');
  await empresa(EMPRESA_B, 'b');
  // `usuario_id` fica NULO de propósito: professor sem conta é o estado
  // normal (INV-014), e a agenda é da FICHA, não do login. Se a tabela
  // dependesse de conta, metade dos professores do clube não teria agenda.
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_A}','${EMPRESA_A}','Prof A','ativo')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_B}','${EMPRESA_B}','Prof B','ativo')`,
  );
});

afterEach(async () => {
  await q(`DELETE FROM disponibilidades_professor`);
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

describe('SPEC-040 — o que o banco garante sozinho', () => {
  it('o caminho feliz grava, e o professor SEM CONTA tem agenda', async () => {
    await inserir(PROF_A, EMPRESA_A, 1, '08:00', '12:00');
    const [linha] = await db.$queryRawUnsafe<
      { dia_semana: number; usuario_id: string | null }[]
    >(`SELECT d.dia_semana, p.usuario_id
         FROM disponibilidades_professor d
         JOIN professores p ON p.id = d.professor_id
        WHERE d.professor_id = '${PROF_A}'`);
    expect(linha).toEqual({ dia_semana: 1, usuario_id: null });
  });

  it('INV-103 — hora quebrada é recusada por `disponibilidades_hora_cheia`', async () => {
    await expect(
      inserir(PROF_A, EMPRESA_A, 2, '08:30', '12:00'),
    ).rejects.toThrow(/disponibilidades_hora_cheia/);
    // E o fim também: um CHECK que só olhasse o início passaria neste
    // arquivo sem que ninguém notasse.
    await expect(
      inserir(PROF_A, EMPRESA_A, 2, '08:00', '12:45'),
    ).rejects.toThrow(/disponibilidades_hora_cheia/);
  });

  it('INV-102 — "atende das 10h às 8h" é recusado por `disponibilidades_intervalo`', async () => {
    await expect(
      inserir(PROF_A, EMPRESA_A, 3, '10:00', '08:00'),
    ).rejects.toThrow(/disponibilidades_intervalo/);
    // Fim IGUAL ao início é janela de duração zero, e também não existe.
    await expect(
      inserir(PROF_A, EMPRESA_A, 3, '09:00', '09:00'),
    ).rejects.toThrow(/disponibilidades_intervalo/);
  });

  it('D6 — a linha SEM horas nem existe: `NOT NULL`, não CHECK', async () => {
    // Este é o caso que a coluna `indisponivel` representava. Depois da D6 ele
    // não é um estado inválido: é um estado **inexpressável**, e a diferença
    // importa — invariante que o tipo já impede não pode ser esquecida.
    //
    // **A asserção é sobre `23502`, e não sobre o nome da coluna.** Medido: a
    // mensagem que o Prisma entrega diz `Failing row contains (…)` e NÃO
    // nomeia a coluna que faltou. É a exceção à regra deste arquivo — e ela
    // fica escrita para o próximo não achar que esqueceram.
    await expect(inserir(PROF_A, EMPRESA_A, 4, null, null)).rejects.toThrow(
      /23502/,
    );
  });

  it('INV-100 — o mesmo dia duas vezes é recusado pelo índice único', async () => {
    await inserir(PROF_A, EMPRESA_A, 5, '08:00', '12:00');
    // Aqui o nome do índice também não aparece: a mensagem traz a CHAVE
    // (`Key (company_id, professor_id, dia_semana)=…`), que é o mesmo fato
    // dito de outro jeito — e é ela que quebraria se alguém tirasse uma
    // coluna do índice, que é o que esta asserção existe para pegar.
    await expect(
      inserir(PROF_A, EMPRESA_A, 5, '14:00', '18:00'),
    ).rejects.toThrow(/Key \(company_id, professor_id, dia_semana\)/);
  });

  it('dia fora de 0..6 é recusado por `disponibilidades_dia_valido`', async () => {
    await expect(
      inserir(PROF_A, EMPRESA_A, 7, '08:00', '12:00'),
    ).rejects.toThrow(/disponibilidades_dia_valido/);
  });

  it('INV-101 — a agenda NÃO cruza empresa (FK composta, DEF-024)', async () => {
    // O par `(EMPRESA_A, PROF_B)`: a empresa existe, o professor existe, e
    // mesmo assim o par não. É exatamente o vazamento que uma FK simples de
    // `professor_id` deixaria passar — e o que a SPEC-025 sofreu com
    // avaliação de aula.
    await expect(
      inserir(PROF_B, EMPRESA_A, 1, '08:00', '12:00'),
    ).rejects.toThrow(/disponibilidades_professor_fkey/);
  });

  it('apagar o professor leva a agenda junto (CASCADE)', async () => {
    const prof = proximo();
    await q(
      `INSERT INTO professores (id,company_id,nome,status) VALUES ('${prof}','${EMPRESA_A}','Efemero','ativo')`,
    );
    await inserir(prof, EMPRESA_A, 6, '08:00', '12:00');
    await q(`DELETE FROM professores WHERE id = '${prof}'`);

    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM disponibilidades_professor WHERE professor_id = '${prof}'`,
    );
    // Agenda é configuração, não histórico: configuração órfã só atrapalha.
    // Difere de `contratos_da_empresa`, que é RESTRICT por ser registro legal.
    expect(n).toBe(0);
  });

  it('o `disponibilidades_empresa_fkey` é INALCANÇÁVEL: `professores` bloqueia antes', async () => {
    // **Este teste nasceu de um erro meu, e fica para que ele não volte.**
    //
    // O commit da TASK-001 afirmou que sem `disponibilidades_professor` em
    // `TABELAS_DA_EMPRESA` o `DELETE FROM empresas` receberia `23503` desta
    // FK. **Medido, e é falso.** A agenda exige um professor, o professor tem
    // `RESTRICT` para a empresa, e ele reclama primeiro — sempre. Esta FK
    // nunca chega a ser o motivo da recusa.
    await inserir(PROF_A, EMPRESA_A, 0, '08:00', '12:00');
    await expect(
      q(`DELETE FROM empresas WHERE id = '${EMPRESA_A}'`),
    ).rejects.toThrow(/professores_company_id_fkey/);

    // E o que a limpeza de verdade faz: apagar `professores` leva a agenda
    // por CASCADE, e a empresa sai em seguida. A linha na lista continua
    // obrigatória — mas por causa do GATE de cobertura
    // (`limpar-empresa.db-spec.ts`, que exige toda tabela com `company_id`),
    // não por causa de um `23503` que não acontece.
    await q(`DELETE FROM professores WHERE id = '${PROF_A}'`);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM disponibilidades_professor WHERE company_id = '${EMPRESA_A}'`,
    );
    expect(n).toBe(0);

    // Recompõe o professor para os testes seguintes — este é o único caso do
    // arquivo que mexe no cenário compartilhado.
    await q(
      `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF_A}','${EMPRESA_A}','Prof A','ativo')`,
    );
  });

  it('SABOTAGEM: sem o `disponibilidades_intervalo`, "das 10h às 8h" passa', async () => {
    // **A prova de que a prova funciona.** Dentro de uma transação que SEMPRE
    // volta atrás — DDL é transacional no Postgres, e uma sabotagem que
    // vazasse deixaria o banco sem o CHECK para as suítes seguintes, que
    // acusariam a spec de não ter uma constraint que ela tem.
    await expect(
      db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          `ALTER TABLE disponibilidades_professor DROP CONSTRAINT disponibilidades_intervalo`,
        );
        await tx.$executeRawUnsafe(
          `INSERT INTO disponibilidades_professor
             (id, company_id, professor_id, dia_semana, hora_inicio, hora_fim, updated_at)
           VALUES ('${proximo()}','${EMPRESA_A}','${PROF_A}',2,'10:00','08:00',now())`,
        );
        // Passou. Agora derruba a transação de propósito.
        throw new Error('SABOTAGEM_OK');
      }),
    ).rejects.toThrow('SABOTAGEM_OK');

    // E o CHECK continua lá para o próximo teste.
    await expect(
      inserir(PROF_A, EMPRESA_A, 2, '10:00', '08:00'),
    ).rejects.toThrow(/disponibilidades_intervalo/);
  });
});
