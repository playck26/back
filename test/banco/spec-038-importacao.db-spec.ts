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
import { ImportacaoDeAlunosService } from '../../src/people/importacao/importacao-de-alunos.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'f0380000-0000-4000-8000-000000000001';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): ImportacaoDeAlunosService {
  return new ImportacaoDeAlunosService(db as unknown as PrismaService);
}

const CABECALHO = 'nome,email';

async function contarAlunos(): Promise<number> {
  return db.aluno.count({ where: { companyId: EMPRESA } });
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-038','spec-038-${EMPRESA}',now())`,
  );
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-038 — a importação escreve de verdade', () => {
  it('cria conta e ficha, com `vinculo: aprovado` e senha temporária', async () => {
    const { criados } = await servico().importar(
      EMPRESA,
      [CABECALHO, 'Ana,ana038@teste.local', 'Beto,beto038@teste.local'].join(
        '\n',
      ),
    );

    expect(criados).toHaveLength(2);
    // A senha sai UMA VEZ, aqui — nenhuma outra rota a devolve (INV-118).
    expect(criados[0].senhaTemporaria).toEqual(expect.any(String));
    expect(criados[0].senhaTemporaria.length).toBeGreaterThan(5);

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

  it('grava os campos da SPEC-036 que vieram na planilha', async () => {
    await servico().importar(
      EMPRESA,
      [
        'nome,email,telefone,dataNascimento,emergenciaNome,emergenciaTelefone',
        'Ana,ana038@teste.local,11999990000,1990-05-10,Beto,11988887777',
      ].join('\n'),
    );

    const aluno = await db.aluno.findFirstOrThrow({
      where: { companyId: EMPRESA },
      include: { usuario: true },
    });
    expect(aluno.usuario.telefone).toBe('11999990000');
    expect(aluno.dataNascimento?.toISOString().slice(0, 10)).toBe('1990-05-10');
    expect(aluno.emergenciaNome).toBe('Beto');
    // Com nome, e-mail, telefone, nascimento e os dois de emergência, este
    // aluno nasce com 86% de completude — falta só o nível (SPEC-036).
    expect(aluno.emergenciaTelefone).toBe('11988887777');
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
        linhas.push(`Aluno ${i},aluno${i}038@teste.local`);
      }

      await expect(
        servico().importar(EMPRESA, linhas.join(String.fromCharCode(10))),
      ).rejects.toBeDefined();

      // **Zero, e não nove.** Metade importada é o estado que ninguém
      // consegue consertar sem saber qual metade — e a segunda tentativa
      // duplicaria o que já passou.
      expect(await contarAlunos()).toBe(0);
    } finally {
      // O `finally` importa: um gatilho deixado para trás faria TODA suíte
      // seguinte falhar na nona inserção de aluno, e a mensagem não diria
      // que a culpa é deste arquivo.
      await q('DROP TRIGGER IF EXISTS sonda_038 ON alunos');
      await q('DROP FUNCTION IF EXISTS sonda_038_falha_na_decima()');
    }
  });

  it('AC-012: arquivo COM erro não escreve nada, e diz quantos', async () => {
    const s = servico();
    await expect(
      s.importar(
        EMPRESA,
        [CABECALHO, 'Ana,ana038@teste.local', ',sem-nome@teste.local'].join(
          '\n',
        ),
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
      [CABECALHO, 'Ana,ana038@teste.local'].join('\n'),
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

    await servico().importar(
      EMPRESA,
      ['nome,email,nivel', 'Ana,ana038@teste.local,intermediario'].join('\n'),
    );

    const aluno = await db.aluno.findFirstOrThrow({
      where: { companyId: EMPRESA },
    });
    // Casou sem acento e sem caixa: o gestor não tem UUID na planilha, e não
    // vai digitar o acento igual todas as vezes.
    expect(aluno.nivelId).toBe(nivel);
  });
});
