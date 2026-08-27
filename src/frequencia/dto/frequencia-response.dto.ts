import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta de frequência** (SPEC-015).
 *
 * ## Este arquivo foi escrito a partir do código, e não de memória
 *
 * Duas vezes neste ciclo um DTO nasceu de memória e estava errado — um DTO
 * inteiro que as rotas de aprovar/recusar não devolvem, e um `enum` com um
 * valor inexistente. As duas vezes o `tsc` barrou, mas o método era o
 * problema.
 *
 * Para as rotas deste módulo o levantamento foi feito por leitura do código,
 * com um segundo agente tentando **refutar** cada campo. Ele refutou: o
 * primeiro levantamento afirmava que `FrequenciaService` era exposto por dois
 * controllers e **omitiu `GET /classes/:id/frequencia` inteira** — a terceira
 * rota do módulo, que é a maior das três.
 *
 * ## O que quase ninguém adivinharia sobre estas três respostas
 *
 * As três vêm do mesmo serviço e **não têm a mesma forma de item**:
 *
 * | Rota | Item |
 * |---|---|
 * | `/classes/:id/frequencia` | traz `alunoAtivo`, `vinculo`, `presente`, `ausente`, `justificado` |
 * | `/dashboard/evasao` | **não traz nenhum desses** |
 * | `/students/:id/frequencia` | tem a cobertura **por turma**, não uma no topo |
 *
 * Publicá-las como três schemas distintos é o ponto: um cliente que suponha
 * "os três relatórios de frequência têm o mesmo item" erra nos três.
 */

/**
 * SPEC-015 — **por que a falta seguida vem decomposta.**
 *
 * `faltasSeguidas` conta ausência **e** justificada na mesma sequência, e o
 * gestor precisa saber a proporção: três faltas justificadas seguidas não são
 * o mesmo caso que três ausências. Sem a decomposição, a tela mostraria o
 * mesmo número para os dois e sugeriria a mesma conversa.
 */
export class FaltasSeguidasComposicaoResponseDto {
  @ApiProperty({ type: Number, example: 2 })
  ausente!: number;

  @ApiProperty({ type: Number, example: 1 })
  justificado!: number;
}

/**
 * SPEC-015 — **quanto se pode confiar no número de frequência.**
 *
 * Existe porque frequência calculada sobre chamada que ninguém lançou é
 * ficção. `confianca: 'baixa'` é o servidor dizendo "este percentual tem base
 * fina" — e `aviso` traz a frase pronta, para as telas não inventarem cada
 * uma a sua.
 */
export class CoberturaResponseDto {
  /** Ocorrências que aconteceram na janela. */
  @ApiProperty({ type: Number, example: 12 })
  aconteceram!: number;

  /** Dessas, quantas tiveram chamada lançada. */
  @ApiProperty({ type: Number, example: 9 })
  lancadas!: number;

  /** Dessas, quantas o professor declarou completas. */
  @ApiProperty({ type: Number, example: 7 })
  completas!: number;

  /** `null` quando `aconteceram` é zero — não há do que tirar percentual. */
  @ApiProperty({ type: Number, nullable: true, example: 58 })
  pctCompletas!: number | null;

  @ApiProperty({ type: String, enum: ['alta', 'baixa'] })
  confianca!: string;

  /** A frase pronta, ou `null` quando a confiança é alta e não há o que avisar. */
  @ApiProperty({ type: String, nullable: true })
  aviso!: string | null;
}

/** Os números de frequência de um aluno, sem identificá-lo. */
export class AgregadoDeFrequenciaResponseDto {
  /** `null` quando `base` é zero: sem ocorrência lançada não há percentual. */
  @ApiProperty({ type: Number, nullable: true, example: 83 })
  frequenciaPct!: number | null;

  @ApiProperty({ type: String, enum: ['alta', 'baixa'] })
  confianca!: string;

  /** Ocorrências que entraram na conta. */
  @ApiProperty({ type: Number, example: 12 })
  base!: number;

  @ApiProperty({ type: Number, example: 10 })
  presente!: number;

  @ApiProperty({ type: Number, example: 1 })
  ausente!: number;

  @ApiProperty({ type: Number, example: 1 })
  justificado!: number;

  @ApiProperty({ type: Number, example: 3 })
  faltasSeguidas!: number;

  @ApiProperty({ type: FaltasSeguidasComposicaoResponseDto })
  faltasSeguidasComposicao!: FaltasSeguidasComposicaoResponseDto;
}

/**
 * O aluno na tela de frequência **da turma**.
 *
 * SPEC-015/AC-011 — `alunoAtivo` e `vinculo` viajam no payload porque a tela
 * precisa distinguir aluno que faltou de aluno que **saiu**: os dois aparecem
 * com frequência baixa, e a conversa com cada um é outra.
 */
export class AlunoNaFrequenciaDaTurmaResponseDto extends AgregadoDeFrequenciaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  /** SPEC-015/INV-020: estar no relatório e estar na turma hoje são coisas diferentes. */
  @ApiProperty({ type: Boolean })
  naTurmaHoje!: boolean;

  /** Derivado de `status === 'ativo'`; o status cru não sai. */
  @ApiProperty({ type: Boolean })
  alunoAtivo!: boolean;

  @ApiProperty({
    type: String,
    enum: ['pendente', 'aprovado', 'recusado'],
  })
  vinculo!: string;
}

export class FrequenciaDaTurmaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ type: String, example: 'Turma A' })
  turmaNome!: string;

  /** A janela pedida, já limitada pelo servidor entre 1 e 90 dias. */
  @ApiProperty({ type: Number, example: 30 })
  janelaDias!: number;

  /** **Uma cobertura da turma inteira**, no topo — ver `porTurma` no relatório do aluno. */
  @ApiProperty({ type: CoberturaResponseDto })
  cobertura!: CoberturaResponseDto;

  /** Ordenado por nome (pt-BR). Vem `[]` quando não há ninguém — nunca 404. */
  @ApiProperty({ type: [AlunoNaFrequenciaDaTurmaResponseDto] })
  alunos!: AlunoNaFrequenciaDaTurmaResponseDto[];
}

/**
 * Uma turma dentro do relatório **do aluno**.
 *
 * **A cobertura vem aqui dentro, uma por turma** — e não uma no topo, como no
 * relatório da turma. Faz sentido: o mesmo aluno pode estar numa turma com
 * chamada em dia e noutra sem, e uma cobertura só esconderia a diferença.
 */
export class FrequenciaPorTurmaResponseDto extends AgregadoDeFrequenciaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Turma A' })
  turmaNome!: string | null;

  @ApiProperty({ type: Boolean })
  naTurmaHoje!: boolean;

  @ApiProperty({ type: CoberturaResponseDto })
  cobertura!: CoberturaResponseDto;
}

export class OcorrenciaDoAlunoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Turma A' })
  turmaNome!: string | null;

  @ApiProperty({ type: String, format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: Boolean })
  cancelada!: boolean;

  /**
   * **Não-nulo aqui**, ao contrário da linha da chamada em `/me/teacher`.
   * Esta lista traz ocorrências **já lançadas**; lá `null` significa "ainda
   * não lançado". Mesma palavra, listas diferentes.
   */
  @ApiProperty({ type: String, enum: ['presente', 'ausente', 'justificado'] })
  status!: string;
}

export class FrequenciaDoAlunoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: Boolean })
  alunoAtivo!: boolean;

  @ApiProperty({ type: String, enum: ['pendente', 'aprovado', 'recusado'] })
  vinculo!: string;

  @ApiProperty({ type: Number, example: 30 })
  janelaDias!: number;

  /** Os números somados de todas as turmas do aluno. */
  @ApiProperty({ type: AgregadoDeFrequenciaResponseDto })
  agregado!: AgregadoDeFrequenciaResponseDto;

  @ApiProperty({ type: [FrequenciaPorTurmaResponseDto] })
  porTurma!: FrequenciaPorTurmaResponseDto[];

  @ApiProperty({ type: [OcorrenciaDoAlunoResponseDto] })
  ocorrencias!: OcorrenciaDoAlunoResponseDto[];
}

/**
 * Um aluno na lista de risco de evasão.
 *
 * **Este item é mais pobre que o da frequência da turma, e é a diferença que
 * o contrato precisa publicar:** aqui não vêm `alunoAtivo`, `vinculo`,
 * `presente`, `ausente` nem `justificado`. Quem supuser a mesma forma dos
 * outros dois relatórios lê `undefined` sem nada reclamar.
 */
export class AlunoEmEvasaoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Turma A' })
  turmaNome!: string | null;

  /**
   * **Por que ele entrou na lista.** Os dois motivos pedem conversas
   * diferentes: faltas seguidas é urgência, frequência baixa é tendência.
   */
  @ApiProperty({
    type: String,
    enum: ['faltas_seguidas', 'frequencia_baixa'],
  })
  motivo!: string;

  @ApiProperty({ type: Number, nullable: true, example: 42 })
  frequenciaPct!: number | null;

  @ApiProperty({ type: Number, example: 12 })
  base!: number;

  @ApiProperty({ type: Number, example: 3 })
  faltasSeguidas!: number;

  @ApiProperty({ type: FaltasSeguidasComposicaoResponseDto })
  faltasSeguidasComposicao!: FaltasSeguidasComposicaoResponseDto;

  @ApiProperty({ type: String, enum: ['alta', 'baixa'] })
  confianca!: string;
}

export class EvasaoResponseDto {
  @ApiProperty({ type: Number, example: 4 })
  total!: number;

  @ApiProperty({ type: Number, example: 30 })
  janelaDias!: number;

  @ApiProperty({ type: [AlunoEmEvasaoResponseDto] })
  alunos!: AlunoEmEvasaoResponseDto[];
}
