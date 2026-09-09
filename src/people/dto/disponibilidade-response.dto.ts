import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-040/AC-007 — um dia da semana como a tela precisa dele.
 *
 * `indisponivel` **não é coluna** (D6): é campo calculado, e vale `true`
 * exatamente quando não existe linha para aquele dia. A resposta tem sempre
 * sete destes.
 */
export class DiaDisponibilidadeResponseDto {
  @ApiProperty({ minimum: 0, maximum: 6, description: '0 = domingo' })
  diaSemana!: number;

  @ApiProperty({ description: 'true quando o professor não atende no dia' })
  indisponivel!: boolean;

  @ApiProperty({ type: String, nullable: true, example: '08:00' })
  horaInicio!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '12:00' })
  horaFim!: string | null;
}
