import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-082/D6 — o corpo do `503` das três rotas de matrícula (`entrar`,
 * `allocateStudent`, `confirmar`): o tempo-limite da transação estourou
 * (`P2028`) ou o pool de conexões esgotou (`P2024`). Nada foi gravado, e a
 * mensagem pede para tentar de novo (decisão I5 do Israel).
 */
export class ErroTransitorioResponseDto {
  @ApiProperty({ example: 503 })
  statusCode!: number;

  @ApiProperty({
    enum: ['SERVIDOR_OCUPADO'],
    description:
      'O código é o contrato; a mensagem é texto para humano e pode mudar sem aviso.',
  })
  code!: string;

  @ApiProperty({
    example:
      'O sistema está com muita procura agora. Tente de novo em alguns segundos.',
  })
  message!: string;
}
