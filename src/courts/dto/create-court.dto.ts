import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
} from 'class-validator';

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
  @IsUUID()
  esporteId!: string;

  /** Opcional: nem todo clube classifica piso (decisão 3 da SPEC-020). */
  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Opção de `/court-categories`.',
  })
  @IsOptional()
  @IsUUID()
  categoriaId?: string;

  @ApiProperty()
  @IsNumber()
  @IsPositive()
  precoHora!: number;
}
