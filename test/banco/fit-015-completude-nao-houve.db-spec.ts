/**
 * **FIT-015: o banco impõe a regra de `esperados` para os TRÊS estados.**
 *
 * SPEC-030 / prova 12 da spec.
 *
 * Isto **só se prova contra Postgres real.** A regra não está em código
 * nenhum: está num `CHECK` escrito à mão em
 * `20260830100100_spec030_check_esperados_nao_houve`, e `prisma migrate diff`
 * **não gera CHECK** — se alguém recriar a migration, ele some sem o CI
 * reclamar (LIM-030a). Este arquivo é o que faz o CI reclamar.
 *
 * **Por que cada INSERT é SQL cru.** O que está em julgamento não é o
 * serviço: é que mesmo um `INSERT` escrito por quem ignorou todos os serviços
 * seja recusado. Passar pelo Prisma Client provaria que o serviço faz o que o
 * serviço faz.
 *
 * **A prova positiva é tão importante quanto a negativa.** Um CHECK que
 * recusasse `nao_houve` sempre passaria em todas as recusas abaixo — e a
 * SPEC-030 inteira estaria quebrada com o teste verde. Foi essa a lição da
 * FIT-014.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { diasAtrasNoClube } from './hoje-no-clube-sql';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0150000-0000-4000-8000-00000000000a';
const QUADRA = 'f0150000-0000-4000-8000-00000000001a';
const PROF = 'f0150000-0000-4000-8000-00000000002a';
const UPROF = 'f0150000-0000-4000-8000-00000000003a';
const TURMA = 'f0150000-0000-4000-8000-00000000004a';

const CHECK = 'chamadas_completude_esperados_check';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

/** Um id de ocorrência por caso: o cabeçalho é 1:1 com a ocupação (PK). */
function ocupacaoId(n: number) {
  return `f0150000-0000-4000-8000-0000000001${String(n).padStart(2, '0')}`;
}

/**
 * Recusado, e recusado **por ESTE CHECK** — não por qualquer erro.
 *
 * `rejects.toThrow()` não separa "a constraint funcionou" de "eu errei o nome
 * de uma coluna", e uma prova assim continua verde depois de a constraint
 * sumir. A exigência aqui é o nome dela na mensagem.
 */
async function recusaPeloCheck(sql: string): Promise<void> {
  const erro: unknown = await q(sql).then(
    () => null,
    (e: unknown) => e,
  );
  // A primeira asserção não é redundante: sem ela, um INSERT que passasse
  // deixaria `erro` nulo e a segunda falharia com "cannot read property
  // message of null" — mensagem que não diz o que aconteceu.
  expect(erro).not.toBeNull();
  expect((erro as Error).message).toContain(CHECK);
}

function inserirChamada(
  ocId: string,
  completude: string,
  esperados: string,
): string {
  return `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,completude,esperados,updated_at)
          VALUES ('${ocId}','TURMA','${EMPRESA}','${UPROF}','${completude}',${esperados},now())`;
}

/**
 * A ocorrência é de **ONTEM**, e isso não é estética.
 *
 * Fixture de aula com a data de hoje escolhe implicitamente uma HORA, e uma
 * aula de hoje às 00:00 "já começou" às 00:03 e não às 23:00 do dia anterior.
 * Quatro defeitos de 2026-08-30 vieram dessa família, e dois derrubaram o CI.
 * A regra está em `hoje-no-clube-sql.ts`, e é ela que este arquivo segue.
 */
/**
 * **`valor` NULO, e o CI foi quem ensinou.**
 *
 * A primeira versão gravava `valor=100` numa ocupação de `TURMA`, e as 7
 * provas deste arquivo caíam em `ocupacoes_valor_por_origem`:
 *
 * ```sql
 * CHECK (
 *   (origem_tipo = 'AVULSO' AND valor IS NOT NULL AND valor >= 0)
 *   OR (origem_tipo = 'TURMA' AND valor IS NULL)
 * )
 * ```
 *
 * Valor é da reserva avulsa; a aula de turma é paga pela mensalidade, e
 * atribuir preço a ela seria cobrar duas vezes. **A fixture escrevia um
 * estado que o produto não tem.**
 *
 * Este arquivo passou sete rodadas de validação cruzada declarado como *"o
 * único sem prova executada, e o mais provável de estar errado"* — Docker não
 * sobe nesta máquina e o Postgres local recusa conexão. Estava errado, e
 * nenhuma leitura pegou: o CHECK mora na migration, não no código que a
 * fixture parece contradizer.
 */
async function criarOcupacao(ocId: string) {
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,valor,updated_at)
     VALUES ('${ocId}','${EMPRESA}','${QUADRA}',${diasAtrasNoClube(1)},TIME '18:00',TIME '19:00','TURMA','${TURMA}','pendente_pagamento',NULL,now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-015','fit-015',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}'),100)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${UPROF}','fit015@teste.local','x','Prof','professor','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${PROF}','${EMPRESA}','Prof','${UPROF}',now())`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma','${QUADRA}','${PROF}',10,'ativa')`,
  );
  for (let n = 1; n <= 6; n += 1) {
    await criarOcupacao(ocupacaoId(n));
  }
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-015 — o valor `nao_houve` existe no enum', () => {
  it('o enum `completude_chamada` tem os TRÊS valores, e `nao_houve` é o ÚLTIMO', async () => {
    const linhas = await db.$queryRawUnsafe<{ valor: string }[]>(
      `SELECT e.enumlabel AS valor
         FROM pg_enum e JOIN pg_type t ON t.oid = e.enumtypid
        WHERE t.typname = 'completude_chamada'
        ORDER BY e.enumsortorder`,
    );

    // A ORDEM importa, e é a segunda vez que ela importa neste projeto:
    // `ALTER TYPE ADD VALUE` anexa ao fim, e declarar noutra posição no
    // `schema.prisma` cria drift permanente entre schema e banco. A primeira
    // foi `professor` em `usuario_role` (SPEC-013).
    expect(linhas.map((l) => l.valor)).toEqual([
      'completa',
      'desconhecida',
      'nao_houve',
    ]);
  });
});

describe('FIT-015 — o CHECK de `esperados`', () => {
  it('ACEITA `nao_houve` com `esperados` nulo', async () => {
    // **A prova positiva, e ela vem primeiro de propósito.** Um CHECK que
    // recusasse `nao_houve` sempre passaria em todas as recusas abaixo, e a
    // spec inteira estaria quebrada com o arquivo verde.
    await expect(
      q(inserirChamada(ocupacaoId(1), 'nao_houve', 'NULL')),
    ).resolves.toBeDefined();
  });

  it('RECUSA `nao_houve` com `esperados` preenchido', async () => {
    // Quem diz que a aula não aconteceu não está afirmando sobre quantos
    // alunos eram esperados: não há universo sobre o qual afirmar.
    await recusaPeloCheck(inserirChamada(ocupacaoId(2), 'nao_houve', '5'));
  });

  it('RECUSA `nao_houve` com `esperados` ZERO', async () => {
    // `0` não é o mesmo que nulo, e um CHECK escrito como `esperados IS NULL
    // OR esperados = 0` passaria aqui. A regra é ausência, não zero.
    await recusaPeloCheck(inserirChamada(ocupacaoId(3), 'nao_houve', '0'));
  });

  it('os dois casos ANTIGOS continuam valendo — `completa` exige `esperados`', async () => {
    // A migration nova faz DROP + ADD da constraint. Se ela tivesse
    // enfraquecido os casos antigos ao reescrevê-los, nada mais reclamaria.
    await recusaPeloCheck(inserirChamada(ocupacaoId(4), 'completa', 'NULL'));
  });

  it('e `desconhecida` continua exigindo `esperados` NULO', async () => {
    await recusaPeloCheck(inserirChamada(ocupacaoId(5), 'desconhecida', '5'));
  });

  it('`completa` com `esperados > 0` continua sendo aceita', async () => {
    await expect(
      q(inserirChamada(ocupacaoId(6), 'completa', '3')),
    ).resolves.toBeDefined();
  });
});
