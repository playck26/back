import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Validate,
} from 'class-validator';
import { DataDoCalendarioConstraint } from './data-do-calendario.dto';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * SPEC-034/CON-034.2 — **mover** uma reserva avulsa.
 *
 * Os quatro campos são opcionais **e pelo menos um é obrigatório** — a
 * segunda metade não cabe em decorator, e é o `moveBooking` que a cobra
 * (AC-005, `422 NADA_A_MOVER`). Corpo vazio não é "mover para onde está":
 * é pedido sem conteúdo, e responder `200` a ele gravaria uma ação
 * administrativa que não descreve gesto nenhum.
 *
 * **O que NÃO está aqui é decisão, não esquecimento:** `alunoId` (LIM-034a),
 * `valor` (LIM-034d, congelado na criação) e `statusPagamento` (tem rota
 * própria, `PATCH /bookings/:id/payment-status`). Mover é mover.
 */
export class MoveBookingDto {
  @ApiPropertyOptional({ example: '2026-09-10', description: 'AAAA-MM-DD' })
  @IsOptional()
  @IsString()
  @Validate(DataDoCalendarioConstraint)
  data?: string;

  @ApiPropertyOptional({ example: '19:00' })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio?: string;

  @ApiPropertyOptional({ example: '20:00' })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  quadraId?: string;
}
