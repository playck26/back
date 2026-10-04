import { Logger } from '@nestjs/common';
import { createHash } from 'crypto';
import {
  Resend,
  type CreateBatchOptions,
  type CreateBatchRequestOptions,
  type CreateEmailOptions,
  type CreateEmailRequestOptions,
} from 'resend';
import {
  partirEmBlocos,
  type MensagemDeEmail,
  type MotivoDaFalha,
  type ProvedorDeEmail,
  type ResultadoDoEnvio,
} from './provedor-de-email';

/**
 * SPEC-083/D8 — **o único arquivo de `src/` que importa o SDK da Resend**
 * (INV-083h). O gate é `so-o-adaptador-importa-resend.spec.ts` (AC-029).
 *
 * Um lugar só porque é aqui que a chave de API encontra a rede, e porque a
 * tradução dos erros da Resend para os cinco motivos da D8 tem de ter um dono.
 * Quem precisa enviar e-mail injeta `PROVEDOR_DE_EMAIL` e não sabe que existe
 * uma Resend do outro lado.
 */

/**
 * D8 — o teto de cada chamada, avulsa ou bloco. Dez segundos são uma eternidade
 * para a Resend responder um `POST`, e pouco para o gestor que espera a
 * importação: o envio acontece depois do commit, mas dentro da requisição.
 * Passou daqui, o resultado é `tempo_esgotado`, que **pode ter enviado**
 * (LIM-083e).
 */
export const TEMPO_MAXIMO_POR_CHAMADA_MS = 10_000;

/**
 * O que este adaptador lê de uma resposta do SDK. Tipo próprio, e não o do
 * SDK, por dois motivos: o teste monta um dublê sem importar o pacote (o gate
 * do AC-029 varre os `.spec.ts` também), e o tipo de sucesso do lote no SDK
 * 6.32 colapsa em `never` no modo `strict`.
 */
interface ErroDoResend {
  readonly name?: string;
  readonly statusCode?: number | null;
}

interface RespostaDoResend<T> {
  readonly data: T | null;
  readonly error: ErroDoResend | null;
}

/** A fatia do cliente `Resend` que o adaptador usa. O real a satisfaz. */
export interface ClienteDoResend {
  readonly emails: {
    send(
      payload: CreateEmailOptions,
      opcoes: CreateEmailRequestOptions,
    ): Promise<RespostaDoResend<{ id: string }>>;
  };
  readonly batch: {
    send(
      payload: CreateBatchOptions,
      opcoes: CreateBatchRequestOptions,
    ): Promise<RespostaDoResend<{ data: { id: string }[] }>>;
  };
}

/**
 * Os nomes que o SDK 6.32 declara (`RESEND_ERROR_CODE_KEY`) somados aos da
 * tabela de erros da documentação (conferida em 2026-10-03), que tem alguns a
 * mais. Nome desconhecido cai no `statusCode`, em {@link motivoDoErroDoResend}.
 */
const ERROS_DE_COTA = new Set([
  'daily_quota_exceeded',
  'monthly_quota_exceeded',
]);

const ERROS_DE_CONFIGURACAO = new Set([
  'missing_api_key',
  'invalid_api_key',
  'restricted_api_key',
  'suspended_api_key',
  'invalid_permission',
  // O `from` é montado de `EMAIL_REMETENTE`, conferido no boot, e o nome do
  // clube já chega higienizado: recusa do remetente é configuração.
  'invalid_from_address',
  'invalid_region',
  'invalid_access',
]);

const ERROS_TRANSITORIOS = new Set([
  // O limite por segundo não é a cota do plano: passa sozinho, e o reenvio
  // resolve. Chamar de `cota` mandaria o gestor esperar o dia seguinte.
  'rate_limit_exceeded',
  'concurrent_idempotent_requests',
  'resource_locked',
  'service_unavailable',
  'internal_server_error',
]);

/**
 * A tabela da D8: limite diário ou mensal → `cota`; chave inválida ou domínio
 * não verificado → `configuracao`; validação → `recusado`; 5xx ou rede →
 * `indisponivel`.
 *
 * **O domínio não verificado não tem nome próprio.** A Resend responde
 * `403 validation_error` ("The domain is not verified"), o mesmo nome da
 * validação comum (`400`). Por isso o `statusCode` decide depois do nome: todo
 * `401` e `403` é credencial ou domínio, e `404`/`405` só acontecem com o
 * endereço da API errado.
 *
 * `application_error` é o que o SDK devolve para rede (`statusCode` nulo) e
 * para resposta que não é JSON (com o status real): o status decide.
 */
export function motivoDoErroDoResend(erro: ErroDoResend): MotivoDaFalha {
  const nome = erro.name ?? '';
  if (ERROS_DE_COTA.has(nome)) {
    return 'cota';
  }
  if (ERROS_DE_CONFIGURACAO.has(nome)) {
    return 'configuracao';
  }
  if (ERROS_TRANSITORIOS.has(nome)) {
    return 'indisponivel';
  }
  const status = erro.statusCode ?? null;
  if (status === null || status === 429 || status >= 500) {
    return 'indisponivel';
  }
  if (status === 401 || status === 403 || status === 404 || status === 405) {
    return 'configuracao';
  }
  return 'recusado';
}

/**
 * D8 — no lote, a chave de idempotência é o sha256 das chaves das mensagens
 * do bloco, e cada chave é `convite-de-acesso/<id>`: o sha256 dos ids do
 * bloco. Blocos diferentes têm ids diferentes, então chaves diferentes; o
 * reenvio emite convite novo, com id novo, e nunca colide com o anterior.
 */
export function chaveDoBloco(bloco: readonly MensagemDeEmail[]): string {
  return createHash('sha256')
    .update(bloco.map((mensagem) => mensagem.chaveDeIdempotencia).join('\n'))
    .digest('hex');
}

type Desfecho<T> =
  | { readonly ok: true; readonly dados: T | null }
  | {
      readonly ok: false;
      readonly motivo: MotivoDaFalha;
      readonly erro: string;
    };

export class ResendProvedorDeEmail implements ProvedorDeEmail {
  private readonly logger = new Logger('Email');

  /** O dublê entra por aqui nos testes; em produção, por {@link comChave}. */
  constructor(private readonly cliente: ClienteDoResend) {}

  static comChave(chave: string): ResendProvedorDeEmail {
    return new ResendProvedorDeEmail(new Resend(chave));
  }

  async enviar(mensagem: MensagemDeEmail): Promise<ResultadoDoEnvio> {
    try {
      const desfecho = await this.chamarComPrazo((signal) =>
        this.cliente.emails.send(paraOResend(mensagem), {
          idempotencyKey: mensagem.chaveDeIdempotencia,
          signal,
        }),
      );
      if (!desfecho.ok) {
        this.registrarFalha(desfecho, 1);
        return { ok: false, motivo: desfecho.motivo };
      }
      const id = desfecho.dados?.id;
      return id ? { ok: true, id } : this.semId(1);
    } catch (causa) {
      // Último anteparo da promessa "a porta não lança": nada acima deveria
      // chegar aqui, mas um `500` numa importação já gravada é pior que um
      // `falhou` a mais.
      return this.excecao(causa, 1);
    }
  }

  async enviarLote(
    mensagens: readonly MensagemDeEmail[],
  ): Promise<ResultadoDoEnvio[]> {
    const resultados: ResultadoDoEnvio[] = [];
    // Em série, e não em paralelo: o limite da Resend é de 10 requisições por
    // segundo por equipe (State 14), e três blocos ao mesmo tempo disputariam
    // com o reenvio que o gestor faz na ficha.
    for (const bloco of partirEmBlocos(mensagens)) {
      resultados.push(...(await this.enviarBloco(bloco)));
    }
    return resultados;
  }

  private async enviarBloco(
    bloco: readonly MensagemDeEmail[],
  ): Promise<ResultadoDoEnvio[]> {
    try {
      const desfecho = await this.chamarComPrazo((signal) =>
        this.cliente.batch.send(bloco.map(paraOResend), {
          idempotencyKey: chaveDoBloco(bloco),
          // `strict` é o padrão do SDK, e fica escrito porque a D8 depende
          // dele: uma mensagem inválida recusa o bloco inteiro, e todas saem
          // com o mesmo motivo. No `permissive` o bloco sairia pela metade.
          batchValidation: 'strict',
          signal,
        }),
      );
      if (!desfecho.ok) {
        this.registrarFalha(desfecho, bloco.length);
        const falha: ResultadoDoEnvio = { ok: false, motivo: desfecho.motivo };
        return bloco.map(() => falha);
      }
      // A resposta vem na ordem do pedido. Faltar id é resposta fora do
      // contrato, e a mensagem sem id não tem como ser dada por aceita.
      const ids = desfecho.dados?.data ?? [];
      return bloco.map((_, i): ResultadoDoEnvio => {
        const id = ids[i]?.id;
        return id ? { ok: true, id } : this.semId(1);
      });
    } catch (causa) {
      const falha = this.excecao(causa, bloco.length);
      return bloco.map(() => falha);
    }
  }

  /**
   * D8 — o teto de 10 s, e ele tem de valer mesmo se o SDK não respeitar o
   * `signal`. O `signal` cancela a requisição de verdade; a corrida com o
   * relógio garante a resposta. O SDK, ao ser abortado, devolve o mesmo
   * `application_error` da rede — por isso quem diz "foi tempo" é o próprio
   * sinal, e não o erro.
   */
  private async chamarComPrazo<T>(
    chamada: (signal: AbortSignal) => Promise<RespostaDoResend<T>>,
  ): Promise<Desfecho<T>> {
    const controlador = new AbortController();
    let relogio: ReturnType<typeof setTimeout> | undefined;
    const prazo = new Promise<'tempo_esgotado'>((resolver) => {
      relogio = setTimeout(() => {
        controlador.abort();
        resolver('tempo_esgotado');
      }, TEMPO_MAXIMO_POR_CHAMADA_MS);
    });
    // Nunca rejeita: a rejeição vira valor, para a corrida não deixar uma
    // promessa rejeitada sem dono quando o relógio ganha.
    const resposta = Promise.resolve()
      .then(() => chamada(controlador.signal))
      .then(
        (valor) => ({ tipo: 'resposta' as const, valor }),
        (causa: unknown) => ({ tipo: 'excecao' as const, causa }),
      );
    try {
      const vencedor = await Promise.race([resposta, prazo]);
      if (vencedor === 'tempo_esgotado' || controlador.signal.aborted) {
        return { ok: false, motivo: 'tempo_esgotado', erro: 'tempo_esgotado' };
      }
      if (vencedor.tipo === 'excecao') {
        return {
          ok: false,
          motivo: 'indisponivel',
          erro: nomeDoErro(vencedor.causa),
        };
      }
      const { data, error } = vencedor.valor;
      if (error) {
        return {
          ok: false,
          motivo: motivoDoErroDoResend(error),
          erro: `${error.name ?? 'sem_nome'}/${error.statusCode ?? 'sem_status'}`,
        };
      }
      return { ok: true, dados: data };
    } finally {
      clearTimeout(relogio);
    }
  }

  /**
   * **Só o nome do erro, o status, o motivo e quantas mensagens.** Nunca o
   * `message` da Resend (a validação ecoa endereço), nunca destinatário, corpo,
   * link ou token (INV-083f).
   */
  private registrarFalha(
    desfecho: { motivo: MotivoDaFalha; erro: string },
    mensagens: number,
  ): void {
    this.logger.warn({
      evento: 'email_falhou',
      motivo: desfecho.motivo,
      erro: desfecho.erro,
      mensagens,
    });
  }

  private semId(mensagens: number): ResultadoDoEnvio {
    this.registrarFalha(
      { motivo: 'indisponivel', erro: 'resposta_sem_id' },
      mensagens,
    );
    return { ok: false, motivo: 'indisponivel' };
  }

  private excecao(causa: unknown, mensagens: number): ResultadoDoEnvio {
    this.registrarFalha(
      { motivo: 'indisponivel', erro: nomeDoErro(causa) },
      mensagens,
    );
    return { ok: false, motivo: 'indisponivel' };
  }
}

/**
 * Só os campos da mensagem, e nada além: sem `headers`, sem `tags`. O
 * rastreamento de abertura e de clique é desligado no domínio (TASK-010), e
 * nenhum campo daqui o religa.
 */
function paraOResend(mensagem: MensagemDeEmail): CreateEmailOptions {
  return {
    from: mensagem.from,
    to: mensagem.to,
    replyTo: mensagem.replyTo,
    subject: mensagem.subject,
    html: mensagem.html,
    text: mensagem.text,
  };
}

function nomeDoErro(causa: unknown): string {
  return causa instanceof Error ? causa.name : 'desconhecido';
}
