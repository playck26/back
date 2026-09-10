/**
 * SPEC-036/TASK-006 — os três `CHECK` do cadastro, contra o banco de verdade.
 *
 * **Só o que a aplicação não decide sozinha está aqui.** A completude é função
 * pura e tem teste próprio (`completude-do-cadastro.spec.ts`); um db-spec para
 * ela seria cerimônia. O que precisa de Postgres é a rede de baixo:
 *
 * - `alunos_uf_valida` — porque a SPEC-038 vai importar aluno por planilha, e
 *   nesse caminho a lista das 27 do DTO não passa por lugar nenhum;
 * - `alunos_nascimento_plausivel` — pelo mesmo motivo, mais o fato de
 *   `CURRENT_DATE` num `CHECK` parecer defeito e não ser (medido abaixo);
 * - `alunos_texto_nao_vazio` — string vazia e ausência se pareceriam iguais na
 *   tela e diferentes na contagem: `''` subiria a barra sem informar nada.
 *
 * Cada caso afirma **o nome da constraint**, e não só que houve erro. Um teste
 * que aceita qualquer `23514` passa quando a linha é recusada pela constraint
 * errada — e aí ele está medindo outra coisa.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'd0360000-0000-4000-8000-000000000001';
const USUARIO = 'd0360000-0000-4000-8000-000000000002';
const ALUNO = 'd0360000-0000-4000-8000-000000000003';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-036','spec-036-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno036@teste.local','x','Ana','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado')`,
  );
}

/** Devolve o nome da constraint que recusou, ou falha se nada recusou. */
async function recusadoPor(sql: string): Promise<string> {
  try {
    await q(sql);
  } catch (erro) {
    const e = erro as Prisma.PrismaClientKnownRequestError;
    const msg = String((e.meta?.message as string) ?? e.message);
    const m = /violates check constraint "([a-z_]+)"/.exec(msg);
    return m ? m[1] : msg;
  }
  throw new Error('o INSERT/UPDATE PASSOU, e deveria ter sido recusado');
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-036/INV-110 — `uf` é uma das 27', () => {
  it('`XX` é recusada, nomeando `alunos_uf_valida`', async () => {
    // Duas letras maiúsculas passariam num `CHAR(2)` puro. É exatamente essa
    // a lacuna: "São Paulo/XX" ninguém consegue filtrar depois.
    expect(
      await recusadoPor(`UPDATE alunos SET uf='XX' WHERE id='${ALUNO}'`),
    ).toBe('alunos_uf_valida');
  });

  it('`SP` passa, e `null` também', async () => {
    await q(`UPDATE alunos SET uf='SP' WHERE id='${ALUNO}'`);
    await q(`UPDATE alunos SET uf=NULL WHERE id='${ALUNO}'`);
    const [linha] = await db.$queryRawUnsafe<{ uf: string | null }[]>(
      `SELECT uf FROM alunos WHERE id='${ALUNO}'`,
    );
    expect(linha.uf).toBeNull();
  });
});

describe('SPEC-036/INV-109 — data de nascimento plausível', () => {
  it('futuro é recusado, nomeando `alunos_nascimento_plausivel`', async () => {
    expect(
      await recusadoPor(
        `UPDATE alunos SET data_nascimento='2099-01-01' WHERE id='${ALUNO}'`,
      ),
    ).toBe('alunos_nascimento_plausivel');
  });

  it('antes de 1900 é recusado — o dedo escorregado em `0202-05-10`', async () => {
    // Sem o piso, a idade calculada na tela viraria 1824 anos, e ninguém
    // desconfiaria de um cadastro que "salvou".
    expect(
      await recusadoPor(
        `UPDATE alunos SET data_nascimento='0202-05-10' WHERE id='${ALUNO}'`,
      ),
    ).toBe('alunos_nascimento_plausivel');
  });

  it('**`CURRENT_DATE` no CHECK não revalida o passado**, e isso é o certo', async () => {
    // Parece defeito e não é: o CHECK só roda em INSERT/UPDATE **daquela
    // linha**. Uma data gravada hoje continua válida amanhã. A prova é gravar
    // HOJE (o limite exato) e mexer noutra coluna depois: se houvesse
    // revalidação retroativa por data, este segundo UPDATE seria o momento em
    // que ela apareceria.
    await q(
      `UPDATE alunos SET data_nascimento=CURRENT_DATE WHERE id='${ALUNO}'`,
    );
    await q(`UPDATE alunos SET cidade='Sao Paulo' WHERE id='${ALUNO}'`);
    const [linha] = await db.$queryRawUnsafe<{ cidade: string }[]>(
      `SELECT cidade FROM alunos WHERE id='${ALUNO}'`,
    );
    expect(linha.cidade).toBe('Sao Paulo');
  });
});

describe('SPEC-036/INV-108 — ausência é NULL, e só', () => {
  it('string vazia é recusada, nomeando `alunos_texto_nao_vazio`', async () => {
    // `''` preencheria o campo sem informar nada, e a barra de completude
    // subiria por engano. É o único erro aqui que faz o número **subir**.
    expect(
      await recusadoPor(
        `UPDATE alunos SET emergencia_nome='' WHERE id='${ALUNO}'`,
      ),
    ).toBe('alunos_texto_nao_vazio');
  });

  it("só espaços também é recusado — `btrim`, não `<> ''`", async () => {
    expect(
      await recusadoPor(`UPDATE alunos SET cidade='   ' WHERE id='${ALUNO}'`),
    ).toBe('alunos_texto_nao_vazio');
  });

  it('o CHECK cobre os CINCO campos de texto, e não só o primeiro', async () => {
    // Um `CHECK` escrito com `AND` é fácil de escrever pela metade, e o teste
    // do primeiro campo passaria igual. Este caso é o que distingue.
    for (const coluna of [
      'emergencia_nome',
      'emergencia_telefone',
      'endereco',
      'cidade',
      'observacoes_saude',
    ]) {
      expect(
        await recusadoPor(`UPDATE alunos SET ${coluna}='' WHERE id='${ALUNO}'`),
      ).toBe('alunos_texto_nao_vazio');
    }
  });

  it('`null` apaga sem reclamar — é a forma de esvaziar', async () => {
    await q(`UPDATE alunos SET cidade='Santos' WHERE id='${ALUNO}'`);
    await q(`UPDATE alunos SET cidade=NULL WHERE id='${ALUNO}'`);
    const [linha] = await db.$queryRawUnsafe<{ cidade: string | null }[]>(
      `SELECT cidade FROM alunos WHERE id='${ALUNO}'`,
    );
    expect(linha.cidade).toBeNull();
  });
});
