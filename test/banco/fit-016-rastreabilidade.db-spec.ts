/**
 * **FIT-016 e FIT-020 — a auditoria que o BANCO impõe.**
 *
 * O FIT-017 (a trigger que exige evento no cancelamento) mora em
 * `fit-017-cancelar-exige-evento.db-spec.ts`, e **isso não é organização, é
 * entrega**: aquela trigger vem na fase `contract`, aplicada só depois que o
 * código que grava eventos estiver no ar. Ver o cabeçalho da migration.
 *
 * SPEC-032. As três invariantes provadas aqui têm uma coisa em comum: **não
 * estão em código nenhum.** Estão em triggers e em chaves estrangeiras, e um
 * dublê não tem nem uma coisa nem outra.
 *
 * Foi exatamente esse o achado que reprovou a v1 da spec: ela dizia
 * *"append-only garantido por não existir rota"*, e isso descreve o código de
 * hoje, não uma garantia. Por isso cada prova aqui escreve **SQL cru** — o
 * que está em julgamento é que mesmo alguém ignorando todos os serviços seja
 * recusado.
 *
 * ## A armadilha do `DEFERRABLE`, e ela quase produziu falso verde
 *
 * A trigger da INV-064 é `DEFERRABLE INITIALLY DEFERRED`: ela **só julga no
 * `COMMIT`**. A primeira versão desta prova isolava os casos por *rollback* e
 * deu **verde em quatro casos que deveriam falhar** — o `COMMIT` nunca
 * acontecia, e a trigger nunca rodava.
 *
 * É por isso que todo caso de INV-064 aqui força
 * `SET CONSTRAINTS ... IMMEDIATE` antes de terminar. Sem essa linha, este
 * arquivo inteiro é decorativo.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0160000-0000-4000-8000-000000000001';
const OUTRA = 'f0160000-0000-4000-8000-000000000002';
const USUARIO = 'f0160000-0000-4000-8000-000000000011';
const ESPORTE = 'f0160000-0000-4000-8000-000000000021';
const QUADRA = 'f0160000-0000-4000-8000-000000000031';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const uuid = () => crypto.randomUUID();

/**
 * **Recusado, e recusado PELO MOTIVO CERTO.**
 *
 * Mesma disciplina do FIT-014, e pela mesma razão: aquela prova passou verde
 * uma vez porque o `INSERT` morria num enum antes de chegar à chave.
 * `rejects.toThrow()` não distingue.
 */
async function recusaPor(
  fn: () => Promise<unknown>,
  trecho: string,
): Promise<void> {
  const erro: unknown = await fn().then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  expect((erro as Error).message).toContain(trecho);
}

/** Uma ocupação avulsa nova, para não reaproveitar estado entre casos. */
async function novaOcupacao(dia: string): Promise<string> {
  const id = uuid();
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,valor,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${dia}','08:00','09:00','AVULSO',80,now())`,
  );
  return id;
}

async function novaAcao(): Promise<string> {
  const id = uuid();
  await q(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES ('${id}','${EMPRESA}','reserva_cancelada','${USUARIO}')`,
  );
  return id;
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA);
  for (const [id, slug] of [
    [EMPRESA, 'a'],
    [OUTRA, 'b'],
  ]) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${id}','FIT-016 ${slug}','fit-016-${slug}',now())`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${USUARIO}','fit016@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q','${ESPORTE}',80)`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA);
  await db.$disconnect();
});

describe('FIT-016 — append-only é do BANCO, não da ausência de rota (INV-061)', () => {
  it('UPDATE em acoes_administrativas é recusado', async () => {
    const acao = await novaAcao();
    await recusaPor(
      () => q(`UPDATE acoes_administrativas SET motivo='x' WHERE id='${acao}'`),
      'append-only',
    );
  });

  it('DELETE em acoes_administrativas é recusado', async () => {
    const acao = await novaAcao();
    await recusaPor(
      () => q(`DELETE FROM acoes_administrativas WHERE id='${acao}'`),
      'append-only',
    );
  });

  it('UPDATE e DELETE em eventos_de_ocupacao são recusados', async () => {
    const oc = await novaOcupacao('2027-01-05');
    const acao = await novaAcao();
    const ev = uuid();
    await q(
      `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
       VALUES ('${ev}','${EMPRESA}','${acao}','${oc}','criada','${uuid()}')`,
    );
    await recusaPor(
      () =>
        q(`UPDATE eventos_de_ocupacao SET tipo='cancelada' WHERE id='${ev}'`),
      'append-only',
    );
    await recusaPor(
      () => q(`DELETE FROM eventos_de_ocupacao WHERE id='${ev}'`),
      'append-only',
    );
  });

  /**
   * **O GUC sozinho NÃO abre a válvula**, e este é o caso que a 3ª rodada de
   * validação cruzada exigiu. A versão anterior aceitava só a configuração de
   * sessão — e `set_config` é chamável por qualquer código, com o nome à
   * vista na migration. Aquilo teria funcionado em produção.
   */
  it('o GUC sem a role NÃO abre a válvula', async () => {
    const acao = await novaAcao();
    await recusaPor(
      () =>
        db.$transaction(async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT set_config('playck.limpeza_append_only','on',true)`,
          );
          await tx.$executeRawUnsafe(
            `DELETE FROM acoes_administrativas WHERE id='${acao}'`,
          );
        }),
      'append-only',
    );
  });
});

describe('FIT-016 — nada cruza empresa (INV-077)', () => {
  it('evento apontando ação de OUTRA empresa é recusado pela FK composta', async () => {
    const oc = await novaOcupacao('2027-01-06');
    const acao = await novaAcao();
    await recusaPor(
      () =>
        q(
          `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
           VALUES ('${uuid()}','${OUTRA}','${acao}','${oc}','criada','${uuid()}')`,
        ),
      'eventos_acao_fkey',
    );
  });

  it('apagar o autor é recusado (INV-062)', async () => {
    await novaAcao();
    await recusaPor(
      () => q(`DELETE FROM usuarios WHERE id='${USUARIO}'`),
      'acoes_autor_fkey',
    );
  });
});

describe('FIT-020 — a válvula da limpeza funciona (LIM-032e)', () => {
  /**
   * O teste que avisa no dia em que a **terceira** tabela append-only nascer
   * sem entrar em `TABELAS_DA_EMPRESA`. Sem ele, a próxima spec descobre isso
   * por uma suíte vermelha longe daqui — foi o que aconteceu em 2026-08-26
   * com `esportes_de_quadra`.
   */
  it('limparEmpresa apaga auditoria sem esbarrar no append-only', async () => {
    const oc = await novaOcupacao('2027-03-09');
    const acao = await novaAcao();
    await q(
      `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
       VALUES ('${uuid()}','${EMPRESA}','${acao}','${oc}','criada','${uuid()}')`,
    );

    await expect(limparEmpresa(db, EMPRESA)).resolves.not.toThrow();

    const sobrou = await db.eventoDeOcupacao.count({
      where: { companyId: EMPRESA },
    });
    expect(sobrou).toBe(0);
  });
});
