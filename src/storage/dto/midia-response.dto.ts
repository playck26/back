import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o contrato das respostas de **mídia** (SPEC-018).
 *
 * ## Uma coisa que só aparece lendo o código, e que muda o que a tela faz
 *
 * `PUT /teachers/:id/foto` **não devolve necessariamente a foto que acabou de
 * ser enviada.** A INV-034 resolve por `coalesce(usuarios.foto_key,
 * professores.foto_key)`: se o professor tem conta com foto de perfil, a
 * conta ganha da ficha, e o gestor sobe uma imagem e recebe outra.
 *
 * `DELETE` é mais estranho ainda, e **não é 204**: apagar a foto da ficha
 * devolve a foto de perfil da pessoa, se houver. A tela precisa **usar o
 * valor devolvido** em vez de assumir que ficou vazio.
 *
 * As duas rotas de logo têm o gêmeo disso: em falha de conferência de chave
 * (fail-soft da AC-013), o valor devolvido cai para a `logo_url` externa
 * antiga — que também não é a imagem recém-enviada.
 *
 * **Nenhum desses três comportamentos é adivinhável a partir do nome da
 * rota**, e nenhum estava escrito em lugar nenhum que um cliente lesse.
 */

export class FotoDeProfessorResponseDto {
  /**
   * URL assinada de leitura, ou `null`.
   *
   * `null` acontece em dois casos diferentes e indistinguíveis daqui: não há
   * foto por nenhum dos dois lados, **ou** a assinatura falhou e o serviço
   * degradou em silêncio (`assinarOuNulo` engole a exceção e loga
   * `foto_de_professor_key_invalida`). A tela trata os dois igual — mostra o
   * fallback — e é por isso que o fail-soft é aceitável ali.
   */
  @ApiProperty({ type: String, nullable: true })
  fotoUrl!: string | null;
}

export class LogoDaEmpresaResponseDto {
  /**
   * URL **pública** (CDN, não assinada) — logo de clube é público por
   * natureza, ao contrário da foto de pessoa.
   *
   * `null` só quando não há nem `logo_key` válida nem `logo_url` externa.
   */
  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}
