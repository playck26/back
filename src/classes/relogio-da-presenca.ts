import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

/**
 * SPEC-076/D11 — **um relógio só no portão da chamada.**
 *
 * O portão (`travarEValidarOcorrencia`) usava três: `clock_timestamp()` no SQL
 * para a janela da automática, `this.hoje()` para a retroativa, e o relógio
 * do Node em `aulaJaComecou`. Três relógios decidindo a mesma resposta tornam
 * a prova impossível — o teste não tem como pôr os três no mesmo instante — e
 * tornam o laço "registrar → desfazer → registrar" dependente de qual deles
 * andou.
 *
 * Agora o portão lê `agora` **uma vez**, depois da raiz, por este provedor, e
 * decide em TypeScript. Em produção ele é o relógio do banco
 * (`clock_timestamp()`, pela mesma transação); o db-spec o substitui por um
 * relógio controlado (AC-009). O instante do **fechamento** continua sendo o
 * do banco, gravado pelo worker: é ele que o gatilho `chamadas_fechamento_imutavel`
 * protege.
 */
@Injectable()
export class RelogioDaPresenca {
  async agora(db: Pick<Prisma.TransactionClient, '$queryRaw'>): Promise<Date> {
    const [linha] = await db.$queryRaw<{ agora: Date }[]>`
      SELECT clock_timestamp() AS agora
    `;
    return linha.agora;
  }
}
