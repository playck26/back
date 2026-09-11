import { ApiProperty } from '@nestjs/swagger';

export class HorarioDeAulaDto {
  @ApiProperty({ example: '09:00' })
  horaInicio!: string;

  @ApiProperty({ example: '10:00' })
  horaFim!: string;

  /**
   * SPEC-047/LIM-047e — **a quadra vem junto, e o aluno não a escolhe.**
   *
   * A limitação dizia *"a tela vai precisar decidir isso, e a decisão não é
   * desta spec"*. A tela foi decidir e descobriu que **não pode**: das três
   * coisas que precisa cruzar — quadra livre, janela do professor e
   * compromisso do professor — só a primeira é visível ao aluno.
   *
   * Quem decide é o servidor, que vê as três. Vai junto no horário porque o
   * `POST /bookings` exige `quadraId`, e escolher no cliente reabriria a
   * divergência entre o que a tela oferece e o que a criação aceita.
   */
  @ApiProperty()
  quadraId!: string;

  @ApiProperty({ example: 'Quadra 1' })
  quadraNome!: string;
}

export class JanelaDoProfessorDto {
  @ApiProperty({ example: '08:00' })
  horaInicio!: string;

  @ApiProperty({ example: '12:00' })
  horaFim!: string;
}

export class HorariosDeAulaResponseDto {
  @ApiProperty({ example: '2026-09-15' })
  data!: string;

  /**
   * **`atende: false` não é o mesmo que lista vazia**, e é a lição da AC-008
   * da SPEC-010: `estado: 'fechado'` existe lá porque "fechado" e "aberto sem
   * nada livre" produzem a mesma grade vazia, e sem distinguir os dois a tela
   * mostra silêncio no lugar de um motivo.
   *
   * Aqui são as mesmas duas situações: *"o professor não atende neste dia"* e
   * *"atende, mas o dia está cheio"*. A pessoa faz coisas diferentes com cada
   * uma — troca de dia numa, espera na outra.
   */
  @ApiProperty()
  atende!: boolean;

  @ApiProperty({ type: JanelaDoProfessorDto, nullable: true })
  janela!: JanelaDoProfessorDto | null;

  /**
   * O preço **já resolvido** (professor → clube), repetido aqui de propósito:
   * a tela de escolher horário não deveria ter de guardar o que veio da lista
   * para poder dizer quanto custa antes de confirmar.
   */
  @ApiProperty({ example: 150 })
  precoAula!: number;

  @ApiProperty({ type: HorarioDeAulaDto, isArray: true })
  slots!: HorarioDeAulaDto[];
}
