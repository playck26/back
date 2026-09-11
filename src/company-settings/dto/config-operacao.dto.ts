import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, Min, ValidateIf } from 'class-validator';

/**
 * SPEC-031/REQ-001 — os dois prazos de cancelamento, em horas.
 *
 * ## Por que os dois campos são OBRIGATÓRIOS, e nulos são aceitos
 *
 * `PUT` é substituição total, e aqui isso é decisão e não descuido: com dois
 * campos opcionais, *"mandei só o da aula"* seria ambíguo entre **"deixe a
 * reserva como está"** e **"tire o prazo da reserva"** — e as duas leituras
 * mudam quem consegue cancelar. O `GET` do mesmo caminho existe justamente
 * para a tela ler os dois antes de escrever.
 *
 * *(Diverge do `UpdateMinhaEmpresaDto`, onde os campos são opcionais. Lá o
 * verbo é `PATCH` e o argumento é o oposto: reenviar valor que não se quis
 * mudar é como se perde configuração sem ninguém perceber.)*
 *
 * ## E `null` é a única ausência (INV-065)
 *
 * Zero não existe: o banco tem `CHECK (IS NULL OR >= 1)` nos dois campos, e
 * aqui `@Min(1)` recusa antes de chegar lá. `0` significaria "prazo de zero
 * horas", que é indistinguível de "sem prazo" para quem lê — e a spec
 * proibiu o zero na origem para não ter de distinguir os dois com teste.
 */
export class DefinirConfigOperacaoDto {
  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    example: 2,
    description:
      'Com quantas horas de antecedência o aluno pode sair de uma aula. ' +
      '`null` = sem antecedência mínima. **Não é "sem limite"**: depois que ' +
      'a aula começou ninguém cancela, nem com `null` (D5b).',
  })
  // `ValidateIf` e não `IsOptional`: `null` é um valor COM significado, e
  // precisa passar pela rota; ausente, não. Mesmo desenho de
  // `UpdateMinhaEmpresaDto.limiteTurmasPorAluno`.
  @ValidateIf((_objeto, valor) => valor !== null)
  @IsInt()
  @Min(1, {
    message:
      'O prazo começa em 1 hora. Zero não existe: para não exigir ' +
      'antecedência, mande `null`.',
  })
  prazoCancelamentoAulaHoras!: number | null;

  @ApiProperty({
    type: Number,
    nullable: true,
    minimum: 1,
    example: 4,
    description:
      'Com quantas horas de antecedência o aluno pode cancelar uma reserva ' +
      'avulsa. `null` = sem antecedência mínima.',
  })
  @ValidateIf((_objeto, valor) => valor !== null)
  @IsInt()
  @Min(1, {
    message:
      'O prazo começa em 1 hora. Zero não existe: para não exigir ' +
      'antecedência, mande `null`.',
  })
  prazoCancelamentoReservaHoras!: number | null;

  /**
   * SPEC-047/D1 — o preço padrão de aula particular, em **reais**.
   *
   * Vale para todo professor que não tem preço próprio. **`null` não é
   * "de graça": é "o clube não vende aula particular por aqui"** — e aí
   * nenhum professor sem preço próprio aparece para o aluno.
   *
   * Zero também não passa (`@Min(0.01)` aqui e `CHECK > 0` no banco): zero é o
   * valor que o ledger recusa, e a aula de graça quebraria na cobrança depois
   * de a tela dizer que deu certo.
   */
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0.01,
    example: 150,
    description:
      'Preco padrao da aula particular, em reais. `null` = o clube nao vende aula particular pelo app.',
  })
  @ValidateIf((_objeto, valor) => valor !== null && valor !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, {
    message:
      'O preco comeca em R$ 0,01. Para nao vender aula particular, mande `null`.',
  })
  precoAulaPadrao?: number | null;
}

/**
 * O que as três rotas devolvem — a do gestor e a do aluno.
 *
 * **Empresa sem configuração devolve os dois campos `null`, não `404`.** Não
 * ter prazo configurado é um estado normal e é a maioria das empresas hoje;
 * responder `404` obrigaria cada chamador a traduzir "não encontrado" em
 * "sem prazo", e essa tradução é exatamente onde o `null` viraria `0`.
 */
export class ConfigOperacaoResponseDto {
  @ApiProperty({ type: Number, nullable: true, example: 2 })
  prazoCancelamentoAulaHoras!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 4 })
  prazoCancelamentoReservaHoras!: number | null;
  @ApiProperty({ type: Number, nullable: true, example: 150 })
  precoAulaPadrao!: number | null;
}
