import { Injectable, Logger } from '@nestjs/common';
import { ChaveDeLock } from '../common/lock/chave-de-lock';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-065/TASK-002 — **a purga: a única coisa desta spec que apaga dado.**
 *
 * ## O quadro normativo é o da D12, e ele mora lá
 *
 * Cadência, teto e critério de parada são da **D12 da spec**, que é a fonte
 * única. Aqui ficam os valores que o código precisa, e o comentário diz de
 * onde vêm — **a v3 da spec foi reprovada por ter a mesma norma em quatro
 * lugares, três deles velhos.**
 *
 * ## Lotes curtos, e não um lote grande
 *
 * A v2 da spec mandava apagar 5.000 e desistir, para evitar transação longa.
 * Transação longa é problema real — mas a resposta certa nunca foi *um lote
 * grande e depois desistir*: é **muitos lotes curtos**, cada um com sua
 * transação e seu lock.
 *
 * Com mais de 5.000 elegíveis por dia, aquele desenho **nunca alcançava o
 * atraso**, e o sintoma só apareceria com a tabela já grande. Represa, não
 * teto.
 *
 * ## O que ela NUNCA apaga
 *
 * Linha **não terminal**, por mais velha que seja. Uma `pendente` de 90 dias
 * não deveria existir — o TTL máximo é 24 h — e, se existir, é defeito.
 * Apagá-la esconderia o defeito, então a purga **conta e registra**.
 */

/** D1 — 90 dias. **Constante, não `ENV`** (LIM-065g): mudar retenção é decisão
 * de produto com efeito irreversível, e um `ENV` convida a mudá-la sem
 * registro. */
export const RETENCAO_DIAS = 90;

/** D12 — cada lote é UMA transação. `DELETE` aberto seguraria linhas que a
 * fila de envio precisa ler. */
export const TETO_POR_LOTE = 5_000;

/** D12 — quanto um ciclo pode consumir antes de devolver o controle. */
export const ORCAMENTO_DO_CICLO_MS = 30_000;

/**
 * A chave do lock. **Uma, global, constante:** a purga não compete por linha,
 * compete consigo mesma rodando noutra réplica.
 *
 * Sai do `ChaveDeLock`, que se declara *"a única forma de calculá-lo"*
 * (INV-043 da SPEC-017) — e não de um `bigint` literal inventado. A razão está
 * escrita lá: colisão entre duas chaves é **inofensiva** (perde-se
 * paralelismo, não exatidão); o perigo é **dois trechos calculando `bigint`
 * diferente para a mesma string**, porque aí não há lock nenhum e nada falha
 * até o dia em que falha.
 */
export const CHAVE_DA_PURGA_DE_AVISOS = 'spec065:purga-de-avisos';

export interface ResultadoDaPurga {
  /** Quantas linhas foram apagadas neste ciclo. */
  apagadas: number;
  /** Quantos lotes o ciclo consumiu. */
  lotes: number;
  /** `true` quando o ciclo parou por tempo, e não por ter drenado. */
  esgotouOOrcamento: boolean;
  /**
   * Quantas continuam elegíveis. **Só é contado quando o orçamento acaba** —
   * é a única consulta cara do worker, e roda só no caso interessante.
   *
   * `restantes` subindo de hora em hora é o alarme de que a capacidade acabou.
   */
  restantes: number | null;
  /** Linhas velhas **não terminais**: defeito, e por isso não são apagadas. */
  naoTerminaisAntigas: number;
  /** `true` quando outra réplica estava com o lock. */
  lockOcupado: boolean;
  duracaoMs: number;
}

@Injectable()
export class PurgaDeAvisosService {
  private readonly logger = new Logger(PurgaDeAvisosService.name);

  constructor(private readonly prisma: PrismaService) {}

  async executarCiclo(
    agora: () => number = Date.now,
  ): Promise<ResultadoDaPurga> {
    const inicio = agora();
    const r: ResultadoDaPurga = {
      apagadas: 0,
      lotes: 0,
      esgotouOOrcamento: false,
      restantes: null,
      naoTerminaisAntigas: 0,
      lockOcupado: false,
      duracaoMs: 0,
    };

    for (;;) {
      if (agora() - inicio >= ORCAMENTO_DO_CICLO_MS) {
        r.esgotouOOrcamento = true;
        break;
      }

      const lote = await this.apagarUmLote();
      if (lote === null) {
        // Outra réplica está com o lock. **Desiste e tenta no ciclo seguinte,
        // uma hora depois** — nunca espera. O trabalho não é urgente.
        r.lockOcupado = true;
        break;
      }

      r.lotes += 1;
      r.apagadas += lote;
      // Lote incompleto = drenou. É o critério de parada.
      if (lote < TETO_POR_LOTE) {
        break;
      }
    }

    if (r.esgotouOOrcamento) {
      r.restantes = await this.contarElegiveis();
    }
    r.naoTerminaisAntigas = await this.contarNaoTerminaisAntigas();

    if (r.naoTerminaisAntigas > 0) {
      // **Não apaga, e grita.** Linha `pendente` com 90 dias é defeito do
      // tick, e apagá-la esconderia o defeito.
      this.logger.warn({
        evento: 'purga_de_avisos_nao_terminais_antigas',
        quantas: r.naoTerminaisAntigas,
      });
    }

    r.duracaoMs = agora() - inicio;
    return r;
  }

  /**
   * Um lote, numa transação. Devolve `null` quando o lock está ocupado.
   *
   * **`pg_try_advisory_xact_lock`, e não `pg_try_advisory_lock`** — escopo de
   * transação, e isto não é detalhe. O `advisory-lock.ts` da SPEC-017 registra
   * o porquê: lock de **sessão**, num pool de conexões, **envenena a conexão
   * para sempre** se um caminho de exceção pular o `unlock` — ela volta ao
   * pool segurando um lock que ninguém solta. Lock de transação solta no
   * commit **e no rollback**, inclusive no que ninguém escreveu.
   */
  private async apagarUmLote(): Promise<number | null> {
    return this.prisma.$transaction(
      async (tx) => {
        const lock = await tx.$queryRaw<{ tomou: boolean }[]>`
        SELECT pg_try_advisory_xact_lock(${ChaveDeLock.deTexto(
          CHAVE_DA_PURGA_DE_AVISOS,
        )}::bigint) AS tomou`;
        if (lock[0]?.tomou !== true) {
          return null;
        }

        // `WHERE id IN (SELECT ... LIMIT)` e não `DELETE` aberto: o teto tem de
        // estar DENTRO da transação, senão ela segura a tabela pelo tempo que
        // levar para apagar tudo.
        //
        // `concluida_em IS NOT NULL` é o predicado terminal — e ele é
        // equivalente a "estado terminal" por construção, pelo
        // `CHECK notificacoes_terminal_conclusao_chk` da SPEC-062.
        return tx.$executeRaw`
        DELETE FROM notificacoes
         WHERE id IN (
           SELECT id FROM notificacoes
            WHERE concluida_em IS NOT NULL
              AND criada_em < now() - ${`${RETENCAO_DIAS} days`}::interval
            LIMIT ${TETO_POR_LOTE}
         )`;
      },
      // **DUAS CONSTANTES QUE SE CONTRADIZIAM, e a CI da SPEC-064 achou.**
      //
      // Sem `timeout` explicito, o Prisma capa TODA `$transaction` interativa
      // em **5 s**. Entao o `ORCAMENTO_DO_CICLO_MS` de 30 s era inalcancavel:
      // qualquer lote que passasse de 5 s morria com
      // `Transaction already closed`, o lote inteiro voltava atras e o ciclo
      // estourava — nao "apagava menos", estourava.
      //
      // Nao era teorico: a CI mediu **5990 ms** num lote e derrubou a suite.
      // Aqui nesta maquina o mesmo lote de 5.000 linhas leva **20 ms** — o que
      // diz que o custo nao e do `DELETE`, e sim do ambiente (disco do runner,
      // fsync do WAL, concorrencia com a propria suite). **Um teto que depende
      // da maquina nao e teto, e uma loteria.**
      //
      // O teto passa a ser O MESMO numero do orcamento do ciclo: um lote pode
      // demorar no maximo o que o ciclo inteiro pode demorar, e o laco ja para
      // quando o orcamento acaba. Uma norma, um lugar — a 3a rodada de
      // validacao da propria SPEC-065 reprovou esta spec por ter "uma norma em
      // quatro lugares, tres divergindo".
      { timeout: ORCAMENTO_DO_CICLO_MS, maxWait: ORCAMENTO_DO_CICLO_MS },
    );
  }

  /** A consulta cara, e ela só roda quando há atraso. */
  private async contarElegiveis(): Promise<number> {
    const linhas = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM notificacoes
       WHERE concluida_em IS NOT NULL
         AND criada_em < now() - ${`${RETENCAO_DIAS} days`}::interval`;
    return Number(linhas[0]?.n ?? 0);
  }

  private async contarNaoTerminaisAntigas(): Promise<number> {
    const linhas = await this.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM notificacoes
       WHERE concluida_em IS NULL
         AND criada_em < now() - ${`${RETENCAO_DIAS} days`}::interval`;
    return Number(linhas[0]?.n ?? 0);
  }
}
