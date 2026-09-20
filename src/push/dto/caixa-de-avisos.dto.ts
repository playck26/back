import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-065/TASK-001 — **o que a caixa mostra, e o que ela nunca mostra.**
 *
 * ## Os cinco campos que ficam de fora, e por que cada um
 *
 * A `notificacoes` é, antes de tudo, uma **caixa de saída**: fila, lease,
 * cerca, contador de tentativas. Nada disso interessa a quem lê o aviso, e um
 * deles é perigoso.
 *
 * | Campo | Por que não sai |
 * |---|---|
 * | `estado` | é da fila. E dizer "este aviso não foi entregue" é informação de operador: a pessoa está lendo o aviso **agora**, então ele chegou — por outro caminho (LIM-065e) |
 * | `tentativas`, `ultimo_erro` | idem |
 * | `reivindicada_por` | token de lease. Não significa nada fora do tick |
 * | **`origem_id`** | **este é o perigoso.** Na SPEC-063 ele aponta para `acoes_administrativas`, que tem `autor_id`: expô-lo permitiria descobrir **quem** cancelou a aula |
 *
 * ## `select` explícito, e não `omit`
 *
 * A INV-065d exige que a caixa não vaze campo de fila. O mecanismo é este
 * arquivo mais o `select` do serviço — **uma lista do que ENTRA, não do que
 * sai**. Com `omit`, um campo novo em `notificacoes` apareceria sozinho na
 * resposta, e ninguém descobriria até alguém ler o JSON.
 */
export class AvisoDaCaixaResponseDto {
  @ApiProperty({ example: '5f7c1e2a-0000-4000-8000-000000000001' })
  id!: string;

  @ApiProperty({
    example: 'Sua aula',
    description:
      'Vocabulário fechado nos avisos de gesto (SPEC-063/D4): `Reservas`, ' +
      '`Sua aula`, `Sua turma`. O aviso de teste usa `Avisos do clube`.',
  })
  titulo!: string;

  @ApiProperty({ example: 'Sua aula de quinta (19h) foi cancelada' })
  corpo!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: '/minhas-aulas',
    description:
      'Para onde o toque leva. Carrega **id**, nunca slug de texto livre ' +
      '(SPEC-063/AC-007).',
  })
  destinoUrl!: string | null;

  @ApiProperty({ example: '2026-09-20T12:31:00.000Z' })
  criadaEm!: Date;

  @ApiProperty({
    type: String,
    nullable: true,
    example: null,
    description:
      '`null` enquanto não lida. **"Lido" é do servidor** (SPEC-065/D2): ' +
      'vale em todo aparelho da mesma conta.',
  })
  lidaEm!: Date | null;
}

/**
 * O envelope `{ data, page, pageSize, total }` que o projeto já publica em
 * `quadras`, `ocupações` e `aulas anteriores` — *"uma segunda forma de
 * paginação no mesmo contrato obrigaria cada frontend a saber qual rota fala
 * qual dialeto"*.
 *
 * **`naoLidos` viaja junto**, e é acréscimo deliberado ao envelope: quem abre
 * a caixa e marca tudo como lido precisa do número novo, e sem isto a tela
 * faria uma segunda chamada só para descobrir que agora é zero.
 */
export class CaixaDeAvisosResponseDto {
  @ApiProperty({ type: [AvisoDaCaixaResponseDto] })
  data!: AvisoDaCaixaResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 37 })
  total!: number;

  @ApiProperty({
    type: Number,
    example: 3,
    description:
      "Quantos ainda não foram lidos. **Não conta `tipo='teste'`** " +
      '(SPEC-065/AC-008): o aviso de teste é diagnóstico do canal, não recado ' +
      'do clube.',
  })
  naoLidos!: number;
}

/** O que o sino pede, e só isso. */
export class NaoLidosResponseDto {
  @ApiProperty({ type: Number, example: 3 })
  naoLidos!: number;
}

/**
 * Quantas linhas a chamada marcou.
 *
 * **`0` é resposta normal, não erro** (AC-006): marcar de novo é idempotente
 * por construção (`WHERE lida_em IS NULL`), então duas abas chamando ao mesmo
 * tempo não brigam — a segunda simplesmente não acha o que marcar.
 */
export class MarcadasResponseDto {
  @ApiProperty({ type: Number, example: 3 })
  marcadas!: number;
}
