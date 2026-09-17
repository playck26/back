import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
} from 'class-validator';
import { PALETA_DE_QUADRA } from '../paleta-de-quadra';
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

  /**
   * SPEC-057/TASK-005/D19 — cor auxiliar da quadra na agenda, uma das seis da
   * paleta (`PALETA_DE_QUADRA`). Minúsculas são aceitas e gravadas na forma
   * canônica maiúscula.
   *
   * **`@Allow()` e não `@IsIn`, de propósito:** quem valida é
   * `validarCorDeQuadra`, no serviço, para a recusa sair com
   * `400 COR_QUADRA_INVALIDA` — o `ValidationPipe` responderia um `400` sem
   * `code`, e a tela não teria como distinguir cor inválida de outro campo.
   * `null` também chega ao serviço e é recusado lá: não existe quadra sem cor.
   */
  @ApiPropertyOptional({
    type: String,
    enum: [...PALETA_DE_QUADRA],
    description: 'Ausente: usa o padrão #00763A.',
  })
  @Allow()
  cor?: string;
}
