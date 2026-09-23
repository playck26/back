import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { FUSO_DO_CLUBE, instanteNoFusoDoClube } from '../courts/date-time.util';

/**
 * SPEC-068/TASK-002 — **o aviso de nota baixa, e por que ele não é um gesto.**
 *
 * ## O precedente é o `lista_espera`, e as razões são três
 *
 * A SPEC-064 já tinha aberto este caminho: `tipo` próprio, fora da família
 * `gesto`. Aqui vale pelo mesmo motivo, multiplicado por três:
 *
 * 1. **é condicional** — só `nota <= 2` avisa, e a matriz de gestos decide
 *    público por tipo, não por valor;
 * 2. **o público é outro** — gestores, não a turma;
 * 3. **o extrato mentiria** — pôr avaliação no enum `TipoDeAcao` faria a
 *    auditoria de uma quadra registrar um gesto que nenhum gestor fez.
 *
 * ## A regra da faixa, e o que ela CALA de propósito
 *
 * Avisa na **entrada** na faixa: não havia avaliação, ou a anterior era
 * `>= 3`. Consequências, todas decisão de produto e não efeito colateral:
 * regravar a mesma nota não avisa; `5 → 1` avisa; **`1 → 2` e `2 → 1` não
 * reavisam** — é a mesma reclamação, do mesmo aluno, sobre a mesma aula, e o
 * gestor já foi chamado uma vez. Reavisar treina a ignorar o aviso.
 *
 * **Mas quem garante a unicidade não é esta regra** — é a UNIQUE parcial
 * `(origem_id, destinatario_id) WHERE tipo = 'avaliacao_baixa'`, com o CHECK
 * que a torna viva. A leitura do estado anterior é economia de trabalho; a
 * proteção mora no banco (D3). É isso que dispensa `Serializable`.
 *
 * ## O corpo não diz QUEM, e a URL também não
 *
 * A INV-063a não abre exceção: o corpo carrega nota, dia e hora — nada de
 * nome de aluno, nada do `comentario`. O *"qual aluno, qual aula"* que o card
 * pede é o botão **+info**, que é o `destino_url`: a tela da turma, onde o
 * gestor autenticado vê nome, nota e comentário por direito.
 *
 * **A URL é da TURMA, nunca da avaliação** (D7). Uma URL por avaliação seria o
 * identificador de volta pela porta lateral, dentro do payload que aparece na
 * tela bloqueada.
 */

/** O `tipo` da linha em `notificacoes`. Fora de `gesto`, e fora de `teste`. */
export const TIPO_AVALIACAO_BAIXA = 'avaliacao_baixa';

/**
 * O quinto valor da bandeja, ao lado de `Reservas`, `Sua aula`, `Sua turma` e
 * `Sua vez`. **Fora de `TITULOS_DE_GESTO` de propósito**: a AC-018 da SPEC-063
 * varre o vocabulário fechado de `tipo = 'gesto'`, e invariante que atropela o
 * vizinho é invariante que alguém desliga.
 */
export const TITULO_DA_AVALIACAO = 'Avaliações';

/**
 * A faixa que avisa. **Fechada dos dois lados sem esforço**: `nota` é `1..5`
 * por CHECK no banco (INV-025c), então `<= 2` não tem borda solta.
 */
export const NOTA_BAIXA_ATE = 2;

export interface FatosDaAvaliacao {
  /** A nota gravada, para o texto. */
  readonly nota: number;
  /** A turma, para a URL — **id, nunca nome**. */
  readonly turmaId: string;
  /** `data` da ocorrência avaliada, quando conhecida. */
  readonly data: Date | null;
  readonly horaInicio: Date | null;
}

export interface AvisoDeNotaBaixa {
  readonly titulo: string;
  readonly corpo: string;
  readonly destinoUrl: string;
}

/**
 * "quinta (19h)" — a mesma forma dos avisos de gesto e do chamado, de
 * propósito: três gramáticas de data na mesma bandeja é a pessoa tendo de
 * aprender três.
 */
function quando(data: Date, horaInicio: Date): string {
  const instante = instanteNoFusoDoClube(data, horaInicio);
  const dia = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    weekday: 'long',
  })
    .format(instante)
    .replace(/-feira$/, '');
  const [hh, mm] = new Intl.DateTimeFormat('pt-BR', {
    timeZone: FUSO_DO_CLUBE,
    hour: 'numeric',
    minute: '2-digit',
    hour12: false,
  })
    .format(instante)
    .split(':');
  return `${dia} (${mm === '00' ? `${hh}h` : `${hh}h${mm}`})`;
}

/** `true` quando a gravação **entra** na faixa baixa (D2). */
export function entrouNaFaixaBaixa(
  notaAnterior: number | null,
  notaNova: number,
): boolean {
  return notaNova <= NOTA_BAIXA_ATE && (notaAnterior ?? 5) > NOTA_BAIXA_ATE;
}

export function montarAvisoDeNotaBaixa(
  fatos: FatosDaAvaliacao,
): AvisoDeNotaBaixa {
  const estrelas = fatos.nota === 1 ? '1 estrela' : `${fatos.nota} estrelas`;
  const momento =
    fatos.data && fatos.horaInicio
      ? quando(fatos.data, fatos.horaInicio)
      : null;
  return {
    titulo: TITULO_DA_AVALIACAO,
    corpo: momento
      ? `Uma aula de ${momento} recebeu ${estrelas}`
      : `Uma aula recebeu ${estrelas}`,
    destinoUrl: `/turmas/${fatos.turmaId}`,
  };
}

/**
 * Grava um aviso **por gestor ativo**, dentro da transação da avaliação.
 *
 * ## Duas idas fixas, como o enfileirador de gestos
 *
 * Uma consulta resolve todos os destinatários; um `INSERT` grava todos. O
 * `DEF-013` conta idas ao banco dentro de transação, e ele proíbe **custo que
 * cresce com o dado** — dez gestores custam o mesmo que um.
 *
 * ## `DO NOTHING`, e não `DO UPDATE`
 *
 * O aviso de gesto é **resumo** e se reescreve quando o gesto ganha efeitos.
 * Este é **fato pontual**: a avaliação entrou na faixa, e isso já aconteceu.
 * Reescrever não teria o que dizer de novo.
 *
 * ## Dentro da transação, e o preço disso
 *
 * Se o `INSERT` falhar, a avaliação não fica gravada. É o INV-068j, e é
 * deliberado: aviso fora da transação criaria aviso de avaliação que não
 * existe. O risco aceito é o acoplamento — e a AC-016 prova que ele é
 * tudo-ou-nada de verdade.
 */
export async function enfileirarAvisoDeNotaBaixa(
  tx: Prisma.TransactionClient,
  dados: {
    companyId: string;
    /** O usuário que avaliou. Sai da lista, como em todo aviso do produto. */
    autorUsuarioId: string;
    /** **O `origem_id`**: id da avaliação, estável pela UNIQUE da tabela. */
    avaliacaoId: string;
    fatos: FatosDaAvaliacao;
  },
): Promise<number> {
  const gestores = await tx.$queryRaw<{ id: string }[]>`
    SELECT id FROM usuarios
     WHERE company_id = ${dados.companyId}::uuid
       AND role = 'company_admin'
       AND status = 'ativo'
       AND id IS DISTINCT FROM ${dados.autorUsuarioId}::uuid`;
  if (gestores.length === 0) {
    return 0;
  }

  const aviso = montarAvisoDeNotaBaixa(dados.fatos);
  const linhas = gestores.map(
    (g) => Prisma.sql`(${randomUUID()}::uuid, ${dados.companyId}::uuid,
                       ${g.id}::uuid, ${dados.avaliacaoId}::uuid,
                       ${TIPO_AVALIACAO_BAIXA}, ${aviso.titulo}, ${aviso.corpo},
                       ${aviso.destinoUrl})`,
  );

  return tx.$executeRaw`
    INSERT INTO notificacoes (id, company_id, destinatario_id, origem_id,
                              tipo, titulo, corpo, destino_url)
    VALUES ${Prisma.join(linhas)}
    ON CONFLICT (origem_id, destinatario_id) WHERE tipo = 'avaliacao_baixa'
    DO NOTHING`;
}
