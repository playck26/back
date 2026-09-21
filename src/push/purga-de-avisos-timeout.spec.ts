/**
 * SPEC-065 — **o teto da transação do lote, e o orçamento do ciclo, têm de ser
 * o mesmo número.**
 *
 * ## Este arquivo nasceu de um CI vermelho que não era da spec que o derrubou
 *
 * A CI da SPEC-064/TASK-002 reprovou o `build` com:
 *
 * ```text
 * Transaction already closed: A query cannot be executed on an expired
 * transaction. The timeout for this transaction was 5000 ms, however 5990 ms
 * passed since the start of the transaction.
 * ```
 *
 * O `apagarUmLote` abria `$transaction` **sem `timeout`**, e o padrão do Prisma
 * para transação interativa é **5 s**. Enquanto isso, o `ORCAMENTO_DO_CICLO_MS`
 * declarava **30 s**.
 *
 * **As duas constantes se contradiziam, e o efeito não era "apagar menos": era
 * o ciclo inteiro estourar.** Um lote que passasse de 5 s voltava atrás
 * completo e a exceção subia — a purga simplesmente não acontecia naquele dia.
 *
 * ## Por que um teste de opção, e não um de tempo
 *
 * Um teste que medisse duração seria a mesma loteria que causou o defeito:
 * nesta máquina o lote de 5.000 linhas leva **20 ms**, na CI levou **5990**.
 * O que está em julgamento não é o tempo — é a **coerência entre os dois
 * números**, que é verificável sem relógio.
 */
import {
  PurgaDeAvisosService,
  ORCAMENTO_DO_CICLO_MS,
} from './purga-de-avisos.service';
import type { PrismaService } from '../prisma/prisma.service';

describe('SPEC-065 — o lote não pode ter teto menor que o ciclo', () => {
  it('a transação do lote recebe `timeout` explícito, igual ao orçamento do ciclo', async () => {
    const opcoesRecebidas: unknown[] = [];

    const prisma = {
      $transaction: (
        callback: (tx: unknown) => Promise<unknown>,
        opcoes?: unknown,
      ) => {
        opcoesRecebidas.push(opcoes);
        // O lock responde "ocupado", o que faz o ciclo desistir no primeiro
        // lote — basta para observar as opções da transação.
        return callback({
          $queryRaw: () => Promise.resolve([{ tomou: false }]),
        });
      },
      $queryRaw: () => Promise.resolve([{ n: 0n }]),
    } as unknown as PrismaService;

    await new PurgaDeAvisosService(prisma).executarCiclo();

    expect(opcoesRecebidas).toHaveLength(1);
    // **`undefined` aqui é o defeito**: significa o padrão de 5 s de volta.
    expect(opcoesRecebidas[0]).toEqual({
      timeout: ORCAMENTO_DO_CICLO_MS,
      maxWait: ORCAMENTO_DO_CICLO_MS,
    });
  });

  it('o orçamento do ciclo continua sendo 30 s — se mudar, o teto do lote muda junto', () => {
    // O ponto do teste anterior é a IGUALDADE entre os dois. Este fixa o valor
    // para que mudá-lo seja uma decisão visível, e não um efeito colateral.
    expect(ORCAMENTO_DO_CICLO_MS).toBe(30_000);
  });
});
