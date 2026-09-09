import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsDateString,
  IsNumber,
  IsOptional,
  Min,
  Matches,
  ValidateNested,
} from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

const HORA_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export class SlotDto {
  @ApiProperty({ example: '09:00' })
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio!: string;

  @ApiProperty({ example: '10:00' })
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim!: string;
}

export class CreateBookingDto {
  @ApiProperty()
  @UuidNoCorpo()
  quadraId!: string;

  @ApiProperty({ example: '2026-08-20' })
  @IsDateString()
  data!: string;

  /**
   * SPEC-011: **formato novo** — vários horários no mesmo dia. Slots
   * contíguos viram uma reserva só; separados viram reservas
   * independentes.
   */
  @ApiPropertyOptional({ type: [SlotDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SlotDto)
  @ArrayMinSize(1)
  @ArrayMaxSize(24)
  slots?: SlotDto[];

  /**
   * Formato antigo (uma hora por pedido), mantido durante a transição.
   *
   * Os frontends **em produção** ainda enviam assim — o `back` atualiza no
   * push e as telas só depois do deploy da Netlify. Remover agora deixaria
   * o app do aluno sem conseguir reservar nessa janela. Sai quando as três
   * telas estiverem atualizadas.
   */
  @ApiPropertyOptional({ example: '14:00', deprecated: true })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaInicio deve estar no formato HH:mm' })
  horaInicio?: string;

  @ApiPropertyOptional({ example: '15:00', deprecated: true })
  @IsOptional()
  @Matches(HORA_REGEX, { message: 'horaFim deve estar no formato HH:mm' })
  horaFim?: string;

  // DATA_MODEL.md: aluno_id é obrigatório quando origem_tipo=AVULSO — mas
  // opcional aqui no DTO (SPEC-005, REQ-005): quando quem chama é `aluno`,
  // o controller ignora este campo e resolve o id a partir do token, nunca
  // do cliente; só é obrigatório de fato quando quem chama é
  // `company_admin` reservando em nome de um aluno (checado no controller).
  @ApiPropertyOptional()
  @IsOptional()
  @UuidNoCorpo()
  alunoId?: string;

  /**
   * SPEC-039 — a aula particular. **Não é um `origem_tipo` novo** (D1): a
   * ocupação continua `AVULSO`, e o professor é atributo dela.
   *
   * Presente, o pedido vira aula particular e passa por três portões que a
   * reserva comum não tem: professor da empresa e ativo, dentro da janela de
   * atendimento dele (SPEC-040), e sem outra ocupação no horário.
   */
  @ApiPropertyOptional()
  @IsOptional()
  @UuidNoCorpo()
  professorId?: string;

  /**
   * SPEC-039/D2 — o preço da aula, definido pelo clube no ato.
   *
   * **Só é aceito junto com `professorId`.** Numa reserva de quadra o preço é
   * `precoHora × horas` e vem da quadra; deixar o cliente escolher o valor de
   * uma reserva comum seria abrir um caminho que a demanda não pediu, num
   * campo que a carteira debita.
   */
  @ApiPropertyOptional({ example: 120 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  valor?: number;
}
