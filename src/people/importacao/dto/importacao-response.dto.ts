import { ApiProperty } from '@nestjs/swagger';

/**
 * SPEC-038/AC-002 — um problema, com o numero da linha DA PLANILHA.
 *
 * **O numero conta o cabecalho**, porque e o que o gestor ve no Excel.
 * Renumerar depois de filtrar linhas em branco faria a mensagem apontar para
 * a linha errada, e ele procuraria o problema no lugar errado.
 */
export class ErroDeImportacaoDto {
  @ApiProperty({ example: 47 })
  linha!: number;

  @ApiProperty({ example: 'email' })
  coluna!: string;

  @ApiProperty({ example: 'Ja existe uma conta com este e-mail.' })
  mensagem!: string;
}

/** Uma linha que passou na conferencia, ja normalizada. */
export class LinhaValidaDto {
  @ApiProperty({ example: 2 })
  linha!: number;

  @ApiProperty({ example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ example: 'ana@clube.local' })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  telefone!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  dataNascimento!: Date | null;

  @ApiProperty({ type: String, nullable: true })
  emergenciaNome!: string | null;

  @ApiProperty({ type: String, nullable: true })
  emergenciaTelefone!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nivelId!: string | null;
}

/**
 * SPEC-038/REQ-001 — o relatorio da conferencia.
 *
 * **`erros` vazio e a unica condicao para importar** (D3): qualquer problema
 * recusa o arquivo inteiro. Importar as boas e listar as ruins deixaria o
 * gestor sem saber quais das 300 entraram, e a segunda tentativa duplicaria o
 * que ja passou.
 */
export class RelatorioDeImportacaoDto {
  @ApiProperty({
    example: 300,
    description: 'Linhas de aluno, sem o cabecalho.',
  })
  total!: number;

  @ApiProperty({ example: 298 })
  validas!: number;

  @ApiProperty({ type: [ErroDeImportacaoDto] })
  erros!: ErroDeImportacaoDto[];

  @ApiProperty({ type: [LinhaValidaDto] })
  linhas!: LinhaValidaDto[];
}

/**
 * SPEC-038/D6 — a senha temporaria sai UMA VEZ, na resposta que a criou.
 *
 * Nenhuma outra rota a devolve, e nao ha como pedi-la de novo -- so regenerar.
 * E a mesma regra do `AlunoComSenhaTemporariaResponseDto` da SPEC-009/AC-006,
 * e ela vale aqui pelo mesmo motivo: senha guardada em algum lugar para ser
 * relida depois deixa de ser temporaria.
 */
export class AlunoImportadoDto {
  @ApiProperty({ example: 2 })
  linha!: number;

  @ApiProperty({ format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ example: 'ana@clube.local' })
  email!: string;

  @ApiProperty({
    example: 'Kx7-mQ2p',
    description:
      'Sai UMA VEZ. Nenhuma outra rota a devolve -- se o gestor perder, o caminho e regenerar.',
  })
  senhaTemporaria!: string;
}

export class ImportacaoConcluidaDto {
  @ApiProperty({ type: [AlunoImportadoDto] })
  criados!: AlunoImportadoDto[];
}
