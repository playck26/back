import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';

/**
 * SPEC-083/D7 — o corpo e a resposta das rotas públicas do link de ativação.
 */

/**
 * `POST /public/ativacao`. A senha segue a regra de `aceitar-convite.dto.ts`:
 * no mínimo 8. **A recusa do DTO é `400` e não consome o link** (AC-023): o
 * `ValidationPipe` responde antes de o serviço ser chamado.
 */
export class AtivarContaDto {
  /**
   * O token do link. Malformado não é `400`: é o mesmo `410 LINK_INVALIDO` dos
   * outros sete casos (D7), conferido no serviço.
   */
  @ApiProperty({ type: String })
  @IsString()
  token!: string;

  @ApiProperty({ type: String, minLength: 8 })
  @IsString()
  @MinLength(8)
  senha!: string;
}

/** O clube, na página do link: **só o nome**. */
export class EmpresaDaAtivacaoResponseDto {
  @ApiProperty({ type: String, example: 'Smart Tennis' })
  nome!: string;
}

/**
 * `GET /public/ativacao/:token` — o que a página mostra antes de a pessoa criar
 * a senha (D11). **Só o primeiro nome e o clube:** e-mail, telefone e o resto
 * da conta não saem numa rota que qualquer um com o link chama.
 */
export class AtivacaoPublicaResponseDto {
  @ApiProperty({ type: String, example: 'Maria' })
  primeiroNome!: string;

  @ApiProperty({ type: EmpresaDaAtivacaoResponseDto })
  empresa!: EmpresaDaAtivacaoResponseDto;
}
