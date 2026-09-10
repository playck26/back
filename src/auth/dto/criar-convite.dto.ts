import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

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
  @UuidNoCorpo()
  nivelId?: string;

  /**
   * SPEC-037/D8/AC-014 — **o convite carrega o plano, e e ai que a jornada
   * fecha.**
   *
   * O gestor convida ja dizendo qual plano, e o aceite cria conta + aceite do
   * contrato + MATRICULA na mesma transacao (AC-015). Opcional: convite sem
   * plano continua sendo o de hoje.
   */
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @UuidNoCorpo()
  planoId?: string;
}
