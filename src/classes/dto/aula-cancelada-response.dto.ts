import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-035/TASK-004 — uma aula cancelada que ainda dá para trazer de volta.
 *
 * ## Por que este DTO existe, se a agenda já lista aula
 *
 * **Porque a agenda esconde o que foi cancelado.** Os três filtros de
 * `agenda.service.ts` trazem `statusPagamento: { not: 'cancelado' }`, e isso
 * está certo para o que a agenda é: o que vai acontecer. O efeito colateral é
 * que a aula cancelada **desaparece da tela** — e não dá para reativar o que
 * não se vê.
 *
 * É o mesmo defeito que a SPEC-039 levou na tela: a funcionalidade existia e
 * não era alcançável. Ali o Israel procurou "marcar aula particular" e não
 * achou; aqui ninguém acharia "desfazer o cancelamento".
 *
 * ## Só o FUTURO, e só o que a rota aceita reativar
 *
 * A lista não é histórico de cancelamentos: é a lista do que **ainda dá para
 * desfazer**. Aula passada não reativa (AC-013), então oferecê-la aqui seria
 * mostrar um botão que só sabe recusar.
 */
export class AulaCanceladaResponseDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'O MESMO id que `POST /classes/:turmaId/ocorrencias/:ocupacaoId/reactivate` aceita — se divergirem, o caminho quebra no último passo (mesma razão da INV-026b).',
  })
  ocupacaoId!: string;

  @ApiProperty({ example: '2026-09-22' })
  data!: string;

  @ApiProperty({ example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ example: '19:00' })
  horaFim!: string;

  @ApiProperty({ example: 'Quadra 1' })
  quadraNome!: string;

  /**
   * **O horário ainda está livre?**
   *
   * Calculado na leitura, e por isso pode envelhecer entre o `GET` e o clique
   * — quem decide continua sendo a `EXCLUDE` no `POST` (AC-012). Serve para a
   * tela avisar ANTES, do mesmo jeito que a janela do professor avisa na aula
   * particular: guiar reduz o erro, prometer seria mentir.
   */
  @ApiProperty({
    description:
      '`false` quando outra ocupação já tomou o horário. A tela avisa antes; quem decide é o servidor.',
  })
  horarioLivre!: boolean;
}
