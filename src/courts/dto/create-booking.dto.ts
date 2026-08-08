import { ApiProperty } from '@nestjs/swagger';
import { IsDateString, IsUUID, Matches } from 'class-validator';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class CreateBookingDto {
  @ApiProperty()
  @IsUUID()
  quadraId!: string;

  @ApiProperty({ example: '2026-08-20' })
  @IsDateString()
  data!: string;

  @ApiProperty({ example: '14:00' })
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio!: string;

  @ApiProperty({ example: '15:00' })
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim!: string;

  // DATA_MODEL.md: aluno_id é obrigatório quando origem_tipo=AVULSO — esta
  // spec só cria ocupações AVULSO, então o campo nunca é opcional aqui.
  @ApiProperty()
  @IsUUID()
  alunoId!: string;
}
