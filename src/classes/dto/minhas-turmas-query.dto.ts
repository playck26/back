import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * SPEC-056/D1 — **o índice do professor só traz turma inativa quando pedem.**
 *
 * Sem o parâmetro, a resposta é a de antes da spec. Um Cliente anterior a ela,
 * com o padrão alargado, mostraria turma inativa como se fosse ativa — o DTO
 * dele não tem `status`.
 */
export class MinhasTurmasQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Inclui as turmas INATIVAS do professor com alguma aula nos últimos 90 ' +
      'dias ou no futuro (SPEC-056/D2). Sem o parâmetro, só as ativas.',
  })
  @IsOptional()
  // **NÃO `@Type(() => Boolean)`**: `Boolean('false')` é `true`. O mesmo
  // cuidado de `ListBookingsQueryDto.excluirCanceladas`.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  incluirInativas?: boolean;
}
