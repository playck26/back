import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString, IsUUID } from 'class-validator';

/**
 * SPEC-009/REQ-002 — o admin pode pré-preencher o que já sabe do aluno.
 * `nome` aparece na tela pública do convite (AC-024); `email`, `telefone`
 * e `nivelId` são aplicados no aceite **sem serem exibidos** (AC-025): a
 * página do convite não vira superfície de leitura de dado pessoal para
 * quem estiver de posse do link.
 */
export class CriarConviteDto {
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

  @ApiPropertyOptional()
  @IsOptional()
  @IsUUID()
  nivelId?: string;
}
