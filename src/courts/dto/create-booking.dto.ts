import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsOptional,
  IsUUID,
  Matches,
  ValidateNested,
} from 'class-validator';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SlotDto {
  @ApiProperty({ example: '09:00' })
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio!: string;

  @ApiProperty({ example: '10:00' })
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim!: string;
}

export class CreateBookingDto {
  @ApiProperty()
  @IsUUID()
  quadraId!: string;

  @ApiProperty({ example: '2026-08-20' })
  @IsDateString()
  data!: string;

  /**
   * SPEC-011: **formato novo** — vários horários no mesmo dia. Slots
   * contíguos viram uma reserva só; separados viram reservas
   * independentes.
   */
  @ApiPropertyOptional({ type: [SlotDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlotDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  slots?: SlotDto[];

  /**
   * Formato antigo (uma hora por pedido), mantido durante a transição.
   *
   * Os frontends **em produção** ainda enviam assim — o `back` atualiza no
   * push e as telas só depois do deploy da Netlify. Remover agora deixaria
   * o app do aluno sem conseguir reservar nessa janela. Sai quando as três
   * telas estiverem atualizadas.
   */
  @ApiPropertyOptional({ example: '14:00', deprecated: true })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio?: string;

  @ApiPropertyOptional({ example: '15:00', deprecated: true })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim?: string;

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
