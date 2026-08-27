import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o contrato de resposta dos convites (SPEC-009).
 */

/**
 * SPEC-009/AC-003 — **o token sai daqui e de mais nenhum lugar.**
 *
 * No banco fica só o `sha256` dele; nem a listagem nem a consulta pública o
 * devolvem. Publicar isso no contrato é o que impede alguém procurá-lo numa
 * segunda rota e concluir que "sumiu".
 */
export class ConviteCriadoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  /** Em claro, uma vez só. `randomBytes(32).toString('base64url')`. */
  @ApiProperty({ type: String })
  token!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiraEm!: Date;
}

/** A empresa, na consulta pública do convite: **só o nome**. */
export class EmpresaDoConviteResponseDto {
  @ApiProperty({ type: String, example: 'Smart Tennis' })
  nome!: string;
}

/**
 * O que quem recebeu o link vê **antes de aceitar**, sem token de acesso.
 *
 * **O que NÃO está aqui é o ponto** (AC-024/AC-025): `email`, `telefone` e
 * `nivelId` existem no convite no banco e não saem nesta resposta. O `status`
 * da empresa também é carregado pela consulta e não sai — serve só para o
 * `410` quando a empresa está inativa.
 */
export class ConvitePublicoResponseDto {
  @ApiProperty({ type: EmpresaDoConviteResponseDto })
  empresa!: EmpresaDoConviteResponseDto;

  /** `null` quando o admin não pré-preencheu o nome. A chave sempre existe. */
  @ApiProperty({ type: String, nullable: true, example: 'Ana Souza' })
  nome!: string | null;
}
