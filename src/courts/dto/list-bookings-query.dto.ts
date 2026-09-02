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
   * SPEC-041/AC-001 — **o corte entre o que já passou e o que está por vir.**
   *
   * Sem o parâmetro, a rota devolve tudo, na ordem de hoje. Isso não é
   * generosidade com o consumidor antigo: é o que a lista do Admin usa, e
   * mudá-la aqui seria alteração não pedida em outro app (LIM-041e).
   *
   * **O corte é pelo FIM da ocupação** (D-I4, decisão do Israel): quem está na
   * quadra às 20h numa reserva de 19h às 21h não está no passado.
   *
   * ## Este parâmetro obriga a ordem de deploy, e por isso está escrito aqui
   *
   * O `ValidationPipe` global usa `forbidNonWhitelisted`, então **um Cliente
   * que mande `quando` contra um Back que não o conhece leva 400** — e como o
   * app pede reservas e quadras no mesmo `Promise.all`, a tela inteira vira
   * uma faixa de erro, não só a lista. **Back primeiro, Cliente depois. No
   * rollback, o inverso.**
   */
  @ApiPropertyOptional({
    enum: ['futuras', 'anteriores'],
    description:
      'Separa por horário, comparando o FIM da ocupação com o agora no fuso ' +
      'do clube. Omitido, devolve tudo (comportamento e ordem de hoje).',
  })
  @IsOptional()
  @IsIn(['futuras', 'anteriores'])
  quando?: 'futuras' | 'anteriores';

  /**
   * SPEC-027 — "tudo menos cancelada", que `status` não expressa.
   *
   * `status` aceita **um** valor; o app do aluno precisa do complemento de
   * um. Ele fazia isso filtrando no cliente, o que passou a ser um problema
   * quando a lista ganhou paginação: página de 20 mostrando 12 itens, com o
   * rodapé dizendo "1–20 de 47".
   */
  /**
   * SPEC-041/D5 — **`deprecated`, e a razão não é a que parece.**
   *
   * Não é app antigo em campo: não existe PWA, service worker é no-op
   * declarado, e a web tem deploy atômico. É a **janela de skew entre dois
   * pipelines independentes** — o Back sobe no DigitalOcean minutos depois do
   * CI, o Cliente na Netlify em 38s —, mais a aba que o aluno já deixou aberta,
   * segurando o bundle antigo em memória enquanto ficar aberta.
   *
   * Nessa janela o Cliente antigo ainda manda `excluirCanceladas=true`. Se o
   * parâmetro sumisse do DTO, `forbidNonWhitelisted` derrubaria **toda** a
   * lista com 400.
   *
   * **Condição de saída:** sai no ciclo seguinte ao deploy da Netlify que
   * remove o envio em `api-client.ts`. Emissor único, condição datável — o
   * molde é o de `create-booking.dto.ts`.
   */
  @ApiPropertyOptional({
    type: Boolean,
    deprecated: true,
    description:
      'DEPRECIADO (SPEC-041/D5) — desde a SPEC-041 o app mostra as canceladas ' +
      'marcadas em vez de escondê-las; use `status` para filtrar. Mantido só ' +
      'pela janela de skew entre os deploys do Back e do Cliente. ' +
      'Exclui ocupações canceladas. Pode ser combinado com `status` — os ' +
      'dois viram um `AND`, então `status=pago&excluirCanceladas=true` ' +
      'devolve só as pagas.',
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
