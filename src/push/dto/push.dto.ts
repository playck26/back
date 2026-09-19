import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, IsUrl, MaxLength } from 'class-validator';

/**
 * SPEC-062/D2 — o que o navegador emitiu, repassado tal qual.
 *
 * **Os três campos são CREDENCIAL** (INV-062f): quem os tiver pode mandar push
 * naquele aparelho. Eles entram por aqui e **não saem em lugar nenhum** — nem
 * em resposta, nem em log, nem em mensagem de erro. No log vai a impressão de
 * oito caracteres, nunca o valor.
 *
 * Por isso o `endpoint` viaja no CORPO também no `DELETE`: em query string ele
 * apareceria no log de acesso de qualquer proxy no caminho, e um segredo em
 * URL é um segredo publicado.
 */
export class AssinaturaPushDto {
  @ApiProperty({
    description:
      'O `endpoint` emitido pelo serviço de push do navegador. CREDENCIAL: não é devolvido por nenhuma rota.',
    maxLength: 2048,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  // O serviço de push é sempre HTTPS; recusar o resto aqui evita gravar lixo
  // que só falharia no primeiro envio, horas depois.
  @IsUrl({ protocols: ['https'], require_protocol: true })
  endpoint!: string;

  @ApiProperty({
    description: 'Chave pública do aparelho. CREDENCIAL.',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  p256dh!: string;

  @ApiProperty({
    description: 'Segredo de autenticação do aparelho. CREDENCIAL.',
    maxLength: 255,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  auth!: string;
}

export class DesassinarPushDto {
  @ApiProperty({
    description: 'O `endpoint` a remover DESTA conta.',
    maxLength: 2048,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  endpoint!: string;
}

/**
 * SPEC-062/D1b — a chave pública e a impressão da privada.
 *
 * **A impressão não é segredo**, e sai aqui de propósito: é o insumo do gate
 * G7, que procura o VALOR da chave privada dentro do bundle publicado sem
 * nunca receber o valor. São 32 bytes aleatórios atrás de um `sha256`.
 */
export class ChavePublicaResponseDto {
  @ApiProperty({ description: 'A chave pública VAPID, em base64url.' })
  chave!: string;

  @ApiProperty({
    description:
      '`sha256` do texto da chave privada, em hexadecimal. Não é segredo: é o insumo do gate que procura a chave no bundle publicado.',
  })
  impressaoDaPrivada!: string;
}

export class TesteEnfileiradoResponseDto {
  @ApiProperty({
    description:
      'Sempre `true`. A linha entrou na caixa de saída; o envio é do tick, e aceitação pelo serviço de push não é entrega.',
  })
  enfileirada!: boolean;
}
