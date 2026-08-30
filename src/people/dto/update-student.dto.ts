import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MinLength } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

export class UpdateStudentDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  nome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telefone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @UuidNoCorpo()
  nivelId?: string;

  @ApiPropertyOptional({ enum: ['ativo', 'inativo'] })
  @IsOptional()
  @IsIn(['ativo', 'inativo'])
  status?: 'ativo' | 'inativo';
}
