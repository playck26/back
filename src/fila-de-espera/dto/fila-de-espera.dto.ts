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
