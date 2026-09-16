import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional } from 'class-validator';
import { PaginationQueryDto } from '../../people/dto/pagination-query.dto';

/**
 * DEF-034 — **`dias` precisa ser propriedade de DTO, não parâmetro solto.**
 *
 * A rota declarava `@Query('dias', new DefaultValuePipe(30), ParseIntPipe)` ao
 * lado de `@Query() PaginationQueryDto`. Com a validação global em
 * `forbidNonWhitelisted: true`, o DTO é conferido contra a query INTEIRA, e
 * `dias` — que não é propriedade dele — derrubava o pedido com
 * `400 property dias should not exist`. A lista de aulas do professor nunca
 * funcionou em produção desde que o app passou a mandar o parâmetro.
 *
 * **Sem `@Max(90)` de propósito.** O teto continua sendo **corte** no
 * controller (`Math.min(…, 90)`), como sempre foi: quem pedir 5000 recebe 90
 * dias, não um erro. Trocar corte por recusa seria corrigir um defeito
 * mudando, de carona, um comportamento que ninguém pediu para mudar — e o app
 * nem manda valor acima de 90.
 *
 * `@IsInt()` preserva a recusa que o `ParseIntPipe` já fazia: `dias=muitos`
 * continua sendo `400`.
 */
export class OcorrenciasDaTurmaQueryDto extends PaginationQueryDto {
  @ApiPropertyOptional({
    default: 30,
    description:
      'Janela de histórico em dias, contada para trás a partir de hoje. Cortada em 90 pelo servidor.',
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  dias?: number = 30;
}
