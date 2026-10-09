import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

/** SPEC-086 — `POST /auth/login/escolher`. */
export class EscolherEmpresaDto {
  /** O token de escolha devolvido no `409 ESCOLHA_DE_EMPRESA`. */
  @ApiProperty()
  @IsString()
  @MinLength(1)
  token!: string;

  @ApiProperty({ format: 'uuid' })
  @UuidNoCorpo()
  usuarioId!: string;
}
