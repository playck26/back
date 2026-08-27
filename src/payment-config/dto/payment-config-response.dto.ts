import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o contrato de resposta de `payment-config` (SPEC-006).
 *
 * ## Os dois DTOs não são o mesmo com um campo a menos
 *
 * `PagamentoPublicoResponseDto` é o que o **aluno** recebe, e ele não traz
 * `companyId`. A diferença não é economia de bytes: a rota pública é
 * alcançável sem token, e devolver o `company_id` ali daria a quem não está
 * autenticado um identificador interno para começar a sondar.
 */

export class ConfiguracaoDePagamentoResponseDto {
  /**
   * **Não vem da linha do banco:** é o `companyId` do próprio token, ecoado
   * pelo mapper. Sai preenchido mesmo quando a empresa ainda não configurou
   * pagamento nenhum — nesse caso os dois campos abaixo vêm `null` e a linha
   * em `configuracoes_pagamento` nem existe.
   */
  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  /** `null` enquanto a empresa não configurar — é o estado inicial, não erro. */
  @ApiProperty({
    type: String,
    nullable: true,
    example: 'https://pag.example/clube',
  })
  linkPagamentoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+5511999999999' })
  whatsappNumero!: string | null;
}

/** Ver o bloco no topo: **sem `companyId`**, e é decisão de segurança. */
export class PagamentoPublicoResponseDto {
  @ApiProperty({ type: String, nullable: true })
  linkPagamentoUrl!: string | null;

  @ApiProperty({ type: String, nullable: true })
  whatsappNumero!: string | null;
}
