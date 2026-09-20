import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TIPO_GESTO } from './avisos-de-gesto';
import { TIPO_TESTE } from './push.service';
import type {
  CaixaDeAvisosResponseDto,
  MarcadasResponseDto,
  NaoLidosResponseDto,
} from './dto/caixa-de-avisos.dto';

/**
 * SPEC-065/TASK-001 — **a caixa de entrada: ler os próprios avisos.**
 *
 * ## O que este serviço NÃO faz
 *
 * Não envia, não reivindica, não conclui. A `notificacoes` continua sendo a
 * caixa de saída da SPEC-062 — com fila, lease e cerca —, e este serviço só a
 * **lê**, mais uma escrita que o tick não conhece: `lida_em`.
 *
 * Os dois lados não se cruzam de propósito. O tick decide por `estado` e
 * `proxima_tentativa_em`; a caixa decide por `destinatario_id` e `criada_em`.
 *
 * ## A regra que é fácil de errar e está no centro da spec
 *
 * **`expira_em` não filtra a caixa** (D7). Aquela coluna responde *"até quando
 * vale a pena TENTAR enviar"* — um aviso de aula expira no fim da ocorrência
 * porque, depois disso, chegar ao aparelho é pior que não chegar.
 *
 * Quem abre a caixa de propósito, amanhã, está fazendo outra pergunta: *"o que
 * aconteceu?"*. Filtrar por `expira_em` esvaziaria justamente os avisos que a
 * pessoa **não viu na hora** — os que motivaram esta spec inteira.
 *
 * ## E `estado` também não filtra
 *
 * A caixa mostra **tudo**, inclusive `sem_destino` e `falha_definitiva`
 * (AC-002). Se ela espelhasse só o que o push entregou, resolveria a
 * conveniência de reler e **não** a perda declarada na LIM-062b.
 */
@Injectable()
export class CaixaDeAvisosService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * **A lista do que ENTRA na resposta**, e não do que sai.
   *
   * Com `omit`, um campo novo em `notificacoes` apareceria sozinho no JSON e
   * ninguém descobriria até alguém ler. O mais perigoso seria o `origem_id`:
   * na SPEC-063 ele aponta para `acoes_administrativas`, que tem `autor_id`.
   */
  private static readonly CAMPOS = {
    id: true,
    titulo: true,
    corpo: true,
    destinoUrl: true,
    criadaEm: true,
    lidaEm: true,
  } as const;

  /**
   * O recorte da caixa: os avisos **desta pessoa, nesta empresa**, menos o de
   * teste.
   *
   * **Lista de EXCLUSÃO, e não de inclusão** (D6). Com uma allowlist de
   * `tipo`, a SPEC-064 teria de lembrar de acrescentar o dela — e esquecer
   * significaria a pessoa **não ver um aviso que recebeu**, que é exatamente a
   * falha que esta spec existe para consertar. Assim, tipo novo aparece
   * sozinho, e quem quiser esconder um precisa dizer isso em voz alta.
   */
  private recorte(companyId: string, usuarioId: string) {
    return {
      companyId,
      destinatarioId: usuarioId,
      tipo: { not: TIPO_TESTE },
    };
  }

  async listar(
    companyId: string,
    usuarioId: string,
    page: number,
    pageSize: number,
  ): Promise<CaixaDeAvisosResponseDto> {
    const where = this.recorte(companyId, usuarioId);

    const [data, total, naoLidos] = await Promise.all([
      this.prisma.notificacao.findMany({
        where,
        select: CaixaDeAvisosService.CAMPOS,
        skip: (page - 1) * pageSize,
        take: pageSize,
        // **O desempate por `id` não é enfeite.** Dois avisos do mesmo gesto
        // nascem no MESMO `INSERT`, com o mesmo `criada_em` (SPEC-063: uma
        // instrução, todas as linhas em `VALUES`). Sem desempate, a paginação
        // pode repetir ou pular linha entre páginas — e o defeito só aparece
        // quando alguém rola a segunda página.
        orderBy: [{ criadaEm: 'desc' }, { id: 'desc' }],
      }),
      this.prisma.notificacao.count({ where }),
      this.prisma.notificacao.count({ where: { ...where, lidaEm: null } }),
    ]);

    return { data, page, pageSize, total, naoLidos };
  }

  /** O que o sino pede: um inteiro, e nada mais. */
  async contarNaoLidos(
    companyId: string,
    usuarioId: string,
  ): Promise<NaoLidosResponseDto> {
    const naoLidos = await this.prisma.notificacao.count({
      where: { ...this.recorte(companyId, usuarioId), lidaEm: null },
    });
    return { naoLidos };
  }

  /**
   * Marca **todas** as não lidas (D9).
   *
   * Não há estado de lido por item na v1, e a razão é que a alternativa não
   * tem resposta boa: *o que conta como ter lido um item — aparecer na tela?
   * ficar dois segundos? tocar?* Qualquer critério seria arbitrário, e
   * marcação arbitrária é pior que marcação grossa e previsível.
   *
   * **`WHERE lida_em IS NULL` é a idempotência** (INV-065b): o próprio
   * predicado garante que chamar de novo devolva `0` e **não reescreva** o
   * `lida_em` já gravado. Duas abas chamando ao mesmo tempo não brigam.
   */
  async marcarTodasComoLidas(
    companyId: string,
    usuarioId: string,
  ): Promise<MarcadasResponseDto> {
    const { count } = await this.prisma.notificacao.updateMany({
      where: { ...this.recorte(companyId, usuarioId), lidaEm: null },
      data: { lidaEm: new Date() },
    });
    return { marcadas: count };
  }
}

/**
 * Exportado para o teste e para quem for acrescentar tipo novo: a caixa mostra
 * `gesto` e qualquer tipo futuro, **menos** `teste`.
 */
export const TIPOS_QUE_A_CAIXA_MOSTRA = {
  inclui: TIPO_GESTO,
  exclui: TIPO_TESTE,
};
