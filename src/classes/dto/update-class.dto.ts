import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsInt,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { EncontroDto } from './encontro.dto';

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

  /**
   * SPEC-019/TASK-002 — **substituiu `diaSemana`/`horaInicio`/`horaFim`.**
   *
   * Ausente: a recorrência não muda, e nenhuma ocupação é regerada. Presente:
   * **substitui a lista inteira** — não há "acrescentar um encontro" nem
   * "editar o de terça". Uma edição parcial de recorrência exigiria id de
   * encontro no corpo, e aí o cliente teria de saber que encontro é uma
   * entidade — quando ele é a recorrência da turma.
   *
   * Lista vazia é recusada com `TURMA_SEM_ENCONTRO`, e **é o caminho real de
   * chegar a zero**: remover o último encontro pela tela.
   */
  @ApiPropertyOptional({ type: [EncontroDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => EncontroDto)
  encontros?: EncontroDto[];

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
