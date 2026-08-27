import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-019/REQ-006 — o **contrato de resposta** de turma.
 *
 * ## Por que este arquivo é requisito, e não zelo
 *
 * A SPEC-019 muda a forma de **cinco** respostas de turma. Antes desta task,
 * das 90 respostas desta API só 10 tinham schema publicado, e **nenhuma delas
 * era de turma**: os quatro controllers de `classes` não tinham um
 * `@ApiOkResponse` sequer, e os três frontends declaravam `diaSemana` à mão.
 *
 * Em 2026-08-26 uma mudança idêntica em forma — campo virou objeto — derrubou
 * três telas do app do aluno em produção **com o typecheck verde** (DEF-012).
 * A validação cruzada da SPEC-019 apontou que esta spec ia repetir o defeito
 * no mesmo mês, e virou a REQ-006.
 *
 * ## O corte, e ele é estreito de propósito
 *
 * Isto cobre **apenas as rotas que esta spec quebra**. Publicar schema das
 * outras ~80 respostas é a SPEC-021/TASK-005 — virar mutirão aqui seria
 * repetir o erro que originou a SPEC-021 (escopo novo pendurado em spec
 * existente, sem delta registrado).
 *
 * A regra que sai disto: **quem quebra a forma de uma resposta paga a
 * proteção daquela resposta — nem menos, nem mais.**
 *
 * ## E o DTO só vale por causa da amarra
 *
 * Um DTO de resposta escrito à mão é a mesma mentira do tipo escrito à mão no
 * frontend. O que muda é `toResponse(): TurmaResponseDto` no serviço: mudar a
 * forma passa a quebrar o typecheck do **próprio `back`**, antes de qualquer
 * cliente (SPEC-021/INV-058).
 *
 * `type:` explícito em todo campo porque um `@ApiPropertyOptional` sem `type`
 * já virou `Record<string, never>` no cliente gerado, neste projeto, nesta
 * semana.
 */
export class TurmaEncontroResponseDto {
  @ApiProperty({ type: Number, minimum: 0, maximum: 6, example: 2 })
  diaSemana!: number;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;
}

export class TurmaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  @ApiProperty({ type: String, example: 'Turma Iniciante' })
  nome!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nivelId!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  professorId!: string | null;

  @ApiProperty({ type: String, format: 'uuid' })
  quadraId!: string;

  /**
   * **Um ou mais.** Substituiu `diaSemana`/`horaInicio`/`horaFim`, que saíram
   * da resposta — não ficaram como alias do primeiro encontro, porque uma
   * turma de três dias que expõe só o primeiro mente sobre si mesma para
   * quem não atualizou.
   */
  @ApiProperty({ type: [TurmaEncontroResponseDto] })
  encontros!: TurmaEncontroResponseDto[];

  @ApiProperty({ type: Number, example: 10 })
  capacidade!: number;

  @ApiProperty({ type: String, enum: ['ativa', 'inativa'] })
  status!: string;

  @ApiProperty({ type: Number, example: 4 })
  alunosAlocados!: number;
}

export class TurmaPaginadaResponseDto {
  @ApiProperty({ type: [TurmaResponseDto] })
  data!: TurmaResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 3 })
  total!: number;
}

export class AlunoDaTurmaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String })
  nome!: string;

  @ApiProperty({ type: String })
  email!: string;
}

export class TurmaDetalheResponseDto extends TurmaResponseDto {
  @ApiProperty({ type: [AlunoDaTurmaResponseDto] })
  alunos!: AlunoDaTurmaResponseDto[];
}

/**
 * As rotas do professor (`/me/teacher/classes`) têm forma **própria**, e não
 * é duplicação: elas trazem `quadraNome`/`nivelNome` resolvidos e **omitem**
 * `companyId`, `nivelId` e `professorId`.
 *
 * O professor não escolhe quadra nem nível — ele precisa do nome para saber
 * onde ir. Reusar o `TurmaResponseDto` aqui obrigaria a mandar ids que a tela
 * dele não usa, e um id que ninguém usa é convite para alguém usar.
 */
export class TurmaDoProfessorResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  nome!: string;

  @ApiProperty({ type: [TurmaEncontroResponseDto] })
  encontros!: TurmaEncontroResponseDto[];

  @ApiProperty({ type: String })
  quadraNome!: string;

  @ApiProperty({ type: String, nullable: true })
  nivelNome!: string | null;

  @ApiProperty({ type: Number })
  capacidade!: number;

  @ApiProperty({ type: Number })
  totalAlunos!: number;
}

export class AlunoDoProfessorResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  nome!: string;

  @ApiProperty({ type: String, nullable: true })
  nivelNome!: string | null;
}

/**
 * **O detalhe da turma do professor — a rota que a 1ª versão da SPEC-019
 * esqueceu.**
 *
 * A validação cruzada apontou que `GET /me/teacher/classes/:id` devolvia
 * `diaSemana`/`horaInicio`/`horaFim` e que `minha-turma-detalhe.tsx`
 * renderizava os três. A lista seria atualizada e o detalhe continuaria
 * esperando campos removidos — tela branca no app do professor.
 *
 * **Ele não estende `TurmaDoProfessorResponseDto`** porque não tem
 * `totalAlunos`: quem tem a lista não precisa da contagem, e mandar as duas
 * criaria a chance de elas discordarem.
 */
export class TurmaDoProfessorDetalheResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  nome!: string;

  @ApiProperty({ type: [TurmaEncontroResponseDto] })
  encontros!: TurmaEncontroResponseDto[];

  @ApiProperty({ type: String })
  quadraNome!: string;

  @ApiProperty({ type: String, nullable: true })
  nivelNome!: string | null;

  @ApiProperty({ type: Number })
  capacidade!: number;

  /**
   * **Nome e nível, e só** (SPEC-013/AC-008). Telefone, e-mail e qualquer
   * coisa de pagamento ficam de fora: o professor precisa saber quem está na
   * quadra, não a ficha financeira de ninguém.
   */
  @ApiProperty({ type: [AlunoDoProfessorResponseDto] })
  alunos!: AlunoDoProfessorResponseDto[];
}
