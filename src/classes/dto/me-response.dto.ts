import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta das rotas `/me`**.
 *
 * ## Por que este bloco importa mais do que o tamanho sugere
 *
 * São as rotas que o **app** lê: o aluno e o professor não têm outra API. E
 * a SPEC-019 já provou, na validação cruzada, que uma delas estava a um passo
 * de repetir o DEF-012 — `GET /me/teacher/classes/:id` não estava na tabela
 * de contrato e teria deixado a tela do professor em branco três dias depois.
 *
 * As turmas do professor ganharam DTO naquela spec. **O resto de `/me` não**,
 * e é o que entra aqui: chamada, ocorrências, foto de perfil e a empresa do
 * gestor.
 *
 * ## Data e hora saem como string, e o tipo TS diz string
 *
 * Diferente de `createdAt`, que é `Date` aqui dentro e ISO no fio, estes
 * campos já **nascem string**: `formatDateOnly` e `formatTimeOnly` os
 * convertem antes de responder. Declarar `Date` aqui faria o contrato
 * prometer um tipo que o serviço não produz.
 */

export class AulaDoAlunoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  ocupacaoId!: string;

  /** `null` só existiria se a ocupação perdesse a turma de origem. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  turmaId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Turma A' })
  turmaNome!: string | null;

  @ApiProperty({ type: String, format: 'uuid' })
  quadraId!: string;

  @ApiProperty({ type: String, example: 'Quadra 1' })
  quadraNome!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;
}

/**
 * SPEC-014 — uma ocorrência da turma na visão do professor.
 *
 * `podeLancar` é **calculado no servidor** e não derivável do resto: ele
 * junta cancelamento, data futura e a janela retroativa. Um app que tentasse
 * recompor isso com `data <= hoje` erraria a janela e ofereceria botão que
 * volta 422.
 */
export class OcorrenciaDaTurmaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;

  @ApiProperty({ type: Boolean })
  cancelada!: boolean;

  @ApiProperty({ type: Boolean })
  chamadaFeita!: boolean;

  @ApiProperty({ type: Number, example: 4 })
  marcados!: number;

  @ApiProperty({ type: Number, example: 8 })
  totalAlunos!: number;

  @ApiProperty({ type: Boolean })
  podeLancar!: boolean;

  /**
   * SPEC-027 — o mesmo vocabulário do calendário do professor.
   *
   * `podeLancar` responde "o servidor aceita?"; `estado` responde "por quê",
   * e é isso que a tela precisa para escolher a cor e o texto sem deduzir
   * regra nenhuma.
   */
  @ApiProperty({
    enum: ['futura', 'em_andamento', 'pendente', 'feita', 'cancelada'],
    description:
      '`futura` = ainda não começou. `em_andamento` = começou e não ' +
      'terminou. `pendente` = terminou sem chamada. `feita` = há presenças. ' +
      '`cancelada` = ocorrência cancelada.',
  })
  estado!: string;
}

export class LinhaDaChamadaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  /**
   * **`null` é "ainda não lançado"**, e não um quarto estado de presença.
   * Um contrato que declarasse só os três valores faria o app tratar
   * ausência como ausente — que é o oposto do que ela significa.
   */
  @ApiProperty({
    type: String,
    enum: ['presente', 'ausente', 'justificado'],
    nullable: true,
  })
  status!: string | null;

  /**
   * SPEC-015/INV-020 — **o aluno pode estar na chamada e não estar mais na
   * turma.** A chamada é um retrato do dia; a matrícula muda depois. Este
   * campo é o que permite a tela distinguir os dois sem inventar regra.
   */
  @ApiProperty({ type: Boolean })
  naTurmaHoje!: boolean;
}

export class ChamadaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  turmaId!: string | null;

  @ApiProperty({ type: String, example: '2026-09-01' })
  data!: string;

  @ApiProperty({ type: String, example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ type: String, example: '19:00' })
  horaFim!: string;

  @ApiProperty({ type: Boolean })
  cancelada!: boolean;

  /**
   * SPEC-015 — **três estados, e o terceiro é `null`.**
   *
   * `null` é *"chamada não lançada"*; `completa` é a declarada completa pelo
   * professor; `desconhecida` é a legada, anterior ao cabeçalho de
   * completude. A tela precisa dos três separados: uma pede ação, outra é
   * história, e a terceira é ausência.
   *
   * **A primeira versão deste campo dizia `['completa', 'incompleta',
   * 'desconhecida']` e não-nulo — escrito de memória.** `incompleta` não
   * existe no código, e o `null` que existe teria sumido do contrato. É a
   * segunda vez nesta task que a memória inventou um contrato; das duas, quem
   * pegou foi o `tsc`, porque a amarra de retorno estava no lugar.
   */
  @ApiProperty({
    type: String,
    enum: ['completa', 'desconhecida'],
    nullable: true,
  })
  completude!: string | null;

  /**
   * SPEC-014 — o token de concorrência otimista. Volta no `PUT`, e duas abas
   * abertas na mesma chamada não sobrescrevem uma à outra em silêncio.
   */
  @ApiProperty({ type: String })
  versao!: string;

  @ApiProperty({ type: [LinhaDaChamadaResponseDto] })
  alunos!: LinhaDaChamadaResponseDto[];
}

/** O que o `PUT` da chamada devolve: a versão nova, para a tela continuar. */
export class ChamadaSalvaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ type: String })
  versao!: string;

  @ApiProperty({ type: Number, example: 8 })
  total!: number;
}

/**
 * SPEC-017/SPEC-018 — a foto de perfil de quem está logado.
 *
 * **`url: null` é o estado normal, não erro.** A maioria das contas não tem
 * foto, e um contrato que declarasse a URL obrigatória faria o app tratar o
 * caso comum como falha.
 */
export class FotoDePerfilResponseDto {
  @ApiProperty({ type: String, nullable: true })
  url!: string | null;
}

/**
 * DEF-003/DEF-004 — a empresa como o **gestor** a vê, em `/me/company`.
 *
 * É menos que `EmpresaResponseDto` de propósito: sem `createdAt`,
 * `updatedAt` nem a lista de esportes. O gestor não administra a própria
 * empresa como o super admin administra — ele precisa do link público e do
 * interruptor dele.
 *
 * **`logoKey` não sai** (INV-037), e `id` sai porque o painel monta
 * `PUT /companies/:id/logo` com ele — e ele já viaja no próprio token.
 */
export class MinhaEmpresaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Smart Tennis' })
  nome!: string;

  /** SPEC-009 — a parte do link público `/cadastro/<slug>`. */
  @ApiProperty({ type: String, example: 'smart-tennis' })
  slug!: string;

  @ApiProperty({ type: String, enum: ['ativa', 'inativa'] })
  status!: string;

  /**
   * DEF-004 — **e este campo é escrito por `PATCH /me/company`.**
   *
   * A SPEC-009/REQ-006 dizia "a empresa decide" e nenhum critério de aceite
   * dava a ela um jeito de decidir: era lida em dois lugares e escrita em
   * nenhum. O DEF-004 fechou isso, e o interruptor mora no
   * `link-cadastro-card` do Admin.
   */
  @ApiProperty({ type: Boolean })
  permiteAutoCadastro!: boolean;

  /**
   * SPEC-023 — quantas turmas um aluno pode entrar **por conta própria**.
   *
   * `null` = sem limite, e é o padrão de propósito: empresa que já existe
   * não muda de comportamento por causa de uma coluna nova.
   *
   * **Vale para entrar, nunca para expulsar** (INV-023a). Baixar o limite
   * não tira ninguém de turma em que já está — ninguém sai de uma turma
   * porque uma configuração mudou.
   */
  @ApiProperty({ type: Number, nullable: true, minimum: 1, example: 2 })
  limiteTurmasPorAluno!: number | null;

  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;
}

/**
 * SPEC-027 — a página de ocorrências de uma turma (histórico de chamadas).
 *
 * Mesmo formato `{ data, page, pageSize, total }` do resto do contrato.
 */
export class OcorrenciasDaTurmaPaginadasResponseDto {
  @ApiProperty({ type: [OcorrenciaDaTurmaResponseDto] })
  data!: OcorrenciaDaTurmaResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 38 })
  total!: number;
}
