import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  MinLength,
  ValidateIf,
} from 'class-validator';
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
}
