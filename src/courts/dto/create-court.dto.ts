import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
} from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

export class CreateCourtDto {
  @ApiProperty()
  @IsString()
  @MinLength(1)
  nome!: string;

  /**
   * SPEC-020/TASK-003 — **era `esporte: string`.** Virou referência ao
   * catálogo do clube, e é o que tira a barra de filtro do app do aluno das
   * mãos de quem digita.
   */
  @ApiProperty({ format: 'uuid', description: 'Opção de /court-sports.' })
  @UuidNoCorpo()
  esporteId!: string;

  /** Opcional: nem todo clube classifica piso (decisão 3 da SPEC-020). */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Opção de `/court-categories`.',
  })
  @IsOptional()
  @UuidNoCorpo()
  categoriaId?: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  precoHora!: number;
}
