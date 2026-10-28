/**
 * SPEC-038/INV-117 — **a importação não cria aluno pela metade.**
 *
 * ## Por que este arquivo precisa de banco
 *
 * A validação é decisão pura e tem teste próprio, sem Prisma. O que só o
 * Postgres decide é o **rollback**: se a décima linha falhar na escrita, as
 * nove anteriores têm de sumir.
 *
 * E há um jeito de fazer isso falhar que nenhum mock alcança — **duas contas
 * com o mesmo e-mail dentro da mesma transação**. A validação pega a duplicata
 * quando ela está no arquivo; a corrida entre dois gestores importando ao
 * mesmo tempo, não. Aí quem recusa é a `UNIQUE` de `usuarios.email`, com
 * `23505`, no meio do lote.
 *
 * **É esse caso que este arquivo mede**, e ele é o único que prova a
 * transação: um teste que só importasse um arquivo bom ficaria verde sem
 * `$transaction` nenhuma.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { AcessoService } from '../../src/acesso/acesso.service';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { ImportacaoDeAlunosService } from '../../src/people/importacao/importacao-de-alunos.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'f0380000-0000-4000-8000-000000000001';
/** SPEC-083/D3 — o gestor do token é uma das linhas que a importação trava. */
const GESTOR = 'f0380000-0000-4000-8000-0000000000e1';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): ImportacaoDeAlunosService {
  const p = db as unknown as PrismaService;
  const memoria = new MemoriaProvedorDeEmail();
  const modelos = {
    remetente: 'convites@spec038.teste.local',
    responderPara: 'suporte@spec038.teste.local',
    urlCliente: 'https://cliente.spec038.teste.local',
    urlAdmin: 'https://admin.spec038.teste.local',
  };
  return new ImportacaoDeAlunosService(
    p,
    new AcessoService(p, memoria, modelos),
    memoria,
    modelos,
  );
}

const importar = (conteudo: string, convidar?: string) =>
  servico().importar(EMPRESA, conteudo, { gestorId: GESTOR, convidar });

const CABECALHO = 'nome,email,telefone,nivel,turma 1,turma 2,turma 3';

/** SPEC-091/D2 — o nível é obrigatório na planilha: todo clube do arquivo
 *  nasce com este, de ordem 0, e as linhas sem outro nível o citam. */
const NIVEL_BASE = 'f0380000-0000-4000-8000-0000000000b0';

async function contarAlunos(): Promise<number> {
  return db.aluno.count({ where: { companyId: EMPRESA } });
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-038','spec-038-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${NIVEL_BASE}','${EMPRESA}','Base',0)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','gestor038@teste.local','h','Gestor 038','company_admin','${EMPRESA}',now())`,
  );
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-038 — a importação escreve de verdade', () => {
  it('cria conta e ficha, com `vinculo: aprovado` e senha temporária', async () => {
    const { criados } = await importar(
      [
        CABECALHO,
        'Ana,ana038@teste.local,,Base,,,',
        'Beto,beto038@teste.local,,Base,,,',
      ].join('\n'),
    );

    expect(criados).toHaveLength(2);
    // A senha sai UMA VEZ, aqui — nenhuma outra rota a devolve (INV-118).
    expect(criados[0].senhaTemporaria).toMatch(/^pck-[A-Z0-9]{6}$/);
    // SPEC-083/D5 — sem `convidar`, ninguém ganha convite: é a de antes.
    expect(criados.map((c) => c.convite)).toEqual([undefined, undefined]);
    expect(
      await db.conviteDeAcesso.count({ where: { companyId: EMPRESA } }),
    ).toBe(0);

    const alunos = await db.aluno.findMany({
      where: { companyId: EMPRESA },
      include: { usuario: true },
    });
    expect(alunos).toHaveLength(2);
    for (const a of alunos) {
      // Foi o CLUBE que trouxe estas pessoas: elas não pedem para entrar, já
      // entraram (AC-014).
      expect(a.vinculo).toBe('aprovado');
      // INV-008 força a troca no primeiro acesso — é o que torna aceitável a
      // senha sair na resposta.
      expect(a.usuario.senhaTemporaria).toBe(true);
      expect(a.usuario.senhaTemporariaExpiraEm).toBeInstanceOf(Date);
    }
  });

  /**
   * SPEC-083/AC-001 — era o caso "grava os campos da SPEC-036", com nascimento
   * e emergência. Essas colunas saíram (D1, I5) e o modelo novo é de `;`: o
   * que sobra da SPEC-036 na planilha é o telefone, e é ele que se prova aqui.
   */
  it('SPEC-083/AC-001: o telefone da planilha de `;` vai para `usuarios.telefone`', async () => {
    await importar(
      [
        'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
        'Ana;ana038@teste.local;(11) 99999-0000;Base;;;',
        'Beto;beto038@teste.local;;Base;;;',
      ].join('\r\n'),
    );
    // O telefone vazio vai NULO, e não texto vazio: o lote passa '' no
    // arranjo, e o `nullif` do SQL é quem o desfaz.
    const beto = await db.usuario.findFirstOrThrow({
      where: { email: 'beto038@teste.local', companyId: EMPRESA },
    });
    expect(beto.telefone).toBeNull();

    const aluno = await db.aluno.findFirstOrThrow({
      where: { companyId: EMPRESA, usuario: { email: 'ana038@teste.local' } },
      include: { usuario: true },
    });
    expect(aluno.usuario.telefone).toBe('(11) 99999-0000');
  });

  it('SPEC-083/AC-002: a planilha antiga é recusada, e nada é escrito', async () => {
    await expect(
      importar(
        ['nome,email,dataNascimento', 'Ana,ana038@teste.local,1990-05-10'].join(
          '\n',
        ),
      ),
    ).rejects.toMatchObject({ response: { code: 'COLUNA_DESCONHECIDA' } });

    expect(await contarAlunos()).toBe(0);
    expect(
      await db.usuario.count({ where: { email: 'ana038@teste.local' } }),
    ).toBe(0);
  });

  /**
   * SPEC-091/D2 — substitui o SPEC-083/AC-005 ("sem nível grava NULO"): pela
   * importação, o aluno sem nível deixou de existir. **Nível vazio recusa o
   * arquivo inteiro, e nada é gravado** — contado no banco, não no relatório.
   * A linha com nível é boa, e também não entra: é tudo ou nada (D3).
   */
  it('SPEC-091/D2: nível vazio é 422 na coluna `nivel`, e nada é gravado', async () => {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('f0380000-0000-4000-8000-0000000000b2','${EMPRESA}','Intermediário',2)`,
    );

    await expect(
      importar(
        [
          'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
          'Ana;ana038@teste.local;;;;;',
          'Beto;beto038@teste.local;;Intermediário;;;',
        ].join('\r\n'),
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PLANILHA_COM_ERROS',
        erros: [
          { linha: 2, coluna: 'nivel', mensagem: 'O nível é obrigatório.' },
        ],
      },
    });

    expect(await contarAlunos()).toBe(0);
    expect(
      await db.usuario.count({
        where: { email: { in: ['ana038@teste.local', 'beto038@teste.local'] } },
      }),
    ).toBe(0);
  });

  /**
   * **INV-117, e a primeira versão deste caso PASSOU COM A SABOTAGEM.**
   *
   * Ela criava a conta duplicada entre `conferir` e `importar`, esperando que
   * a `UNIQUE` de `usuarios.email` derrubasse a décima escrita. Não derruba:
   * **`importar` reconfere antes de escrever**, então a duplicata virava
   * `PLANILHA_COM_ERROS` e nenhuma linha chegava a ser gravada. O teste ficava
   * verde com e sem `$transaction` — medido, trocando a transação por escrita
   * solta.
   *
   * A reconferência é o comportamento certo, e é ela que torna aquele cenário
   * inalcançável por dado. **O que sobra é uma falha que a validação não pode
   * prever**, e é isso que o gatilho abaixo produz: a décima linha falha por
   * um motivo que não está no arquivo.
   *
   * É artificial de propósito. O que ele mede é real: se a nona escrita
   * sobreviver a uma falha na décima, a importação cria aluno pela metade.
   */
  it('**INV-117: a décima linha falhando desfaz as nove anteriores**', async () => {
    await q(
      `CREATE OR REPLACE FUNCTION sonda_038_falha_na_decima() RETURNS trigger AS $BODY$ BEGIN IF (SELECT count(*) FROM alunos WHERE company_id = NEW.company_id) >= 9 THEN RAISE EXCEPTION 'sonda-038: a decima linha falhou' USING ERRCODE = '23514'; END IF; RETURN NEW; END $BODY$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER sonda_038 BEFORE INSERT ON alunos FOR EACH ROW EXECUTE FUNCTION sonda_038_falha_na_decima()`,
    );

    try {
      const linhas = [CABECALHO];
      for (let i = 1; i <= 10; i++) {
        linhas.push(`Aluno ${i},aluno${i}038@teste.local,,Base,,,`);
      }

      // A sonda é o que falha, e não outra coisa: sem isto, um erro qualquer
      // (de SQL, de tipo) faria o caso passar com zero linhas pelo motivo
      // errado. O `INSERT` em lote da SPEC-083 é uma instrução só, e o
      // gatilho de linha ainda vê as nove linhas que a mesma instrução já
      // inseriu — é o que o Postgres garante a um gatilho `BEFORE ROW`.
      await expect(
        importar(linhas.join(String.fromCharCode(10))),
      ).rejects.toThrow(/sonda-038: a decima linha falhou/);

      // **Zero, e não nove.** Metade importada é o estado que ninguém
      // consegue consertar sem saber qual metade — e a segunda tentativa
      // duplicaria o que já passou.
      expect(await contarAlunos()).toBe(0);
      // E as contas da mesma transação, escritas antes, saem junto.
      expect(
        await db.usuario.count({
          where: { companyId: EMPRESA, role: 'aluno' },
        }),
      ).toBe(0);
    } finally {
      // O `finally` importa: um gatilho deixado para trás faria TODA suíte
      // seguinte falhar na nona inserção de aluno, e a mensagem não diria
      // que a culpa é deste arquivo.
      await q('DROP TRIGGER IF EXISTS sonda_038 ON alunos');
      await q('DROP FUNCTION IF EXISTS sonda_038_falha_na_decima()');
    }
  });

  /**
   * SPEC-083/AC-015 — **o INV-117 nas quatro tabelas.** A sonda falha na
   * ÚLTIMA linha da ÚLTIMA escrita (`convites_de_acesso`): quando ela dispara,
   * `usuarios`, `alunos` e `turma_alunos` já foram gravadas pela mesma
   * transação. Zero nas quatro prova que o lote é uma transação só, com a
   * turma e o convite dentro dela.
   */
  it('SPEC-083/AC-015: a sonda na última linha da última escrita deixa ZERO nas quatro tabelas', async () => {
    const turma = 'f0380000-0000-4000-8000-0000000000c1';
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('f0380000-0000-4000-8000-0000000000b9','${EMPRESA}','Iniciante',1)`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('f0380000-0000-4000-8000-0000000000d1','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
    );
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${turma}','${EMPRESA}','Terça 19h','f0380000-0000-4000-8000-0000000000d1',20,'ativa','f0380000-0000-4000-8000-0000000000b9')`,
    );

    const N = 6;
    await q(
      `CREATE OR REPLACE FUNCTION sonda_083_falha_no_ultimo_convite() RETURNS trigger AS $BODY$ BEGIN IF (SELECT count(*) FROM convites_de_acesso WHERE company_id = NEW.company_id) >= ${N - 1} THEN RAISE EXCEPTION 'sonda-083: o ultimo convite falhou' USING ERRCODE = '23514'; END IF; RETURN NEW; END $BODY$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER sonda_083 BEFORE INSERT ON convites_de_acesso FOR EACH ROW EXECUTE FUNCTION sonda_083_falha_no_ultimo_convite()`,
    );

    try {
      const linhas = ['nome;email;telefone;nivel;turma 1;turma 2;turma 3'];
      for (let i = 1; i <= N; i++) {
        linhas.push(
          `Aluno ${i};conv${i}038@teste.local;;Iniciante;Terça 19h;;`,
        );
      }
      // Todas convidadas e todas na turma: as quatro escritas acontecem.
      const todas = Array.from({ length: N }, (_, i) => i + 2).join(',');

      await expect(importar(linhas.join('\r\n'), todas)).rejects.toThrow(
        /sonda-083: o ultimo convite falhou/,
      );

      expect(await contarAlunos()).toBe(0);
      expect(
        await db.usuario.count({
          where: { companyId: EMPRESA, role: 'aluno' },
        }),
      ).toBe(0);
      expect(await db.turmaAluno.count({ where: { turmaId: turma } })).toBe(0);
      expect(
        await db.conviteDeAcesso.count({ where: { companyId: EMPRESA } }),
      ).toBe(0);
    } finally {
      await q('DROP TRIGGER IF EXISTS sonda_083 ON convites_de_acesso');
      await q('DROP FUNCTION IF EXISTS sonda_083_falha_no_ultimo_convite()');
    }
  });

  it('AC-012: arquivo COM erro não escreve nada, e diz quantos', async () => {
    await expect(
      importar(
        [
          CABECALHO,
          'Ana,ana038@teste.local,,Base,,,',
          ',sem-nome@teste.local,,Base,,,',
        ].join('\n'),
      ),
    ).rejects.toMatchObject({
      response: { code: 'PLANILHA_COM_ERROS' },
    });

    // A linha boa também não entra: é tudo ou nada (D3).
    expect(await contarAlunos()).toBe(0);
  });

  it('AC-001: `conferir` não escreve — provado CONTANDO, não pela ausência de erro', async () => {
    await servico().conferir(
      EMPRESA,
      [CABECALHO, 'Ana,ana038@teste.local,,Base,,,'].join('\n'),
    );
    // Um teste que só verificasse "não lançou erro" ficaria verde com uma
    // implementação que escrevesse.
    expect(await contarAlunos()).toBe(0);
  });

  it('o nível vem por NOME, e o id gravado é o certo', async () => {
    const nivel = 'f0380000-0000-4000-8000-0000000000a1';
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${nivel}','${EMPRESA}','Intermediário',1)`,
    );

    await importar(
      [CABECALHO, 'Ana,ana038@teste.local,,intermediario,,,'].join('\n'),
    );

    const aluno = await db.aluno.findFirstOrThrow({
      where: { companyId: EMPRESA },
    });
    // Casou sem acento e sem caixa: o gestor não tem UUID na planilha, e não
    // vai digitar o acento igual todas as vezes.
    expect(aluno.nivelId).toBe(nivel);
  });
});
