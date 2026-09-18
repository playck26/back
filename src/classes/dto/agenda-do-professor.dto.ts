import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-026 — os DTOs do calendário do professor.
 *
 * O estado da chamada sai **resolvido** aqui, e não como `completude` cru: a
 * tela não pode reinterpretar a regra da SPEC-014, senão vira uma segunda
 * cópia dela.
 */

export class DiaDaAgendaDoProfessorDto {
  @ApiProperty({ example: '2026-09-01' })
  data!: string;

  @ApiProperty({ example: 2, description: 'Quantas aulas dele neste dia.' })
  aulas!: number;

  /**
   * SPEC-052/D1 — a partição de `aulas` por tipo, para a grade pintar um
   * marcador por tipo sem abrir cada dia. `aulas = turmas + particulares`
   * (INV-129, só aplicação: os três saem do mesmo laço).
   */
  @ApiProperty({
    example: 1,
    description:
      'Quantas das `aulas` são aula de TURMA. `aulas = turmas + particulares` (SPEC-052/INV-129).',
  })
  turmas!: number;

  @ApiProperty({
    example: 1,
    description:
      'Quantas das `aulas` são aula PARTICULAR (SPEC-039). `aulas = turmas + particulares` (SPEC-052/INV-129).',
  })
  particulares!: number;

  @ApiProperty({
    example: 1,
    description:
      'Quantas ainda sem chamada registrada. É esta contagem que faz o calendário valer: a grade ele já conhece de cabeça; o que falta registrar, não. **Aula particular nunca entra aqui** (SPEC-039/LIM-039a), mas conta em `aulas`.',
  })
  pendentes!: number;
}

export class AulaDoDiaDoProfessorDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'O MESMO id que `PUT /me/teacher/attendance/:ocupacaoId` aceita (INV-026b). Se divergirem, o caminho quebra no último passo.',
  })
  ocupacaoId!: string;

  /**
   * SPEC-039/AC-009 — o que distingue aula de turma de aula particular.
   *
   * A tela poderia deduzir por `turmaId === null`, e dedução não é contrato:
   * no dia em que existir ocorrência de turma sem turma, a dedução quebra em
   * silêncio.
   */
  @ApiProperty({ enum: ['turma', 'particular'] })
  tipo!: 'turma' | 'particular';

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  turmaId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  turmaNome!: string | null;

  @ApiProperty({ example: 'Quadra 1' })
  quadraNome!: string;

  @ApiProperty({ example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ example: '19:00' })
  horaFim!: string;

  /**
   * SPEC-027 — ganhou `futura` e `em_andamento`, e a diferença é de produto.
   *
   * Antes, ausência de linha em `chamadas` era sempre `pendente`, então uma
   * aula da semana que vem aparecia cobrando chamada. O estado agora depende
   * de `data` + `hora_inicio`/`hora_fim` contra o relógio do clube.
   */
  @ApiProperty({
    enum: [
      'futura',
      'em_andamento',
      'pendente',
      'feita',
      'legada',
      'nao_houve',
      // SPEC-057/TASK-001/D4 — sem cabeçalho, terminada pós-corte e com
      // `M ∪ V` vazio: não cobra ninguém.
      'sem_participantes',
    ],
    description:
      '`futura` = ainda não começou; a chamada **não** pode ser lançada. ' +
      '`em_andamento` = começou e não terminou; pode lançar, e não é ' +
      'pendência. `pendente` = já terminou e não há linha em `chamadas`. ' +
      '`legada` = chamada de antes da SPEC-015, com `completude: desconhecida`. ' +
      '`nao_houve` = alguém declarou que a aula não aconteceu (SPEC-030); ' +
      '**não** é pendência e não pinta o ponto vermelho. ' +
      '`sem_participantes` = terminou depois do corte da presença automática, ' +
      'sem chamada e sem ninguém matriculado nem repondo (SPEC-057); não é ' +
      'pendência. ' +
      '`cancelada` não aparece aqui: o filtro do calendário a exclui antes. ' +
      '**`null` na aula PARTICULAR** (SPEC-039/LIM-039a): ela não tem ' +
      'chamada, e resolver um estado ali pintaria `pendente` numa aula que ' +
      'nunca poderá receber uma — ponto vermelho que o professor não limpa.',
    type: String,
    nullable: true,
  })
  chamada!: string | null;

  /**
   * SPEC-058/D5 — **quantos avisaram que vão faltar nesta aula.**
   *
   * O Israel escolheu este insight para o cartão do professor: *"quem avisou
   * que vai faltar"*. Ele já é visível na chamada, depois que a aula termina;
   * o que faltava era saber **antes**, quando ainda dá para mudar o plano da
   * aula.
   *
   * **Zero em aula particular:** falta avisada é de aluno de turma
   * (SPEC-031), e um aluno só que não vem cancela a aula, não a esvazia.
   */
  @ApiProperty({
    example: 2,
    description: 'Quantos avisaram falta nesta aula.',
  })
  faltasAvisadas!: number;

  /**
   * Os nomes de quem avisou, em ordem alfabética.
   *
   * **Não é dado novo exposto:** o professor já vê a lista da turma e a
   * chamada já diz quem avisou que ia faltar. O que muda é a hora em que ele
   * fica sabendo.
   */
  @ApiProperty({ type: [String], example: ['Ana Lima', 'Bruno Sá'] })
  quemAvisou!: string[];
}
