import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional } from 'class-validator';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';
import { CamposDoCadastroDto } from './campos-do-cadastro.dto';

/**
 * O DTO do GESTOR. **Estende os sete campos do cadastro** e acrescenta o que
 * so ele pode mexer: `nivelId` e `status`.
 *
 * `nome` e `telefone` sairam daqui e vivem no pai — eram identicos, e duas
 * copias divergem no primeiro ajuste.
 *
 * A heranca e na direcao certa (SPEC-036/D7): o DTO do ALUNO
 * (`CamposDoCadastroDto`) e o menor, e o do gestor cresce a partir dele. O
 * contrario — um DTO so, com o papel decidindo quais campos valem — foi
 * recusado: campos que ora valem ora nao e como nasce escalada de privilegio,
 * porque basta alguem esquecer o `if` numa rota.
 */
export class UpdateStudentDto extends CamposDoCadastroDto {
  @ApiPropertyOptional()
  @IsOptional()
  @UuidNoCorpo()
  nivelId?: string;

  @ApiPropertyOptional({ enum: ['ativo', 'inativo'] })
  @IsOptional()
  @IsIn(['ativo', 'inativo'])
  status?: 'ativo' | 'inativo';
}
