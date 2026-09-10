import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * SPEC-045/AC-003 — a janela, em dias.
 *
 * **Parâmetro e não coluna de configuração (D5).** Uma coluna em `empresas`
 * seria migration, tela de configuração e uma decisão que ninguém pediu — e a
 * tela oferece 7/30/60 sem o servidor guardar nada.
 *
 * O teto de 365 não é enfeite: `dias` entra numa data e uma janela de dez anos
 * varreria o histórico inteiro devolvendo "vencendo" para quem tem plano
 * anual. **1** é o mínimo porque zero não é uma janela — seria pedir a lista
 * de quem vence hoje, que é o grupo `vencidas` do dia seguinte.
 */
export class JanelaDeVencimentoDto {
  @ApiPropertyOptional({ default: 30, minimum: 1, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(365)
  dias?: number = 30;
}
