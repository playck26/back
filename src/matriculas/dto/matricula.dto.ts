import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsISO8601, IsOptional, Min } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

export class CriarMatriculaDto {
  @ApiProperty({ format: 'uuid' })
  @UuidNoCorpo()
  planoId!: string;

  /** `AAAA-MM-DD`. Ausente = hoje, no fuso do clube. */
  @ApiPropertyOptional({ type: String, example: '2026-09-10' })
  @IsOptional()
  @IsISO8601({ strict: true })
  inicio?: string;

  /**
   * **Ausente = o preco de tabela do plano** (AC-005).
   *
   * `Min(0)` e nao `Min(1)`: bolsa integral existe, e zero e um valor
   * legitimo. E por isso o servico compara contra `undefined` e nao contra
   * falsy -- `dto.valorCentavos || plano.valorCentavos` transformaria a bolsa
   * em preco cheio, em silencio.
   */
  @ApiPropertyOptional({ type: Number, example: 25000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  valorCentavos?: number;
}
