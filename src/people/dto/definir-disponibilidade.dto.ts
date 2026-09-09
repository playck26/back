import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsInt,
  IsString,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

/**
 * SPEC-040/AC-001 — um dia em que o professor **atende**.
 *
 * **Não há campo `indisponivel` (D6).** No molde do horário da quadra existe
 * `fechado` porque lá existe herança, e a quadra precisa poder sobrepor um dia
 * aberto herdado. Aqui não há herança (D3): dia ausente do corpo é "não
 * atende", e é a única forma de dizer isso.
 */
export class DiaDisponibilidadeDto {
  /** 0 = domingo, mesma convenção de `Date.getDay()` (D2). */
  @ApiProperty({ minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  diaSemana!: number;

  // **O formato NÃO é validado por `@Matches` de propósito.** A AC-004 exige
  // `422 HORA_NAO_CHEIA`, com código; o `ValidationPipe` responde `400` com
  // mensagem de biblioteca e sem `code`, e o Admin não teria o que casar. A
  // regra vive no serviço, e o `CHECK` do banco é a rede de baixo.
  @ApiProperty({ example: '08:00' })
  @IsString()
  horaInicio!: string;

  @ApiProperty({ example: '12:00' })
  @IsString()
  horaFim!: string;
}

/**
 * A semana, e **só os dias em que ele atende**.
 *
 * `dias: []` é pedido legítimo: apaga a semana inteira. O molde exige os 7
 * dias porque lá o dia omitido seria ambíguo (manter? fechar?); aqui a D3 já
 * respondeu — ausência é ausência de atendimento.
 */
export class DefinirDisponibilidadeDto {
  @ApiProperty({ type: [DiaDisponibilidadeDto], maxItems: 7 })
  @ValidateNested({ each: true })
  @Type(() => DiaDisponibilidadeDto)
  @ArrayMaxSize(7)
  dias!: DiaDisponibilidadeDto[];
}
