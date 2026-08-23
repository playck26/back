import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * DEF-004 — o interruptor que a SPEC-009/REQ-006 prometeu e nunca existiu.
 *
 * `permiteAutoCadastro` era lida em dois lugares (o link público e o
 * `register-aluno`) e **escrita em nenhum**: a empresa "decidia" sobre uma
 * coisa que ficava congelada no default `true`.
 */
export class UpdateAutoCadastroDto {
  @ApiProperty({
    description:
      'Liga ou desliga o link público de auto-cadastro de alunos desta empresa.',
  })
  @IsBoolean()
  permiteAutoCadastro!: boolean;
}
