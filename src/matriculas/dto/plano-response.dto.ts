import { ApiProperty } from '@nestjs/swagger';

export class PlanoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Mensal' })
  nome!: string;

  @ApiProperty({ example: 30000 })
  valorCentavos!: number;

  @ApiProperty({ example: 1 })
  prazoMeses!: number;

  /**
   * **Ja RESOLVIDO pela heranca** (SPEC-037/D6/AC-004).
   *
   * `planos.link_pagamento_url` nulo significa "usa o da empresa", e a tela
   * nao deveria ter de saber disso -- mesma regra do AC-007 da SPEC-040, onde
   * o `GET` da disponibilidade devolve os sete dias mesmo sem linha.
   */
  @ApiProperty({ type: String, nullable: true })
  linkPagamentoUrl!: string | null;

  /**
   * `true` quando o plano NAO tem link proprio.
   *
   * Sem este campo o gestor nao distinguiria "este plano tem link proprio" de
   * "usa o do clube" -- e editar o link da empresa mudaria, em silencio,
   * planos que ele achava configurados.
   */
  @ApiProperty({ example: true })
  linkHerdado!: boolean;

  @ApiProperty({ example: true })
  ativo!: boolean;
}
