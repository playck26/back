import { ConflictException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * SPEC-033/D7 — o fechamento das transações que mexem em carteira.
 *
 * ## Por que existe, e por que NOMEADO
 *
 * As invariantes que julgam o estado **completo** (INV-064, INV-096, INV-098)
 * são `CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`: elas só decidem no
 * `COMMIT`. E no `COMMIT` **natural** o Prisma entrega o erro como
 * `PrismaClientUnknownRequestError`, **sem `code` e sem `meta`** — só texto.
 * Discriminar por `includes` de string, em código de dinheiro, é retrocesso.
 *
 * Forçar o julgamento com `SET CONSTRAINTS … IMMEDIATE` como **última
 * instrução** traz o erro para dentro do escopo em que o Prisma ainda traduz:
 * chega como `P2010` + `meta.code` com o SQLSTATE customizado da trigger.
 *
 * **A lista é NOMEADA, não `ALL`.** Com `ALL`, qualquer constraint diferida
 * que uma spec futura criasse passaria a ser julgada aqui dentro sem ninguém
 * decidir isso. O custo da lista é real e foi medido: **nome que não existe
 * derruba a transação inteira com `42704`** — por isso a ordem
 * *migration antes do deploy* é carga desta decisão, e por isso a reversão
 * preserva as constraints em vez de derrubá-las.
 *
 * ## A posição, e o que ela de fato governa
 *
 * Não é que uma escrita posterior escape — não escapa; as constraints ficam
 * imediatas até o fim da transação. O que a posição governa é o **estado
 * intermediário**: posto cedo demais, o `SET CONSTRAINTS` rejeita um estado
 * que só é válido quando ocupação, evento e devolução existem **juntos**.
 * "Última instrução" é a convenção segura por ser o único ponto em que o
 * estado está completo.
 */
const NOMEADAS = [
  'ocupacao_cancelada_exige_evento', // INV-064, SPEC-032
  'ocupacao_cancelada_exige_devolucao', // INV-096
  'movimentos_consumo_ativo_unico', // INV-098
] as const;

/** Os SQLSTATE customizados que as duas triggers desta spec levantam. */
export const SQLSTATE_CANCELAMENTO_SEM_DEVOLUCAO = 'P3301';
export const SQLSTATE_CONSUMO_ATIVO_DUPLICADO = 'P3302';

/**
 * Fecha a transação forçando as três diferidas a julgarem AQUI.
 *
 * Tem de ser a **última** instrução do callback do `$transaction`.
 */
export async function julgarInvariantesDiferidas(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$executeRawUnsafe(
    `SET CONSTRAINTS ${NOMEADAS.join(', ')} IMMEDIATE`,
  );
}

/** O `meta.code` que o Prisma expõe quando o erro vem de raw query. */
function sqlstateDe(erro: unknown): string | undefined {
  const meta = (erro as { meta?: { code?: string; db_error_code?: string } })
    .meta;
  return meta?.code ?? meta?.db_error_code;
}

/**
 * Traduz a recusa da INV-096 em `409`, e deixa o resto subir.
 *
 * **Por que `409` e não `500`:** no `back` revertido (saída B do rollout) esta
 * trigger dispara **por desenho** — o código volta a não devolver crédito, e a
 * trigger recusa o cancelamento. Responder `500` transformaria a contingência
 * planejada em erro de servidor. Na fase 2 ela é inalcançável; se disparar, o
 * `409` continua sendo a resposta segura e o monitoramento acusa a anomalia.
 *
 * **Um limite declarado:** quando mais de uma diferida é violada na mesma
 * transação, chega **um** código só — o primeiro julgado. Medido. O serviço
 * não pode supor que o código nomeia a única causa; ele nomeia a primeira.
 * Para o HTTP dá no mesmo, porque as duas são `409`.
 */
export function traduzirRecusaDeCancelamento(erro: unknown): never {
  const traducao = POR_SQLSTATE[sqlstateDe(erro) ?? ''];
  if (traducao) {
    throw new ConflictException({ statusCode: 409, ...traducao });
  }
  if (ehDevolucaoRepetida(erro)) {
    throw new ConflictException({
      statusCode: 409,
      code: 'DEVOLUCAO_JA_FEITA',
      message: 'O crédito desta reserva já foi devolvido.',
    });
  }
  throw erro;
}

/**
 * O índice parcial `ux_movimentos_devolucao_por_consumo`, violado.
 *
 * **A primeira versão deste conserto casava `23505` e NUNCA teria disparado.**
 * `23505` é o SQLSTATE do Postgres — verdade no banco, e é o que a tabela da
 * spec registra —, mas a devolução é inserida pelo CLIENT do Prisma, não por
 * raw: o erro chega como `P2002` com `meta.target`, e `meta.code` nem existe.
 * Medido antes de embarcar:
 *
 *     {classe: PrismaClientKnownRequestError, code: P2002,
 *      meta: {modelName: MovimentoDeCredito, target: [movimento_origem_id]}}
 *
 * Casar pela COLUNA e não pelo nome do índice é deliberado: `meta.target` traz
 * as colunas, não o nome — e `movimento_origem_id` só tem um índice único.
 */
function ehDevolucaoRepetida(erro: unknown): boolean {
  const e = erro as { code?: string; meta?: { target?: unknown } };
  if (e.code !== 'P2002') return false;
  const alvo = e.meta?.target;
  return Array.isArray(alvo) && alvo.includes('movimento_origem_id');
}

/**
 * **Um código por MECANISMO, e não um só para todos — DEF de 2026-09-09.**
 *
 * A tabela normativa da spec dá três destinos distintos, e o código dava um só
 * (`CANCELAMENTO_CARTEIRA_INDISPONIVEL` para os dois SQLSTATE) e **nenhum**
 * para o `23505` do índice parcial — que subia cru, virando `500` numa recusa
 * que a norma declara como `409`.
 *
 * Quem achou foi o `Docs/contrato-spec-x-codigo.py`: a spec prometia
 * `DEVOLUCAO_JA_FEITA` e `CONSUMO_JA_ATIVO`, e nenhum dos dois existia no
 * código. Quem escrevesse o frontend tratando esses códigos escreveria um ramo
 * morto.
 *
 * Nenhum frontend tratava o código antigo (medido: zero ocorrências nos três),
 * então a troca não quebra tela nenhuma.
 */
const POR_SQLSTATE: Record<string, { code: string; message: string }> = {
  [SQLSTATE_CANCELAMENTO_SEM_DEVOLUCAO]: {
    code: 'CANCELAMENTO_CARTEIRA_INDISPONIVEL',
    message:
      'Não foi possível concluir o cancelamento porque a devolução do crédito não pôde ser registrada.',
  },
  [SQLSTATE_CONSUMO_ATIVO_DUPLICADO]: {
    code: 'CONSUMO_JA_ATIVO',
    message: 'Esta reserva já tem um consumo de crédito ativo.',
  },
};
