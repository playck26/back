import { ApiProperty } from '@nestjs/swagger';
import { UuidNoCorpo } from '../../common/validation/uuid-no-corpo.decorator';

/**
 * SPEC-046/AC-007 — o corpo de `POST /me/reposicoes`.
 *
 * **Os dois ids vem do cliente, e os dois sao conferidos contra o aluno do
 * TOKEN no servico.** `faltaId` precisa ser uma falta DELE (`alunoId` derivado
 * de `user.sub`), e `ocupacaoId` precisa ser da empresa dele. Sem as duas
 * conferencias, um id adivinhado usaria a falta de outra pessoa.
 *
 * Nao ha `alunoId` aqui de proposito: quem age e sempre o proprio aluno (D3), e
 * um campo de sujeito no corpo seria o convite para o gestor marcar em nome de
 * terceiro -- que a LIM-046e declara fora.
 *
 * **`@UuidNoCorpo()` e nao `@IsUUID()` cru**, e o gate
 * `uuid-no-corpo.gate.spec.ts` me reprovou por isso: ele exige o `Transform`
 * registrado junto, que normaliza para minusculas. Sem ele, o mesmo id em
 * maiusculas viraria um id diferente na comparacao com a coluna.
 */
export class MarcarReposicaoDto {
  @ApiProperty({
    format: 'uuid',
    description: 'A falta que este gesto consome.',
  })
  @UuidNoCorpo()
  faltaId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'A ocorrencia que ele vai frequentar.',
  })
  @UuidNoCorpo()
  ocupacaoId!: string;
}
