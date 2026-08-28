import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * SPEC-023/TASK-007 — **os corpos de erro com schema, e o porquê.**
 *
 * A LIM-004 mediu em 2026-08-27: das 90 respostas declaradas da API,
 * **90 são `2xx` e zero são `4xx`**. Foi por isso que três tipos escritos à
 * mão sobreviveram à INV-059 nos frontends — e eles governam desvio de
 * sessão inteiro.
 *
 * Esta spec cria seis erros novos que **decidem o que a tela mostra**. Nascer
 * sem schema seria o terceiro ciclo repetindo o mesmo erro depois de escrever
 * que ele é caro. Aviso não é mecanismo; schema é.
 */
export class EncontroDaTurmaDisponivelDto {
  @ApiProperty({ example: 2, description: '0 = domingo, 6 = sábado' })
  diaSemana!: number;

  @ApiProperty({ example: '18:00' })
  horaInicio!: string;

  @ApiProperty({ example: '19:00' })
  horaFim!: string;
}

export class TurmaDisponivelResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'Iniciantes — Terça e Quinta' })
  nome!: string;

  @ApiProperty({ enum: ['ativa', 'inativa'] })
  status!: 'ativa' | 'inativa';

  @ApiProperty({ example: 8 })
  capacidade!: number;

  @ApiProperty({
    example: 6,
    description:
      'Quantos alunos já estão na turma. Vem da mesma fonte que a trava de capacidade (INV-003) — uma segunda contagem seria uma segunda verdade.',
  })
  matriculados!: number;

  @ApiProperty({ example: false })
  jaEstouNela!: boolean;

  @ApiProperty({
    example: true,
    description:
      'Calculado no servidor. Se a tela deduzisse, viraria uma segunda cópia das regras — e é a cópia que fica velha.',
  })
  podeEntrar!: boolean;

  @ApiPropertyOptional({
    nullable: true,
    enum: [
      'ALUNO_NAO_APROVADO',
      'TURMA_INATIVA',
      'LIMITE_DE_TURMAS',
      'TURMA_CHEIA',
    ],
    description: 'Por que não pode entrar. `null` quando pode.',
  })
  motivo!: string | null;

  @ApiProperty({ type: [EncontroDaTurmaDisponivelDto] })
  encontros!: EncontroDaTurmaDisponivelDto[];
}

/** O corpo que a tela lê para decidir a mensagem. Ver a nota do topo. */
export class ErroDeMatriculaResponseDto {
  @ApiProperty({ example: 409 })
  statusCode!: number;

  @ApiProperty({
    enum: [
      'ALUNO_NAO_APROVADO',
      'TURMA_INATIVA',
      'LIMITE_DE_TURMAS',
      'TURMA_CHEIA',
      'AULA_HOJE',
    ],
    description:
      'O código é o contrato; a mensagem é texto para humano e pode mudar sem aviso. Tela que decide pela mensagem quebra na primeira revisão de copy.',
  })
  code!: string;

  @ApiProperty({ example: 'Esta turma já está com todas as vagas ocupadas.' })
  message!: string;
}

export class MatriculaDoAlunoResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  turmaId!: string;

  @ApiProperty({ format: 'uuid' })
  alunoId!: string;
}
