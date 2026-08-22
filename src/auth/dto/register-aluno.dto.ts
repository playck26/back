import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, MinLength } from 'class-validator';

export class RegisterAlunoDto {
  @ApiProperty()
  @IsEmail()
  email!: string;

  @ApiProperty()
  @IsString()
  @MinLength(8)
  senha!: string;

  @ApiProperty()
  @IsString()
  @MinLength(1)
  nome!: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telefone?: string;

  /**
   * SPEC-009/REQ-001 — a empresa é identificada pelo `slug` do link
   * público (`/cadastro/<slug>`), não pelo `company_id` cru. O UUID é
   * detalhe interno: não deve circular em link divulgado no Instagram nem
   * ser algo que o aluno precise ter em mãos para se cadastrar.
   */
  @ApiProperty({ example: 'smart-tennis' })
  @IsString()
  empresaSlug!: string;
}
