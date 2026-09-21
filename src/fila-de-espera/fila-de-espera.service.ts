import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { situacaoDoCredito } from '../classes/credito-de-reposicao';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import type { LinhaDaFilaResponseDto } from './dto/fila-de-espera.dto';

/**
 * SPEC-064/TASK-002 — **entrar e sair da fila de espera** (card 5331).
 *
 * ## Duas filas, e elas não se misturam (D1)
 *
 * | Fila | Dispara quando | Quem entra | Como confirma |
 * |---|---|---|---|
 * | **de turma** | alguém **sai** da turma | aluno ativo não matriculado nela | matrícula normal |
 * | **de aula** | alguém **avisa falta** naquela aula | **só quem tem crédito** | `ReposicaoService.marcar` |
 *
 * *Vaga de reposição não vira vaga de matrícula* — e é por isso que as duas
 * contas de capacidade (TASK-003) também não se misturam.
 *
 * ## Esta classe NÃO chama ninguém
 *
 * Ela só grava o fato de que a pessoa quer a vaga. **Quem chama é o varredor**
 * (D3/TASK-003), e o motivo é ordem de locks: chamar dentro da transação do
 * gesto exigiria tomar `turmas` **depois** de `ocupacoes_quadra` no caminho da
 * falta avisada — inversão da ordem canônica, e deadlock (achado v2-02).
 *
 * ## Por que não há `FOR UPDATE` em lugar nenhum aqui
 *
 * Foi decidido, não esquecido. As duas coisas que precisam de garantia já têm:
 *
 * - **entrar duas vezes** (AC-001) é impedido pelo índice único parcial
 *   `fila_ativa_turma_key` / `fila_ativa_ocupacao_key`. A pré-checagem não
 *   existe — o `23505` **é** o mecanismo, e vira `409 JA_NA_FILA`;
 * - **o crédito** (AC-002) é conferência de elegibilidade, não de capacidade.
 *   Duas entradas simultâneas com o mesmo crédito produzem duas linhas, e isso
 *   é **deliberado**: a fila não reserva a vaga (LIM-064a), e a D6 já lista
 *   *"crédito consumido por outro caminho"* como um dos sete caminhos de
 *   encerramento (TASK-004). Travar aqui seria reservar o que a spec diz que
 *   não se reserva.
 *
 * Capacidade — a única coisa que exigiria lock — é conta do **varredor**, que
 * toma `turmas FOR UPDATE` antes de contar.
 */
@Injectable()
export class FilaDeEsperaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operacao: ConfigOperacaoService,
  ) {}

  /** `alunoId` nunca vem do corpo nem da URL — é derivado do token. Mesma
   *  regra do `ReposicaoService`, e pelo mesmo motivo (SPEC-031/D19). */
  private async alunoDoUsuario(
    companyId: string,
    usuarioId: string,
  ): Promise<{ id: string }> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { companyId, usuarioId },
      select: { id: true },
    });
    if (!aluno) throw new NotFoundException();
    return aluno;
  }

  /**
   * AC-001 — **a garantia é o índice, não uma consulta antes.**
   *
   * Entre um `SELECT` de checagem e o `INSERT` cabe outra requisição; entre o
   * `INSERT` e a constraint não cabe nada. É a mesma divisão de trabalho da
   * INV-001 (a `EXCLUDE` da quadra) e da INV-118 (o `UNIQUE (falta_id)`).
   */
  private async inserir(
    dados: Prisma.ListaDeEsperaUncheckedCreateInput,
  ): Promise<LinhaDaFilaResponseDto> {
    try {
      const linha = await this.prisma.listaDeEspera.create({
        data: dados,
        select: {
          id: true,
          estado: true,
          turmaId: true,
          ocupacaoId: true,
          faltaId: true,
          criadaEm: true,
        },
      });
      return {
        id: linha.id,
        estado: linha.estado,
        turmaId: linha.turmaId,
        ocupacaoId: linha.ocupacaoId,
        faltaId: linha.faltaId,
        criadaEm: linha.criadaEm.toISOString(),
      };
    } catch (erro) {
      if (ehConflitoDeUnicidade(erro)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'JA_NA_FILA',
          message: 'Você já está nesta fila de espera.',
        });
      }
      throw erro;
    }
  }

  /**
   * REQ-001 — entrar na fila de **turma**, por uma vaga de matrícula.
   *
   * Sem conferência de capacidade: entrar na fila de uma turma que tem vaga
   * agora é legítimo — a vaga pode sumir antes de ele se matricular, e o
   * varredor o chamará se ela voltar. Recusar aqui seria adivinhar.
   */
  async entrarNaTurma(
    companyId: string,
    usuarioId: string,
    turmaId: string,
  ): Promise<LinhaDaFilaResponseDto> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: { id: true, status: true },
    });
    if (!turma) throw new NotFoundException();
    if (turma.status !== 'ativa') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'TURMA_INATIVA',
        message: 'Esta turma está fora de operação.',
      });
    }

    await this.recusarSeJaMatriculado(turma.id, aluno.id);

    return this.inserir({
      id: crypto.randomUUID(),
      companyId,
      alunoId: aluno.id,
      turmaId: turma.id,
    });
  }

  /**
   * REQ-001 + LIM-064e — entrar na fila de **aula**, por uma vaga de reposição.
   *
   * **Só quem tem crédito**, e a linha guarda **qual** `falta_id` (D1). É
   * decisão de produto (2026-09-18): a reposição é o único caminho que existe
   * hoje para entrar numa ocorrência isolada, então sem crédito o chamado seria
   * convite que a pessoa não pode cumprir.
   *
   * **Quem escolhe o crédito é o servidor, não a tela.** A AC-002 fala em
   * *"entrar na fila de aula sem crédito"* — propriedade da pessoa, não de uma
   * falta específica —, e mandar a tela escolher abriria a porta para
   * `faltaId` vencido entre o carregamento e o toque. Escolhe-se o que **vence
   * primeiro**: crédito guardado é crédito perdido.
   */
  async entrarNaAula(
    companyId: string,
    usuarioId: string,
    ocupacaoId: string,
  ): Promise<LinhaDaFilaResponseDto> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    const hoje = hojeNoFusoDoClube();

    // Só ocorrência de TURMA: reposição acontece dentro de uma turma, e é o
    // mesmo recorte que o `ReposicaoService.marcar` exige.
    const alvo = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id: ocupacaoId, companyId, origemTipo: 'TURMA' },
      select: {
        id: true,
        data: true,
        statusPagamento: true,
        origemTurmaId: true,
      },
    });
    if (!alvo?.origemTurmaId) throw new NotFoundException();

    if (alvo.statusPagamento === 'cancelado') {
      throw new ConflictException({
        statusCode: 409,
        code: 'OCUPACAO_CANCELADA',
        message: 'Esta aula foi cancelada pelo clube.',
      });
    }
    if (alvo.data < hoje) {
      throw new ConflictException({
        statusCode: 409,
        code: 'PRAZO_DE_CANCELAMENTO',
        message: 'Esta aula já passou.',
      });
    }

    await this.recusarSeJaMatriculado(alvo.origemTurmaId, aluno.id);

    const faltaId = await this.creditoQueVenceAntes(companyId, aluno.id, hoje);
    if (!faltaId) {
      throw new ConflictException({
        statusCode: 409,
        code: 'SEM_CREDITO',
        message:
          'A fila de espera de uma aula é só para quem tem crédito de reposição.',
      });
    }

    return this.inserir({
      id: crypto.randomUUID(),
      companyId,
      alunoId: aluno.id,
      ocupacaoId: alvo.id,
      faltaId,
    });
  }

  /**
   * REQ-001 — sair por conta própria.
   *
   * Vale também para quem **já foi chamado**: desistir da vez é legítimo, e
   * desistir libera o alvo — o índice `fila_chamado_*_key` deixa de ver um
   * `chamado` vivo e o próximo ciclo do varredor chama o seguinte.
   *
   * `updateMany` e não `update`: o recorte por `(company_id, aluno_id)` tem de
   * entrar no `WHERE`, senão o id na URL seria suficiente para tirar **outra
   * pessoa** da fila.
   */
  async sair(companyId: string, usuarioId: string, id: string): Promise<void> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const { count } = await this.prisma.listaDeEspera.updateMany({
      where: {
        id,
        companyId,
        alunoId: aluno.id,
        estado: { in: ['aguardando', 'chamado'] },
      },
      data: {
        estado: 'desistiu',
        concluidaEm: new Date(),
        motivoFim: 'saiu da fila',
      },
    });
    // Linha de outra pessoa, inexistente ou **já terminada** caem no mesmo
    // `404`: responder `204` para uma linha encerrada diria que a ação
    // aconteceu agora, e ela não aconteceu.
    if (count === 0) throw new NotFoundException();
  }

  /**
   * AC-011 do `marcar`, repetida aqui pelo mesmo motivo: quem já está na turma
   * já é esperado lá. Entrar na fila dela seria pedir a vaga que ele ocupa.
   */
  private async recusarSeJaMatriculado(
    turmaId: string,
    alunoId: string,
  ): Promise<void> {
    const jaNaTurma = await this.prisma.turmaAluno.findFirst({
      where: { turmaId, alunoId },
      select: { turmaId: true },
    });
    if (jaNaTurma) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'JA_MATRICULADO_NA_TURMA',
        message: 'Você já faz parte desta turma.',
      });
    }
  }

  /**
   * O crédito **utilizável** que vence primeiro, ou `null`.
   *
   * `utilizavel`, e não `contaComoSaldo`: as duas regras existem e **discordam**
   * num caso (reposição feita numa aula que o clube depois cancelou). O saldo
   * na tela devolve esse crédito; o `marcar` o recusa com `FALTA_JA_REPOSTA`.
   * Ver `credito-de-reposicao.ts`.
   *
   * **A fila usa a regra estrita de propósito.** Convidar alguém com um crédito
   * que o `marcar` vai recusar é pior que não convidar: ele recebe o aviso,
   * corre até o clube e leva `409`.
   */
  private async creditoQueVenceAntes(
    companyId: string,
    alunoId: string,
    hoje: Date,
  ): Promise<string | null> {
    const regra = await this.operacao.reposicaoDaEmpresa(companyId);

    const faltas = await this.prisma.faltaAvisada.findMany({
      where: { companyId, alunoId },
      select: {
        id: true,
        ocupacao: { select: { data: true, statusPagamento: true } },
        reposicao: {
          select: { ocupacao: { select: { statusPagamento: true } } },
        },
      },
    });

    const utilizaveis = faltas
      .map((f) => ({
        id: f.id,
        ...situacaoDoCredito(f, regra.validadeDias, hoje),
      }))
      .filter((c) => c.utilizavel)
      .sort((a, b) => a.expiraEm.getTime() - b.expiraEm.getTime());

    return utilizaveis[0]?.id ?? null;
  }
}

/**
 * Violação de unicidade, **venha ela pelo Prisma ou crua do Postgres**.
 *
 * Os quatro índices da fila são **parciais**, e o `schema.prisma` não os
 * declara (o Prisma não expressa `WHERE` em índice). Então não há garantia de
 * que a violação chegue sempre como `P2002` — pode chegar como `P2010`/`23505`.
 * Conferir os dois é mais barato que descobrir em produção que `JA_NA_FILA`
 * virou `500`.
 */
function ehConflitoDeUnicidade(erro: unknown): boolean {
  const e = erro as { code?: string; meta?: { code?: string } };
  return e?.code === 'P2002' || e?.meta?.code === '23505';
}
