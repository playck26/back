/**
 * **FIT-014: o banco recusa apontar para quadra de outra empresa.**
 *
 * DEF-022 / validação cruzada da SPEC-026, achado 3.
 *
 * Isto **só se prova contra Postgres real**. A regra não está em código
 * nenhum: está numa `FOREIGN KEY (company_id, quadra_id)`. Um mock não tem
 * chave estrangeira, e um teste unitário provaria no máximo que o serviço faz
 * o que o serviço faz — que é justamente o que **não** está em julgamento.
 *
 * O que está em julgamento é o contrário: que mesmo um `INSERT` cru, escrito
 * por alguém que ignorou todos os serviços, seja recusado. É por isso que
 * cada prova aqui usa SQL direto em vez do Prisma Client.
 *
 * **Por que três tabelas e não uma.** A validação cruzada apontou só
 * `ocupacoes_quadra`. Mas `turmas` e `horarios_funcionamento` têm a mesma
 * forma, e a migration anterior (SPEC-025) fechou exatamente uma tabela e
 * parou — o que trouxe este achado de volta uma spec depois. Corrigir onde se
 * está olhando, em vez de onde o defeito mora, já custou três ciclos a este
 * projeto.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA_A = 'f0140000-0000-4000-8000-00000000000a';
const EMPRESA_B = 'f0140000-0000-4000-8000-00000000000b';
const QUADRA_A = 'f0140000-0000-4000-8000-00000000001a';
const QUADRA_B = 'f0140000-0000-4000-8000-00000000001b';
const PROF_A = 'f0140000-0000-4000-8000-00000000002a';
const UPROF_A = 'f0140000-0000-4000-8000-00000000003a';
const TURMA_A = 'f0140000-0000-4000-8000-00000000004a';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

/**
 * **Recusado, e recusado PELA FK** — não por qualquer erro.
 *
 * Esta função existe porque a primeira versão deste arquivo passou verde
 * pelo motivo errado: eu escrevi `'AVULSA'` num enum cujos valores são
 * `TURMA` e `AVULSO`, então o Postgres recusava o `INSERT` **no enum**, antes
 * de chegar perto da chave estrangeira. `rejects.toThrow()` não distingue as
 * duas coisas, e a prova teria continuado verde mesmo se a FK não existisse.
 *
 * É o mesmo defeito que a validação cruzada da SPEC-025 encontrou na minha
 * prova do aviso de não-anonimato: assertiva fraca demais para separar o
 * certo do errado. Aqui a exigência é o nome da constraint.
 */
async function recusaPelaFK(sql: string, constraint: string): Promise<void> {
  const erro: unknown = await q(sql).then(
    () => null,
    (e: unknown) => e,
  );

  // Duas asserções, e a primeira não é redundante: sem ela, um `INSERT` que
  // passasse deixaria `erro` nulo e a segunda falharia com "cannot read
  // property message of null" — mensagem que não diz o que aconteceu.
  expect(erro).not.toBeNull();
  expect((erro as Error).message).toContain(constraint);
}

async function empresaCom(empresaId: string, quadraId: string, slug: string) {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresaId}','FIT-014 ${slug}','fit-014-${slug}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${empresaId}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadraId}','${empresaId}','Q ${slug}',(SELECT id FROM esportes_de_quadra WHERE company_id='${empresaId}'),100)`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await empresaCom(EMPRESA_A, QUADRA_A, 'a');
  await empresaCom(EMPRESA_B, QUADRA_B, 'b');

  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${UPROF_A}','fit014-a@teste.local','x','Prof A','professor','${EMPRESA_A}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${PROF_A}','${EMPRESA_A}','Prof A','${UPROF_A}',now())`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA_A);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

describe('FIT-014 — ocupacoes_quadra', () => {
  it('RECUSA ocupação da empresa A numa quadra da empresa B', async () => {
    await recusaPelaFK(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,status_pagamento,valor,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${QUADRA_B}',DATE '2026-09-01',TIME '18:00',TIME '19:00','AVULSO','pendente_pagamento',100,now())`,
      'ocupacoes_quadra_quadra_fkey',
    );
  });

  it('e ACEITA a mesma ocupação na quadra da própria empresa', async () => {
    // O outro lado. Sem esta, uma FK que recusasse TUDO passaria na de cima —
    // e o produto estaria quebrado com o teste verde.
    await expect(
      q(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,status_pagamento,valor,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${QUADRA_A}',DATE '2026-09-01',TIME '18:00',TIME '19:00','AVULSO','pendente_pagamento',100,now())`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('FIT-014 — turmas', () => {
  it('RECUSA turma da empresa A numa quadra da empresa B', async () => {
    await recusaPelaFK(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES (gen_random_uuid(),'${EMPRESA_A}','Turma torta','${QUADRA_B}','${PROF_A}',10,'ativa')`,
      'turmas_quadra_fkey',
    );
  });

  it('e ACEITA na quadra da própria empresa', async () => {
    await expect(
      q(
        `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA_A}','${EMPRESA_A}','Turma certa','${QUADRA_A}','${PROF_A}',10,'ativa')`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('FIT-014 — horarios_funcionamento', () => {
  it('RECUSA horário da empresa A numa quadra da empresa B', async () => {
    await recusaPelaFK(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,hora_inicio,hora_fim,fechado,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${QUADRA_B}',1,TIME '06:00',TIME '22:00',false,now())`,
      'horarios_funcionamento_quadra_fkey',
    );
  });

  it('e a linha da EMPRESA INTEIRA (quadra_id NULL) continua valendo', async () => {
    // **A prova que mais importa nesta tabela.** `quadra_id` é nulável de
    // propósito (SPEC-010: horário da empresa toda), e uma FK composta mal
    // pensada quebraria justamente esse caso. O MATCH SIMPLE do Postgres não
    // dispara quando qualquer coluna da chave é nula — mas isso é uma
    // afirmação sobre o Postgres, e afirmação sobre o banco se confere no
    // banco.
    await expect(
      q(
        `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,hora_inicio,hora_fim,fechado,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}',NULL,2,TIME '06:00',TIME '22:00',false,now())`,
      ),
    ).resolves.toBeDefined();
  });
});
