import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * SPEC-075/AC-029 — **nenhum escritor protegido fora da lista.**
 *
 * A INV-075h (edição de nível e criação de matrícula de uma empresa nunca
 * correm juntas) vale pelos caminhos que tomam a trava de nível da empresa
 * (D13). Um caminho NOVO que matricule, ou que escreva nível, sem tomá-la
 * derrubaria a invariante em silêncio. Esta varredura é o que falha no dia em
 * que ele for escrito.
 *
 * **Os arquivos vêm do `git ls-files`, e não de uma pasta escolhida à mão** —
 * foi escolher a pasta (`src/`) que deixou o seed de fora na v4 da spec.
 * Código, SQL e workflow; fora `test/`, `*.spec.ts` e `node_modules/`: as
 * fixtures de teste gravam por SQL de propósito, e não são runtime.
 *
 * **É varredura TEXTUAL** (R4-03): prova que não apareceu escritor novo nas
 * formas enumeradas — não que SQL montado em pedaços, ou uma abstração nova,
 * não escapem. **Quebrar numa refatoração inocente é o propósito**: obriga
 * quem mexeu na fronteira a rever esta lista e as provas da D13. Que os da
 * lista tomam a trava é o FIT-055 (AC-026).
 */

const RAIZ = join(__dirname, '..', '..');

function arquivosRastreados(): string[] {
  const saida = execFileSync('git', ['ls-files'], {
    cwd: RAIZ,
    encoding: 'utf8',
  });
  return saida
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => /\.(ts|js|cjs|mjs|sql|ya?ml)$/.test(l))
    .filter((l) => !l.startsWith('test/') && !l.startsWith('node_modules/'))
    .filter((l) => !l.endsWith('.spec.ts'));
}

/** Linhas de código, sem comentário: um comentário que CITA o escritor não é
 *  escritor. */
function linhasDeCodigo(arquivo: string): string[] {
  return readFileSync(join(RAIZ, arquivo), 'utf8')
    .split('\n')
    .filter((l) => {
      const s = l.trim();
      return !(
        s.startsWith('//') ||
        s.startsWith('*') ||
        s.startsWith('/*') ||
        s.startsWith('--')
      );
    });
}

function ocorrencias(padrao: RegExp, excluir?: RegExp): Map<string, number> {
  const achados = new Map<string, number>();
  for (const arquivo of arquivosRastreados()) {
    const n = linhasDeCodigo(arquivo).filter(
      (l) => padrao.test(l) && !(excluir && excluir.test(l)),
    ).length;
    if (n > 0) achados.set(arquivo, n);
  }
  return achados;
}

describe('SPEC-075/AC-029 — nenhum escritor protegido fora da lista', () => {
  it('a varredura enxerga o repositório (e não uma lista vazia que passaria por nada)', () => {
    const arquivos = arquivosRastreados();
    expect(arquivos).toContain('src/classes/classes.service.ts');
    expect(arquivos).toContain('prisma/seed.ts');
    expect(arquivos.some((a) => a.endsWith('.sql'))).toBe(true);
  });

  /**
   * **SPEC-082/D2b — o `INSERT` mudou de casa, não de dono.** O
   * `tx.turmaAluno.create` de `allocateStudent` e de `entrarNaTransacao` virou
   * SQL cru, num lugar só (`matricula-com-prazo.ts`), porque a API de modelo
   * não carrega o prazo nem o `FOR KEY SHARE`. Os escritores continuam os
   * mesmos dois caminhos — agora provados pelo teste de baixo, que conta
   * quem CHAMA a instrução.
   */
  it('escritores de MATRÍCULA: exatamente a instrução com prazo e o seed — um em cada', () => {
    const achados = ocorrencias(
      /turmaAluno\.(create|createMany|upsert)\b|INSERT\s+INTO\s+"?turma_alunos"?/i,
    );
    expect(Object.fromEntries(achados)).toEqual({
      'prisma/seed.ts': 1,
      'src/classes/matricula-com-prazo.ts': 1,
    });
  });

  it('chamadores da instrução com prazo (SPEC-082): só classes.service e matricula-do-aluno.service — um em cada', () => {
    const achados = ocorrencias(
      /inserirMatriculaComPrazo\(/,
      /function inserirMatriculaComPrazo\(/,
    );
    expect(Object.fromEntries(achados)).toEqual({
      'src/classes/classes.service.ts': 1,
      'src/classes/matricula-do-aluno.service.ts': 1,
    });
  });

  /**
   * **SPEC-079/D2 — as migrações de passagem entram PELO NOME.** Elas escrevem
   * nível (os três padrão nas empresas sem nível) e o nível da turma, no boot
   * da instância nova com a antiga atendendo — por isso tomam a trava da
   * empresa, como os outros da lista (a espera é provada no AC-018 da 079).
   *
   * O padrão ganhou o `UPDATE turmas SET nivel_id` por SQL: sem ele, a
   * atribuição do primeiro nível passaria por esta varredura sem ser vista. Não
   * é exceção por pasta: uma migração nova que escreva nível continua
   * reprovando.
   */
  it('escritores de NÍVEL: só MOD-003 (src/people) e as migrações da 079 — a empresa e o seed delegam (D7)', () => {
    const achados = ocorrencias(
      /\bnivel\.(create|createMany|upsert|update|updateMany)\b|(INSERT\s+INTO|UPDATE)\s+"?niveis"?\b|UPDATE\s+"?turmas"?\s+SET\s+"?nivel_id"?\b/i,
    );
    expect(Object.fromEntries(achados)).toEqual({
      'prisma/migrations/20260928180000_spec079_niveis_e_primeiro_nivel/migration.sql': 2,
      'prisma/migrations/20260929120000_spec079_turma_nivel_not_null/migration.sql': 1,
      'src/people/levels.service.ts': 2,
      'src/people/nivel-efetivo.ts': 1,
    });
  });

  it('chamadores de entrarNaTransacao (que confia em quem o chama para tomar a trava): só entrar e confirmar', () => {
    const achados = ocorrencias(
      /entrarNaTransacao\(/,
      /async entrarNaTransacao\(/,
    );
    expect(Object.fromEntries(achados)).toEqual({
      'src/classes/matricula-do-aluno.service.ts': 1,
      'src/fila-de-espera/fila-de-espera.service.ts': 1,
    });
  });
});

/**
 * SPEC-082/AC-003 — **a tabela leitor/escritor, caminho a caminho (forma).**
 *
 * Leitor toma a trava do clube em modo compartilhado e a do aluno (a instrução
 * única do D2); escritor, a exclusiva. Uma transação que tomasse as duas
 * formas promoveria a compartilhada para exclusiva — e o Postgres não promove
 * sem esperar, o que é o caminho mais curto para um deadlock. Por isso cada
 * caminho aparece numa lista só.
 *
 * O caminho é o arquivo e o método (ou função) que envolve a chamada; o modo é
 * o terceiro argumento dela. **É varredura textual**, como as de cima: prova a
 * forma; o comportamento (o leitor não espera o compartilhado, o escritor
 * espera) são o AC-001 e o AC-002, contra banco.
 */
describe('SPEC-082/AC-003 — leitor e escritor da trava de nível, por caminho', () => {
  const DECLARACAO =
    /^(?:export\s+)?(?:async\s+)?function\s+(\w+)|^ {2}(?:private\s+|public\s+)?(?:async\s+)?(\w+)\(/;

  function chamadas(): string[] {
    const achadas: string[] = [];
    for (const arquivo of arquivosRastreados()) {
      const linhas = readFileSync(join(RAIZ, arquivo), 'utf8').split('\n');
      let caminho = '?';
      linhas.forEach((linha, i) => {
        const declaracao = DECLARACAO.exec(linha);
        if (declaracao) caminho = declaracao[1] ?? declaracao[2];
        const s = linha.trim();
        if (s.startsWith('//') || s.startsWith('*') || s.startsWith('/*')) {
          return;
        }
        if (
          !/travarNivelDaEmpresa\(/.test(linha) ||
          /function travarNivelDaEmpresa\(/.test(linha)
        ) {
          return;
        }
        const chamada = linhas.slice(i, i + 3).join(' ');
        const modo = /'escrita'/.test(chamada)
          ? 'escrita'
          : /\{\s*leituraDoAluno:/.test(chamada)
            ? 'leitura'
            : 'SEM_MODO';
        achadas.push(`${arquivo}#${caminho}: ${modo}`);
      });
    }
    return achadas.sort();
  }

  it('cada caminho com o seu modo, e nenhum outro', () => {
    expect(chamadas()).toEqual(
      [
        // leitores (instrução única: clube compartilhado + aluno)
        'src/classes/matricula-do-aluno.service.ts#entrar: leitura',
        'src/classes/classes.service.ts#allocateStudent: leitura',
        'src/fila-de-espera/fila-de-espera.service.ts#confirmar: leitura',
        // escritores (exclusiva, como na SPEC-075)
        'src/classes/classes.service.ts#update: escrita',
        'src/people/levels.service.ts#gravarConferindoOPrimeiro: escrita',
        'src/people/levels.service.ts#remove: escrita',
        'src/people/students.service.ts#update: escrita',
        'prisma/seed.ts#seedEtapa3: escrita',
        'prisma/seed.ts#seedEtapa3: escrita',
      ].sort(),
    );
  });

  it('nenhum caminho aparece nas duas listas (sem promoção na mesma transação)', () => {
    const modos = new Map<string, Set<string>>();
    for (const linha of chamadas()) {
      const [caminho, modo] = linha.split(': ');
      modos.set(caminho, (modos.get(caminho) ?? new Set()).add(modo));
    }
    const nasDuas = [...modos].filter(([, m]) => m.size > 1).map(([c]) => c);
    expect(nasDuas).toEqual([]);
    expect(modos.size).toBe(8);
  });
});
