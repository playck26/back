import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsInt,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * SPEC-024 — os DTOs do aceite.
 *
 * **Os dois erros nascem com schema publicado.** A regra que ficou da
 * SPEC-023, quando a LIM-004 saiu do zero: erro que muda o que a tela mostra
 * publica schema no mesmo commit. `ACEITE_PENDENTE` governa um desvio de
 * sessão inteiro — é a mesma família de `SENHA_TEMPORARIA`, que hoje é um
 * dos três tipos escritos à mão que sobreviveram à INV-059 nos frontends.
 */

export class TextoParaAceiteDto {
  @ApiProperty({ example: 1 })
  versao!: number;

  @ApiProperty({
    description:
      'Texto puro, com quebras de linha preservadas. Markdown e HTML ficam fora de propósito: HTML vindo do gestor seria XSS na tela do aluno.',
  })
  texto!: string;
}

export class AceitesPendentesResponseDto {
  @ApiProperty({
    type: TextoParaAceiteDto,
    nullable: true,
    description: 'null quando o termo vigente já foi aceito.',
  })
  termo!: TextoParaAceiteDto | null;

  @ApiProperty({
    type: TextoParaAceiteDto,
    nullable: true,
    description:
      'null quando já aceito — ou quando o clube não publicou contrato nenhum (REQ-005).',
  })
  contrato!: TextoParaAceiteDto | null;
}

export class RegistrarAceiteDto {
  @ApiPropertyOptional({
    example: 1,
    description:
      'A versão do termo que a pessoa LEU. Exigida para que ninguém aceite "o que estiver valendo" — seria concordar com um texto que não viu.',
  })
  @IsOptional()
  @IsInt()
  termo?: number;

  @ApiPropertyOptional({
    example: 3,
    description: 'A versão do contrato do clube que a pessoa LEU.',
  })
  @IsOptional()
  @IsInt()
  contrato?: number;
}

export class ContratoDaEmpresaResponseDto {
  @ApiProperty({ type: Number, nullable: true, example: 3 })
  versao!: number | null;

  @ApiProperty({ type: String, nullable: true })
  texto!: string | null;

  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  publicadoEm!: Date | null;
}

export class PublicarContratoDto {
  @ApiProperty({ minLength: 1, maxLength: 50000 })
  @IsString()
  @MinLength(1)
  @MaxLength(50000)
  texto!: string;
}

/**
 * O estado depois do aceite.
 *
 * Devolve as versões em vigor na conta em vez de um `{ ok: true }`: a tela
 * precisa saber se ainda sobrou pendência (aceitar só o termo, com contrato
 * pendente, é um caminho real) e um booleano não responde isso.
 */
export class AceiteRegistradoResponseDto {
  @ApiProperty({ type: Number, nullable: true, example: 1 })
  termoVersaoAceita!: number | null;

  @ApiProperty({ type: Number, nullable: true, example: 3 })
  contratoVersaoAceita!: number | null;

  @ApiProperty({
    example: false,
    description: 'true quando ainda falta aceitar alguma coisa.',
  })
  aindaPendente!: boolean;
}

/** Ver a nota do topo: o código é o contrato; a mensagem é copy. */
export class ErroDeAceiteResponseDto {
  @ApiProperty({ example: 403 })
  statusCode!: number;

  @ApiProperty({ enum: ['ACEITE_PENDENTE', 'VERSAO_DESATUALIZADA'] })
  code!: string;

  @ApiProperty({
    example: 'Há termos pendentes de aceite (GET /me/aceites/pendentes).',
  })
  message!: string;
}
