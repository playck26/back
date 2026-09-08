import { ApiProperty } from '@nestjs/swagger';

/** Uma linha do extrato. */
export class MovimentoDeCreditoResponseDto {
  @ApiProperty()
  id!: string;

  @ApiProperty({ enum: ['entrada', 'retirada', 'consumo', 'devolucao'] })
  tipo!: string;

  @ApiProperty({ description: 'Sempre positivo; o sinal vem do tipo (D3).' })
  valorCentavos!: number;

  // **`type` explícito nos anuláveis, e isto não é enfeite.** Sem ele o
  // schema sai sem tipo, o `openapi-typescript` gera `Record<string, never>`
  // e o campo fica INUTILIZÁVEL nos frontends — que é a forma silenciosa do
  // DEF-012: contrato que compila e não serve.
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Nota interna do clube. Presente só nos administrativos, e **omitido na visão do aluno** (AC-013).',
  })
  motivo!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ocupacaoId!: string | null;

  @ApiProperty()
  criadoEm!: string;
}

/** Saldo e extrato, que é o que as duas telas mostram. */
export class ExtratoDeCreditoResponseDto {
  @ApiProperty({
    description:
      'Derivado do ledger pela trigger (D1). Nunca escrito por serviço.',
  })
  saldoCentavos!: number;

  @ApiProperty({ type: [MovimentoDeCreditoResponseDto] })
  movimentos!: MovimentoDeCreditoResponseDto[];
}

/** O que o `POST` devolve: o movimento criado e o saldo depois dele. */
export class MovimentoCriadoResponseDto {
  @ApiProperty()
  movimentoId!: string;

  @ApiProperty()
  saldoCentavos!: number;
}
