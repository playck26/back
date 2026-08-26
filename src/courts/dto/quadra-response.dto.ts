import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-020/TASK-007 — o **contrato de resposta** de quadra, e o primeiro do
 * projeto.
 *
 * ## Por que este arquivo existe
 *
 * O DEF-012 deixou três telas do app do aluno em branco em produção: a
 * TASK-003 trocou `quadra.esporte` de string para objeto, e o Cliente
 * continuou renderizando a string. **O typecheck dos três frontends ficou
 * verde o tempo todo.**
 *
 * A causa foi medida, não suposta: das 90 respostas que esta API expõe,
 * **zero** declaravam schema. O Nest só emite schema para corpo de
 * **requisição** — por isso o Admin pegou, no mesmo dia, um erro de
 * `UpdateCourtDto` (requisição), e ninguém tinha como pegar o do `esporte`
 * (resposta). Os frontends escreviam à mão *toda* resposta porque não havia
 * o que gerar.
 *
 * ## O detalhe que faz este arquivo valer alguma coisa
 *
 * **Um DTO de resposta escrito à mão é a mesma mentira do tipo escrito à mão
 * no Cliente** — a menos que algo o amarre ao código que produz a resposta.
 * A amarra é `toQuadraResponse(): QuadraResponseDto` no serviço: mudar a
 * forma da resposta passa a quebrar o typecheck do **próprio `back`**, antes
 * de qualquer frontend.
 *
 * A corrente inteira fica: serviço → este DTO → `openapi.json` →
 * `gen:api-types` no frontend → typecheck do frontend. Quebrar um elo agora
 * acende luz vermelha em vez de tela branca.
 *
 * ## Sobre `type:` explícito em todo campo
 *
 * Não é estilo. Neste mesmo ciclo, um `@ApiPropertyOptional({ format:
 * 'uuid', nullable: true })` **sem `type`** emitiu um schema sem tipo nenhum,
 * e o `openapi-typescript` traduziu para `Record<string, never>` — um objeto
 * vazio no lugar de um uuid. Só foi descoberto porque o typecheck do Admin
 * reclamou.
 */
export class OpcaoDeCatalogoResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Saibro' })
  nome!: string;
}

export class QuadraResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  @ApiProperty({ type: String, example: 'Quadra 1' })
  nome!: string;

  /**
   * **`null` acontece de verdade**, e é o campo do DEF-012. Quadra cujo
   * `esporte` estava em branco quando o backfill da TASK-001 rodou não tem
   * como ser catalogada. A TASK-004 vai exigir preenchimento; até lá, quem
   * consome precisa tratar o nulo.
   */
  @ApiProperty({ type: OpcaoDeCatalogoResponseDto, nullable: true })
  esporte!: OpcaoDeCatalogoResponseDto | null;

  /** Opcional por decisão de produto (AC-006): nem todo clube classifica piso. */
  @ApiProperty({ type: OpcaoDeCatalogoResponseDto, nullable: true })
  categoria!: OpcaoDeCatalogoResponseDto | null;

  @ApiProperty({ type: Number, example: 120 })
  precoHora!: number;

  @ApiProperty({ type: String, enum: ['ativa', 'inativa'] })
  status!: string;

  /**
   * **O tipo em TS e o tipo no contrato divergem de propósito.** Aqui dentro
   * o valor é um `Date` vindo do Prisma; no fio ele é a string ISO que o
   * serializador do Nest produz. Declarar `Date` no decorator faria o
   * frontend gerar um tipo que nunca chega.
   */
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  /**
   * URL de CDN, **sem assinatura** (SPEC-018/AC-002). A chave crua nunca sai
   * daqui (INV-037).
   */
  @ApiProperty({ type: String, nullable: true })
  imagemUrl!: string | null;
}

/**
 * A linha **inteira** do catálogo, como `/court-sports` e `/court-categories`
 * devolvem — e é de propósito que ela não seja a mesma coisa que a
 * `OpcaoDeCatalogoResponseDto` embutida na quadra.
 *
 * Dentro da quadra basta `{ id, nome }`: é o que a tela mostra e o que o
 * filtro compara. A lista do catálogo precisa de `ordem` (o gestor ordena) e
 * de `companyId`. **Usar um tipo só faria o embutido prometer campos que não
 * chegam** — que é exatamente o que o tipo do Admin fazia antes desta task,
 * na direção oposta ao DEF-012: em vez de negar o objeto, prometia campos
 * inexistentes, e o typecheck concordava com os dois.
 */
export class CatalogoDeQuadraResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;

  @ApiProperty({ type: String, example: 'Saibro' })
  nome!: string;

  @ApiProperty({ type: Number, example: 0 })
  ordem!: number;

  /** Ver `QuadraResponseDto.createdAt`: `Date` aqui dentro, string no fio. */
  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

export class QuadraPaginadaResponseDto {
  @ApiProperty({ type: [QuadraResponseDto] })
  data!: QuadraResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 3 })
  total!: number;
}
