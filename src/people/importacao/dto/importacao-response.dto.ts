import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  MOTIVOS_DA_FALHA,
  type MotivoDaFalha,
} from '../../../email/provedor-de-email';

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

/**
 * Uma linha que passou na conferencia, ja normalizada.
 *
 * SPEC-083/D1: `dataNascimento`, `emergenciaNome` e `emergenciaTelefone`
 * sairam junto com as colunas -- um campo que nenhuma planilha aceita mais
 * viria sempre nulo, e o Admin seguiria mostrando uma coluna morta.
 */
export class LinhaValidaDto {
  @ApiProperty({ example: 2 })
  linha!: number;

  @ApiProperty({ example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ example: 'ana@clube.local' })
  email!: string;

  @ApiProperty({ type: String, nullable: true })
  telefone!: string | null;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  nivelId!: string | null;

  /**
   * SPEC-083/D3 — a turma achada pelo nome entre as ativas. Nula quando a
   * linha não tem turma. O id vai junto do nome para o Admin mostrar o que a
   * busca achou (o nome cadastrado, com a caixa e o acento de lá), e não o
   * que o gestor digitou.
   */
  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  turmaId!: string | null;

  @ApiProperty({ type: String, nullable: true, example: 'Terça 19h' })
  turmaNome!: string | null;
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
 * SPEC-083/D5 e AC-019 — o que aconteceu com o e-mail da linha convidada.
 *
 * `enviado` quer dizer **aceito pelo provedor**, e nao entregue (LIM-083a).
 * `falhou` vem com o motivo da porta de e-mail (D8); a conta existe do mesmo
 * jeito, e o caminho e reenviar pela ficha ou gerar senha temporaria.
 */
export class ConviteDaImportacaoDto {
  @ApiProperty({ enum: ['enviado', 'falhou'], example: 'enviado' })
  email!: 'enviado' | 'falhou';

  @ApiPropertyOptional({ enum: MOTIVOS_DA_FALHA, example: 'cota' })
  motivo?: MotivoDaFalha;
}

/**
 * SPEC-038/D6 — a senha temporaria sai UMA VEZ, na resposta que a criou.
 *
 * Nenhuma outra rota a devolve, e nao ha como pedi-la de novo -- so regenerar.
 * E a mesma regra do `AlunoComSenhaTemporariaResponseDto` da SPEC-009/AC-006,
 * e ela vale aqui pelo mesmo motivo: senha guardada em algum lugar para ser
 * relida depois deixa de ser temporaria.
 *
 * SPEC-083/D5 — **uma linha tem senha OU convite, nunca os dois.** A linha
 * convidada nasce sem senha conhecida (D4), entao nao ha o que mostrar; a nao
 * convidada e exatamente a de antes.
 */
export class AlunoImportadoDto {
  @ApiProperty({ example: 2 })
  linha!: number;

  @ApiProperty({ format: 'uuid' })
  alunoId!: string;

  @ApiProperty({ example: 'ana@clube.local' })
  email!: string;

  @ApiPropertyOptional({
    example: 'pck-ACDE34',
    description:
      'Sai UMA VEZ, so na linha NAO convidada. Nenhuma outra rota a devolve -- se o gestor perder, o caminho e regenerar.',
  })
  senhaTemporaria?: string;

  @ApiPropertyOptional({
    type: ConviteDaImportacaoDto,
    description: 'So na linha convidada (campo `convidar`).',
  })
  convite?: ConviteDaImportacaoDto;
}

export class ImportacaoConcluidaDto {
  @ApiProperty({ type: [AlunoImportadoDto] })
  criados!: AlunoImportadoDto[];
}
