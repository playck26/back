import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, Validate } from 'class-validator';
import { DataDoCalendarioConstraint } from './data-do-calendario.dto';

export class AgendaQueryDto {
  @ApiPropertyOptional({ example: '2026-08', description: 'AAAA-MM' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'mes deve estar no formato AAAA-MM',
  })
  mes?: string;
}

/**
 * SPEC-034/AC-002 — o primeiro dia da semana, validado como DIA DO
 * CALENDÁRIO, não por regex.
 *
 * `@IsDateString()` aceita `2026-02-30` e `2026-09-10T12:00:00Z`; o
 * `parseDateOnly` então normaliza em silêncio e a rota responde `200` com a
 * semana de um dia que ninguém pediu. É o DEF-020, e o projeto já tem o
 * mecanismo: `DataDoCalendarioConstraint`.
 */
export class SemanaDaAgendaQueryDto {
  @ApiProperty({ example: '2026-09-06', description: 'AAAA-MM-DD' })
  @IsString()
  @Validate(DataDoCalendarioConstraint)
  inicio!: string;
}
