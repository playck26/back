import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-026 — os DTOs do calendário do professor.
 *
 * O estado da chamada sai **resolvido** aqui, e não como `completude` cru: a
 * tela não pode reinterpretar a regra da SPEC-014, senão vira uma segunda
 * cópia dela.
 */

export class DiaDaAgendaDoProfessorDto {
  @ApiProperty({ example: '2026-09-01' })
  data!: string;

  @ApiProperty({ example: 2, description: 'Quantas aulas dele neste dia.' })
  aulas!: number;

  @ApiProperty({
    example: 1,
    description:
      'Quantas ainda sem chamada registrada. É esta contagem que faz o calendário valer: a grade ele já conhece de cabeça; o que falta registrar, não.',
  })
  pendentes!: number;
}

export class AulaDoDiaDoProfessorDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'O MESMO id que `PUT /me/teacher/attendance/:ocupacaoId` aceita (INV-026b). Se divergirem, o caminho quebra no último passo.',
  })
  ocupacaoId!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  turmaId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  turmaNome!: string | null;

  @ApiProperty({ example: 'Quadra 1' })
  quadraNome!: string;

  @ApiProperty({ example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ example: '19:00' })
  horaFim!: string;

  @ApiProperty({
    enum: ['pendente', 'feita', 'legada'],
    description:
      '`pendente` = não há linha em `chamadas`. `legada` = chamada de antes da SPEC-015, com `completude: desconhecida`.',
  })
  chamada!: string;
}
