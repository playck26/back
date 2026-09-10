import { ApiProperty } from '@nestjs/swagger';

export class MatriculaResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ format: 'uuid' })
  planoId!: string;

  @ApiProperty({ type: String, nullable: true, example: 'Mensal' })
  planoNome!: string | null;

  @ApiProperty({
    example: 25000,
    description: 'O que foi ACERTADO, congelado.',
  })
  valorCentavos!: number;

  @ApiProperty({
    example: 30000,
    description:
      'O que o plano cobrava NAQUELE DIA, congelado. Com os dois, o desconto fica visivel; com um so, ninguem distingue desconto de mudanca de preco depois.',
  })
  valorDeTabelaCentavos!: number;

  @ApiProperty({
    example: 5000,
    description:
      'CALCULADO na leitura, nunca gravado. Uma coluna seria uma terceira verdade sobre os mesmos dois numeros -- e a primeira a divergir.',
  })
  descontoCentavos!: number;

  @ApiProperty({ example: 1 })
  prazoMeses!: number;

  @ApiProperty({ example: '2026-09-10' })
  inicio!: string;

  @ApiProperty({
    example: '2026-10-10',
    description:
      'GRAVADO, nao derivado na leitura: "quem vence este mes" viraria varredura com aritmetica de data.',
  })
  fim!: string;

  @ApiProperty({
    example: 3,
    description:
      'A versao do contrato aceita. Exigida PELO BANCO (INV-114): matricula sem o aceite correspondente e recusada com `23503`.',
  })
  contratoVersao!: number;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Ja RESOLVIDO pela heranca: o do plano, ou o da empresa quando o plano nao tem proprio.',
  })
  linkPagamentoUrl!: string | null;
}
