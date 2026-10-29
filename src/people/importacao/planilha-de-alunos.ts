/**
 * SPEC-092 — **a planilha de alunos que o gestor baixa, e só ela.**
 *
 * É o caminho de volta do `csv.ts`: aquele transforma texto em `string[][]`,
 * este transforma alunos em texto. Nenhum dos dois conhece o banco — quem lê
 * é o `ExportacaoDeAlunosService`, e a separação é o que deixa a tabela de
 * células abaixo testável sem Postgres.
 *
 * ## O formato é o do modelo da importação (D1)
 *
 * BOM, `;` e CRLF, com as sete colunas do modelo na mesma ordem e com os
 * mesmos rótulos (`test/fixtures/modelo-alunos.csv`). O que muda é o que vem
 * depois: `Turma 4…N` quando algum aluno passa de três turmas (D2), e
 * `Status` no fim.
 *
 * ## Por que o `'` na frente (D5)
 *
 * Nome e telefone são escritos pelo próprio aluno, no cadastro. O arquivo é
 * aberto no Excel pelo gestor, e o Excel trata uma célula que começa com `=`,
 * `+`, `-` ou `@` como **fórmula** — um aluno chamado `=HYPERLINK(...)` vira um
 * link na planilha do clube. O `'` é o jeito do próprio Excel de dizer "isto é
 * texto", e ele não aparece na célula.
 */

/** Os rótulos das sete colunas do modelo, na ordem do modelo (SPEC-091/D1). */
export const ROTULOS_DO_MODELO = [
  'Nome',
  'E-mail',
  'Telefone',
  'Nível',
  'Turma 1',
  'Turma 2',
  'Turma 3',
] as const;

/** As três colunas de turma que o modelo sempre tem (D2). */
export const TURMAS_DO_MODELO = 3;

/** D3 — o que a coluna `Status` diz. */
export type StatusNaPlanilha =
  'ativo' | 'desativado' | 'recusado' | 'aguardando aprovação' | 'pendente';

/** D3 — o vínculo do aluno com o clube (`alunos.vinculo`). */
export type VinculoNaPlanilha = 'pendente' | 'aprovado' | 'recusado';

/** Um aluno, já lido do banco, do jeito que a planilha precisa. */
export interface AlunoDaPlanilha {
  nome: string;
  email: string;
  telefone: string | null;
  /** O nome do nível; `null` para o aluno sem nível (D4: célula vazia). */
  nivel: string | null;
  /** Só as turmas ATIVAS, já na ordem da D4. */
  turmas: readonly string[];
  status: StatusNaPlanilha;
}

/**
 * D3 — **a precedência é a ordem dos `if`s:** `desativado`, `recusado`,
 * `aguardando aprovação`, `pendente`; o resto é `ativo`.
 *
 * - `desativado` vence tudo: o aluno que o gestor desligou não "aguarda" nem
 *   está "pendente"; dizer isso dele faria o gestor aprovar ou reenviar
 *   convite a quem ele mesmo desligou.
 * - `recusado` e `aguardando aprovação` vêm do vínculo (`alunos.vinculo`) e
 *   vencem `pendente`: enquanto o clube não aprovou, não é a senha temporária
 *   que deixa a pessoa de fora.
 * - `pendente` é o critério da "situação do acesso" (`derivarSituacao`): a
 *   conta ainda com senha temporária, que é a de quem não aceitou o convite
 *   nem trocou a `pck-`.
 */
export function statusNaPlanilha(situacao: {
  alunoInativo: boolean;
  contaInativa: boolean;
  vinculo: VinculoNaPlanilha;
  senhaTemporaria: boolean;
}): StatusNaPlanilha {
  if (situacao.alunoInativo || situacao.contaInativa) return 'desativado';
  if (situacao.vinculo === 'recusado') return 'recusado';
  if (situacao.vinculo === 'pendente') return 'aguardando aprovação';
  if (situacao.senhaTemporaria) return 'pendente';
  return 'ativo';
}

/**
 * D5 — **os caracteres que o Excel lê como começo de fórmula** (ou que
 * escondem uma). É a lista de UM lugar só: a exportação põe o `'` antes deles
 * (`celulaDaPlanilha`) e a importação o tira (`semProtecaoDeFormula`). Duas
 * listas divergiriam em silêncio — o arquivo exportado deixaria de voltar
 * limpo, ou a importação passaria a comer o `'` de quem o escreveu de
 * propósito.
 */
export const CARACTERES_DE_FORMULA: readonly string[] = [
  '=',
  '+',
  '-',
  '@',
  '\t',
  '\r',
];

function comecaComFormula(valor: string): boolean {
  return valor !== '' && CARACTERES_DE_FORMULA.includes(valor[0]);
}

/**
 * D5 — **o inverso exato do `'` da exportação**, aplicado pela importação a
 * toda célula que ela lê: tira o `'` inicial só quando o caractere seguinte é
 * um de `CARACTERES_DE_FORMULA` (`'+55…` volta `+55…`). O `'` antes de outro
 * caractere (`'Ana`) não foi a exportação que pôs, e fica.
 */
export function semProtecaoDeFormula(valor: string): string {
  return valor.startsWith("'") && comecaComFormula(valor.slice(1))
    ? valor.slice(1)
    : valor;
}

/** D5 — o que obriga a célula a ir entre aspas no CSV de `;`. */
const PEDE_ASPAS = /[;"\r\n]/;

/**
 * Uma célula pronta para o arquivo.
 *
 * **A ordem importa:** o `'` entra primeiro, e só depois a célula é posta
 * entre aspas. Ao contrário, o `'` ficaria fora das aspas, e o leitor de CSV
 * leria o campo como `'` seguido de texto entre aspas — que não é CSV.
 */
export function celulaDaPlanilha(valor: string): string {
  const texto = comecaComFormula(valor) ? `'${valor}` : valor;
  return PEDE_ASPAS.test(texto) ? `"${texto.replace(/"/g, '""')}"` : texto;
}

/** D2 — `Turma 1…N`, com N pelo menos 3 e no máximo o maior do arquivo. */
export function quantasColunasDeTurma(
  alunos: readonly AlunoDaPlanilha[],
): number {
  return alunos.reduce(
    (maior, a) => Math.max(maior, a.turmas.length),
    TURMAS_DO_MODELO,
  );
}

const BOM = '\uFEFF';
const FIM_DE_LINHA = '\r\n';

/**
 * O arquivo inteiro: BOM, cabeçalho e uma linha por aluno, cada linha
 * terminada em CRLF, como o modelo (D1).
 */
export function montarPlanilhaDeAlunos(
  alunos: readonly AlunoDaPlanilha[],
): string {
  const n = quantasColunasDeTurma(alunos);
  const turmas = Array.from({ length: n }, (_, i) => `Turma ${i + 1}`);
  const cabecalho = [...ROTULOS_DO_MODELO.slice(0, 4), ...turmas, 'Status'];

  const linhas = alunos.map((a) => [
    a.nome,
    a.email,
    a.telefone ?? '',
    a.nivel ?? '',
    // As células extras de quem tem menos turmas saem vazias (AC-002).
    ...Array.from({ length: n }, (_, i) => a.turmas[i] ?? ''),
    a.status,
  ]);

  return (
    BOM +
    [cabecalho, ...linhas]
      .map((campos) => campos.map(celulaDaPlanilha).join(';') + FIM_DE_LINHA)
      .join('')
  );
}

/** D6 — `alunos-AAAA-MM-DD.csv`, com a data de hoje no fuso do clube. */
export function nomeDoArquivoDaPlanilha(hojeNoClube: string): string {
  return `alunos-${hojeNoClube}.csv`;
}
