import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsDateString,
  IsIn,
  IsInt,
  IsOptional,
  Max,
  Min,
} from 'class-validator';

export class ListBookingsQueryDto {
  @ApiPropertyOptional({ enum: ['pendente_pagamento', 'pago', 'cancelado'] })
  @IsOptional()
  @IsIn(['pendente_pagamento', 'pago', 'cancelado'])
  status?: 'pendente_pagamento' | 'pago' | 'cancelado';

  /**
   * SPEC-027 — "tudo menos cancelada", que `status` não expressa.
   *
   * `status` aceita **um** valor; o app do aluno precisa do complemento de
   * um. Ele fazia isso filtrando no cliente, o que passou a ser um problema
   * quando a lista ganhou paginação: página de 20 mostrando 12 itens, com o
   * rodapé dizendo "1–20 de 47".
   */
  @ApiPropertyOptional({
    type: Boolean,
    description: 'Exclui ocupações canceladas. Combina com `status`.',
  })
  @IsOptional()
  // **NÃO use `@Type(() => Boolean)` aqui.** Query string chega como texto, e
  // `Boolean('false')` é `true` — o filtro ligaria justamente quando alguém
  // pedisse para desligá-lo. Conferido por comando, não suposto.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  excluirCanceladas?: boolean;

  @ApiPropertyOptional({ example: '2026-08-20' })
  @IsOptional()
  @IsDateString()
  data?: string;

  @ApiPropertyOptional({ default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  pageSize?: number = 20;
}
