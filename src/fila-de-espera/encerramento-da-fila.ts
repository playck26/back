import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  montarAvisoDeFilaEncerrada,
  TIPO_LISTA_ESPERA,
} from './aviso-do-chamado';

/**
 * SPEC-064/D6/TASK-004 — **os sete caminhos em que a fila termina.**
 *
 * | Evento terminal | Onde acontece | Avisa? |
 * |---|---|---|
 * | ocorrência cancelada / reativada | `classes.service.ts` | **sim** (AC-008) |
 * | turma inativada / reativada | `PATCH` da turma | **sim** |
 * | aluno sai da turma | `classes.service.ts`, `matricula-do-aluno.service.ts` | não |
 * | aluno perde vínculo / conta inativa | `people` | **não** (AC-010) |
 * | **falta retirada** | `falta-avisada.service.ts` | não — **e ANTES do `deleteMany`** |
 * | crédito consumido por outro caminho | `reposicao.service.ts` | não |
 * | prazo vencido | varredor (TASK-003) | não |
 *
 * **São sete, e a retirada da falta é o que a SPEC-061/v4 esquecera.**
 *
 * ## Por que uma função que recebe o `tx`, e não um serviço que abre transação
 *
 * O encerramento tem de comitar **com o gesto que o causou**. Uma transação
 * própria deixaria a janela em que a aula já está cancelada e a fila ainda
 * chama gente para ela — e o varredor (que roda a cada minuto) usaria essa
 * janela.
 *
 * ## A `lista_de_espera` é o NÍVEL 4, e estas escritas vêm por último
 *
 * Quem chama já está com `turmas` (1), talvez `alunos` (2) e
 * `ocupacoes_quadra` (3) na mão. Escrever a fila antes de qualquer um deles
 * inverteria a ordem canônica — foi o segundo bloqueio da 1ª rodada de
 * validação, e o motivo de a tabela ter nascido no fim da ordem.
 *
 * ## `updateMany` e não laço
 *
 * O DEF-013 conta **idas ao banco** dentro da transação do gesto. Um laço por
 * linha da fila faria o custo do cancelamento de uma aula depender de quantas
 * pessoas estavam esperando por ela. Aqui são duas idas fixas: uma para saber
 * quem estava `chamado` (só para avisar), outra para encerrar.
 */

/** Os motivos, escritos uma vez. Eles vão para `motivo_fim` e são o que alguém
 *  vai ler meses depois tentando entender por que a fila daquela pessoa
 *  terminou. */
export const MOTIVO = {
  AULA_CANCELADA: 'aula cancelada',
  TURMA_INATIVADA: 'turma inativada',
  SAIU_DA_TURMA: 'saiu da turma',
  SEM_VINCULO: 'sem vinculo',
  FALTA_RETIRADA: 'falta retirada',
  CREDITO_CONSUMIDO: 'credito consumido',
} as const;

export type MotivoDeEncerramento = (typeof MOTIVO)[keyof typeof MOTIVO];

/** O recorte do que encerrar. Exatamente um campo, como o `CHECK` da tabela. */
export interface AlvoDoEncerramento {
  /** Tudo o que espera por esta turma. */
  turmaId?: string;
  /** Tudo o que espera por esta ocorrência. */
  ocupacaoId?: string;
  /** Várias ocorrências de uma vez — o cancelamento em massa do
   *  horário da turma. **Uma ida ao banco, não N** (DEF-013). */
  ocupacaoIds?: readonly string[];
  /** Tudo o que este aluno espera — em qualquer alvo. */
  alunoId?: string;
  /** As linhas que usam este crédito. */
  faltaId?: string;
  /** Só a fila desta turma, e só deste aluno (quando ele sai dela). */
  turmaEAluno?: { turmaId: string; alunoId: string };
}

export interface ResultadoDoEncerramento {
  encerradas: number;
  /** Quem estava **chamado** — os únicos que merecem aviso, e só nos casos em
   *  que o ALVO morreu (AC-008). Quem perdeu o vínculo não é avisado (AC-010). */
  chamados: { id: string; usuarioId: string; turmaId: string | null }[];
}

function condicao(alvo: AlvoDoEncerramento): Prisma.Sql {
  if (alvo.turmaId) return Prisma.sql`f.turma_id = ${alvo.turmaId}::uuid`;
  if (alvo.ocupacaoId)
    return Prisma.sql`f.ocupacao_id = ${alvo.ocupacaoId}::uuid`;
  if (alvo.ocupacaoIds) {
    // Lista vazia vira `false`, e NÃO um `IN ()` inválido: cancelar zero
    // ocorrências encerra zero filas, e isso tem de ser dizível.
    if (alvo.ocupacaoIds.length === 0) return Prisma.sql`false`;
    return Prisma.sql`f.ocupacao_id IN (${Prisma.join(
      alvo.ocupacaoIds.map((id) => Prisma.sql`${id}::uuid`),
    )})`;
  }
  if (alvo.alunoId) return Prisma.sql`f.aluno_id = ${alvo.alunoId}::uuid`;
  if (alvo.faltaId) return Prisma.sql`f.falta_id = ${alvo.faltaId}::uuid`;
  if (alvo.turmaEAluno)
    return Prisma.sql`f.turma_id = ${alvo.turmaEAluno.turmaId}::uuid
                  AND f.aluno_id = ${alvo.turmaEAluno.alunoId}::uuid`;
  // **Falha fechada.** Um alvo vazio encerraria a fila da empresa inteira, e
  // esse é o tipo de engano que só aparece em produção.
  throw new Error('SPEC-064: encerrarFila sem alvo');
}

/**
 * Encerra as linhas ativas do alvo, **dentro da transação de quem chama**.
 *
 * @returns quantas encerrou e quem estava `chamado` (para avisar, se o caso
 *   pedir).
 */
export async function encerrarFila(
  tx: Prisma.TransactionClient,
  companyId: string,
  alvo: AlvoDoEncerramento,
  motivo: MotivoDeEncerramento,
): Promise<ResultadoDoEncerramento> {
  const onde = condicao(alvo);

  // Quem estava chamado, ANTES de encerrar — depois a informação some.
  const chamados = await tx.$queryRaw<
    { id: string; usuarioId: string; turmaId: string | null }[]
  >`
    SELECT f.id, a.usuario_id AS "usuarioId", f.turma_id AS "turmaId"
      FROM lista_de_espera f
      JOIN alunos a ON a.id = f.aluno_id AND a.company_id = f.company_id
     WHERE f.company_id = ${companyId}::uuid
       AND f.estado = 'chamado'
       AND ${onde}`;

  const encerradas = await tx.$executeRaw`
    UPDATE lista_de_espera f
       SET estado = 'encerrada', concluida_em = now(), motivo_fim = ${motivo}
     WHERE f.company_id = ${companyId}::uuid
       AND f.estado IN ('aguardando', 'chamado')
       AND ${onde}`;

  return { encerradas, chamados };
}

/**
 * AC-008 — **quem estava chamado e perdeu o alvo é avisado.**
 *
 * Só nos casos em que o **alvo** morreu. Quem perdeu o vínculo não recebe nada
 * (AC-010): a conta dele está saindo do ar, e um aviso que ele não vai ler
 * seria ruído no relatório de entrega.
 *
 * **Na mesma transação do gesto**, como todo aviso desta família: aviso sobre
 * gesto que voltou atrás é pior que aviso nenhum.
 */
export async function avisarChamadosQuePerderamOAlvo(
  tx: Prisma.TransactionClient,
  companyId: string,
  chamados: ResultadoDoEncerramento['chamados'],
  motivo: MotivoDeEncerramento,
): Promise<number> {
  if (chamados.length === 0) return 0;

  const linhas = chamados.map((c) => {
    const aviso = montarAvisoDeFilaEncerrada(motivo, c.turmaId);
    return Prisma.sql`(${randomUUID()}::uuid, ${companyId}::uuid,
                       ${c.usuarioId}::uuid, ${c.id}::uuid, ${TIPO_LISTA_ESPERA},
                       ${aviso.titulo}, ${aviso.corpo}, ${aviso.destinoUrl})`;
  });

  // **Uma ida só**, qualquer que seja o tamanho da fila — DEF-013 conta idas.
  return tx.$executeRaw`
    INSERT INTO notificacoes
      (id, company_id, destinatario_id, origem_id, tipo, titulo, corpo, destino_url)
    VALUES ${Prisma.join(linhas)}`;
}
