import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **histórico de chamada visto pelo gestor** e a
 * matrícula de aluno em turma.
 *
 * ## A diferença que este arquivo publica, e que a palavra esconde
 *
 * O `status` de um aluno aqui é **não-nulo**; na chamada do professor
 * (`ChamadaResponseDto`, em `me-response.dto.ts`) ele é `string | null`.
 *
 * Não é inconsistência: são listas diferentes. Lá, `null` é *"ainda não
 * lançado"* e a tela precisa oferecer o lançamento. Aqui, a lista é o
 * **registro do que foi lançado** — quem não tem registro não aparece.
 *
 * Um contrato só, reusado entre as duas, faria o app do professor tratar
 * ausência de registro como ausência de aula.
 */

export class AlunoNoHistoricoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  /** Ver o bloco no topo: **não-nulo**, ao contrário da chamada do professor. */
  @ApiProperty({ type: String, enum: ['presente', 'ausente', 'justificado'] })
  status!: string;

  /** SPEC-015/INV-020 — a chamada é retrato do dia; a matrícula muda depois. */
  @ApiProperty({ type: Boolean })
  naTurmaHoje!: boolean;

  @ApiProperty({ type: Boolean })
  alunoAtivo!: boolean;
}

/**
 * SPEC-014/AC-009 e LIM-002 — **só leitura.** O gestor não corrige chamada,
 * e o custo está declarado na spec: se o professor sair do clube, uma chamada
 * errada dele não tem quem conserte.
 */
export class OcorrenciaNoHistoricoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;

  @ApiProperty({ type: Boolean })
  cancelada!: boolean;

  @ApiProperty({ type: Boolean })
  chamadaFeita!: boolean;

  /**
   * SPEC-030 — o estado resolvido, o mesmo vocabulário das outras duas
   * telas.
   *
   * `chamadaFeita` sozinho não bastava para o gestor: ele responde "há
   * registro?", e a tela dele precisa saber **qual** — uma aula `nao_houve`
   * tem registro e nenhuma presença, e sem o estado apareceria como chamada
   * feita com a lista de alunos vazia.
   *
   * `cancelada` continua como campo próprio ao lado, porque aqui ela não é
   * excludente: o AC-012 mostra a chamada de uma aula cancelada depois, e o
   * estado colapsado responderia só `cancelada`.
   */
  @ApiProperty({
    enum: [
      'futura',
      'em_andamento',
      'pendente',
      'feita',
      'legada',
      'nao_houve',
      'cancelada',
    ],
  })
  estado!: string;

  /**
   * Quem registrou a chamada, ou `null` para chamada legada — anterior ao
   * cabeçalho que passou a guardar isso.
   *
   * **SPEC-030 — passou a vir do CABEÇALHO primeiro.** Antes saía de
   * `presencas[0].registrante`, e uma aula `nao_houve` não tem nenhuma
   * presença: o gestor não veria quem fechou a aula — que é exatamente o
   * caso que motivou a spec (professor saiu, gestor fechou). As presenças
   * ficam como segunda fonte, para as chamadas legadas.
   *
   * **GAP conhecido (LIM-002 da SPEC-015):** professor que sai do clube
   * continua nomeado aqui, e não há caminho de produto para corrigir a
   * chamada dele.
   */
  @ApiProperty({ type: String, nullable: true, example: 'Carlos Lima' })
  registradoPor!: string | null;

  @ApiProperty({ type: [AlunoNoHistoricoResponseDto] })
  alunos!: AlunoNoHistoricoResponseDto[];
}

/**
 * O vínculo de um aluno com uma turma, como ele volta da matrícula.
 *
 * **É a linha crua de `turma_alunos`**, e o `createdAt` é `Date` — vira ISO
 * no fio. Não passa por mapper: foi o que a leitura do código mostrou, e é o
 * que o contrato diz. Descrever a API que existe, não a que se gostaria.
 */
export class MatriculaEmTurmaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}
