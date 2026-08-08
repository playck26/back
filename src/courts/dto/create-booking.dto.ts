import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDateString, IsOptional, IsUUID, Matches } from 'class-validator';

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

  // DATA_MODEL.md: aluno_id é obrigatório quando origem_tipo=AVULSO — mas
  // opcional aqui no DTO (SPEC-005, REQ-005): quando quem chama é `aluno`,
  // o controller ignora este campo e resolve o id a partir do token, nunca
  // do cliente; só é obrigatório de fato quando quem chama é
  // `company_admin` reservando em nome de um aluno (checado no controller).
  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  alunoId?: string;
}
