import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta de reserva e agenda**.
 *
 * ## O campo que o contrato existe para congelar
 *
 * `valor` é o preço **cobrado**, não o preço atual da quadra (SPEC-011).
 * Antes de ele existir na resposta, as telas multiplicavam `precoHora ×
 * horas` por conta própria — e passariam a mostrar um número diferente do
 * cobrado assim que o clube reajustasse o preço. Publicá-lo no schema é o que
 * impede alguém "simplificar" a tela recalculando de novo.
 */

export class OcupacaoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  quadraId!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;

  /** Ver `statusPagamento`: união no tipo TS, para o `tsc` conferir o valor. */
  @ApiProperty({ type: String, enum: ['AVULSO', 'TURMA'] })
  origemTipo!: 'AVULSO' | 'TURMA';

  /** `null` em ocupação de turma: o dono ali é a turma, não uma pessoa. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  alunoId!: string | null;

  /**
   * **DEF-016 — este campo dizia `'pendente'`, e o valor não existe.**
   *
   * O enum do banco é `pendente_pagamento` (`schema.prisma`, `StatusPagamento`),
   * e o próprio `back` compara com ele em `agenda.service.ts`. Publiquei
   * `'pendente'` de memória em 2026-08-27, e o `openapi.json` chegou a **se
   * contradizer no mesmo documento**: o filtro de `GET /bookings` publicava
   * `pendente_pagamento` e a resposta publicava `pendente`.
   *
   * O tipo escrito à mão do Admin estava **certo** o tempo todo. O contrato
   * publicado é que mentia — que é o pior caso possível, e o que esta spec
   * inteira existe para impedir.
   *
   * O tipo TS é a união, não `string`: com `string` o `tsc` não tem como
   * comparar o valor que o Prisma devolve com o que o decorator promete, e
   * foi essa folga que deixou o erro passar.
   */
  @ApiProperty({
    type: String,
    enum: ['pendente_pagamento', 'pago', 'cancelado'],
  })
  statusPagamento!: 'pendente_pagamento' | 'pago' | 'cancelado';

  /**
   * SPEC-011 — **o valor congelado no momento da reserva**, e `null` em
   * ocupação de turma. Ver o bloco no topo do arquivo: recalcular na tela é o
   * defeito que este campo existe para tornar desnecessário.
   */
  @ApiProperty({ type: Number, nullable: true, example: 120 })
  valor!: number | null;
}

/**
 * SPEC-011 — o formato **novo** de `POST /bookings`: um pedido pode gerar
 * vários blocos.
 *
 * O formato antigo (um objeto só) continua sendo aceito e devolvido quando o
 * cliente manda o corpo antigo — é dívida datada, com condição de saída no
 * DTO de requisição. **As duas formas estão no contrato porque as duas estão
 * no fio**; publicar só a nova faria o schema descrever uma API que ainda não
 * é esta.
 */
export class ReservasCriadasResponseDto {
  @ApiProperty({ type: [OcupacaoResponseDto] })
  reservas!: OcupacaoResponseDto[];
}

export class OcupacaoPaginadaResponseDto {
  @ApiProperty({ type: [OcupacaoResponseDto] })
  data!: OcupacaoResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 240 })
  total!: number;
}

/**
 * SPEC-012 — um dia no resumo mensal da agenda do gestor.
 *
 * `fechado` **não é "sem reserva"**: é dia sem nada reservado **e** com todas
 * as quadras fechadas (AC-008). Um cliente que derivasse `total === 0` como
 * fechado marcaria de cinza um sábado vazio em que o clube estava aberto.
 */
export class DiaDaAgendaResponseDto {
  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: Number, example: 12 })
  total!: number;

  @ApiProperty({ type: Number, example: 3 })
  pendentes!: number;

  @ApiProperty({ type: Boolean })
  fechado!: boolean;
}

export class ItemDaAgendaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Quadra 1' })
  quadraNome!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;

  @ApiProperty({ type: String, enum: ['AVULSO', 'TURMA'] })
  origemTipo!: 'AVULSO' | 'TURMA';

  /**
   * SPEC-012/AC-004 — **a turma, quando a ocupação é de turma; o aluno,
   * quando é avulsa.** Identificar ocupação de turma pelo aluno era o defeito
   * que a AC-004 existe para barrar: a turma tem muitos alunos e nenhum deles
   * é o responsável pelo horário.
   */
  @ApiProperty({ type: String, nullable: true })
  responsavel!: string | null;

  /** Ver `OcupacaoResponseDto.statusPagamento` — DEF-016, mesmo erro. */
  @ApiProperty({
    type: String,
    enum: ['pendente_pagamento', 'pago', 'cancelado'],
  })
  statusPagamento!: 'pendente_pagamento' | 'pago' | 'cancelado';

  @ApiProperty({ type: Number, nullable: true, example: 120 })
  valor!: number | null;
}

/**
 * MOD-007 — o KPI da tela inicial do gestor.
 *
 * As duas taxas são **percentuais inteiros já calculados no servidor**, e é
 * decisão: a ocupação de quadra depende do horário de funcionamento de cada
 * dia (SPEC-010/REQ-009), e nenhum cliente tem como recompor isso sem
 * refazer a resolução de horário — que é justamente a fonte única que a
 * SPEC-010 criou para não existir em dois lugares.
 */
export class DashboardResumoResponseDto {
  @ApiProperty({ type: Number, example: 87 })
  alunosAtivos!: number;

  @ApiProperty({ type: Number, example: 72 })
  ocupacaoTurmasPct!: number;

  @ApiProperty({ type: Number, example: 45 })
  ocupacaoQuadrasPct!: number;
}
