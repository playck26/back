import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUUID,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateCourtDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  nome?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
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
  @IsUUID()
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
