import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  Matches,
  Max,
  Min,
  MinLength,
} from 'class-validator';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class UpdateClassDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  nome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  nivelId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  professorId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  quadraId?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 6 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(6)
  diaSemana?: number;

  @ApiPropertyOptional({ example: '14:00' })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio?: string;

  @ApiPropertyOptional({ example: '15:00' })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsInt()
  @IsPositive()
  capacidade?: number;

  @ApiPropertyOptional({ enum: ['ativa', 'inativa'] })
  @IsOptional()
  @IsIn(['ativa', 'inativa'])
  status?: 'ativa' | 'inativa';
}
