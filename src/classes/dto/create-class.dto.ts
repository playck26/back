import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
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

export class CreateClassDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  nome!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  nivelId?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  professorId?: string;

  @ApiProperty()
  @IsUUID()
  quadraId!: string;

  @ApiProperty({ minimum: 0, maximum: 6, description: '0=domingo..6=sábado' })
  @IsInt()
  @Min(0)
  @Max(6)
  diaSemana!: number;

  @ApiProperty({ example: '14:00' })
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio!: string;

  @ApiProperty({ example: '15:00' })
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim!: string;

  @ApiProperty()
  @IsInt()
  @IsPositive()
  capacidade!: number;
}
