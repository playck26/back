import { randomUUID } from 'node:crypto';
import type {
  Prisma,
  TipoDeAcao,
  TipoDeEventoDeOcupacao,
} from '@prisma/client';

/**
 * SPEC-032 — o registrador da ação administrativa.
 *
 * **Uma ação por COMANDO LÓGICO, e ela nasce PREGUIÇOSA.**
 *
 * Preguiçosa não é elegância: `cancelBooking` retorna **sem escrever nada**
 * quando a reserva já está cancelada (`courts.service.ts`, "repetir a ação
 * não é engano do usuário, é rede instável"). Se o caso de uso criasse a ação
 * ao entrar, cada retentativa de rede gravaria uma ação vazia — e a
 * auditoria passaria a contar tentativas em vez de gestos.
 *
 * Então o `INSERT` de `acoes_administrativas` acontece na **primeira**
 * chamada de `registrar`, dentro da mesma transação. Comando sem efeito não
 * cria ação.
 *
 * **Uma instância por comando lógico** (INV-078), e a identidade está na
 * matriz da spec:
 *
 * | Gesto | Identidade |
 * |---|---|
 * | pedido de reserva com N blocos | o pedido — **uma** ação, N eventos |
 * | cancelar reserva | a ocupação |
 * | criar ou editar turma | a turma |
 * | cancelar ocorrências de N turmas | **uma por turma** |
 *
 * O registrador prova "nenhuma ação vazia"; **ele não prova unicidade** —
 * dois registradores no mesmo gesto criariam duas ações e o banco não
 * reclamaria. Quem garante a unicidade é o caso de uso instanciar **um** só,
 * e a prova de integração que conta as linhas.
 */
export class RegistradorDeAcao {
  private acaoId: string | null = null;

  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly companyId: string,
    private readonly autorId: string,
    private readonly tipo: TipoDeAcao,
    private readonly motivo?: string,
  ) {}

  /**
   * Registra o efeito sobre UMA ocupação, criando a ação se ainda não existir.
   *
   * `transicaoId` é a identidade da mudança de estado, e o mesmo valor tem de
   * ser gravado em `ocupacoes_quadra.transicao_id` na mesma transação —
   * é isso que a trigger `ocupacao_cancelada_exige_evento` confere no
   * `COMMIT` (INV-064). Use {@link novaTransicao} para gerá-lo.
   */
  async registrar(
    ocupacaoId: string,
    tipo: TipoDeEventoDeOcupacao,
    transicaoId: string,
  ): Promise<void> {
    this.acaoId ??= (
      await this.tx.acaoAdministrativa.create({
        data: {
          companyId: this.companyId,
          tipo: this.tipo,
          autorId: this.autorId,
          motivo: this.motivo ?? null,
        },
        select: { id: true },
      })
    ).id;

    await this.tx.eventoDeOcupacao.create({
      data: {
        companyId: this.companyId,
        acaoId: this.acaoId,
        ocupacaoId,
        tipo,
        transicaoId,
      },
    });
  }

  /**
   * N eventos em **uma** instrução, para os caminhos de turma.
   *
   * **Não é otimização — é orçamento.** O DEF-013 existe porque a transação
   * de turma estourou `P2028` em produção, e o teste do orçamento afirma que
   * *"o custo não pode crescer com o número de encontros"*. Um laço de
   * `registrar` faria N idas ao banco dentro da transação e quebraria essa
   * invariante — o teste pegou, e é por isso que este método existe.
   */
  async registrarMuitos(
    ocupacaoIds: string[],
    tipo: TipoDeEventoDeOcupacao,
    transicaoId: string,
  ): Promise<void> {
    if (ocupacaoIds.length === 0) return;

    this.acaoId ??= (
      await this.tx.acaoAdministrativa.create({
        data: {
          companyId: this.companyId,
          tipo: this.tipo,
          autorId: this.autorId,
          motivo: this.motivo ?? null,
        },
        select: { id: true },
      })
    ).id;

    await this.tx.eventoDeOcupacao.createMany({
      data: ocupacaoIds.map((ocupacaoId) => ({
        companyId: this.companyId,
        acaoId: this.acaoId as string,
        ocupacaoId,
        tipo,
        transicaoId,
      })),
    });
  }

  /** Só para prova: `null` enquanto nada foi registrado. */
  get idDaAcao(): string | null {
    return this.acaoId;
  }
}

/**
 * A identidade de UMA transição de estado.
 *
 * Existe porque a versão anterior da INV-064 usava
 * `criado_em >= transaction_timestamp()`, e a validação cruzada derrubou por
 * dois caminhos: o timestamp é o **início** da transação e não a identidade
 * dela (o evento de uma transação concorrente satisfazia a outra), e
 * `cancelar → reativar → cancelar` na mesma transação passava com um evento
 * só.
 */
export function novaTransicao(): string {
  return randomUUID();
}
