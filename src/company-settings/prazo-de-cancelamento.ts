/**
 * SPEC-031/TASK-001 — **a política de prazo, e ela é pura.**
 *
 * Nada aqui toca banco, relógio ou HTTP: recebe o estado já apurado e devolve
 * a decisão. É de propósito — a regra é a mesma para o aluno que sai da turma
 * e para quem cancela reserva, e política que mora dentro de um serviço só
 * vale para esse serviço.
 *
 * ## As duas ausências são TIPO, não número (D5)
 *
 * "Sem prazo configurado" e "não há próxima ocorrência" são estados, não
 * zeros. A primeira correção desta spec blindou o prazo e deixou o outro lado
 * cru — daí os **dois** tipos soma. Com `number | null` dos dois lados,
 * `prazo ?? 0` e `Number(prazo)` compilam (medido com o `tsc` deste projeto,
 * `strictNullChecks: true`), e um deles vira "prazo zero" em silêncio.
 *
 * ## Depois que a aula começou, ninguém cancela (D5b)
 *
 * Nem sem prazo configurado, **nem o gestor**. Isso muda o comportamento de
 * hoje: `cancelBooking` não tem validação temporal nenhuma. A razão só existe
 * agora que a SPEC-033 vem: cancelar uma quadra que já foi usada e receber o
 * dinheiro de volta é abuso.
 *
 * `SEM_PRAZO` significa "sem antecedência mínima", **não** "sem limite".
 */

/** O que o clube exige de antecedência. Ausência é `SEM_PRAZO`, nunca `0`. */
export type PrazoDeCancelamento =
  | { readonly regra: 'SEM_PRAZO' }
  | { readonly regra: 'HORAS'; readonly horas: number };

/** "Não há próxima ocorrência" também não tem número. */
export type Antecedencia =
  | { readonly tipo: 'SEM_OCORRENCIA' }
  | { readonly tipo: 'MINUTOS'; readonly minutos: number };

/** Papéis que chegam à política. O gestor é **valor**, não exceção (D12). */
export type PapelDoAutor = 'aluno' | 'company_admin';

export const CODIGO_PRAZO = 'PRAZO_DE_CANCELAMENTO' as const;

/**
 * Cabe cancelar, dada a antecedência que sobrou?
 *
 * A ordem dos três testes é normativa:
 *
 * 1. **`SEM_OCORRENCIA` permite** (AC-010) — sem aula à frente não há
 *    professor contando com o aluno, e o prazo não tem sobre o que incidir.
 *    Não confundir com o item 2: aqui não existe aula alguma; lá ela existe e
 *    já começou.
 * 2. **`minutos <= 0` recusa** (AC-010b, D5b) — e recusa **antes** de olhar o
 *    prazo, que é o que faz a regra valer também para `SEM_PRAZO`.
 * 3. só então o prazo do clube.
 *
 * **Exatamente no limite, permite** (AC-009/D6): prazo de 2h com a aula às
 * 19h00 e agora 17h00 dá `minutos = 120`, e `120 >= 120`.
 */
export function podeCancelar(
  prazo: PrazoDeCancelamento,
  a: Antecedencia,
): boolean {
  if (a.tipo === 'SEM_OCORRENCIA') return true;
  if (a.minutos <= 0) return false;
  switch (prazo.regra) {
    case 'SEM_PRAZO':
      return true;
    case 'HORAS':
      return a.minutos >= prazo.horas * 60;
    default: {
      const _exaustivo: never = prazo;
      return _exaustivo;
    }
  }
}

/**
 * A ÚNICA tradução de `number | null` para o tipo soma.
 *
 * Existe como função, e num lugar só, porque o buraco que o D5 fechou não é
 * de tipo — é de aritmética: `prazo ?? 0` e `Number(prazo)` **compilam** neste
 * projeto (`strictNullChecks: true`, `strict` ausente), e os dois produzem
 * "prazo de zero horas", que `podeCancelar` trata como permitir sempre. Com a
 * conversão espalhada, bastaria um serviço esquecer.
 *
 * O banco garante o outro lado: `CHECK (IS NULL OR >= 1)` nas duas colunas.
 * Se um zero chegasse aqui mesmo assim, ele viraria `HORAS 0` e a política o
 * trataria como "sem antecedência" — por isso o zero é proibido na origem, e
 * não interpretado (D4).
 */
export function prazoDe(horas: number | null): PrazoDeCancelamento {
  return horas === null ? { regra: 'SEM_PRAZO' } : { regra: 'HORAS', horas };
}

export interface EntradaDeSaidaDeTurma {
  readonly papelDoAutor: PapelDoAutor;
  /**
   * Injetado, **nunca `new Date()` aqui**. A política não lê relógio: quem
   * apura `ocorrenciaRelevante` já usou este instante, e recebê-lo mantém a
   * decisão reproduzível num teste.
   */
  readonly agora: Date;
  readonly ocorrenciaRelevante: Antecedencia;
  readonly prazo: PrazoDeCancelamento;
}

export type VeredictoDeSaida =
  | { readonly permitido: true }
  | { readonly permitido: false; readonly code: typeof CODIGO_PRAZO };

/**
 * O ponto de entrada único (D12) — **e o gestor passa por aqui, não em volta.**
 *
 * ## INV-066, e por que ele é um `SEM_PRAZO` e não um `if`
 *
 * O caminho administrativo chama `podeCancelar` com `{ regra: 'SEM_PRAZO' }`
 * e **não pula a função**. Assim ele herda a recusa de `minutos <= 0`
 * (AC-010b) sem herdar a antecedência do clube (AC-013).
 *
 * A v2 desta spec dizia "o gestor nunca é barrado por prazo" **e** mandava
 * não chamar a função. As duas coisas juntas deixavam o gestor cancelar aula
 * já iniciada — e, com a SPEC-033, devolver crédito por quadra usada.
 *
 * Um `if (papel === 'aluno')` dentro do serviço do aluno seria a falácia do
 * *"garantido por não existir rota"*, que este projeto já reprovou duas
 * vezes: no dia em que aparecer um terceiro caminho, ele não passa pela
 * regra.
 */
export function avaliarSaidaDeTurma(
  entrada: EntradaDeSaidaDeTurma,
): VeredictoDeSaida {
  return avaliar(entrada);
}

/**
 * SPEC-031/D17 — **o AC-013 tem DOIS verbos**, e este é o segundo.
 *
 * A v3 da spec fechou "remover da turma" e seguiu afirmando o AC-013 inteiro,
 * que fala de *cancelar e desmatricular*. O segundo verbo continuava aberto, e
 * a guarda de hoje é literalmente condicional ao aluno — `alunoIdScope`
 * funcionando como papel administrativo **por omissão e sem nome**.
 *
 * Delega ao mesmo `avaliar`: o INV-066 é implementado **uma vez**. Dois nomes
 * porque os dois caminhos são chamados de lugares diferentes e a assinatura
 * documenta qual prazo cada um usa — o da aula ou o da reserva.
 */
export function avaliarCancelamentoDeReserva(
  entrada: EntradaDeSaidaDeTurma,
): VeredictoDeSaida {
  return avaliar(entrada);
}

/** O mecanismo, num lugar só. Ver o docstring de `avaliarSaidaDeTurma`. */
function avaliar(entrada: EntradaDeSaidaDeTurma): VeredictoDeSaida {
  const prazoEfetivo: PrazoDeCancelamento =
    entrada.papelDoAutor === 'company_admin'
      ? { regra: 'SEM_PRAZO' }
      : entrada.prazo;

  return podeCancelar(prazoEfetivo, entrada.ocorrenciaRelevante)
    ? { permitido: true }
    : { permitido: false, code: CODIGO_PRAZO };
}
