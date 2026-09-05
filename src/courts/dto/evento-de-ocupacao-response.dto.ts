import { ApiProperty } from '@nestjs/swagger';

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

  @ApiProperty({
    enum: [
      'reserva_criada',
      'reserva_cancelada',
      // SPEC-034: mover uma reserva e cancelar uma ocorrência de turma são
      // gestos próprios — nenhum dos dois cabia em `reserva_cancelada`.
      'reserva_movida',
      'aula_cancelada',
      'pagamento_confirmado',
      'turma_criada',
      'turma_horario_editado',
      'credito_lancado',
      'credito_retirado',
    ],
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
