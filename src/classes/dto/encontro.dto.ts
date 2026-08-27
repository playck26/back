import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Matches, Max, Min } from 'class-validator';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * SPEC-019/TASK-002 — um encontro semanal da turma.
 *
 * **Substitui os três campos soltos** (`diaSemana`, `horaInicio`, `horaFim`)
 * que viviam direto no corpo de criar e editar turma. Não ficam como alias do
 * primeiro encontro: duas fontes para a mesma pergunta é o que a SPEC-020
 * passou um dia inteiro desfazendo.
 *
 * ## O que este DTO valida, e o que ele NÃO valida
 *
 * Ele valida a **forma** de um encontro: dia no intervalo, hora no formato.
 *
 * Ele **não** valida `horaFim > horaInicio` nem sobreposição entre encontros
 * — essas são regras da lista inteira, não de um item, e um decorator por
 * campo não enxerga os irmãos. Elas vivem em `encontros.ts`, e o motivo de
 * não estarem aqui é o mesmo do `CatalogoDeQuadraDto` da SPEC-020: deixar a
 * validação parecer que está no decorator, quando não está, é pior que não
 * ter decorator nenhum.
 */
export class EncontroDto {
  @ApiProperty({
    type: Number,
    minimum: 0,
    maximum: 6,
    description: '0=domingo..6=sábado',
  })
  @IsInt()
  @Min(0)
  @Max(6)
  diaSemana!: number;

  @ApiProperty({ type: String, example: '18:00' })
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim!: string;
}
