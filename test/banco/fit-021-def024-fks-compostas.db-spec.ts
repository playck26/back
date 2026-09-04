/**
 * **FIT-021: o banco recusa apontar para aluno, usuário ou ocorrência de
 * outra empresa.** DEF-024, fase 1.
 *
 * Mesmo molde do FIT-014 (DEF-022), e pelo mesmo motivo: a regra **não está
 * em código nenhum**. Está numa `FOREIGN KEY (company_id, x_id)`. Um mock não
 * tem chave estrangeira, e um teste de serviço provaria no máximo que o
 * serviço faz o que o serviço faz — que é justamente o que **não** está em
 * julgamento.
 *
 * O que está em julgamento é o contrário: que um `INSERT` cru, escrito por
 * alguém que ignorou todos os serviços, seja recusado. Por isso cada prova
 * aqui é SQL direto.
 *
 * **Por que quatro, e não as catorze da varredura.** As outras dez não são
 * substituição limpa: três já são compostas com `origem_tipo` (precisam de
 * uma segunda FK) e sete são `ON DELETE SET NULL`, que numa chave composta
 * anularia `company_id` — `NOT NULL` em todas elas. Ver
 * `DEF-024-FKS-CROSS-TENANT.md`. Fechar quatro e declarar as dez é melhor que
 * fechar as quatro e deixar o leitor achar que acabou: foi exatamente esse o
 * erro do DEF-022, que fechou três e a família voltou uma spec depois.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA_A = 'f0240000-0000-4000-8000-00000000000a';
const EMPRESA_B = 'f0240000-0000-4000-8000-00000000000b';
const QUADRA_A = 'f0240000-0000-4000-8000-00000000001a';
const QUADRA_B = 'f0240000-0000-4000-8000-00000000001b';
const USUARIO_A = 'f0240000-0000-4000-8000-00000000002a';
const USUARIO_B = 'f0240000-0000-4000-8000-00000000002b';
const ALUNO_A = 'f0240000-0000-4000-8000-00000000003a';
const ALUNO_B = 'f0240000-0000-4000-8000-00000000003b';
const OCUPACAO_A = 'f0240000-0000-4000-8000-00000000004a';
const OCUPACAO_B = 'f0240000-0000-4000-8000-00000000004b';
const CHAMADA_PROF = 'f0240000-0000-4000-8000-00000000005a';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

/**
 * **Recusado, e recusado PELA FK** — não por qualquer erro.
 *
 * A exigência do nome da constraint é herdada do FIT-014, e a razão dela está
 * escrita lá: a primeira versão daquele arquivo passou verde pelo motivo
 * errado, porque o `INSERT` era recusado num enum antes de chegar perto da
 * chave estrangeira. `rejects.toThrow()` não distingue as duas coisas.
 */
async function recusaPelaFK(sql: string, constraint: string): Promise<void> {
  const erro: unknown = await q(sql).then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  expect(String((erro as Error).message)).toContain(constraint);
}

/** O mesmo `INSERT`, com o par certo, TEM de passar — senão a prova acima
 *  estaria verde por qualquer motivo, inclusive por a linha ser inválida. */
async function aceitaOParCerto(sql: string): Promise<void> {
  await expect(q(sql)).resolves.toBeDefined();
}

async function montar(): Promise<void> {
  for (const [emp, nome] of [
    [EMPRESA_A, 'A'],
    [EMPRESA_B, 'B'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','DEF-024 ${nome}','def024-${nome.toLowerCase()}-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
  }
  for (const [quadra, emp] of [
    [QUADRA_A, EMPRESA_A],
    [QUADRA_B, EMPRESA_B],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadra}','${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80)`,
    );
  }
  for (const [usuario, aluno, emp, sufixo] of [
    [USUARIO_A, ALUNO_A, EMPRESA_A, 'a'],
    [USUARIO_B, ALUNO_B, EMPRESA_B, 'b'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuario}','def024-${sufixo}@teste.local','x','U','aluno','${emp}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${aluno}','${usuario}','${emp}','aprovado')`,
    );
  }
  // Uma ocorrência avulsa por empresa. `valor` é obrigatório para AVULSO
  // (CHECK `ocupacoes_valor_por_origem`).
  for (const [ocupacao, quadra, emp, aluno] of [
    [OCUPACAO_A, QUADRA_A, EMPRESA_A, ALUNO_A],
    [OCUPACAO_B, QUADRA_B, EMPRESA_B, ALUNO_B],
  ] as const) {
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES ('${ocupacao}','${emp}','${quadra}',CURRENT_DATE + 1,'09:00','10:00','AVULSO','${aluno}',80,'pendente_pagamento',now())`,
    );
  }
  // Um usuário para registrar chamada/presença na empresa A.
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${CHAMADA_PROF}','def024-prof@teste.local','x','P','company_admin','${EMPRESA_A}',now())`,
  );
}

beforeAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await montar();
});

afterAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await db.$disconnect();
});

describe('FIT-021 — DEF-024 fase 1: a empresa entra na chave', () => {
  it('avaliacoes_de_aula não avalia com aluno de outra empresa', async () => {
    await recusaPelaFK(
      `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,created_at,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${OCUPACAO_A}','${ALUNO_B}',5,now(),now())`,
      'avaliacoes_de_aula_aluno_fkey',
    );
    await aceitaOParCerto(
      `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,created_at,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${OCUPACAO_A}','${ALUNO_A}',5,now(),now())`,
    );
  });

  it('avaliacoes_de_aula não avalia ocorrência de outra empresa', async () => {
    await recusaPelaFK(
      `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,created_at,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${OCUPACAO_B}','${ALUNO_A}',5,now(),now())`,
      'avaliacoes_de_aula_ocupacao_fkey',
    );
  });

  it('presencas não registra aluno de outra empresa', async () => {
    // A presença precisa de chamada e de ocorrência de TURMA; para isolar a
    // FK do aluno, basta que o `INSERT` chegue nela — e ele chega, porque a
    // FK do aluno é conferida junto com as outras.
    await recusaPelaFK(
      `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at) VALUES (gen_random_uuid(),'${EMPRESA_A}','${OCUPACAO_A}','TURMA','${ALUNO_B}','presente','${CHAMADA_PROF}',now())`,
      'presencas_aluno_fkey',
    );
  });

  it('alunos não aponta para usuário de outra empresa', async () => {
    await recusaPelaFK(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES (gen_random_uuid(),'${USUARIO_B}','${EMPRESA_A}','aprovado')`,
      'alunos_usuario_fkey',
    );
  });

  /**
   * A prova de que as **cinco benignas** continuam benignas — e não é
   * detalhe: se alguém "consertar" a FK de autoria por simetria, o
   * `super_admin` (que tem `company_id` nulo) deixa de poder ser autor de
   * qualquer coisa, e é isso que a LIM-032f protege.
   */
  it('a FK de AUTORIA continua simples: super_admin pode ser autor', async () => {
    const SUPER = 'f0240000-0000-4000-8000-00000000009f';
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,updated_at) VALUES ('${SUPER}','def024-super@teste.local','x','S','super_admin',now())`,
    );
    await aceitaOParCerto(
      `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id,criado_em) VALUES (gen_random_uuid(),'${EMPRESA_A}','reserva_cancelada','${SUPER}',now())`,
    );
    await q(`DELETE FROM usuarios WHERE id = '${SUPER}'`).catch(() => undefined);
  });
});
