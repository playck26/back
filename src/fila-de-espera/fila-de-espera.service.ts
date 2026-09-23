import {
  ConflictException,
  HttpException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { MatriculaDoAlunoService } from '../classes/matricula-do-aluno.service';
import { ReposicaoService } from '../classes/reposicao.service';
import { situacaoDoCredito } from '../classes/credito-de-reposicao';
import {
  formatDateOnly,
  formatTimeOnly,
  hojeNoFusoDoClube,
} from '../courts/date-time.util';
import type { LinhaDaFilaResponseDto } from './dto/fila-de-espera.dto';

/**
 * D5 - **a recusa e resultado de dominio, nao excecao.**
 *
 * *"O encerramento COMITA"* (achado v2-03, reaberto em v4-06): a transacao
 * grava `encerrada` com o motivo e **termina**; o `409` e montado **fora**
 * dela. Lancar excecao dentro do callback reverteria o proprio encerramento, e
 * o chamado morto continuaria aparecendo para a pessoa.
 */
export type ResultadoDaConfirmacao =
  | { ok: true; fila: 'turma' | 'aula'; reposicaoId: string | null }
  | { ok: false; code: string; message: string };

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
    // **Compor, e nao reescrever.** As duas confirmacoes sao o gesto que ja
    // existe - matricular e marcar reposicao -, e duplicar as regras deles
    // aqui seria a terceira copia da mesma conta.
    private readonly matriculas: MatriculaDoAlunoService,
    private readonly reposicoes: ReposicaoService,
  ) {}

  /** `alunoId` nunca vem do corpo nem da URL — é derivado do token. Mesma
   *  regra do `ReposicaoService`, e pelo mesmo motivo (SPEC-031/D19). */
  private async alunoDoUsuario(
    companyId: string,
    usuarioId: string,
  ): Promise<{ id: string; vinculo: string }> {
    // `vinculo` entra porque a confirmacao de TURMA o exige: `entrarNaTransacao`
    // recusa quem nao esta aprovado, e le o vinculo do objeto que recebe.
    const aluno = await this.prisma.aluno.findFirst({
      where: { companyId, usuarioId },
      select: { id: true, vinculo: true },
    });
    if (!aluno) throw new NotFoundException();
    return aluno;
  }

  /**
   * SPEC-064/TASK-005 — **as filas vivas do aluno, para a tela dele.**
   *
   * ## Por que só `aguardando` e `chamado`
   *
   * São os dois estados não-terminais (D2), e a pergunta que a tela responde é
   * *"onde eu ainda estou esperando?"*. Linha terminada não é fila: é
   * histórico, e histórico de fila ninguém pediu. O que aconteceu com ela
   * continua na **caixa de avisos**, que guarda o chamado.
   *
   * ## `vezAberta` é calculado aqui, e não lido do estado
   *
   * A D8 é explícita: *"mesmo com o varredor desligado, chamados vivos expiram
   * na leitura — a tela e a confirmação conferem `chamado_ate`"*. Uma linha
   * pode estar `chamado` no banco com o prazo já vencido, porque quem a expira
   * é um agendador que pode estar parado. **Mostrar "confirme agora" nesse
   * caso seria oferecer o que o `confirmar` vai recusar** com `VEZ_EXPIRADA` —
   * a armadilha do DEF-011, que este projeto já pagou.
   *
   * A comparação é a mesma do `confirmar`: prazo **no passado** fecha a vez.
   */
  async minhasLinhas(companyId: string, usuarioId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const linhas = await this.prisma.listaDeEspera.findMany({
      where: {
        companyId,
        alunoId: aluno.id,
        estado: { in: ['aguardando', 'chamado'] },
      },
      select: {
        id: true,
        estado: true,
        turmaId: true,
        ocupacaoId: true,
        criadaEm: true,
        chamadoAte: true,
        turma: { select: { nome: true } },
        ocupacao: {
          select: {
            data: true,
            horaInicio: true,
            horaFim: true,
            quadra: { select: { nome: true } },
            origemTurma: { select: { nome: true } },
          },
        },
      },
      // **Ordem total**, e o `id` no fim não é enfeite: duas entradas no mesmo
      // instante (o `criada_em` tem precisão de microssegundo, mas empate
      // existe) ficariam em ordem indefinida entre duas leituras, e a lista
      // trocaria de ordem sozinha na cara da pessoa.
      orderBy: [{ criadaEm: 'asc' }, { id: 'asc' }],
    });

    const agora = new Date();
    return linhas.map((l) => ({
      id: l.id,
      fila: l.turmaId ? 'turma' : 'aula',
      estado: l.estado,
      vezAberta:
        l.estado === 'chamado' &&
        l.chamadoAte !== null &&
        l.chamadoAte.getTime() > agora.getTime(),
      chamadoAte: l.chamadoAte?.toISOString() ?? null,
      turmaId: l.turmaId,
      turmaNome: l.turma?.nome ?? l.ocupacao?.origemTurma?.nome ?? null,
      ocupacaoId: l.ocupacaoId,
      data: l.ocupacao ? formatDateOnly(l.ocupacao.data) : null,
      horaInicio: l.ocupacao ? formatTimeOnly(l.ocupacao.horaInicio) : null,
      horaFim: l.ocupacao ? formatTimeOnly(l.ocupacao.horaFim) : null,
      quadraNome: l.ocupacao?.quadra.nome ?? null,
      criadaEm: l.criadaEm.toISOString(),
    }));
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
   * REQ-003 - **confirmar a vez, e o encerramento nao se desfaz.**
   *
   * ## A ordem canonica de QUATRO niveis, e a v2 nao a escrevia
   *
   * ```
   * 1  turmas FOR UPDATE                 (a turma, ou a da ocupacao)
   * 2  alunos FOR KEY SHARE              (so na fila de AULA)
   * 3  ocupacoes_quadra FOR UPDATE       (so na fila de aula)
   * 4  lista_de_espera FOR UPDATE        (a linha do chamado, POR ULTIMO)
   * ```
   *
   * A v2 dizia *"sob a ordem canonica"* **sem escreve-la**, e foi isso que
   * permitiu o ciclo: o varredor segurava a turma e queria a linha da fila; a
   * confirmacao segurava a linha e queria a turma. Deadlock sob exatamente a
   * carga que esta spec existe para criar.
   *
   * **O nivel 2 entra so na fila de AULA**, e a v3 o deixava de fora (achado
   * da 2a rodada): a confirmacao ali **cria `reposicoes_de_aula`**, que e a
   * mesma escrita do `ReposicaoService`, e ele toma `1->2->3`. Pular o
   * `alunos FOR KEY SHARE` faria a confirmacao e a reposicao pela tela normal
   * tomarem ordens diferentes sobre as mesmas linhas.
   *
   * Na fila de TURMA ele fica fora com razao nomeada: ali a confirmacao e uma
   * matricula, e `entrarNaTransacao` tambem nao toma `alunos` - o aluno e
   * lido, nao escrito.
   *
   * ## A leitura que identifica a linha pode ser sem lock
   *
   * E e: sem ela nao ha como saber QUAL turma travar primeiro. O `FOR UPDATE`
   * da linha vem no fim, e tudo o que importa e reconferido sob ele.
   *
   * ## A fila nao reserva a vaga (LIM-064a)
   *
   * Confirmar pode falhar - alguem pode ter levado a vaga pela tela normal
   * durante o prazo (LIM-064f). Quando falha, a linha vira `encerrada` **e o
   * encerramento comita**; a recusa volta como resultado, nao como excecao.
   */
  async confirmar(
    companyId: string,
    usuarioId: string,
    id: string,
  ): Promise<ResultadoDaConfirmacao> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const linha = await this.prisma.listaDeEspera.findFirst({
      where: { id, companyId, alunoId: aluno.id },
      select: { id: true, turmaId: true, ocupacaoId: true, faltaId: true },
    });
    if (!linha) throw new NotFoundException();

    return this.prisma.$transaction(async (tx) => {
      const fila = linha.ocupacaoId ? 'aula' : 'turma';

      // Sem lock: so para descobrir QUAL turma travar primeiro.
      const ocupacao = linha.ocupacaoId
        ? await tx.ocupacaoQuadra.findFirst({
            where: { id: linha.ocupacaoId, companyId },
            select: { id: true, origemTurmaId: true },
          })
        : null;
      const turmaId = linha.turmaId ?? ocupacao?.origemTurmaId;
      if (!turmaId) throw new NotFoundException();

      // ---- 1. TURMA
      await tx.$queryRaw`
        SELECT id FROM turmas
         WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
         FOR UPDATE`;

      // ---- 2. ALUNO, so na fila de aula (ela cria reposicao)
      if (fila === 'aula') {
        await tx.$queryRaw`
          SELECT id FROM alunos
           WHERE company_id = ${companyId}::uuid
             AND usuario_id = ${usuarioId}::uuid
           FOR KEY SHARE`;
      }

      // ---- 3. OCUPACAO, so na fila de aula
      if (ocupacao) {
        await tx.$queryRaw`
          SELECT id FROM ocupacoes_quadra
           WHERE id = ${ocupacao.id}::uuid AND company_id = ${companyId}::uuid
           FOR UPDATE`;
      }

      // ---- 4. A LINHA, por ultimo
      const travadas = await tx.$queryRaw<
        { estado: string; vencida: boolean }[]
      >`
        SELECT estado::text AS estado,
               (chamado_ate IS NULL OR chamado_ate < now()) AS vencida
          FROM lista_de_espera
         WHERE id = ${linha.id}::uuid
         FOR UPDATE`;
      const travada = travadas[0];
      if (!travada) throw new NotFoundException();

      if (travada.estado !== 'chamado') {
        // Nao encerra: a linha ja esta no estado que esta, e sobrescrever o
        // motivo apagaria por que ela terminou.
        return {
          ok: false as const,
          code: 'NAO_E_SUA_VEZ',
          message: 'Esta vez nao esta mais aberta.',
        };
      }

      // **A tela nao depende do varredor para isto** (D8): a confirmacao
      // confere o prazo por conta propria, entao um varredor desligado nao
      // deixa ninguem confirmar uma vez vencida.
      if (travada.vencida) {
        return this.encerrar(
          tx,
          linha.id,
          'prazo vencido',
          'VEZ_EXPIRADA',
          'O prazo desta vez venceu.',
        );
      }

      try {
        let reposicaoId: string | null = null;
        if (fila === 'aula') {
          const criada = await this.reposicoes.marcarNaTransacao(
            tx,
            companyId,
            usuarioId,
            linha.faltaId as string,
            (ocupacao as { id: string }).id,
          );
          reposicaoId = criada.id;
        } else {
          await this.matriculas.entrarNaTransacao(
            tx,
            companyId,
            aluno,
            turmaId,
          );
        }

        // AC-007 - **os dois comitam juntos.** Separa-los deixaria alguem com
        // reposicao marcada e fila ainda `chamado`, ou o contrario.
        await tx.$executeRaw`
          UPDATE lista_de_espera
             SET estado = 'atendida', concluida_em = now(),
                 motivo_fim = 'confirmou'
           WHERE id = ${linha.id}::uuid`;

        return { ok: true as const, fila, reposicaoId };
      } catch (erro) {
        // **Recusa de dominio vira resultado; erro de banco sobe.**
        //
        // A diferenca importa: as recusas dos dois servicos sao lancadas
        // depois de LEITURAS bem-sucedidas, entao a transacao continua
        // utilizavel e o encerramento pode comitar. Um erro do banco (um
        // `23505` na INV-118, por exemplo) **aborta** a transacao - ai nao ha
        // o que comitar, e deixar a linha em `chamado` e o certo: a pessoa
        // tenta de novo, ou o varredor expira.
        if (!(erro instanceof HttpException)) throw erro;
        const corpo = erro.getResponse() as { code?: string; message?: string };
        return this.encerrar(
          tx,
          linha.id,
          corpo.code ?? 'recusada',
          corpo.code ?? 'CONFIRMACAO_RECUSADA',
          corpo.message ?? 'Nao foi possivel confirmar esta vez.',
        );
      }
    });
  }

  /** Encerra a linha **e devolve a recusa** - nunca lanca. */
  private async encerrar(
    tx: Prisma.TransactionClient,
    id: string,
    motivo: string,
    code: string,
    message: string,
  ): Promise<ResultadoDaConfirmacao> {
    await tx.$executeRaw`
      UPDATE lista_de_espera
         SET estado = 'encerrada', concluida_em = now(), motivo_fim = ${motivo}
       WHERE id = ${id}::uuid`;
    return { ok: false as const, code, message };
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
