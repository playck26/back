import { randomUUID } from 'node:crypto';
import { Injectable, UnprocessableEntityException } from '@nestjs/common';
import type { Prisma, TipoMovimentoCredito } from '@prisma/client';

/**
 * SPEC-033/TASK-003 — o serviço do saldo.
 *
 * ## O que ele NÃO faz, e é a decisão central
 *
 * **Ele não escreve `alunos.saldo_creditos`.** Quem escreve é a trigger
 * `movimentos_atualiza_saldo`, e a guarda `alunos_saldo_so_pelo_ledger`
 * recusa (`23514`) qualquer outra escrita — inclusive um `UPDATE` bem
 * intencionado deste serviço (D1/INV-071). O ledger é a escrita primária; o
 * saldo é derivado.
 *
 * A consequência prática: todo método daqui insere **uma linha** em
 * `movimentos_de_credito` e lê o saldo depois, se precisar. Não há caminho
 * "corrigir o saldo".
 *
 * ## Por que todo método recebe uma transação
 *
 * Nenhuma operação de crédito é solitária. O lançamento do admin precisa da
 * ação administrativa (SPEC-032) na mesma transação; o consumo precisa nascer
 * junto da ocupação (AC-006); a devolução, junto do cancelamento (INV-096).
 * Um serviço que abrisse a própria transação obrigaria o chamador a aninhar,
 * e o Prisma não aninha — então o `tx` entra por parâmetro, sempre.
 *
 * ## As duas camadas do saldo insuficiente (AC-004)
 *
 * 1. **pré-checagem sob `FOR UPDATE`**, que produz o `422 SALDO_INSUFICIENTE`
 *    com a mensagem certa;
 * 2. **tradução defensiva do `23514`**, para o dia em que uma corrida passar
 *    pela pré-checagem: sem ela o Postgres devolve constraint violada, e
 *    **não existe filtro global no back que traduza constraint em erro de
 *    domínio** — viraria `500`.
 *
 * A segunda camada não é redundância: a primeira só vale enquanto a trava
 * estiver correta, e a segunda vale mesmo se ela não estiver.
 */
@Injectable()
export class CreditosService {
  /**
   * Trava a linha do aluno e devolve o saldo.
   *
   * **A trava vem antes de qualquer decisão sobre dinheiro** — é a mesma
   * disciplina do pedido de reserva, e a razão é a de sempre: conferir fora
   * da trava deixa janela entre a checagem e a escrita, e aqui a janela custa
   * saldo negativo ou débito dobrado.
   *
   * `alunos` é o **nível 2** da ordem global de travas (INV-029,
   * `DATA_MODEL.md`): depois de `turmas`, antes de `ocupacoes_quadra`. Quem
   * chamar isto depois de já ter tocado a ocupação está invertendo a ordem e
   * vai encontrar deadlock sob concorrência, não erro de lógica.
   */
  async travarESaber(
    tx: Prisma.TransactionClient,
    companyId: string,
    alunoId: string,
  ): Promise<number> {
    // Raw porque `FOR UPDATE` não é expressável no query builder do Prisma —
    // mesmo motivo de `classes.service.ts`.
    const linhas = await tx.$queryRaw<{ saldo_creditos: number }[]>`
      SELECT saldo_creditos FROM alunos
      WHERE id = ${alunoId}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    const aluno = linhas[0];
    if (!aluno) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'ALUNO_NAO_ENCONTRADO',
        message: 'Aluno não encontrado nesta empresa.',
      });
    }
    return aluno.saldo_creditos;
  }

  /**
   * `entrada` — o admin põe crédito na carteira.
   *
   * `motivo` é obrigatório e o **banco** é quem exige
   * (`movimentos_motivo_administrativo`, AC-003). A checagem daqui existe
   * para a mensagem, não para a garantia.
   */
  async lancar(
    tx: Prisma.TransactionClient,
    params: MovimentoAdministrativo,
  ): Promise<string> {
    return this.inserir(tx, { ...params, tipo: 'entrada' });
  }

  /**
   * `retirada` — o admin tira crédito da carteira.
   *
   * Trava, confere, insere. A pré-checagem é a camada 1 do AC-004.
   */
  async retirar(
    tx: Prisma.TransactionClient,
    params: MovimentoAdministrativo,
  ): Promise<string> {
    const saldo = await this.travarESaber(tx, params.companyId, params.alunoId);
    if (saldo < params.valorCentavos) {
      throw saldoInsuficiente(saldo, params.valorCentavos);
    }
    return this.inserir(tx, { ...params, tipo: 'retirada' });
  }

  /**
   * `consumo` — a reserva debita a carteira (AC-006).
   *
   * **Um consumo por OCUPAÇÃO, não por pedido** (D4): é o que faz cancelar um
   * bloco devolver aquele bloco. Quem chama passa uma ocupação por vez.
   *
   * Não trava: quem cria reserva já travou o aluno antes de decidir o pedido
   * inteiro (AC-007 é tudo-ou-nada sobre a soma). Travar de novo por bloco
   * seria trabalho sem garantia nova — a trava já é da transação.
   */
  async consumir(
    tx: Prisma.TransactionClient,
    params: MovimentoDeOcupacao,
  ): Promise<string> {
    return this.inserir(tx, { ...params, tipo: 'consumo', motivo: null });
  }

  /**
   * `devolucao` — o cancelamento devolve o que aquele bloco consumiu.
   *
   * `movimentoOrigemId` é obrigatório, e o banco confere **mais que o
   * ponteiro**: a FK causal de seis colunas exige que a origem seja um
   * `consumo` do mesmo aluno, da mesma ocupação e do mesmo valor (D5). Errar
   * qualquer um dos cinco é `23503`, não erro silencioso.
   */
  async devolver(
    tx: Prisma.TransactionClient,
    params: MovimentoDeOcupacao & { movimentoOrigemId: string },
  ): Promise<string> {
    return this.inserir(tx, { ...params, tipo: 'devolucao', motivo: null });
  }

  /**
   * O consumo ATIVO de uma ocupação, ou `null` se não houver.
   *
   * "Ativo" é consumo **sem devolução** — a mesma definição da INV-098, e a
   * que faz a reativação (consumo/devolução/consumo) continuar possível. É
   * daqui que o cancelamento tira o que devolver.
   */
  async consumoAtivoDaOcupacao(
    tx: Prisma.TransactionClient,
    companyId: string,
    ocupacaoId: string,
  ): Promise<{ id: string; alunoId: string; valorCentavos: number } | null> {
    const linhas = await tx.$queryRaw<
      { id: string; aluno_id: string; valor_centavos: number }[]
    >`
      SELECT c.id, c.aluno_id, c.valor_centavos
        FROM movimentos_de_credito c
       WHERE c.company_id = ${companyId}::uuid
         AND c.ocupacao_id = ${ocupacaoId}::uuid
         AND c.tipo = 'consumo'
         AND NOT EXISTS (
           SELECT 1 FROM movimentos_de_credito d
            WHERE d.movimento_origem_id = c.id AND d.tipo = 'devolucao')
    `;
    const c = linhas[0];
    return c
      ? { id: c.id, alunoId: c.aluno_id, valorCentavos: c.valor_centavos }
      : null;
  }

  /**
   * O `INSERT` único, e a tradução defensiva em volta dele.
   *
   * **A tradução é a camada 2 do AC-004** e cobre os dois caminhos que só o
   * banco conhece: o `CHECK` do saldo não negativo, que a corrida alcança, e
   * o `CHECK` do motivo, que o banco impõe (AC-003).
   */
  private async inserir(
    tx: Prisma.TransactionClient,
    dados: {
      companyId: string;
      alunoId: string;
      tipo: TipoMovimentoCredito;
      valorCentavos: number;
      motivo: string | null;
      autorId: string;
      acaoId: string;
      ocupacaoId?: string;
      movimentoOrigemId?: string;
    },
  ): Promise<string> {
    try {
      const criado = await tx.movimentoDeCredito.create({
        data: {
          id: randomUUID(),
          companyId: dados.companyId,
          alunoId: dados.alunoId,
          tipo: dados.tipo,
          valorCentavos: dados.valorCentavos,
          motivo: dados.motivo,
          autorId: dados.autorId,
          acaoId: dados.acaoId,
          ocupacaoId: dados.ocupacaoId ?? null,
          movimentoOrigemId: dados.movimentoOrigemId ?? null,
        },
        select: { id: true },
      });
      return criado.id;
    } catch (erro) {
      relancarTraduzido(erro, dados.valorCentavos);
    }
  }
}

/** O que todo movimento administrativo (`entrada`/`retirada`) carrega. */
export interface MovimentoAdministrativo {
  companyId: string;
  alunoId: string;
  valorCentavos: number;
  /** Obrigatório nos administrativos — o banco recusa vazio ou só espaço. */
  motivo: string;
  autorId: string;
  acaoId: string;
}

/** O que `consumo` e `devolucao` carregam: sem motivo, com ocupação. */
export interface MovimentoDeOcupacao {
  companyId: string;
  alunoId: string;
  valorCentavos: number;
  autorId: string;
  acaoId: string;
  ocupacaoId: string;
}

export function saldoInsuficiente(
  saldoCentavos: number,
  pedidoCentavos: number,
): UnprocessableEntityException {
  const faltam = pedidoCentavos - saldoCentavos;
  return new UnprocessableEntityException({
    statusCode: 422,
    code: 'SALDO_INSUFICIENTE',
    message: `Saldo insuficiente: faltam ${reais(faltam)}.`,
    saldoCentavos,
    faltamCentavos: faltam,
  });
}

/**
 * Constraint do banco vira erro de domínio.
 *
 * **Sem isto o `23514` sai como `500`**, porque o back não tem filtro global
 * de constraint — está escrito no AC-004 e é o motivo de esta função existir
 * em vez de um `catch` genérico no controller.
 */
function relancarTraduzido(erro: unknown, valorCentavos: number): never {
  const texto = erro instanceof Error ? erro.message : String(erro);
  if (texto.includes('alunos_saldo_nao_negativo')) {
    // O saldo real não é legível aqui — a transação já abortou. `0` é o piso
    // honesto: dizer "faltam X" com um saldo que não medimos seria inventar.
    throw saldoInsuficiente(0, valorCentavos);
  }
  if (texto.includes('movimentos_motivo_administrativo')) {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'MOTIVO_OBRIGATORIO',
      message: 'Movimento administrativo exige motivo.',
    });
  }
  throw erro;
}

function reais(centavos: number): string {
  return (centavos / 100).toLocaleString('pt-BR', {
    style: 'currency',
    currency: 'BRL',
  });
}
