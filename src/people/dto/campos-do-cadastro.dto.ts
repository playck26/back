import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsIn,
  IsISO8601,
  IsOptional,
  IsString,
  Length,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * SPEC-036 — **as 27 unidades federativas.**
 *
 * Duas letras maiusculas nao bastam: `XX` passaria, e a cidade "Sao Paulo/XX"
 * ninguem consegue filtrar depois. A mesma lista vive no `CHECK
 * alunos_uf_valida` -- o banco e a rede de baixo, e daqui sai a MENSAGEM.
 */
export const UFS = [
  'AC',
  'AL',
  'AP',
  'AM',
  'BA',
  'CE',
  'DF',
  'ES',
  'GO',
  'MA',
  'MT',
  'MS',
  'MG',
  'PA',
  'PB',
  'PR',
  'PE',
  'PI',
  'RJ',
  'RN',
  'RS',
  'RO',
  'RR',
  'SC',
  'SP',
  'SE',
  'TO',
] as const;

/**
 * SPEC-036/D7 — **os sete campos que o ALUNO pode escrever no proprio
 * cadastro**, e o gestor tambem.
 *
 * ## Por que este DTO e o menor, e o do gestor cresce dele
 *
 * O "cadastro hibrido" do item 15 e literalmente isto: o gestor comeca e o
 * aluno termina, sobre os MESMOS campos. O que difere e o que so o gestor
 * mexe -- `nivelId` e `status` --, e isso mora no `UpdateStudentDto`.
 *
 * **Um DTO so, com o papel decidindo, foi recusado.** Campos que ora valem
 * ora nao dependendo de quem chama e como nasce escalada de privilegio: basta
 * alguem esquecer o `if` numa rota.
 *
 * ## `null` apaga; `''` e erro (AC-005)
 *
 * As duas intencoes sao legitimas e diferentes, e se pareceriam identicas na
 * tela. String vazia preencheria o campo sem informar nada, e a barra de
 * completude subiria por engano -- por isso `MinLength(1)` na aplicacao e
 * `btrim(x) <> ''` no banco (INV-108).
 */
export class CamposDoCadastroDto {
  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  nome?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsString()
  @MinLength(1)
  telefone?: string;

  /**
   * `AAAA-MM-DD`. **`IsISO8601` e nao `IsDate`**: o corpo chega como JSON, e
   * `IsDate` so passaria com um `@Type(() => Date)` que transforma silencio em
   * `Invalid Date`. A plausibilidade (1900 < d <= hoje) e conferida no
   * servico e no `CHECK alunos_nascimento_plausivel`.
   */
  @ApiPropertyOptional({ type: String, nullable: true, example: '1990-05-10' })
  @IsOptional()
  @IsISO8601({ strict: true })
  dataNascimento?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  emergenciaNome?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  emergenciaTelefone?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(240)
  endereco?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  cidade?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true, enum: UFS })
  @IsOptional()
  @IsIn(UFS, {
    message: 'uf deve ser uma das 27 unidades federativas',
  })
  @Length(2, 2)
  uf?: string | null;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(2000)
  observacoesSaude?: string | null;
}
