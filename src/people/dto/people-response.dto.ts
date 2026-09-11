import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta de `people`**: aluno,
 * professor e nível.
 *
 * ## O que apareceu ao escrever isto
 *
 * Escrever um DTO de resposta obriga a olhar o que a rota **devolve**, e não
 * o que se lembra dela. Dois desencontros com os tipos escritos à mão do
 * Admin apareceram só por causa disso:
 *
 * | Tipo à mão no Admin | O que a API faz |
 * |---|---|
 * | `Student.vinculo?: "pendente" \| "aprovado" \| "recusado"` | `toResponse` **não devolve `vinculo`** — nunca devolveu |
 * | `Teacher` sem `fotoUrl` obrigatório | a SPEC-018 troca `fotoKey` por `fotoUrl` em toda leitura |
 *
 * O primeiro é a forma **oposta** do DEF-012: lá o tipo negava um objeto que
 * chegava; aqui promete um campo que não chega. O typecheck aceita os dois
 * calado, e o sintoma do segundo tipo é pior — `undefined` renderiza vazio,
 * então a tela fica certa até alguém depender do valor.
 *
 * `vinculo` **continua fora** deste contrato, porque continua fora da
 * resposta. A fila de aprovação funciona filtrando no servidor
 * (`?vinculo=pendente`, SPEC-009/AC-015), não lendo o campo por linha. O
 * contrato descreve a API que existe; mudá-la é decisão de produto, e teria
 * de ser spec.
 */

/**
 * SPEC-036/REQ-003 — a completude do cadastro.
 *
 * ## Vem CALCULADA, e nao ha coluna (D2/INV-111)
 *
 * A SPEC-037 vai acrescentar plano e contrato a matricula. Uma percentagem
 * gravada estaria errada no dia em que isso entrar -- e seria uma afirmacao
 * sobre um passado que ninguem consegue localizar.
 *
 * ## `faltam` existe porque o numero sozinho nao serve
 *
 * `70%` nao diz a ninguem o que fazer. `faltam: ["dataNascimento"]` diz. E a
 * mesma licao que a SPEC-035 pagou do outro lado: a mensagem crua do servidor
 * nao dizia QUANTOS conflitos, e sem a contagem o gestor nao sabia se liberava
 * uma quadra ou seis.
 *
 * **Nada e bloqueado por este numero** (SPEC-036/D4, AC-012). Nenhuma rota
 * passa a exigir cadastro completo, e ha teste so para provar essa ausencia.
 */
export class CompletudeDoCadastroDto {
  @ApiProperty({
    example: 71,
    description:
      'Fracao dos SETE campos contaveis, arredondada. O piso real e 29% -- `nome` e `email` sao NOT NULL em `usuarios`, entao todo aluno nasce com dois. Barra em zero mentiria sobre o trabalho ja feito.',
  })
  percentual!: number;

  @ApiProperty({
    type: [String],
    example: ['dataNascimento', 'emergenciaTelefone'],
    description:
      'Os que faltam, NA ORDEM EM QUE A TELA DEVE PEDI-LOS. Vazio quando `percentual` e 100.',
  })
  faltam!: string[];
}

export class AlunoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  @ApiProperty({ type: String, nullable: true, example: '+5511999999999' })
  telefone!: string | null;

  /** `null` é o estado normal: nivelamento é opcional. */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nivelId!: string | null;

  @ApiProperty({ type: String, enum: ['ativo', 'inativo'] })
  status!: string;

  /**
   * SPEC-036 — os sete campos do cadastro completo.
   *
   * **Todos anulaveis, e e o estado normal**: ha alunos em producao que nunca
   * viram estes campos. `null` e ausencia; string vazia nao existe aqui
   * (INV-108, `CHECK alunos_texto_nao_vazio`).
   */
  @ApiProperty({ type: String, nullable: true, example: '1990-05-10' })
  dataNascimento!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Beto Souza' })
  emergenciaNome!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '+5511988887777' })
  emergenciaTelefone!: string | null;

  @ApiProperty({ type: String, nullable: true })
  endereco!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Sao Paulo' })
  cidade!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'SP' })
  uf!: string | null;

  @ApiProperty({ type: String, nullable: true })
  observacoesSaude!: string | null;

  @ApiProperty({ type: CompletudeDoCadastroDto })
  cadastro!: CompletudeDoCadastroDto;
}

/**
 * SPEC-009/AC-006 — **a senha temporária vem uma única vez**, na resposta que
 * a criou. Nenhuma outra rota a devolve.
 *
 * É um DTO próprio, e não um campo opcional em `AlunoResponseDto`, porque a
 * diferença é de segurança e não de conveniência: um campo opcional no tipo
 * comum faria toda leitura de aluno parecer capaz de trazer senha, e quem
 * integra passaria a procurá-la onde ela nunca vai estar.
 */
export class AlunoComSenhaTemporariaResponseDto extends AlunoResponseDto {
  @ApiProperty({ type: String, example: 'Xk4p-9Qm2' })
  senhaTemporaria!: string;
}

export class AlunoPaginadoResponseDto {
  @ApiProperty({ type: [AlunoResponseDto] })
  data!: AlunoResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 137 })
  total!: number;
}

export class ProfessorResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  @ApiProperty({ type: String, example: 'Carlos Lima' })
  nome!: string;

  @ApiProperty({ type: String, nullable: true })
  telefone!: string | null;

  /** SPEC-013/INV-014: professor sem conta é válido, e a maioria fica assim. */
  @ApiProperty({ type: String, format: 'email', nullable: true })
  email!: string | null;

  @ApiProperty({ type: String, enum: ['ativo', 'inativo'] })
  status!: string;

  /** `null` enquanto o professor não tiver conta de acesso (INV-014). */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  usuarioId!: string | null;

  /**
   * SPEC-018/TASK-004 — **`fotoKey` nunca sai daqui, `fotoUrl` sai.**
   *
   * A chave crua permitiria montar URL por fora e contornar a conferência do
   * `StorageService` (INV-037). O contrato publica só a URL já assinada, e o
   * `comFoto()` do serviço é quem garante a troca em toda leitura.
   */
  @ApiProperty({ type: String, nullable: true })
  fotoUrl!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** Ver `AlunoComSenhaTemporariaResponseDto`: mesma regra, mesmo motivo. */
export class ProfessorComSenhaTemporariaResponseDto extends ProfessorResponseDto {
  @ApiProperty({ type: String, example: 'Xk4p-9Qm2' })
  senhaTemporaria!: string;
}

export class ProfessorPaginadoResponseDto {
  @ApiProperty({ type: [ProfessorResponseDto] })
  data!: ProfessorResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 12 })
  total!: number;
}

/**
 * Nível devolve **a linha inteira** do Prisma — inclusive `companyId` e
 * `createdAt`, que o tipo escrito à mão do Admin omitia.
 *
 * Omitir no tipo é menos grave que prometer a mais, mas é a mesma classe: o
 * contrato e a afirmação discordavam, e nada reclamava.
 */
export class NivelResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  @ApiProperty({ type: String, example: 'Iniciante' })
  nome!: string;

  @ApiProperty({ type: Number, example: 0 })
  ordem!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/**
 * **Nota de método, e ela vale mais que o DTO que não ficou aqui.**
 *
 * A primeira versão deste arquivo tinha um `DecisaoDeVinculoResponseDto`
 * com `{ id, vinculo }` — escrito de memória, do jeito que aprovar/recusar
 * *pareciam* responder. `decidirVinculo()` devolve `this.toResponse(aluno)`:
 * o aluno inteiro, sem `vinculo`.
 *
 * Um DTO inventado teria publicado um contrato **mais errado que a ausência
 * de contrato**, porque ninguém desconfia de schema publicado. As duas rotas
 * usam `AlunoResponseDto`, que é o que elas devolvem de verdade.
 */
