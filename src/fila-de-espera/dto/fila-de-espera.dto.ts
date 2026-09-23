import { ApiProperty } from '@nestjs/swagger';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

/**
 * SPEC-064/TASK-002 — o corpo de `POST /me/fila-de-espera/turmas`.
 *
 * O `alunoId` **não entra aqui**, e não é esquecimento: ele sai de
 * `(companyId, user.sub)` no serviço. Aceitá-lo do corpo deixaria um aluno
 * entrar na fila em nome de outro — a lição que a SPEC-031/D19 deixou escrita
 * (*"o prefixo não é mecanismo"*) vale também para o corpo.
 *
 * **`@UuidNoCorpo()` e não `@IsUUID()` cru**, e quem me reprovou por isso foi
 * o gate `uuid-no-corpo.gate.spec.ts`, na primeira rodada da suíte — não eu.
 * O decorador registra o `Transform` que normaliza para minúsculas: sem ele, o
 * mesmo id em maiúsculas vira um id diferente na comparação com a coluna.
 */
export class EntrarNaFilaDeTurmaDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000001' })
  @UuidNoCorpo()
  turmaId!: string;
}

/**
 * SPEC-064/TASK-002 — o corpo de `POST /me/fila-de-espera/aulas`.
 *
 * **Não há `faltaId` aqui, e isso é decisão** (LIM-064e). A linha da fila
 * guarda qual crédito a sustenta (D1), mas **quem escolhe é o servidor**: a
 * AC-002 fala em *"entrar na fila de aula sem crédito"* — propriedade da
 * pessoa, não de uma falta específica —, e deixar a tela escolher abriria a
 * porta para um `faltaId` que venceu entre o carregamento e o toque. Escolhe-se
 * o crédito que **vence primeiro**.
 */
export class EntrarNaFilaDeAulaDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000002' })
  @UuidNoCorpo()
  ocupacaoId!: string;
}

/**
 * A linha criada. **Não devolve posição na fila** — LIM-064c: a fila não mostra
 * *"você é o 3º"*. Uma posição que anda para trás (porque alguém à frente
 * desistiu, ou porque a vaga foi tomada pela tela normal) é pior que nenhuma.
 */
export class LinhaDaFilaResponseDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000003' })
  id!: string;

  @ApiProperty({
    example: 'aguardando',
    description:
      'Nasce sempre `aguardando`. Quem muda para `chamado` é o varredor ' +
      '(SPEC-064/D3), nunca esta rota.',
  })
  estado!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '5f7c1e2a-0000-4000-8000-000000000001',
    description: 'Fila de turma. Exclusivo com `ocupacaoId`.',
  })
  turmaId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description: 'Fila de aula. Exclusivo com `turmaId`.',
  })
  ocupacaoId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      'O crédito que sustenta a fila de aula. `null` na fila de turma — e ' +
      'vira `null` se a falta for apagada (a FK anula só esta coluna).',
  })
  faltaId!: string | null;

  @ApiProperty({ example: '2026-09-20T12:31:00.000Z' })
  criadaEm!: string;
}

/**
 * SPEC-064/TASK-005 — **a linha como a TELA do aluno precisa dela.**
 *
 * ## Por que esta rota não existia, e por que ela é obrigatória
 *
 * A TASK-005 pedia *"Cliente: entrar, ver a vez e o prazo, confirmar"* e
 * declarava write-set **`nada`** — nenhuma mudança de Back. Ao implementá-la
 * ficou claro que **não havia de onde ler**: a fila só tinha `POST`, `POST`,
 * `POST /confirmar` e `DELETE`, e a caixa de avisos **omite `origem_id` de
 * propósito** (INV-065d, *"a caixa não vaza campo de fila"*). A LIM-064d
 * promete que quem não tem push *"vê na tela da fila"* — e essa tela não tinha
 * fonte de dados. Lacuna da spec, achada na implementação.
 *
 * ## O que ela acrescenta ao `LinhaDaFilaResponseDto`
 *
 * O **prazo** e o **alvo com nome**. O `POST` devolve a linha crua porque quem
 * acabou de entrar já sabe onde entrou; a tela, aberta dias depois, não sabe.
 *
 * **Nome de turma e de quadra entram aqui, e isso não contradiz a INV-063a.**
 * A regra proíbe texto de tabela no **corpo do aviso**, que aparece na tela
 * bloqueada de quem passar por perto. Esta é a tela do próprio aluno, atrás de
 * login, mostrando a fila dele.
 *
 * **Não devolve posição** — LIM-064c continua valendo.
 */
export class MinhaLinhaDaFilaResponseDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000003' })
  id!: string;

  @ApiProperty({
    example: 'turma',
    description: '`turma` = vaga de matrícula; `aula` = vaga de reposição.',
  })
  fila!: 'turma' | 'aula';

  @ApiProperty({
    example: 'aguardando',
    description: 'Só `aguardando` ou `chamado`: a lista é das filas VIVAS.',
  })
  estado!: string;

  @ApiProperty({
    description:
      '**É a sua vez, e ainda dá tempo.** `estado = chamado` **e** o prazo ' +
      'ainda não venceu. A SPEC-064/D8 é explícita: a tela confere ' +
      '`chamado_ate` por conta própria e **não depende do varredor** — com o ' +
      'varredor desligado, uma vez vencida não pode aparecer como aberta.',
  })
  vezAberta!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-09-21T12:00:00.000Z',
    description: 'Até quando a vez vale. `null` enquanto não foi chamado.',
  })
  chamadoAte!: string | null;

  @ApiProperty({ type: String, nullable: true })
  turmaId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'O nome da turma do alvo — na fila de aula, a turma da aula.',
  })
  turmaNome!: string | null;

  @ApiProperty({ type: String, nullable: true })
  ocupacaoId!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '2026-09-25',
    description: 'A data da aula, na fila de aula.',
  })
  data!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '19:00' })
  horaInicio!: string | null;

  @ApiProperty({ type: String, nullable: true, example: '20:00' })
  horaFim!: string | null;

  @ApiProperty({ type: String, nullable: true })
  quadraNome!: string | null;

  @ApiProperty({ example: '2026-09-20T12:31:00.000Z' })
  criadaEm!: string;
}

/**
 * O que a confirmação devolve quando dá certo.
 *
 * **Não devolve a reposição inteira** — a tela do aluno já sabe para onde ir, e
 * repetir os dados da aula aqui criaria uma segunda fonte para os mesmos fatos.
 */
export class ConfirmacaoDaVezResponseDto {
  @ApiProperty({
    example: 'aula',
    description: '`turma` = virou matrícula; `aula` = virou reposição.',
  })
  fila!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '5f7c1e2a-0000-4000-8000-000000000004',
    description:
      'A reposição criada, na fila de aula. `null` na fila de turma, que ' +
      'gera matrícula e não reposição.',
  })
  reposicaoId!: string | null;
}
