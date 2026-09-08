import { ApiProperty } from '@nestjs/swagger';
import {
  IsIn,
  IsInt,
  IsNotEmpty,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * SPEC-033/AC-001 — o corpo do lançamento administrativo.
 *
 * **`motivo` é validado aqui E no banco, e as duas coisas são necessárias.**
 * O `CHECK movimentos_motivo_administrativo` é a garantia (AC-003); esta
 * validação existe para a mensagem de campo, que o banco não sabe dar. Se
 * uma delas sair, é esta — nunca a do banco.
 */
export class LancarCreditoDto {
  @ApiProperty({
    enum: ['entrada', 'retirada'],
    description:
      'Só os dois administrativos. `consumo` e `devolucao` nascem da reserva e do cancelamento, nunca de uma chamada humana.',
  })
  @IsIn(['entrada', 'retirada'])
  tipo!: 'entrada' | 'retirada';

  @ApiProperty({
    minimum: 1,
    description:
      'Centavos inteiros, sempre positivos — o sinal vem do tipo (D3). "Entrada de −500" é impossível por construção.',
  })
  @IsInt()
  @Min(1)
  // Teto de R$ 1.000.000,00 em centavos: `valor_centavos` é INTEGER, e o
  // limite do tipo (2.147.483.647) seria alcançado por um erro de digitação
  // antes de por um lançamento real.
  @Max(100_000_000)
  valorCentavos!: number;

  @ApiProperty({
    description:
      'Obrigatório. É nota interna do clube — o aluno não vê (AC-013).',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  motivo!: string;

  @ApiProperty({
    description:
      'A senha de quem está logado, reconferida no ato (D6). Não é sessão elevada: cada lançamento pede de novo.',
  })
  @IsString()
  @IsNotEmpty()
  senha!: string;
}
