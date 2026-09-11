import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-047/AC-004 e AC-007 — **so o que o aluno precisa para escolher.**
 *
 * Compare com `ProfessorResponseDto`, que o gestor recebe: aquele traz
 * `telefone`, `email`, `status` e `usuarioId`. **Nenhum deles esta aqui**, e a
 * ausencia e a decisao (D6) -- o aluno escolhe por nome, rosto e preco.
 *
 * `precoAula` ja vem RESOLVIDO (professor -> padrao do clube): a tela nao tem
 * como refazer essa conta, porque nao conhece a configuracao do clube. E quem
 * nao tem preco nenhum nao chega ate aqui.
 */
export class ProfessorParaAlunoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Carlos Lima' })
  nome!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'URL assinada, ou `null`. **Fail-soft**: chave corrompida vira `null` e linha no log, nunca erro na listagem (INV-034).',
  })
  fotoUrl!: string | null;

  @ApiProperty({
    example: 150,
    description:
      'Preco da aula em REAIS, ja resolvido (professor -> padrao do clube). Nunca nulo aqui: quem nao tem preco nao e listado (D2).',
  })
  precoAula!: number;
}
