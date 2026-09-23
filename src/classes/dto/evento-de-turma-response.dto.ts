import { ApiProperty } from '@nestjs/swagger';
import { AutorDoEventoDto } from '../../courts/dto/evento-de-ocupacao-response.dto';
import { TIPOS_DE_ACAO_PUBLICADOS } from '../../common/auditoria/tipos-de-acao-publicados';

/**
 * SPEC-069/D2 — uma linha do extrato administrativo de uma TURMA.
 *
 * ## O que esta resposta é, e o que ela não é
 *
 * **Ela não remonta a história da turma** (LIM-069a). Os gestos que mexem na
 * grade — criar, editar horário, inativar, reativar, cancelar ou reativar uma
 * aula — continuam em `eventos_de_ocupacao`, e são lidos por
 * `GET /bookings/:id/eventos`, uma ocupação por vez. Aqui ficam os gestos cujo
 * alvo é a turma **em si**, e hoje há um: a troca de professor.
 *
 * Isso está dito na `description` da rota com todas as letras, e não só aqui:
 * quem abrir esperando linha do tempo completa vai encontrar uma linha só e
 * concluir que o histórico sumiu.
 *
 * ## Os dois tipos, que respondem perguntas diferentes
 *
 * Mesma forma do irmão de ocupação: `tipo` é o efeito sobre a turma,
 * `acao` é o gesto humano que o provocou. Aqui os dois andam juntos — um
 * evento `professor_alterado` sob uma ação `turma_professor_alterado` —, e
 * eles continuam separados porque o modelo é o mesmo: a ação é o gesto, o
 * evento é o alvo.
 */
export class EventoDeTurmaResponseDto {
  @ApiProperty({
    enum: ['professor_alterado'],
    description: 'O efeito sobre a TURMA.',
  })
  tipo!: 'professor_alterado';

  @ApiProperty({ format: 'date-time' })
  em!: string;

  /**
   * O enum inteiro, pela exigência do gate do DEF-016 — e **do que está nele,
   * só `turma_professor_alterado` chega nesta resposta hoje**. Os demais
   * gestos têm outro alvo técnico.
   */
  @ApiProperty({
    enum: TIPOS_DE_ACAO_PUBLICADOS,
    description: 'O GESTO humano que provocou o evento.',
  })
  acao!: string;

  @ApiProperty({
    nullable: true,
    description:
      'Nota interna da ação administrativa. A troca de professor não pede ' +
      'motivo, então hoje ela chega sempre nula nesta resposta.',
  })
  motivo!: string | null;

  @ApiProperty({ type: AutorDoEventoDto })
  autor!: AutorDoEventoDto;
}
