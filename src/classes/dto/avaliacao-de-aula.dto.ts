import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/**
 * SPEC-025 — os DTOs da avaliação de turma.
 *
 * O erro nasce com schema publicado, como manda a regra que ficou da
 * SPEC-023 (quando a LIM-004 saiu de `{2xx: 90, 4xx: 0}`) e que a SPEC-024
 * seguiu: erro que muda o que a tela mostra publica schema no mesmo commit.
 */

export class AvaliarAulaDto {
  @ApiProperty({
    minimum: 1,
    maximum: 5,
    example: 5,
    description:
      'Nota inteira de 1 a 5. O banco tem CHECK equivalente — o DTO protege a API, o CHECK protege a tabela.',
  })
  @IsInt()
  @Min(1)
  @Max(5)
  nota!: number;

  @ApiPropertyOptional({
    maxLength: 500,
    description:
      'Texto puro. Sem markdown nem HTML: isto aparece no painel do gestor, e HTML vindo do aluno seria XSS lá dentro.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comentario?: string;
}

export class MinhaAvaliacaoResponseDto {
  @ApiProperty({ type: Number, nullable: true, example: 5 })
  nota!: number | null;

  @ApiProperty({ type: String, nullable: true })
  comentario!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  updatedAt!: Date | null;
}

/**
 * **INV-025a vive nesta forma.** Nada de autoria, nada de comentário.
 *
 * É o que aluno e professor recebem. O gestor tem outra rota, e o que
 * distingue as duas não é um filtro no meio do caminho: são dois DTOs
 * diferentes, para que acrescentar um campo aqui por engano seja uma decisão
 * visível e não um vazamento silencioso.
 */
export class MediaDaTurmaResponseDto {
  /**
   * SPEC-028 — **`null` agora significa "ninguém avaliou ainda"**, e só isso.
   *
   * Antes significava também "há avaliações, mas menos que o mínimo de 3".
   * Esse mínimo foi removido por decisão do Israel em 2026-08-30 — a média sai
   * desde a primeira nota. Ver `AvaliacaoDeAulaService`, onde o que se perdeu
   * está registrado.
   */
  @ApiProperty({
    type: Number,
    nullable: true,
    example: 4.3,
    description:
      'null quando ainda não há nenhuma avaliação. Uma casa decimal: a tela desenha estrelas, e precisão maior seria falsa.',
  })
  media!: number | null;

  @ApiProperty({
    example: 7,
    description:
      'Quantas avaliações compõem a média. A tela mostra ao lado dela — média sem o tamanho da amostra faz 5,0 de uma nota parecer 5,0 de vinte.',
  })
  quantidade!: number;
}

/** **Só o gestor recebe isto.** */
export class AvaliacaoParaOGestorDto {
  @ApiProperty({ example: 'Ana Souza' })
  alunoNome!: string;

  @ApiProperty({ example: 4 })
  nota!: number;

  @ApiProperty({ type: String, nullable: true })
  comentario!: string | null;

  @ApiProperty({
    example: '2026-08-12',
    description:
      'A data da AULA, não a do registro: é ela que diz ao gestor qual terça-feira investigar.',
  })
  dataDaAula!: string;

  @ApiProperty({ example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ format: 'date-time' })
  avaliadaEm!: Date;

  @ApiProperty({
    example: true,
    description:
      'Calculado no servidor. Se a tela calculasse, a régua de detrator viraria uma segunda cópia da regra.',
  })
  detrator!: boolean;
}

export class AvaliacoesDaTurmaResponseDto {
  @ApiProperty({
    type: [AvaliacaoParaOGestorDto],
    description:
      'Ordenadas por PIOR NOTA primeiro. A ordem é a funcionalidade: ordenar por data enterraria o 1 da semana passada embaixo dos 5 de ontem.',
  })
  itens!: AvaliacaoParaOGestorDto[];

  @ApiProperty({ example: 2 })
  detratores!: number;

  @ApiProperty({ example: 2 })
  notaMaximaDeDetrator!: number;
}

/** Uma aula que já aconteceu, com a nota que este aluno deu (ou não deu). */
export class AulaAnteriorResponseDto {
  @ApiProperty({ format: 'uuid' })
  ocupacaoId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  turmaId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  turmaNome!: string | null;

  @ApiProperty({ example: 'Quadra 1' })
  quadraNome!: string;

  @ApiProperty({ example: '2026-08-12' })
  data!: string;

  @ApiProperty({ example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ example: '19:00' })
  horaFim!: string;

  @ApiProperty({
    type: Number,
    nullable: true,
    description:
      'null quando ainda não avaliou. Vem junto para a tela distinguir "não avaliei" de "dei 4" sem uma requisição por linha.',
  })
  minhaNota!: number | null;

  @ApiProperty({ type: String, nullable: true })
  meuComentario!: string | null;
}

/** Ver a nota do topo: o código é o contrato; a mensagem é copy. */
export class ErroDeAvaliacaoResponseDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({ enum: ['NAO_MATRICULADO', 'AULA_NAO_TERMINOU'] })
  code!: string;

  @ApiProperty({
    example: 'Você só pode avaliar turmas em que está matriculado.',
  })
  message!: string;
}

/**
 * SPEC-027 — a página de aulas anteriores.
 *
 * Mesmo formato `{ data, page, pageSize, total }` que `quadras` e `ocupações`
 * já publicam. Uma segunda forma de paginação no mesmo contrato obrigaria
 * cada frontend a saber qual rota fala qual dialeto.
 */
export class AulasAnterioresPaginadasResponseDto {
  @ApiProperty({ type: [AulaAnteriorResponseDto] })
  data!: AulaAnteriorResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 37 })
  total!: number;
}
