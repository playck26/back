import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EncontroDto } from './encontro.dto';

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

  /**
   * SPEC-019/TASK-002 — **substituiu `diaSemana`/`horaInicio`/`horaFim`.**
   *
   * A quantidade mínima é cobrada pelo serviço (`TURMA_SEM_ENCONTRO`), e não
   * por `@ArrayMinSize`: a INV-051 tem código de erro próprio, e o
   * `ValidationPipe` devolveria `400` genérico onde a spec pede `422` com
   * código. Mesma razão do `nome` no `CatalogoDeQuadraDto` da SPEC-020.
   */
  @ApiProperty({ type: [EncontroDto] })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EncontroDto)
  encontros!: EncontroDto[];

  @ApiProperty()
  @IsInt()
  @IsPositive()
  capacidade!: number;
}
