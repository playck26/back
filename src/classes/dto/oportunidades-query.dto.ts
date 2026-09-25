import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional } from 'class-validator';

/**
 * SPEC-064/TASK-007 — **a oportunidade sem vaga só vem quando pedem.**
 *
 * ## Por que um parâmetro, e não trocar o que a rota devolve
 *
 * O card 5331 pede que o aluno *"encontre turma/aula para repor, mas não tem
 * vaga"* e possa deixar o aviso de interesse. Hoje ele **nunca encontra**: a
 * lista termina em `.filter((o) => o.vagas > 0)`, e a aula cheia é descartada
 * antes de chegar à tela — sem ela na tela, não há onde clicar para entrar na
 * fila, e é por isso que `entrarNaFilaDeAula` existe no cliente sem nenhum
 * componente que a chame.
 *
 * **Alargar o padrão seria regressão em produção.** O Cliente que está no ar
 * desenha um botão "Marcar" para cada item que recebe; passar a mandar itens
 * com `vagas: 0` faria esse botão aparecer numa aula cheia, e o toque levaria
 * um `409 TURMA_SEM_VAGA`. E o `back` sobe **antes** do `cliente` (regra do
 * rollout), então a janela ruim existiria de verdade.
 *
 * Com o parâmetro, **o contrato cresce e nada muda para quem não pediu** — é a
 * mesma escolha da `MinhasTurmasQueryDto` da SPEC-056, pelo mesmo motivo.
 */
export class OportunidadesQueryDto {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Inclui as ocorrencias SEM VAGA (`vagas: 0`), para o aluno poder ' +
      'entrar na fila de espera delas (card 5331). Sem o parametro, so as ' +
      'que tem vaga — o comportamento de antes desta task.',
  })
  @IsOptional()
  // **NAO `@Type(() => Boolean)`**: `Boolean('false')` e `true`, e o filtro
  // ligaria justamente quando alguem pedisse para desliga-lo. Mesmo cuidado
  // da `MinhasTurmasQueryDto` e da `ListBookingsQueryDto`.
  @Transform(({ value }) => value === true || value === 'true')
  @IsBoolean()
  incluirSemVaga?: boolean;
}
