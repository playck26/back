import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsBoolean,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  Min,
  ValidateNested,
} from 'class-validator';

// SPEC-010/REQ-008 (AC-014): horário só existe em hora cheia. A regra
// também está no banco (CHECK); aqui ela devolve `400` com mensagem útil
// em vez de estourar constraint com erro de driver.
const HORA_CHEIA = /^([01]\d|2[0-3]):00$/;

export class DiaHorarioDto {
  /** 0 = domingo, mesma convenção de `Date.getUTCDay()`. */
  @ApiProperty({ minimum: 0, maximum: 6 })
  @IsInt()
  @Min(0)
  @Max(6)
  diaSemana!: number;

  @ApiProperty()
  @IsBoolean()
  fechado!: boolean;

  @ApiPropertyOptional({ example: '07:00' })
  @IsOptional()
  @IsString()
  @Matches(HORA_CHEIA, {
    message: 'horaInicio deve ser hora cheia (ex.: 07:00)',
  })
  horaInicio?: string;

  @ApiPropertyOptional({ example: '22:00' })
  @IsOptional()
  @IsString()
  @Matches(HORA_CHEIA, { message: 'horaFim deve ser hora cheia (ex.: 22:00)' })
  horaFim?: string;
}

/**
 * A semana inteira, sempre. Aceitar configuração parcial obrigaria a
 * decidir o que fazer com os dias omitidos — manter o que estava? fechar?
 * — e qualquer resposta surpreenderia metade dos usuários. Mandar os 7
 * dias torna o pedido autoexplicativo.
 */
export class DefinirHorariosDto {
  @ApiProperty({ type: [DiaHorarioDto], minItems: 7, maxItems: 7 })
  @ValidateNested({ each: true })
  @Type(() => DiaHorarioDto)
  @ArrayMinSize(7)
  @ArrayMaxSize(7)
  dias!: DiaHorarioDto[];
}
