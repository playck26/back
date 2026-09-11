import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsOptional, IsString, MaxLength } from 'class-validator';
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

  /**
   * SPEC-049/REQ-001 — **busca por nome, porque `pageSize` para em 100.**
   *
   * O teto do `PaginationQueryDto` é `@Max(100)` e **fica** (D5): ele protege o
   * banco de um pedido que o derruba, e a resposta para "tenho mais de 100
   * alunos" é buscar, não pedir mil.
   *
   * Sem isto, o seletor de aluno do Admin simplesmente **terminava** no
   * centésimo — sem busca, sem aviso, e o gestor concluindo que a pessoa não
   * existe.
   */
  @ApiPropertyOptional({
    description:
      'Filtra por nome do aluno. Vários termos combinam com AND, em qualquer ordem. Não ignora acento (LIM-049a).',
    example: 'silva joao',
  })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  busca?: string;
}
