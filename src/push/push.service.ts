import {
  ConflictException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { impressaoDaAssinatura } from './impressao-da-assinatura';
import type { ConfiguracaoVapid } from './vapid.config';

/** D6 — três avisos de teste por hora, por pessoa. */
export const TESTES_POR_HORA = 3;
/** D6 — o teste que chega meia hora depois não testa nada. */
export const VALIDADE_DO_TESTE_MS = 10 * 60 * 1000;
export const TIPO_TESTE = 'teste';

export const TEXTO_DO_TESTE = {
  titulo: 'Avisos do clube',
  corpo: 'Tudo certo — os avisos do clube chegam neste aparelho.',
} as const;

export interface DadosDaAssinatura {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/**
 * SPEC-062/D2, D2a, D6 — **as rotas, e os três tetos do aviso de teste.**
 */
@Injectable()
export class PushService {
  private readonly logger = new Logger(PushService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly vapid: ConfiguracaoVapid | null,
  ) {}

  /**
   * D1b — a pública vem por rota, nunca no bundle: trocar o par invalida todas
   * as assinaturas, e um bundle com a chave velha continuaria errado até o
   * próximo deploy da Netlify, que custa crédito.
   *
   * `impressaoDaPrivada` sai junto de propósito — é o insumo do gate G7, e
   * publicá-la é seguro (ver `vapid.config.ts`).
   */
  chavePublica(): { chave: string; impressaoDaPrivada: string } {
    const vapid = this.exigirConfiguracao();
    return {
      chave: vapid.publicKey,
      impressaoDaPrivada: vapid.impressaoDaPrivada,
    };
  }

  /**
   * D2/D2a — registrar o aparelho.
   *
   * **A mesma conta, o mesmo aparelho, duas vezes: uma linha só** (AC-001) — o
   * app reconcilia a cada abertura, e criar linha nova a cada vez encheria a
   * tabela de duplicatas do mesmo endpoint.
   *
   * **Endpoint de outra conta: `409`** (AC-002, INV-062d). A autenticação prova
   * a CONTA, não o controle do aparelho; transferir por declaração seria
   * sequestro de avisos. Quem entrou depois no aparelho faz `unsubscribe()` no
   * navegador — a única prova de controle que existe do lado do cliente — e
   * assina de novo, ganhando outro `endpoint`.
   */
  async assinar(
    companyId: string,
    usuarioId: string,
    dados: DadosDaAssinatura,
  ): Promise<void> {
    this.exigirConfiguracao();

    const existente = await this.prisma.assinaturaPush.findUnique({
      where: { endpoint: dados.endpoint },
      select: { id: true, companyId: true, usuarioId: true },
    });

    if (existente) {
      if (
        existente.companyId !== companyId ||
        existente.usuarioId !== usuarioId
      ) {
        throw this.endpointEmUso();
      }
      await this.prisma.assinaturaPush.update({
        where: { id: existente.id },
        data: { p256dh: dados.p256dh, auth: dados.auth, falhasSeguidas: 0 },
      });
      return;
    }

    try {
      await this.prisma.assinaturaPush.create({
        data: {
          id: randomUUID(),
          companyId,
          usuarioId,
          endpoint: dados.endpoint,
          p256dh: dados.p256dh,
          auth: dados.auth,
        },
      });
    } catch (causa) {
      // Corrida com outra requisição entre o `findUnique` e o `create`. O
      // `UNIQUE` do banco é quem decide, e é por isso que ele existe: a
      // conferência de aplicação acima é conveniência, não garantia.
      if (
        causa instanceof Prisma.PrismaClientKnownRequestError &&
        causa.code === 'P2002'
      ) {
        throw this.endpointEmUso();
      }
      throw causa;
    }
  }

  /**
   * D2a-2 — **só apaga o que é seu.**
   *
   * A versão anterior apagava por `endpoint` e declarava a negação de push como
   * limite aceito: quem tivesse um `endpoint` alheio derrubava a assinatura do
   * dono. Não precisava — o servidor sabe quem está pedindo.
   *
   * **`204` sempre**, tenha apagado ou não: resposta diferente por existência
   * transformaria a rota em oráculo de assinaturas alheias.
   */
  async desassinar(
    companyId: string,
    usuarioId: string,
    endpoint: string,
  ): Promise<void> {
    await this.prisma.assinaturaPush.deleteMany({
      where: { companyId, usuarioId, endpoint },
    });
  }

  /**
   * D6 — o aviso de teste, e os dois tetos que moram no banco.
   *
   * O `@Throttle` do controller é a terceira camada, e a mais fraca: o storage
   * padrão do `@nestjs/throttler` é um `Map` **do processo**, então reiniciar
   * zera a janela e duas réplicas dão dois baldes. "Três por hora" só é verdade
   * porque a contagem abaixo lê a própria tabela.
   */
  async enfileirarTeste(
    companyId: string,
    usuarioId: string,
  ): Promise<{ enfileirada: true }> {
    this.exigirConfiguracao();

    const desde = new Date(Date.now() - 60 * 60 * 1000);
    const recentes = await this.prisma.notificacao.findMany({
      where: {
        destinatarioId: usuarioId,
        tipo: TIPO_TESTE,
        criadaEm: { gt: desde },
      },
      select: { criadaEm: true },
      orderBy: { criadaEm: 'asc' },
      take: TESTES_POR_HORA,
    });

    if (recentes.length >= TESTES_POR_HORA) {
      // `Retry-After` sai da MAIS ANTIGA das três: é quando a janela
      // deslizante abre espaço de novo.
      const liberaEm = recentes[0].criadaEm.getTime() + 60 * 60 * 1000;
      const segundos = Math.max(1, Math.ceil((liberaEm - Date.now()) / 1000));
      // `HttpException` com 429, e NÃO `ConflictException`: esta última
      // responderia **409** com um corpo dizendo 429. O código HTTP é o
      // contrato que o cliente lê primeiro, e corpo que discorda do status é
      // a pior espécie de documentação errada.
      throw new HttpException(
        {
          statusCode: 429,
          code: 'TESTE_ACIMA_DO_TETO',
          message: 'Você já pediu três avisos de teste na última hora.',
          retryAfter: segundos,
        },
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }

    try {
      await this.prisma.notificacao.create({
        data: {
          id: randomUUID(),
          companyId,
          destinatarioId: usuarioId,
          tipo: TIPO_TESTE,
          titulo: TEXTO_DO_TESTE.titulo,
          corpo: TEXTO_DO_TESTE.corpo,
          expiraEm: new Date(Date.now() + VALIDADE_DO_TESTE_MS),
        },
      });
    } catch (causa) {
      if (
        causa instanceof Prisma.PrismaClientKnownRequestError &&
        causa.code === 'P2002'
      ) {
        // INV-062g — o índice parcial. **`409`, não `429`:** ter um teste
        // ainda pendente é conflito de ESTADO, não excesso de ritmo. O `429`
        // é do teto horário, acima.
        throw new ConflictException({
          statusCode: 409,
          code: 'TESTE_JA_ENFILEIRADO',
          message: 'Já há um aviso de teste a caminho deste aparelho.',
        });
      }
      throw causa;
    }

    return { enfileirada: true };
  }

  /** Quantas assinaturas vivas esta pessoa tem. A tela usa para explicar o estado. */
  async contarAssinaturas(
    companyId: string,
    usuarioId: string,
  ): Promise<number> {
    return this.prisma.assinaturaPush.count({
      where: { companyId, usuarioId },
    });
  }

  private endpointEmUso(): ConflictException {
    return new ConflictException({
      statusCode: 409,
      code: 'ENDPOINT_EM_USO',
      message: 'Este aparelho já está registrado em outra conta.',
    });
  }

  /**
   * D1b/D1c — falha fechada. Sem as três variáveis, **diz que não funciona** em
   * vez de fingir que funcionou e perder o aviso em silêncio.
   */
  private exigirConfiguracao(): ConfiguracaoVapid {
    if (!this.vapid) {
      throw new ServiceUnavailableException({
        statusCode: 503,
        code: 'PUSH_NAO_CONFIGURADO',
        message: 'Os avisos do clube ainda não foram configurados.',
      });
    }
    return this.vapid;
  }

  /** Só para log: nunca devolva isto numa resposta (INV-062f). */
  protected impressao(endpoint: string): string {
    return impressaoDaAssinatura(endpoint);
  }
}
