import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-009 — a empresa na **página pública de auto-cadastro** (`/cadastro/<slug>`).
 *
 * **Dois campos, e a escassez é a decisão.** Esta rota é alcançável por
 * qualquer pessoa com o link, sem autenticação: tudo o que sai aqui é
 * público de fato. `id`, `slug`, `status` e `permiteAutoCadastro` ficam de
 * fora — o `status` inclusive é lido pela rota para decidir se responde, e
 * ainda assim não sai no corpo.
 */
export class EmpresaPublicaResponseDto {
  @ApiProperty({ type: String, example: 'Smart Tennis' })
  nome!: string;

  /** Já resolvida (INV-037): a chave de storage nunca sai. */
  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

/**
 * A resposta do smoke test de tenant. Rota interna, sem cliente — declarada
 * porque "não tem cliente hoje" é exatamente o que se diz antes de alguém
 * começar a depender dela.
 */
export class SmokeDeTenantResponseDto {
  @ApiProperty({ type: Boolean, example: true })
  ok!: boolean;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;
}
