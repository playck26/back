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

  it('escritores de MATRÍCULA: exatamente classes.service, matricula-do-aluno.service e o seed — um em cada', () => {
    const achados = ocorrencias(
      /turmaAluno\.(create|createMany|upsert)\b|INSERT\s+INTO\s+"?turma_alunos"?/i,
    );
    expect(Object.fromEntries(achados)).toEqual({
      'prisma/seed.ts': 1,
      'src/classes/classes.service.ts': 1,
      'src/classes/matricula-do-aluno.service.ts': 1,
    });
  });

  it('escritores de NÍVEL: só MOD-003 (src/people) — a empresa e o seed delegam (D7)', () => {
    const achados = ocorrencias(
      /\bnivel\.(create|createMany|upsert|update|updateMany)\b|(INSERT\s+INTO|UPDATE)\s+"?niveis"?\b/i,
    );
    expect(Object.fromEntries(achados)).toEqual({
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
