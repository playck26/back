import { ApiProperty } from '@nestjs/swagger';
import { IsEmail, IsString, MinLength } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

/**
 * SPEC-090 — o corpo e a resposta das três rotas públicas do "esqueci minha
 * senha".
 */

/**
 * `POST /auth/esqueci-senha` (D1). E-mail malformado é `400` do
 * `ValidationPipe`, como em qualquer DTO — não revela nada sobre contas. Bem
 * formado, a resposta é `202` vazio, exista conta ou não.
 *
 * O e-mail **não é normalizado** (LIM-090-01): a busca é exata, como no login.
 */
export class EsqueciSenhaDto {
  @ApiProperty({ type: String, format: 'email' })
  @IsEmail()
  email!: string;
}

/**
 * `POST /public/redefinicao` (D5). A senha segue a regra do `AtivarContaDto`:
 * no mínimo 8. **A recusa do DTO é `400` e não consome o link** (AC-015): o
 * `ValidationPipe` responde antes de o serviço ser chamado.
 */
export class RedefinirSenhaDto {
  /**
   * O token do link. Malformado não é `400`: é o mesmo `410` dos outros
   * casos (D4), conferido no serviço.
   */
  @ApiProperty({ type: String })
  @IsString()
  token!: string;

  /** A conta escolhida na página do link, entre as do `GET`. */
  @ApiProperty({ type: String, format: 'uuid' })
  @UuidNoCorpo()
  usuarioId!: string;

  @ApiProperty({ type: String, minLength: 8 })
  @IsString()
  @MinLength(8)
  senha!: string;
}

/** Os três papéis que pedem redefinição (I1). O `super_admin` fica fora (D7). */
export const PAPEIS_DA_REDEFINICAO = [
  'aluno',
  'professor',
  'company_admin',
] as const;
export type PapelDaRedefinicao = (typeof PAPEIS_DA_REDEFINICAO)[number];

/** O clube de uma conta do link: o nome e a logo, e nada mais. */
export class EmpresaDaRedefinicaoResponseDto {
  @ApiProperty({ type: String, example: 'Clube X' })
  nome!: string;

  /** Pelo `LogoDaEmpresaService.resolver`, como na escolha da SPEC-086. */
  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

export class ContaDaRedefinicaoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  usuarioId!: string;

  @ApiProperty({ enum: PAPEIS_DA_REDEFINICAO, enumName: 'PapelDaRedefinicao' })
  papel!: PapelDaRedefinicao;

  @ApiProperty({ type: EmpresaDaRedefinicaoResponseDto })
  empresa!: EmpresaDaRedefinicaoResponseDto;
}

/**
 * `GET /public/redefinicao/:token` (D4) — as contas que ainda aceitam o link,
 * na ordem do nome do clube. **Nem e-mail, nem nome da pessoa:** quem tem o
 * link vê só os clubes e os papéis (AC-010).
 */
export class RedefinicaoPublicaResponseDto {
  @ApiProperty({ type: [ContaDaRedefinicaoResponseDto] })
  contas!: ContaDaRedefinicaoResponseDto[];
}
