import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, Max, Min } from 'class-validator';

/**
 * SPEC-066/TASK-001 — **a página da lista de aulas do aluno.**
 *
 * ## Por que não estende o `PaginationQueryDto`
 *
 * O compartilhado é `pageSize` padrão **20**, teto **100**. Esta rota é
 * padrão **10** (é o pedido do usuário: *"apresentar apenas 10 aulas por
 * página"*) e teto **50**.
 *
 * Herdar e sobrescrever funcionaria, mas o `@Max(100)` herdado continuaria
 * registrado no metadado da propriedade — dois tetos na mesma chave, e o que
 * vale é acidente de ordem de decorator. **Teto que depende de ordem de
 * decorator não é teto.** Um DTO próprio custa vinte linhas e não tem essa
 * pergunta.
 *
 * ## Por que existe teto (INV-066c)
 *
 * `pageSize` vem do cliente. Sem teto, `?pageSize=100000` reconstrói
 * exatamente o problema que esta spec fecha — a página enorme que o aluno
 * relatou. O `@Max(50)` recusa com `400` **antes de chegar ao banco**, que é
 * o que torna a invariante mecânica em vez de combinada.
 *
 * ## Por que 50, e não 200
 *
 * Na v1 desta spec o teto era 200, porque a mesma rota tinha de servir a home
 * — que desenha um mês inteiro. A validação independente mediu **270 aulas em
 * 90 dias com apenas três turmas**, e `limiteTurmasPorAluno` é nulável
 * (`NULL` = sem limite), então nenhum número serviria.
 *
 * A v2 separou as duas perguntas: a janela ficou em `GET /me/classes?de&ate`,
 * que **não pagina**, e esta rota responde só pela lista. **O teto deixou de
 * precisar carregar a home, e por isso pôde voltar a ser pequeno.**
 */
export class ProximasAulasQueryDto {
  @ApiPropertyOptional({ default: 1, minimum: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number = 1;

  @ApiPropertyOptional({ default: 10, minimum: 1, maximum: 50 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(50)
  pageSize?: number = 10;
}

/** O padrão e o teto, nomeados — o service não repete literal. */
export const PAGINA_PADRAO = 10;
export const PAGINA_MAXIMA = 50;
