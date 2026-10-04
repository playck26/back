import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { travarNivelDaEmpresa } from '../people/nivel-efetivo';

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
  /**
   * **SPEC-083/D3 — o quarto escritor é a importação**, com o modo
   * `lote-novo`: um `INSERT` em lote, só de alunos que a mesma transação
   * criou. Que ele trava antes de escrever é o teste do fim deste arquivo.
   */
  it('escritores de MATRÍCULA: a instrução com prazo, a importação e o seed — um em cada', () => {
    const achados = ocorrencias(
      /turmaAluno\.(create|createMany|upsert)\b|INSERT\s+INTO\s+"?turma_alunos"?/i,
    );
    expect(Object.fromEntries(achados)).toEqual({
      'prisma/seed.ts': 1,
      'src/classes/matricula-com-prazo.ts': 1,
      'src/people/importacao/importacao-de-alunos.service.ts': 1,
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
          : /'leitura'/.test(chamada)
            ? 'leitura'
            : /'lote-novo'/.test(chamada)
              ? 'lote-novo'
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
        // SPEC-083/D3 — o lote de alunos novos: clube compartilhado, sem a
        // trava por aluno (os alunos nascem na própria transação)
        'src/people/importacao/importacao-de-alunos.service.ts#escreverNaTransacao: lote-novo',
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

  it('o tipo exige o aluno no modo leitura (sobrecarga, D1 v8)', () => {
    // Não roda: é o compilador que prova. Se a sobrecarga aceitar a leitura
    // sem aluno, o `@ts-expect-error` fica sem erro e o arquivo não compila.
    const semAluno = (db: Parameters<typeof travarNivelDaEmpresa>[0]) =>
      // @ts-expect-error — leitura sem o aluno não compila
      travarNivelDaEmpresa(db, 'c1', 'leitura');
    const escritaComAluno = (db: Parameters<typeof travarNivelDaEmpresa>[0]) =>
      // @ts-expect-error — escrita não recebe aluno
      travarNivelDaEmpresa(db, 'c1', 'escrita', 'a1');
    // SPEC-083/D3 — o lote-novo é a dispensa da trava do aluno: passar um
    // aluno a ele seria fingir uma trava que não é tomada.
    const loteComAluno = (db: Parameters<typeof travarNivelDaEmpresa>[0]) =>
      // @ts-expect-error — lote-novo não recebe aluno
      travarNivelDaEmpresa(db, 'c1', 'lote-novo', 'a1');
    expect([
      typeof semAluno,
      typeof escritaComAluno,
      typeof loteComAluno,
    ]).toEqual(['function', 'function', 'function']);
  });

  it('nenhum caminho aparece nas duas listas (sem promoção na mesma transação)', () => {
    const modos = new Map<string, Set<string>>();
    for (const linha of chamadas()) {
      const [caminho, modo] = linha.split(': ');
      modos.set(caminho, (modos.get(caminho) ?? new Set()).add(modo));
    }
    const nasDuas = [...modos].filter(([, m]) => m.size > 1).map(([c]) => c);
    expect(nasDuas).toEqual([]);
    expect(modos.size).toBe(9);
  });
});

/**
 * SPEC-083/AC-047 — **o escritor de `turma_alunos` da importação trava antes
 * de escrever.** A lista de cima diz QUEM escreve; esta diz que a importação
 * escreve DEPOIS da trava do clube no modo `lote-novo`, e depois de cobrar do
 * lote que todo aluno a matricular nasceu na própria transação (AC-049).
 *
 * Varredura textual do corpo do método, como as de cima: um `INSERT` de
 * matrícula chamado de outro método, ou antes da trava, fica vermelho aqui.
 * Que a trava espera e é esperada como deve é o FIT-057 (ordem, AC-047), contra
 * banco.
 */
describe('SPEC-083/AC-047 — a importação trava antes de escrever turma_alunos', () => {
  const ARQUIVO = 'src/people/importacao/importacao-de-alunos.service.ts';

  function corpoDoMetodo(texto: string, nome: string): string {
    const inicio = texto.search(
      new RegExp(`\\n {2}(?:private\\s+)?async ${nome}\\(`),
    );
    if (inicio < 0) throw new Error(`${ARQUIVO}: ${nome} não encontrado`);
    const abre = texto.indexOf('{', texto.indexOf(')', inicio));
    let profundidade = 0;
    for (let i = abre; i < texto.length; i++) {
      if (texto[i] === '{') profundidade++;
      if (texto[i] === '}') profundidade--;
      if (profundidade === 0) return texto.slice(inicio, i + 1);
    }
    throw new Error(`${ARQUIVO}: ${nome} sem fim`);
  }

  const texto = () => linhasDeCodigo(ARQUIVO).join('\n');

  it('o INSERT em turma_alunos mora num método só, chamado de um lugar só', () => {
    const t = texto();
    expect(t.match(/INSERT\s+INTO\s+turma_alunos/g)).toHaveLength(1);
    expect(corpoDoMetodo(t, 'inserirMatriculas')).toMatch(
      /INSERT\s+INTO\s+turma_alunos/,
    );
    // A declaração e uma chamada.
    expect(t.match(/inserirMatriculas\(/g)).toHaveLength(2);
  });

  /** Trava, cobrança e escrita, nessa ordem e todas presentes. */
  function travaAntesDaEscrita(corpo: string): boolean {
    const trava = corpo.search(
      /travarNivelDaEmpresa\(\s*tx,\s*companyId,\s*'lote-novo'\s*\)/,
    );
    const cobranca = corpo.search(/lote\.exigirCriados\(/);
    const escrita = corpo.search(/this\.inserirMatriculas\(/);
    return trava > -1 && cobranca > trava && escrita > cobranca;
  }

  it('a chamada vem DEPOIS da trava lote-novo e da cobrança do lote, no mesmo corpo', () => {
    expect(
      travaAntesDaEscrita(corpoDoMetodo(texto(), 'escreverNaTransacao')),
    ).toBe(true);
  });

  it('controle: a mesma conferência reprova o escritor sem trava, sem cobrança, ou com a trava depois', () => {
    const trava = "await travarNivelDaEmpresa(tx, companyId, 'lote-novo');";
    const cobranca = 'lote.exigirCriados(ids);';
    const escrita = 'await this.inserirMatriculas(tx, m);';
    expect(travaAntesDaEscrita([trava, cobranca, escrita].join('\n'))).toBe(
      true,
    );
    expect(travaAntesDaEscrita([cobranca, escrita].join('\n'))).toBe(false);
    expect(travaAntesDaEscrita([trava, escrita].join('\n'))).toBe(false);
    expect(travaAntesDaEscrita([escrita, trava, cobranca].join('\n'))).toBe(
      false,
    );
    expect(
      travaAntesDaEscrita(
        [trava.replace('lote-novo', 'escrita'), cobranca, escrita].join('\n'),
      ),
    ).toBe(false);
  });
});
