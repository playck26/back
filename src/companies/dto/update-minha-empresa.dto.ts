import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, Min, ValidateIf } from 'class-validator';

/**
 * As configurações que o próprio clube muda em `PATCH /me/company`.
 *
 * **Nasceu como `UpdateAutoCadastroDto`, de campo único e obrigatório**
 * (DEF-004: `permiteAutoCadastro` era lida em dois lugares e escrita em
 * nenhum). A SPEC-023 acrescentou o segundo campo, e com dois campos o
 * obrigatório vira armadilha: quem quisesse mexer só no limite teria de
 * reenviar o auto-cadastro, e reenviar valor que não se quis mudar é como
 * se perde configuração sem ninguém perceber.
 *
 * Por isso os dois são opcionais e **pelo menos um é exigido** — corpo vazio
 * é engano de chamada, não "não mude nada".
 */
export class UpdateMinhaEmpresaDto {
  @ApiPropertyOptional({
    description:
      'Liga ou desliga o link público de auto-cadastro de alunos desta empresa.',
  })
  @IsOptional()
  @IsBoolean()
  permiteAutoCadastro?: boolean;

  @ApiPropertyOptional({
    nullable: true,
    minimum: 1,
    example: 2,
    description:
      'Quantas turmas um aluno pode entrar por conta própria. `null` = sem limite. Vale para ENTRAR, nunca para expulsar (INV-023a): baixar o limite não tira ninguém de turma em que já está.',
  })
  @IsOptional()
  // `ValidateIf` e não só `IsOptional`: `null` é um valor com significado
  // aqui ("sem limite"), e precisa passar. `IsOptional` sozinho deixaria
  // `null` passar sem validar, mas também deixaria passar quando não
  // deveria — a intenção fica explícita assim.
  @ValidateIf((_objeto, valor) => valor !== null)
  @IsInt()
  @Min(1, {
    message:
      'O limite começa em 1. Zero seria "ninguém entra", que é desligar a turma, não limitar — para isso existe desativar a turma.',
  })
  limiteTurmasPorAluno?: number | null;
}
