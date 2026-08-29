import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsInt,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

export class AceitarConviteDto {
  @ApiProperty()
  @IsString()
  token!: string;

  @ApiProperty({ minLength: 8 })
  @IsString()
  @MinLength(8)
  senha!: string;

  // Só usados quando o convite não os trouxe pré-preenchidos.
  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  nome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telefone?: string;

  /**
   * SPEC-024/REQ-007 — as versoes que a pessoa LEU na tela do convite.
   *
   * Opcionais para nao quebrar cliente antigo: sem elas, o cadastro funciona
   * e o portao pega a pessoa no primeiro acesso. E um degrau a mais para ela,
   * nunca um furo — ninguem entra sem aceitar.
   */
  @ApiPropertyOptional({ example: 1 })
  @IsOptional()
  @IsInt()
  termoVersao?: number;

  @ApiPropertyOptional({ example: 3 })
  @IsOptional()
  @IsInt()
  contratoVersao?: number;
}
