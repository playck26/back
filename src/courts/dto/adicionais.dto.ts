import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Length,
  Matches,
  Max,
  Min,
  Validate,
} from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';
import { DataDoCalendarioConstraint } from './data-do-calendario.dto';

/**
 * SPEC-054/D2 e AC-002 — **nome sem espaço nas pontas, recusado, e não
 * aparado.** O `CHECK` do banco é `btrim(nome) = nome`: aparar aqui faria o DTO
 * aceitar o que a coluna recusa em outra rota que não apare, e as duas
 * barreiras deixariam de dizer a mesma coisa. Recusar com `400` mantém DTO e
 * banco iguais — e é o que a AC-038 confere, com o DTO desligado.
 */
const SEM_ESPACO_NAS_PONTAS = /^\S(?:[\s\S]*\S)?$/;
const MENSAGEM_PONTAS = 'nome não pode começar nem terminar com espaço';

/** O teto do `numeric(10,2)`: oito dígitos antes da vírgula. */
const PRECO_MAXIMO = 99_999_999.99;
/** O teto do `integer` do Postgres. */
const INTEIRO_MAXIMO = 2_147_483_647;

export class CriarTipoDeAdicionalDto {
  @ApiProperty({ example: 'Raquetes', minLength: 1, maxLength: 30 })
  @IsString()
  @Length(1, 30)
  @Matches(SEM_ESPACO_NAS_PONTAS, { message: MENSAGEM_PONTAS })
  nome!: string;

  @ApiPropertyOptional({
    example: 0,
    description: 'Ordena na tela. Default 0.',
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INTEIRO_MAXIMO)
  ordem?: number;
}

export class EditarTipoDeAdicionalDto {
  @ApiPropertyOptional({ example: 'Raquetes', minLength: 1, maxLength: 30 })
  @IsOptional()
  @IsString()
  @Length(1, 30)
  @Matches(SEM_ESPACO_NAS_PONTAS, { message: MENSAGEM_PONTAS })
  nome?: string;

  @ApiPropertyOptional({ example: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INTEIRO_MAXIMO)
  ordem?: number;
}

export class CriarAdicionalDto {
  @ApiProperty()
  @UuidNoCorpo()
  tipoId!: string;

  @ApiProperty({ example: 'Raquete Wilson', minLength: 1, maxLength: 40 })
  @IsString()
  @Length(1, 40)
  @Matches(SEM_ESPACO_NAS_PONTAS, { message: MENSAGEM_PONTAS })
  nome!: string;

  /**
   * Em **reais**, como `quadras.preco_hora` e `ocupacoes_quadra.valor`. **Zero
   * não passa** (INV-136): adicional de graça quebraria o `CHECK valor_unitario
   * > 0` do item, e o gestor descobriria na primeira reserva.
   */
  @ApiProperty({ example: 15, minimum: 0.01 })
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(PRECO_MAXIMO)
  preco!: number;

  @ApiProperty({ example: 4, minimum: 0 })
  @IsInt()
  @Min(0)
  @Max(INTEIRO_MAXIMO)
  estoque!: number;
}

/**
 * **Sem `DELETE`**: tirar de oferta é `ativo: false`. O item de reserva aponta
 * para o adicional com `RESTRICT` e guarda o que foi cobrado.
 */
export class EditarAdicionalDto {
  @ApiPropertyOptional()
  @IsOptional()
  @UuidNoCorpo()
  tipoId?: string;

  @ApiPropertyOptional({
    example: 'Raquete Wilson',
    minLength: 1,
    maxLength: 40,
  })
  @IsOptional()
  @IsString()
  @Length(1, 40)
  @Matches(SEM_ESPACO_NAS_PONTAS, { message: MENSAGEM_PONTAS })
  nome?: string;

  @ApiPropertyOptional({ example: 15, minimum: 0.01 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01)
  @Max(PRECO_MAXIMO)
  preco?: number;

  /**
   * D13 — **baixar abaixo do já reservado é permitido**: uma raquete quebrou e
   * o gestor registra a realidade. A resposta lista os horários que ficaram
   * acima; as reservas feitas não são tocadas.
   */
  @ApiPropertyOptional({ example: 3, minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(INTEIRO_MAXIMO)
  estoque?: number;

  @ApiPropertyOptional({ example: true })
  @IsOptional()
  @IsBoolean()
  ativo?: boolean;
}

/** `HH:mm-HH:mm`, separados por vírgula — a mesma seleção que o `POST /bookings` recebe. */
const SLOTS_NA_QUERY =
  /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d(,([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d){0,23}$/;

export class AdicionaisDisponiveisQueryDto {
  @ApiProperty({ example: '2026-10-01', description: 'AAAA-MM-DD' })
  @IsString()
  @Matches(/^20\d{2}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/, {
    message: 'data deve estar no formato AAAA-MM-DD, com ano entre 2000 e 2099',
  })
  @Validate(DataDoCalendarioConstraint)
  data!: string;

  @ApiProperty({
    example: '09:00-10:00,10:00-11:00',
    description:
      'Os horários do pedido, `HH:mm-HH:mm` separados por vírgula. Horários contíguos viram um bloco, como no `POST /bookings`.',
  })
  @IsString()
  @Matches(SLOTS_NA_QUERY, {
    message: 'slots deve ser uma lista de HH:mm-HH:mm separada por vírgula',
  })
  slots!: string;
}

export class TipoDeAdicionalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty({ example: 'Raquetes' }) nome!: string;
  @ApiProperty({ example: 0 }) ordem!: number;
}

export class AdicionalResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() tipoId!: string;
  @ApiProperty({ example: 'Raquetes' }) tipoNome!: string;
  @ApiProperty({ example: 'Raquete Wilson' }) nome!: string;
  @ApiProperty({ example: 15, description: 'Em reais.' }) preco!: number;
  @ApiProperty({ example: 4 }) estoque!: number;
  @ApiProperty({ example: true }) ativo!: boolean;
}

export class HorarioAcimaDoEstoqueDto {
  @ApiProperty({ example: '2026-10-01' }) data!: string;
  @ApiProperty({ example: '09:00' }) horaInicio!: string;
  @ApiProperty({ example: '10:00' }) horaFim!: string;
  @ApiProperty({
    example: 4,
    description: 'Unidades reservadas que se sobrepõem a este horário.',
  })
  reservado!: number;
}

export class AdicionalEditadoResponseDto extends AdicionalResponseDto {
  @ApiProperty({
    type: [HorarioAcimaDoEstoqueDto],
    description:
      'D13 — reservas futuras, não canceladas, em que a soma sobreposta passou do estoque novo. Vazio quando nada ficou acima.',
  })
  horariosAcimaDoEstoque!: HorarioAcimaDoEstoqueDto[];
}

export class AdicionalDisponivelResponseDto {
  @ApiProperty() id!: string;
  @ApiProperty() tipoId!: string;
  @ApiProperty({ example: 'Raquetes' }) tipoNome!: string;
  @ApiProperty({ example: 'Raquete Wilson' }) nome!: string;
  @ApiProperty({ example: 15, description: 'Em reais.' }) preco!: number;
  @ApiProperty({
    example: 2,
    description:
      'O MENOR saldo entre os blocos do pedido — o quanto o `POST /bookings` aceitaria agora. Nunca negativo.',
  })
  disponivel!: number;
}
