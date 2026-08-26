import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * SPEC-020/TASK-002 — o corpo de criar e editar opção de catálogo.
 *
 * **Um DTO só para os dois verbos e os dois catálogos.** No `POST` o nome é
 * obrigatório, mas quem cobra isso é o serviço (`NOME_OBRIGATORIO`), e não o
 * `class-validator`: o serviço precisa fazer `trim` antes de julgar, senão
 * `" "` passaria pelo `@MinLength(1)` e viraria uma opção de nome invisível
 * na barra de filtro do aluno.
 *
 * Ter dois DTOs — um com `nome!` e outro com `nome?` — daria a impressão de
 * que a validação está no decorator, e ela não está.
 */
export class CatalogoDeQuadraDto {
  @ApiPropertyOptional({ example: 'Saibro' })
  @IsOptional()
  @IsString()
  @MaxLength(60)
  nome?: string;

  @ApiPropertyOptional({
    example: 0,
    description: 'Ordena na tela. Default 0.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  ordem?: number;
}
