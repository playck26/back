import { Inject, Injectable, Logger } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { impressaoDaAssinatura } from './impressao-da-assinatura';
import {
  PORTA_DE_ENVIO,
  type DestinoDePush,
  type PortaDeEnvio,
  type ResultadoDeEnvio,
} from './porta-de-envio';

/** D4a — o lease. Curto o bastante para destravar, longo para caber num envio. */
export const LEASE_MS = 2 * 60 * 1000;
/** D4b — a terceira tentativa queimada encerra a linha. */
export const TENTATIVAS_NO_MAXIMO = 3;
/** D4b — espera crescente, em segundos, por tentativa já queimada. */
export const ESPERA_POR_TENTATIVA_S = [60, 300] as const;
/** D1a — sem `expira_em`, o TTL é de 24 h. */
export const TTL_PADRAO_S = 86_400;
/** Quanto tempo um ciclo pode consumir antes de devolver o controle. */
export const ORCAMENTO_DO_CICLO_MS = 50_000;

type EstadoTerminal =
  | 'aceita_pelo_servico'
  | 'sem_destino'
  | 'falha_definitiva'
  | 'falha_operacional';

interface LinhaReivindicada {
  id: string;
  company_id: string;
  destinatario_id: string;
  titulo: string;
  corpo: string;
  destino_url: string | null;
  expira_em: Date | null;
  tentativas: number;
}

export interface ResultadoDoTick {
  /** `false` quando falta par VAPID: o tick não roda (AC-009). */
  configurado: boolean;
  vencidasNaFila: number;
  leasesRecuperados: number;
  processadas: number;
  aceitas: number;
  semDestino: number;
  expiradasNoEmissor: number;
  temporarias: number;
  definitivas: number;
  operacionais: number;
  assinaturasApagadas: number;
  /** A cerca recusou a conclusão: outro emissor já assumiu a linha. */
  cercadas: number;
  duracaoMs: number;
}

/**
 * SPEC-062/D4a e D4b — **o tick, e as seis transições.**
 *
 * ## Uma linha por vez, e por quê
 *
 * A versão anterior desta spec reivindicava 20 linhas e provava por aritmética
 * que o lote cabia no lease. A validação derrubou por dois motivos: o `timeout`
 * do `web-push` mede **inatividade de socket**, não duração, e `Promise.race`
 * **não cancela** a requisição — `sendNotification` não aceita `signal`. Pior:
 * ao parar no orçamento, as linhas já reivindicadas ficavam `enviando` até o
 * lease vencer.
 *
 * Com **uma linha por vez**, parar no meio não deixa nada preso: existe uma
 * reivindicada, e ela termina ou cai no lease.
 *
 * ## O que continua sendo verdade (LIM-062a)
 *
 * Um envio que ultrapasse o lease pode coincidir com o próximo tick. A cerca
 * impede a **conclusão** antiga; não impede o **segundo envio**. Entrega
 * exatamente-uma-vez não é oferecida, e a pessoa pode ver o mesmo aviso duas
 * vezes — aceitável para aviso informativo de clube, e é por isso que o aviso
 * de teste é uma frase idempotente, sem botão e sem contagem.
 *
 * ## A ordem do ciclo é 5 → 4 → 1, e não é detalhe
 *
 * Varrer as vencidas primeiro evita reivindicar o que já venceu, e resolve o
 * `Retry-After` maior que o próprio prazo: a linha reagendada para além do
 * vencimento é fechada pela transição 5, que **não** olha
 * `proxima_tentativa_em`.
 */
@Injectable()
export class TickDeEnvioService {
  private readonly logger = new Logger(TickDeEnvioService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Inject(PORTA_DE_ENVIO) private readonly porta: PortaDeEnvio | null,
  ) {}

  async executarTick(agora: () => number = Date.now): Promise<ResultadoDoTick> {
    const inicio = agora();
    const r: ResultadoDoTick = {
      configurado: this.porta !== null,
      vencidasNaFila: 0,
      leasesRecuperados: 0,
      processadas: 0,
      aceitas: 0,
      semDestino: 0,
      expiradasNoEmissor: 0,
      temporarias: 0,
      definitivas: 0,
      operacionais: 0,
      assinaturasApagadas: 0,
      cercadas: 0,
      duracaoMs: 0,
    };

    // AC-009 — sem par VAPID o tick NÃO roda. Falha fechada: não há envio
    // silenciosamente descartado, porque não há reivindicação.
    if (!this.porta) {
      r.duracaoMs = agora() - inicio;
      return r;
    }

    r.vencidasNaFila = await this.varrerVencidas();
    r.leasesRecuperados = await this.recuperarLeasesVencidos();

    while (agora() - inicio < ORCAMENTO_DO_CICLO_MS) {
      const token = randomUUID();
      const linha = await this.reivindicarUma(token);
      if (!linha) {
        break;
      }
      r.processadas += 1;
      await this.processar(linha, token, r);
    }

    r.duracaoMs = agora() - inicio;
    return r;
  }

  // =====================================================================
  // As seis transições, na linguagem do SQL que a D4b normatiza
  // =====================================================================

  /** Transição 1 — reivindicar UMA, já contando a tentativa. */
  private async reivindicarUma(
    token: string,
  ): Promise<LinhaReivindicada | null> {
    const linhas = await this.prisma.$queryRaw<LinhaReivindicada[]>`
      UPDATE notificacoes SET estado = 'enviando',
             tentativas = tentativas + 1,
             reivindicada_ate = now() + ${`${LEASE_MS} milliseconds`}::interval,
             reivindicada_por = ${token}
       WHERE id = (SELECT id FROM notificacoes
                    WHERE estado = 'pendente'
                      AND proxima_tentativa_em <= now()
                      AND (expira_em IS NULL OR expira_em > now())
                    ORDER BY criada_em, id
                    FOR UPDATE SKIP LOCKED LIMIT 1)
      RETURNING id, company_id, destinatario_id, titulo, corpo, destino_url,
                expira_em, tentativas`;
    return linhas[0] ?? null;
  }

  /** Transição 2 — terminar. CERCADA. */
  private async terminar(
    id: string,
    token: string,
    estado: EstadoTerminal,
    erro: string | null,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE notificacoes SET estado = ${estado}::estado_da_notificacao,
             concluida_em = now(), reivindicada_por = NULL,
             reivindicada_ate = NULL, ultimo_erro = ${erro}
       WHERE id = ${id}::uuid AND estado = 'enviando'
         AND reivindicada_por = ${token}`;
    return n > 0;
  }

  /** Transição 3 — falha temporária: reagenda ou esgota. CERCADA. */
  private async reagendar(
    id: string,
    token: string,
    esperaSegundos: number,
    erro: string,
  ): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE notificacoes
         SET estado = CASE WHEN tentativas >= ${TENTATIVAS_NO_MAXIMO}
                           THEN 'falha_definitiva'::estado_da_notificacao
                           ELSE 'pendente'::estado_da_notificacao END,
             concluida_em = CASE WHEN tentativas >= ${TENTATIVAS_NO_MAXIMO}
                                 THEN now() ELSE NULL END,
             proxima_tentativa_em = now() + ${`${esperaSegundos} seconds`}::interval,
             reivindicada_por = NULL, reivindicada_ate = NULL,
             ultimo_erro = ${erro}
       WHERE id = ${id}::uuid AND estado = 'enviando'
         AND reivindicada_por = ${token}`;
    return n > 0;
  }

  /**
   * Transição 4 — lease vencido. **De propósito SEM cerca:** ela existe
   * justamente para quando não há dono vivo que apresente o token.
   *
   * `expirada` ganha de `falha_definitiva`: o aviso não falhou, ele venceu, e
   * quem lê o relatório precisa da diferença. Estado e `concluida_em` saem do
   * **mesmo predicado** — a versão que os separou foi reprovada por produzir
   * terminal sem conclusão, e hoje o `CHECK` do banco não deixaria passar.
   */
  private async recuperarLeasesVencidos(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE notificacoes
         SET estado = CASE
               WHEN expira_em IS NOT NULL AND expira_em <= now()
                 THEN 'expirada'::estado_da_notificacao
               WHEN tentativas >= ${TENTATIVAS_NO_MAXIMO}
                 THEN 'falha_definitiva'::estado_da_notificacao
               ELSE 'pendente'::estado_da_notificacao END,
             concluida_em = CASE
               WHEN (expira_em IS NOT NULL AND expira_em <= now())
                 OR tentativas >= ${TENTATIVAS_NO_MAXIMO}
                 THEN now() ELSE NULL END,
             reivindicada_por = NULL, reivindicada_ate = NULL
       WHERE estado = 'enviando' AND reivindicada_ate < now()`;
  }

  /** Transição 5 — vencida na fila: fecha sem enviar. */
  private async varrerVencidas(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE notificacoes SET estado = 'expirada'::estado_da_notificacao,
             concluida_em = now()
       WHERE estado = 'pendente' AND expira_em IS NOT NULL
         AND expira_em <= now()`;
  }

  /** Transição 6 — venceu entre reivindicar e enviar. CERCADA. */
  private async expirarNoEmissor(id: string, token: string): Promise<boolean> {
    const n = await this.prisma.$executeRaw`
      UPDATE notificacoes SET estado = 'expirada'::estado_da_notificacao,
             concluida_em = now(), reivindicada_por = NULL,
             reivindicada_ate = NULL
       WHERE id = ${id}::uuid AND estado = 'enviando'
         AND reivindicada_por = ${token}`;
    return n > 0;
  }

  // =====================================================================
  // O envio de uma linha
  // =====================================================================

  private async processar(
    linha: LinhaReivindicada,
    token: string,
    r: ResultadoDoTick,
  ): Promise<void> {
    const ttl = this.ttlDe(linha.expira_em);
    if (ttl === null) {
      // D1a — abaixo de 1 segundo NÃO se envia. É a transição 6, e ela existe
      // porque a transição 1 aprovou a linha e o prazo caiu no caminho.
      if (await this.expirarNoEmissor(linha.id, token)) {
        r.expiradasNoEmissor += 1;
      } else {
        r.cercadas += 1;
      }
      return;
    }

    const destinos = await this.destinosVivos(
      linha.company_id,
      linha.destinatario_id,
    );
    if (destinos.length === 0) {
      // D5/LIM-062b — sem assinatura viva o aviso se perde, e isso é limite
      // declarado. Não há caixa de entrada nesta spec.
      await this.concluir(linha, token, 'sem_destino', null, r);
      r.semDestino += 1;
      return;
    }

    let aceitou = false;
    let temporario: Extract<ResultadoDeEnvio, { tipo: 'temporario' }> | null =
      null;
    let operacional: string | null = null;

    for (const destino of destinos) {
      const resultado = await this.porta!.enviar(destino, {
        titulo: linha.titulo,
        corpo: linha.corpo,
        destinoUrl: linha.destino_url,
        ttl,
      });

      switch (resultado.tipo) {
        case 'aceito':
          aceitou = true;
          await this.marcarUso(destino.endpoint);
          break;
        case 'assinatura_morta':
          await this.apagarAssinatura(destino.endpoint);
          r.assinaturasApagadas += 1;
          break;
        case 'temporario':
          temporario = resultado;
          break;
        case 'falha_operacional':
          operacional = resultado.detalhe;
          break;
      }
    }

    // A precedência importa: **uma aceita basta** (D5, "uma aceita, outra
    // morre"). A pessoa viu o aviso; insistir por causa do outro aparelho
    // mandaria o mesmo aviso de novo para o que já recebeu.
    if (aceitou) {
      await this.concluir(linha, token, 'aceita_pelo_servico', null, r);
      r.aceitas += 1;
      return;
    }

    if (temporario) {
      const espera = this.esperaDe(linha.tentativas, temporario);
      if (await this.reagendar(linha.id, token, espera, temporario.detalhe)) {
        if (linha.tentativas >= TENTATIVAS_NO_MAXIMO) {
          r.definitivas += 1;
        } else {
          r.temporarias += 1;
        }
      } else {
        r.cercadas += 1;
      }
      return;
    }

    if (operacional) {
      await this.concluir(linha, token, 'falha_operacional', operacional, r);
      r.operacionais += 1;
      return;
    }

    // Todas as assinaturas morreram durante este envio: não sobrou destino.
    await this.concluir(linha, token, 'sem_destino', null, r);
    r.semDestino += 1;
  }

  private async concluir(
    linha: LinhaReivindicada,
    token: string,
    estado: EstadoTerminal,
    erro: string | null,
    r: ResultadoDoTick,
  ): Promise<void> {
    if (!(await this.terminar(linha.id, token, estado, erro))) {
      // INV-062e — a cerca recusou: o lease venceu e outro emissor assumiu.
      // O envio pode ter acontecido duas vezes (LIM-062a), e é isto que o
      // operador vê quando isso ocorre.
      r.cercadas += 1;
      this.logger.warn({
        evento: 'push_cerca_recusou_conclusao',
        notificacao: linha.id,
        estadoPretendido: estado,
      });
    }
  }

  /**
   * D1a — `floor(expira_em − now())`, e `null` quando não se deve enviar.
   *
   * `max(1, …)` foi recusado na validação: arredondar para cima guardaria a
   * mensagem um segundo **além** do prazo, e um convite vencido que chega é
   * pior que um que não chega.
   */
  private ttlDe(
    expiraEm: Date | null,
    agora: number = Date.now(),
  ): number | null {
    if (!expiraEm) {
      return TTL_PADRAO_S;
    }
    const segundos = Math.floor((expiraEm.getTime() - agora) / 1000);
    return segundos >= 1 ? segundos : null;
  }

  /** D4b — `greatest(Retry-After, espera crescente)`. Nunca menos do que pediram. */
  private esperaDe(
    tentativas: number,
    temporario: Extract<ResultadoDeEnvio, { tipo: 'temporario' }>,
  ): number {
    const indice = Math.min(
      Math.max(tentativas - 1, 0),
      ESPERA_POR_TENTATIVA_S.length - 1,
    );
    const crescente = ESPERA_POR_TENTATIVA_S[indice];
    return Math.max(crescente, temporario.esperaSugeridaSegundos ?? 0);
  }

  private async destinosVivos(
    companyId: string,
    usuarioId: string,
  ): Promise<DestinoDePush[]> {
    const linhas = await this.prisma.assinaturaPush.findMany({
      where: { companyId, usuarioId },
      select: { endpoint: true, p256dh: true, auth: true },
      orderBy: { criadaEm: 'asc' },
    });
    return linhas;
  }

  private async marcarUso(endpoint: string): Promise<void> {
    await this.prisma.assinaturaPush.updateMany({
      where: { endpoint },
      data: { ultimoUsoEm: new Date(), falhasSeguidas: 0 },
    });
  }

  private async apagarAssinatura(endpoint: string): Promise<void> {
    await this.prisma.assinaturaPush.deleteMany({ where: { endpoint } });
    this.logger.log({
      evento: 'push_assinatura_apagada',
      assinatura: impressaoDaAssinatura(endpoint),
    });
  }
}
