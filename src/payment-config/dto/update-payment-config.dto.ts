import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUrl, Matches } from 'class-validator';

// Formato E.164 (DATA_MODEL.md), ex. +5511999999999 — usado para montar
// o link wa.me (AC-003).
const WHATSAPP_E164_REGEX = /^\+[1-9]\d{6,14}$/;

export class UpdatePaymentConfigDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsUrl({}, { message: 'linkPagamentoUrl deve ser uma URL válida' })
  linkPagamentoUrl?: string;

  @ApiPropertyOptional({ example: '+5511999999999' })
  @IsOptional()
  @Matches(WHATSAPP_E164_REGEX, {
    message: 'whatsappNumero deve estar em formato E.164, ex. +5511999999999',
  })
  whatsappNumero?: string;
}
