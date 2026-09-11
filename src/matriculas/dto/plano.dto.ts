import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';

/**
 * SPEC-037/AC-002 — os limites, e cada um tem razao de estar aqui.
 *
 * `valorCentavos >= 0`: zero e legitimo (plano de cortesia existe); negativo
 * nao e desconto, e digitacao errada -- e viraria receita negativa em
 * qualquer relatorio.
 *
 * `prazoMeses` de 1 a 60: **sessenta e o teto porque plano de mais de cinco
 * anos e engano de digitacao, nao produto.** O piso de 1 impede o plano de
 * zero mes, cujo `fim` cairia no proprio `inicio` e quebraria a INV-113.
 *
 * As duas regras vivem AQUI e no banco (`planos_valor_nao_negativo`,
 * `planos_prazo_positivo`). O DTO da a mensagem; o CHECK e a rede de baixo,
 * porque a aplicacao nao e o unico caminho -- a SPEC-038 vai importar dado.
 */
export class CriarPlanoDto {
  @ApiProperty({ example: 'Mensal' })
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nome!: string;

  @ApiProperty({ example: 30000, description: 'Em CENTAVOS, como a carteira.' })
  @IsInt()
  @Min(0)
  valorCentavos!: number;

  @ApiProperty({ example: 1, minimum: 1, maximum: 60 })
  @IsInt()
  @Min(1)
  @Max(60)
  prazoMeses!: number;

  /**
   * **Nulo/ausente = herda o link da empresa** (D6), e nao "sem link".
   *
   * `IsUrl` porque isto vai virar um `<a href>` na tela do aluno: string
   * qualquer aqui produziria link quebrado no unico lugar onde o clube recebe
   * dinheiro.
   */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  linkPagamentoUrl?: string | null;
}

export class AtualizarPlanoDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  nome?: string;

  @ApiPropertyOptional({ type: Number })
  @IsOptional()
  @IsInt()
  @Min(0)
  valorCentavos?: number;

  @ApiPropertyOptional({ type: Number, minimum: 1, maximum: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(60)
  prazoMeses?: number;

  /** `null` devolve o plano a heranca da empresa; ausente nao mexe. */
  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsUrl({ require_protocol: true })
  linkPagamentoUrl?: string | null;

  /**
   * **A unica forma de "sumir" com um plano** (AC-003/INV-115). Nao ha
   * `DELETE`: plano contratado carrega historia, e apagar quebraria a FK
   * `RESTRICT` com `23503` -- que vaza como `500`.
   */
  @ApiPropertyOptional({ type: Boolean })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}
