import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsEmail,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

export class UpdateTeacherDto {
  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MinLength(1)
  nome?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  telefone?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ enum: ['ativo', 'inativo'] })
  @IsOptional()
  @IsIn(['ativo', 'inativo'])
  status?: 'ativo' | 'inativo';

  /**
   * SPEC-047/AC-001 — o preco da aula particular DESTE professor, em reais.
   *
   * **`null` APAGA e volta a usar o padrao do clube**; ausente nao mexe. Sao
   * duas intencoes diferentes, e por isso e `ValidateIf` e nao `IsOptional`:
   * `null` precisa passar pela validacao, ausente nao.
   *
   * Zero nao passa. Zero e o valor que o ledger recusa, e a aula de graca
   * quebraria na cobranca depois de a tela dizer que deu certo.
   */
  @ApiPropertyOptional({
    type: Number,
    nullable: true,
    minimum: 0.01,
    example: 150,
  })
  @ValidateIf((_objeto, valor) => valor !== null && valor !== undefined)
  @IsNumber({ maxDecimalPlaces: 2 })
  @Min(0.01, {
    message:
      'O preco comeca em R$ 0,01. Para usar o padrao do clube, mande `null`.',
  })
  precoAula?: number | null;
}
