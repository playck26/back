import { ApiProperty } from '@nestjs/swagger';
import { IsString, Length } from 'class-validator';

/**
 * SPEC-034/D7 — cancelar uma ocorrência exige **motivo**.
 *
 * O aluno vê a aula sumir da agenda e pergunta por quê; sem motivo o gestor
 * não tem o que responder três dias depois. `acoes_administrativas.motivo` já
 * existe e é anulável (SPEC-032), então isto não custa migration — custa uma
 * decisão, e ela está tomada.
 *
 * 3 a 280: menos que três é "ok"/"x", que não é motivo; 280 é o teto de um
 * campo que ninguém vai paginar.
 */
export class CancelarOcorrenciaDto {
  @ApiProperty({
    example: 'Quadra interditada para manutenção',
    minLength: 3,
    maxLength: 280,
  })
  @IsString()
  @Length(3, 280, { message: 'motivo deve ter de 3 a 280 caracteres' })
  motivo!: string;
}
