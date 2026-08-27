import { UnprocessableEntityException } from '@nestjs/common';

/**
 * SPEC-019/TASK-002 — a regra dos encontros de uma turma, escrita **uma vez**.
 *
 * Criar e editar precisam da mesma validação, e duas cópias divergiriam no
 * primeiro ajuste — o mesmo motivo que fez a SPEC-020 pôr a regra dos
 * catálogos numa base compartilhada.
 *
 * ## O que este módulo garante, e o que ele NÃO garante
 *
 * Ele garante a forma da recorrência: pelo menos um encontro, cada um com fim
 * depois do início, e nenhum par sobreposto **entre si**.
 *
 * Ele **não** garante que os encontros caibam na agenda da quadra. Quem faz
 * isso é o `EXCLUDE` `no_overlap_por_quadra` de `ocupacoes_quadra`, e é ele a
 * autoridade final — inclusive sobre os encontros desta mesma turma, porque
 * ele não sabe de qual turma vem cada ocupação.
 *
 * **Então por que validar sobreposição aqui, se o banco já pega?** Pela
 * mensagem. Sem esta validação, "terça 18h–19h" e "terça 18h30–19h30" na
 * mesma turma chegariam à `EXCLUDE` e voltariam como *"conflito com ocupação
 * existente"* — verdade técnica, mentira útil: não existe ocupação existente,
 * existe uma turma que colide consigo mesma. O gestor procuraria a reserva
 * fantasma.
 */

export interface EncontroDaTurma {
  diaSemana: number;
  horaInicio: string;
  horaFim: string;
}

export const TURMA_SEM_ENCONTRO = 'TURMA_SEM_ENCONTRO';
export const ENCONTRO_HORARIO_INVALIDO = 'ENCONTRO_HORARIO_INVALIDO';
export const ENCONTROS_SOBREPOSTOS = 'ENCONTROS_SOBREPOSTOS';

/**
 * Dois encontros do mesmo dia se sobrepõem?
 *
 * **Semiaberto**, `[início, fim)`: `08:00–09:00` e `09:00–10:00` **não** se
 * sobrepõem. É a mesma semântica que `ocupacoes_quadra` usa para conflito
 * (REQ-010 da SPEC-010), e usar outra aqui faria a API recusar um par que o
 * banco aceitaria — ou pior, aceitar um que ele recusa.
 *
 * Compara string `HH:mm` direto: nesse formato a ordem lexicográfica é a
 * ordem cronológica, e converter para `Date` só para comparar introduziria
 * fuso onde não há.
 */
function seSobrepoem(a: EncontroDaTurma, b: EncontroDaTurma): boolean {
  if (a.diaSemana !== b.diaSemana) {
    return false;
  }
  return a.horaInicio < b.horaFim && b.horaInicio < a.horaFim;
}

/**
 * Valida a lista inteira e lança no primeiro problema, **dizendo qual
 * encontro**.
 *
 * O índice na mensagem não é detalhe: uma turma de quatro encontros que
 * recebe *"horaFim precisa ser depois de horaInicio"* manda o gestor conferir
 * os quatro. Com o índice, ele vai direto.
 *
 * **A recusa é sempre da turma inteira** (AC-005/AC-006). Aceitar os
 * encontros válidos e descartar o inválido criaria uma turma que não é a que
 * a pessoa pediu, sem ela saber.
 */
export function validarEncontros(encontros: EncontroDaTurma[]): void {
  if (encontros.length === 0) {
    // INV-051. **Quem garante é isto aqui, não o banco** — Postgres não
    // expressa "pai com pelo menos um filho" sem trigger, e o projeto tem
    // zero. Está declarado na spec em vez de prometido.
    throw new UnprocessableEntityException({
      code: TURMA_SEM_ENCONTRO,
      message: 'Uma turma precisa de pelo menos um encontro semanal.',
    });
  }

  for (const [indice, encontro] of encontros.entries()) {
    if (encontro.horaFim <= encontro.horaInicio) {
      throw new UnprocessableEntityException({
        code: ENCONTRO_HORARIO_INVALIDO,
        message: `O encontro ${indice + 1} termina antes de começar.`,
        encontro: indice,
      });
    }
  }

  for (let i = 0; i < encontros.length; i++) {
    for (let j = i + 1; j < encontros.length; j++) {
      if (seSobrepoem(encontros[i], encontros[j])) {
        throw new UnprocessableEntityException({
          code: ENCONTROS_SOBREPOSTOS,
          message: `Os encontros ${i + 1} e ${j + 1} se sobrepõem.`,
          encontros: [i, j],
        });
      }
    }
  }
}
