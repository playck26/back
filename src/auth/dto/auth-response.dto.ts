import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { UsuarioRole } from '@prisma/client';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta de `auth`**.
 *
 * ## Por que este módulo veio primeiro
 *
 * A TASK-005 estende às rotas que a TASK-001 deixou de fora, e a ordem não é
 * alfabética: é por alcance. `LoginResult` e `Usuario` estavam escritos à mão
 * nos **três** frontends — nenhum outro tipo de resposta aparece nos três.
 *
 * E os três já tinham divergido, sem uma linha vermelha em lugar nenhum:
 *
 * | Onde | O que a mão escreveu | O que a API devolve |
 * |---|---|---|
 * | `Admin` | `role: "super_admin" \| "company_admin" \| "aluno"` | inclui `"professor"` desde a SPEC-013 |
 * | `Admin` | `usuario` sem `email` nem `senhaTemporaria` | devolve os dois |
 *
 * Nenhuma das duas virou apagão porque ninguém tentou logar um professor no
 * Admin, e porque campo a mais não quebra render. **É o DEF-012 com sorte** —
 * a mesma mentira, num campo que ninguém leu ainda.
 *
 * ## A amarra
 *
 * Igual à da TASK-001: o serviço anota o retorno com estes DTOs, então mudar
 * a forma da resposta quebra o typecheck do próprio `back` antes de chegar a
 * qualquer frontend (INV-058). DTO sem amarra é afirmação, não contrato.
 */

/** Os quatro papéis, na ordem em que o enum do Postgres os declara. */
const PAPEIS: UsuarioRole[] = [
  'super_admin',
  'company_admin',
  'aluno',
  'professor',
];

export class UsuarioPublicoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  /**
   * **`professor` está aqui, e é o campo que o Admin errava.** Entrou na
   * SPEC-013 e nunca chegou ao tipo escrito à mão de lá.
   */
  @ApiProperty({ type: String, enum: PAPEIS })
  role!: UsuarioRole;

  /** `null` para `super_admin`: ele é da plataforma, não de um clube. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  companyId!: string | null;

  /**
   * SPEC-009/AC-008 — **ausente quando não é primeiro acesso**, não `false`.
   *
   * Opcional de propósito: quem consome precisa tratar `undefined`, e um
   * `boolean` obrigatório faria o frontend confiar num campo que nem sempre
   * vem. A trava de verdade é do servidor (INV-008); isto só evita que o app
   * ofereça telas que ele sabe que voltarão 403.
   */
  @ApiPropertyOptional({ type: Boolean })
  senhaTemporaria?: boolean;
}

export class LoginResponseDto {
  @ApiProperty({ type: String })
  accessToken!: string;

  /**
   * **Vem no corpo E no cookie `httpOnly`, e isso é deliberado.**
   *
   * O cookie é o caminho que o navegador usa em `/auth/refresh`. O campo no
   * corpo existe para quem não é navegador — e continua no contrato porque
   * **está no fio hoje**: declarar só o cookie faria o schema descrever uma
   * API que não é esta. Contrato não é a API que se gostaria de ter.
   */
  @ApiProperty({ type: String })
  refreshToken!: string;

  @ApiProperty({ type: UsuarioPublicoResponseDto })
  usuario!: UsuarioPublicoResponseDto;
}

/**
 * O que `/auth/refresh` e `/auth/trocar-senha` devolvem.
 *
 * **Só o access token.** O refresh novo sai pelo cookie e não aparece no
 * corpo — ao contrário do login. A assimetria é real e está no contrato
 * porque quem integra precisa dela: esperar `refreshToken` aqui é receber
 * `undefined` em silêncio.
 */
export class AccessTokenResponseDto {
  @ApiProperty({ type: String })
  accessToken!: string;
}

/** O que `POST /auth/register-aluno` devolve: a conta criada, sem token. */
export class RegistroDeAlunoResponseDto {
  @ApiProperty({ type: UsuarioPublicoResponseDto })
  usuario!: UsuarioPublicoResponseDto;
}

/**
 * O que `POST /auth/aceitar-convite` devolve.
 *
 * **É menos que `UsuarioPublicoResponseDto`, e de propósito:** só `id`,
 * `email` e `nome`. Reusar o DTO maior faria o contrato prometer `role`,
 * `companyId` e `senhaTemporaria`, que este caminho não devolve — o mesmo
 * erro que o tipo escrito à mão do Admin cometia com o catálogo antes da
 * TASK-001, prometendo campos que não chegam.
 */
export class ContaDeConviteResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;
}

export class ConviteAceitoResponseDto {
  @ApiProperty({ type: ContaDeConviteResponseDto })
  usuario!: ContaDeConviteResponseDto;
}
