import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches } from 'class-validator';

export class AgendaQueryDto {
  @ApiPropertyOptional({ example: '2026-08', description: 'AAAA-MM' })
  @IsOptional()
  @IsString()
  @Matches(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: 'mes deve estar no formato AAAA-MM',
  })
  mes?: string;
}
