import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  Allow,
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
import { PALETA_DE_QUADRA } from '../paleta-de-quadra';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

export class UpdateCourtDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  nome?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @UuidNoCorpo()
  esporteId?: string;

  /**
   * `null` **explícito limpa** a categoria — e é por isso que o
   * `ValidateIf` existe: sem ele o `@IsUUID` recusaria o `null`, e o clube
   * que classificou uma quadra por engano nunca conseguiria desclassificar.
   *
   * Ausente (`undefined`) é "não mexe", que é diferente.
   */
  // `type: String` explicito: sem ele o Swagger emite um schema SEM tipo,
  // e o gerador de tipos do cliente traduz para `Record<string, never>` --
  // um objeto vazio no lugar de um uuid. O typecheck do Admin pegou.
  @ApiPropertyOptional({ type: String, format: 'uuid', nullable: true })
  @IsOptional()
  @ValidateIf((_, valor) => valor !== null)
  @UuidNoCorpo()
  categoriaId?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsNumber()
  @IsPositive()
  precoHora?: number;

  @ApiPropertyOptional({ enum: ['ativa', 'inativa'] })
  @IsOptional()
  @IsIn(['ativa', 'inativa'])
  status?: 'ativa' | 'inativa';

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
    description: 'Ausente: preserva a cor atual. null é recusado.',
  })
  @Allow()
  cor?: string;
}
