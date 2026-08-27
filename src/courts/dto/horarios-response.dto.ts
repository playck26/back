import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta de horário e disponibilidade**
 * (SPEC-010, SPEC-011).
 *
 * ## O campo que ninguém adivinha, e por isso precisa estar no contrato
 *
 * `origem: 'proprio' | 'herdado'` diz se a quadra tem horário próprio ou se
 * está seguindo o padrão da empresa. **É a diferença entre "editar esta
 * quadra" e "editar o padrão"**, e um cliente que não a receba mostra os
 * mesmos sete dias nos dois casos, sem dizer qual dos dois o gestor está
 * prestes a mudar.
 *
 * ## E o que a disponibilidade devolve não é "livre/ocupado"
 *
 * São **três** estados, e o terceiro distingue ocupação de turma de reserva
 * avulsa. Quem colapsar em booleano perde a informação que decide se o
 * horário pode ser negociado com alguém.
 */

export class DiaDeHorarioResponseDto {
  /** 0 = domingo, como `Date.getUTCDay()`. */
  @ApiProperty({ type: Number, example: 1 })
  diaSemana!: number;

  @ApiProperty({ type: Boolean })
  fechado!: boolean;

  /** `null` quando o dia está fechado — não há hora a mostrar. */
  @ApiProperty({ type: String, nullable: true, example: '06:00' })
  horaInicio!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '22:00' })
  horaFim!: string | null;
}

export class QuadraComHorarioProprioResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  quadraId!: string;

  @ApiProperty({ type: [DiaDeHorarioResponseDto] })
  dias!: DiaDeHorarioResponseDto[];
}

export class HorariosDaQuadraResponseDto {
  /**
   * **`herdado` significa que a quadra não tem linha própria** e segue o
   * padrão da empresa — e continuará seguindo quando o padrão mudar
   * (SPEC-010/AC-005). É o que a tela precisa para não sugerir que está
   * editando só esta quadra.
   */
  @ApiProperty({ type: String, enum: ['proprio', 'herdado'] })
  origem!: string;

  @ApiProperty({ type: [DiaDeHorarioResponseDto] })
  dias!: DiaDeHorarioResponseDto[];
}

/**
 * SPEC-010 — uma ocupação que **seria atingida** por uma mudança de horário,
 * mostrada ao gestor antes de ele confirmar.
 */
export class OcupacaoAfetadaResponseDto {
  /**
   * **O tipo TS aqui é a união, não `string`.**
   *
   * Nos outros DTOs deste ciclo o campo de enum é `string` com o `enum:` no
   * decorator — o contrato publica os valores e o TS fica largo, o que basta
   * quando ninguém decide nada com o campo aqui dentro. Este é diferente:
   * este DTO substituiu uma `interface` interna que já era união, e alargar
   * para `string` teria tirado uma checagem que o módulo usava.
   *
   * A regra que sai daqui: **publicar contrato não pode custar tipagem.**
   */
  @ApiProperty({ type: String, enum: ['AVULSO', 'TURMA'] })
  origemTipo!: 'AVULSO' | 'TURMA';

  @ApiProperty({ type: String, example: 'Quadra 1' })
  quadraNome!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;

  /** O aluno, quando avulsa; a turma, quando recorrente. */
  @ApiProperty({ type: String, nullable: true })
  responsavel!: string | null;
}

/**
 * O que a definição de horário devolve.
 *
 * **`amostra` é amostra mesmo**, e `afetadasCount` é o total: a tela mostra
 * algumas e diz quantas são. Um contrato que só publicasse a lista faria o
 * cliente contar o array e informar um número errado quando houver mais
 * ocupações do que a amostra traz.
 */
export class ResultadoDeHorariosResponseDto {
  @ApiProperty({ type: Number, example: 12 })
  afetadasCount!: number;

  @ApiProperty({ type: [OcupacaoAfetadaResponseDto] })
  amostra!: OcupacaoAfetadaResponseDto[];
}

export class SlotDeDisponibilidadeResponseDto {
  /** Intervalo já formatado, `HH:MM-HH:MM`. */
  @ApiProperty({ type: String, example: '18:00-19:00' })
  slot!: string;

  /**
   * **Três estados, não dois.** `ocupado_turma` e `ocupado_avulso` são
   * ocupações diferentes para quem opera: uma é compromisso recorrente do
   * clube, a outra é reserva de uma pessoa. Colapsar em "ocupado" apaga a
   * informação que decide se dá para negociar o horário.
   */
  @ApiProperty({
    type: String,
    enum: ['livre', 'ocupado_turma', 'ocupado_avulso'],
  })
  status!: string;
}

export class DisponibilidadeResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  quadraId!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  /**
   * **`fechado` não é erro** (SPEC-010/AC-008): é resposta legítima, e vem
   * com `slots: []`. Um cliente que tratasse lista vazia como falha mostraria
   * erro num domingo em que o clube simplesmente não abre.
   */
  @ApiProperty({ type: String, enum: ['aberto', 'fechado'] })
  estado!: string;

  @ApiProperty({ type: [SlotDeDisponibilidadeResponseDto] })
  slots!: SlotDeDisponibilidadeResponseDto[];
}

/**
 * SPEC-018 — a imagem da quadra, e a foto de perfil, têm a mesma forma e o
 * mesmo motivo: **a chave nunca sai, a URL sai** (INV-037).
 */
export class ImagemDaQuadraResponseDto {
  /** URL de CDN, sem assinatura (AC-002), ou `null` quando não há imagem. */
  @ApiProperty({ type: String, nullable: true })
  imagemUrl!: string | null;
}

/**
 * **DEF-017 — este DTO existe porque eu anotei a rota errada com o DTO de
 * outra.**
 *
 * `GET /company-settings/horarios` foi anotada com `HorariosDaQuadraResponseDto`
 * (`{ origem, dias }`) em 2026-08-27. Ela devolve outra coisa:
 * `listarConfiguracao()` monta `{ padrao, quadrasComHorarioProprio }`.
 *
 * **A amarra de retorno não pegou, e o motivo é estrutural:** ela confere a
 * forma que o *serviço anotado* devolve. Eu pus o `@ApiOkResponse` no
 * controller sem conferir **qual método** ele chama — e o controller chama
 * `listarConfiguracao`, não `listarDaQuadra`. O gate de contrato também não
 * pegou: ele pergunta "tem schema?", não "tem o schema **certo**?".
 *
 * O tipo escrito à mão do Admin (`HorariosEmpresa`) estava certo o tempo
 * todo. De novo: o contrato publicado é que mentia.
 */
export class ConfiguracaoDeHorariosResponseDto {
  /** Os sete dias da empresa — o padrão que toda quadra herda por ausência. */
  @ApiProperty({ type: [DiaDeHorarioResponseDto] })
  padrao!: DiaDeHorarioResponseDto[];

  /**
   * **Só as quadras que TÊM horário próprio.** As demais herdam, e herança é
   * ausência de registro — listar todas com o padrão copiado daria a
   * impressão errada de que foram configuradas uma a uma.
   */
  @ApiProperty({ type: [QuadraComHorarioProprioResponseDto] })
  quadrasComHorarioProprio!: QuadraComHorarioProprioResponseDto[];
}
