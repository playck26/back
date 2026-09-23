import { ApiProperty } from '@nestjs/swagger';
import { TIPOS_DE_ACAO_PUBLICADOS } from '../../common/auditoria/tipos-de-acao-publicados';

/**
 * SPEC-032/CON-016 — uma linha do histórico de uma ocupação.
 *
 * **Dois tipos, e eles respondem perguntas diferentes.** `tipo` é o efeito
 * técnico sobre a ocupação (`criada`, `cancelada`); `acao` é o gesto humano
 * que o provocou (`turma_horario_editado`, por exemplo). Editar o horário de
 * uma turma é **uma** ação com eventos `cancelada` e `criada` — descrever só
 * pelo efeito faria parecer dois gestos.
 */
export class AutorDoEventoDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Maria' })
  nome!: string;
}

export class EventoDeOcupacaoResponseDto {
  @ApiProperty({
    enum: [
      'criada',
      'cancelada',
      'movida',
      'reativada',
      'pagamento_confirmado',
    ],
    description: 'O efeito TÉCNICO sobre esta ocupação.',
  })
  tipo!:
    'criada' | 'cancelada' | 'movida' | 'reativada' | 'pagamento_confirmado';

  @ApiProperty({ format: 'date-time' })
  em!: string;

  /**
   * **A lista mora em `TIPOS_DE_ACAO_PUBLICADOS`, e não aqui.** O gate do
   * DEF-016 exige o enum INTEIRO em toda resposta que publique este campo, e
   * a SPEC-069 criou a segunda — duas cópias da mesma lista é a forma de
   * drift que este arquivo já pagou três vezes.
   *
   * O que continua sendo desta resposta: **`turma_aluno_removido` e
   * `turma_professor_alterado` nunca aparecem aqui**, porque o alvo técnico
   * dos dois não é uma ocupação (é uma matrícula e uma turma). Eles entram no
   * enum publicado, não no que chega.
   */
  @ApiProperty({
    enum: TIPOS_DE_ACAO_PUBLICADOS,
    description: 'O GESTO humano que provocou o evento.',
  })
  acao!: string;

  @ApiProperty({
    nullable: true,
    description:
      'Nota interna, e só existe em ação administrativa que a exige. ' +
      'Consumo e devolução não têm motivo — o motivo deles é a própria reserva.',
  })
  motivo!: string | null;

  @ApiProperty({ type: AutorDoEventoDto })
  autor!: AutorDoEventoDto;
}
