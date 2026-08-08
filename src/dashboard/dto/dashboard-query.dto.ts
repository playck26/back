import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, Matches } from 'class-validator';

const PERIODO_REGEX = /^\d{4}-(0[1-9]|1[0-2])$/;

export class DashboardQueryDto {
  @ApiPropertyOptional({
    example: '2026-09',
    description: 'Mês no formato AAAA-MM — default: mês atual',
  })
  @IsOptional()
  @Matches(PERIODO_REGEX, { message: 'periodo deve estar no formato AAAA-MM' })
  periodo?: string;
}
