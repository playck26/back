import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-045/AC-002 — uma linha da lista de vencimentos.
 *
 * **Traz nome do aluno e do plano, e não só os ids.** Uma lista de UUIDs
 * obrigaria a tela a buscar cada aluno para conseguir escrever a frase — o N+1
 * empurrado do servidor para o navegador, que é onde ele custa mais caro.
 */
export class VencimentoResponseDto {
  @ApiProperty({ format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ example: 'Maria Silva' })
  alunoNome!: string;

  @ApiProperty({ example: 'Mensal' })
  planoNome!: string;

  @ApiProperty({ format: 'date', example: '2026-10-12' })
  fim!: string;

  @ApiProperty({
    example: 5,
    description:
      'Dias ate o vencimento. **Negativo quando ja venceu** — e o mesmo campo, porque "vence em -3 dias" e "venceu ha 3 dias" sao a mesma informacao e dois campos divergiriam.',
  })
  diasRestantes!: number;
}

/**
 * SPEC-045/AC-008 — os dois grupos separados, e não uma lista ordenada.
 *
 * **Misturá-los faria o topo da tela alternar entre "cobre já" e "ligue
 * depois"** sem o gestor perceber a diferença: quem venceu está usando o clube
 * sem plano vigente agora; quem vence em 20 dias está em dia.
 */
export class VencimentosResponseDto {
  @ApiProperty({
    example: 30,
    description: 'A janela usada, ecoada: a tela nao precisa lembrar o padrao.',
  })
  dias!: number;

  @ApiProperty({ type: [VencimentoResponseDto] })
  vencidas!: VencimentoResponseDto[];

  @ApiProperty({ type: [VencimentoResponseDto] })
  vencendo!: VencimentoResponseDto[];
}
