import { ApiProperty } from '@nestjs/swagger';

/** A reposição já marcada para uma falta, quando existe. */
export class ReposicaoMarcadaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Iniciante Terça' })
  turmaNome!: string | null;

  @ApiProperty({ format: 'date', example: '2026-09-24' })
  data!: string;

  @ApiProperty({ example: '19:00' })
  horaInicio!: string;
}

/**
 * SPEC-046/AC-001 — uma falta avisada, e o que dá para fazer com ela.
 *
 * **Falta expirada e falta de aula cancelada continuam na lista** (AC-002,
 * AC-003), marcadas. Sumir com elas faria o aluno achar que nunca avisou — e a
 * SPEC-031/D14 já tinha tomado essa decisão do outro lado, mantendo a falta de
 * uma aula cancelada visível na chamada.
 */
export class FaltaParaReporResponseDto {
  @ApiProperty({ format: 'uuid' })
  faltaId!: string;

  @ApiProperty({ type: String, nullable: true })
  turmaNome!: string | null;

  @ApiProperty({ format: 'date' })
  data!: string;

  @ApiProperty({ example: '19:00' })
  horaInicio!: string;

  @ApiProperty({ example: '20:00' })
  horaFim!: string;

  @ApiProperty({
    format: 'date',
    description: 'Ate quando da para repor esta falta (D6).',
  })
  expiraEm!: string;

  @ApiProperty({ description: 'Passou da validade — nao gera credito.' })
  expirada!: boolean;

  @ApiProperty({
    description:
      'O CLUBE cancelou a aula. Nao gera credito porque o aluno nao perdeu nada (AC-003).',
  })
  aulaCancelada!: boolean;

  @ApiProperty({ type: ReposicaoMarcadaResponseDto, nullable: true })
  reposicao!: ReposicaoMarcadaResponseDto | null;
}

/**
 * SPEC-046/D1 — **o credito e DERIVADO**, e este DTO e a leitura dele.
 *
 * `creditos` nao sai de coluna nenhuma: e `faltas validas − reposicoes`.
 * `usadasNoMes` e `porMes` vem junto porque "voce tem 1 credito" sem dizer que
 * o teto do mes ja acabou produz a recusa que o aluno nao entende.
 */
export class CreditoDeReposicaoResponseDto {
  @ApiProperty({
    example: 1,
    description: 'Faltas validas ainda nao repostas.',
  })
  creditos!: number;

  @ApiProperty({ example: 2, description: 'Teto do clube, por mes da falta.' })
  porMes!: number;

  @ApiProperty({ example: 30 })
  validadeDias!: number;

  @ApiProperty({ example: 0 })
  usadasNoMes!: number;

  @ApiProperty({ type: [FaltaParaReporResponseDto] })
  faltas!: FaltaParaReporResponseDto[];
}

/**
 * SPEC-046/AC-004 — uma ocorrencia onde da para repor.
 *
 * `vagas` ja vem calculado pela D2 (`matriculados − faltas + reposicoes`): a
 * tela nao tem como refazer essa conta, porque nao conhece as faltas dos
 * outros — e nem deve.
 */
export class OportunidadeDeReposicaoResponseDto {
  @ApiProperty({ format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ example: 'Iniciante Quinta' })
  turmaNome!: string;

  @ApiProperty({ example: 'Quadra 2' })
  quadraNome!: string;

  @ApiProperty({ format: 'date' })
  data!: string;

  @ApiProperty({ example: '19:00' })
  horaInicio!: string;

  @ApiProperty({ example: '20:00' })
  horaFim!: string;

  @ApiProperty({ example: 2 })
  vagas!: number;
}

export class ReposicaoCriadaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  faltaId!: string;

  @ApiProperty({ format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ format: 'date' })
  data!: string;

  @ApiProperty({ example: '19:00' })
  horaInicio!: string;

  @ApiProperty({ example: '20:00' })
  horaFim!: string;
}
