import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional } from 'class-validator';
import { PaginationQueryDto } from './pagination-query.dto';

/**
 * SPEC-009/REQ-008 — a fila de aprovação do admin é a listagem normal de
 * alunos filtrada por vínculo, não um endpoint próprio: é a mesma coleção,
 * com o mesmo escopo de empresa e a mesma paginação.
 */
export class ListStudentsQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({ enum: ['pendente', 'aprovado', 'recusado'] })
  @IsOptional()
  @IsEnum(['pendente', 'aprovado', 'recusado'])
  vinculo?: 'pendente' | 'aprovado' | 'recusado';
}
