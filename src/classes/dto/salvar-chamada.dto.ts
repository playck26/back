import { ApiProperty } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayNotEmpty,
  IsArray,
  IsEnum,
  IsString,
  IsUUID,
  ValidateNested,
} from 'class-validator';

export class ItemChamadaDto {
  @ApiProperty()
  @IsUUID()
  alunoId!: string;

  @ApiProperty({ enum: ['presente', 'ausente', 'justificado'] })
  @IsEnum(['presente', 'ausente', 'justificado'])
  status!: 'presente' | 'ausente' | 'justificado';
}

export class SalvarChamadaDto {
  /**
   * SPEC-014/INV-019 — a versão que o aparelho leu. Sem ela, dois aparelhos
   * na mesma chamada se sobrescrevem em silêncio: o segundo salva o corpo
   * inteiro com a tela antiga e desfaz o que o primeiro marcou, sem querer
   * e sem perceber.
   */
  @ApiProperty({ example: '3:1756000000000' })
  @IsString()
  versao!: string;

  /**
   * A chamada **inteira**. `PUT` descreve o estado final da aula, o que
   * torna o reenvio inofensivo — e reenvio acontece: quadra tem sinal ruim
   * e gente com pressa toca duas vezes.
   */
  @ApiProperty({ type: [ItemChamadaDto] })
  @IsArray()
  @ArrayNotEmpty()
  @ArrayMaxSize(100)
  @ValidateNested({ each: true })
  @Type(() => ItemChamadaDto)
  itens!: ItemChamadaDto[];
}
