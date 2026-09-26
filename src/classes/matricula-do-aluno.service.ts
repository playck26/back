import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { encerrarFila, MOTIVO } from '../fila-de-espera/encerramento-da-fila';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { avaliarSaidaDeTurma } from '../company-settings/prazo-de-cancelamento';
import { ocorrenciaRelevante } from './ocorrencia-relevante';
import {
  aulaQueAMatriculaLotaria,
  aulasQueAMatriculaLotaria,
  diaEMes,
} from './ocupacao-da-ocorrencia';
import {
  nivelEfetivoDoAluno,
  podeEntrarPorNivel,
  recusaPorNivel,
  travarNivelDaEmpresa,
} from '../people/nivel-efetivo';

/**
 * SPEC-023 — **o aluno entra e sai de turma sozinho.**
 *
 * Mora fora de `ClassesService` de propósito: lá é o CRUD do gestor, e as
 * regras daqui são de outro ator. Misturar deixaria as regras do aluno
 * valendo, sem querer, para o caminho do gestor — que é o oposto do que a
 * SPEC-023 decide (o gestor continua podendo tudo o que já podia, REQ-006).
 *
 * **O que este serviço NÃO reinventa:** a trava de capacidade. `INV-003` é
 * `SELECT ... FOR UPDATE` na linha da turma, e existe desde a SPEC-003. O
 * caminho do aluno usa a mesma trava na mesma linha — dois caminhos de
 * matrícula com travas diferentes seriam duas verdades sobre a mesma vaga.
 */
@Injectable()
export class MatriculaDoAlunoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operacao: ConfigOperacaoService,
  ) {}

  /**
   * Resolve o aluno a partir do usuário do token.
   *
   * `ForbiddenException` e não `NotFound`: quem chega aqui tem papel
   * `aluno` no token mas não tem linha em `alunos` — é sessão inconsistente,
   * não recurso ausente.
   */
  private async alunoDoUsuario(companyId: string, usuarioId: string) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }
    return aluno;
  }

  /**
   * REQ-001 — as turmas do clube, com a ocupação à vista.
   *
   * **Turma cheia aparece, marcada como cheia.** Some com ela e a pessoa vai
   * perguntar no WhatsApp por que a turma das 18h sumiu.
   *
   * `podeEntrar` vem calculado do servidor junto com o `motivo`, em vez de a
   * tela deduzir: se a tela deduzir, ela vira uma segunda cópia das regras,
   * e é a cópia que fica velha.
   */
  async disponiveis(companyId: string, usuarioId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const [empresa, turmas, minhas] = await Promise.all([
      this.prisma.empresa.findUniqueOrThrow({
        where: { id: companyId },
        select: { limiteTurmasPorAluno: true },
      }),
      this.prisma.turma.findMany({
        where: { companyId },
        select: {
          id: true,
          nome: true,
          status: true,
          capacidade: true,
          // SPEC-057/TASK-004 — o nível vai junto porque a tela filtra por ele.
          // `nivelId` para comparar, `nivel.nome` para escrever na chip: sem o
          // nome, a tela teria de buscar o catálogo de níveis, que é fechado
          // para o aluno (AC-027).
          nivelId: true,
          nivel: { select: { nome: true } },
          encontros: {
            select: { diaSemana: true, horaInicio: true, horaFim: true },
          },
          _count: { select: { alunos: true } },
        },
        orderBy: { nome: 'asc' },
      }),
      this.prisma.turmaAluno.findMany({
        where: { alunoId: aluno.id },
        select: { turmaId: true },
      }),
    ]);

    const minhasIds = new Set(minhas.map((alocacao) => alocacao.turmaId));
    const noLimite =
      empresa.limiteTurmasPorAluno !== null &&
      minhasIds.size >= empresa.limiteTurmasPorAluno;

    // SPEC-075/D3 (INV-075b) — **a lista não oferece o que o servidor recusa.**
    // Some a turma que o aluno não pode entrar por nível E na qual ele não
    // está: a turma em que ele já está (de antes da regra, D6) continua,
    // porque é por ela que ele sai. O recorte não vira `motivo` — um motivo
    // novo apareceria como texto que o Cliente no ar não conhece.
    const efetivo = await nivelEfetivoDoAluno(
      this.prisma,
      companyId,
      aluno.nivelId,
    );

    const visiveis = turmas.filter(
      (turma) =>
        minhasIds.has(turma.id) || podeEntrarPorNivel(turma.nivelId, efetivo),
    );

    // A regra de 2026-09-26 (`aulasQueAMatriculaLotaria`): a turma com vaga
    // de matrícula mas com uma próxima aula lotada por reposições aparece
    // CHEIA — senão a lista oferece "Entrar" e o `POST` recusa. Só para as
    // que chegariam à checagem de vaga, e numa ida só para todas.
    const lotadas = await aulasQueAMatriculaLotaria(
      this.prisma,
      companyId,
      visiveis.filter(
        (turma) =>
          !minhasIds.has(turma.id) &&
          aluno.vinculo === 'aprovado' &&
          turma.status === 'ativa' &&
          !noLimite &&
          turma._count.alunos < turma.capacidade,
      ),
      aluno.id,
      new Date(),
    );

    return visiveis.map((turma) => {
      const matriculados = turma._count.alunos;
      const jaEstouNela = minhasIds.has(turma.id);
      const motivo = this.motivoDeBloqueio({
        jaEstouNela,
        status: turma.status,
        matriculados,
        capacidade: turma.capacidade,
        vinculo: aluno.vinculo,
        noLimite,
        aulaLotada: lotadas.has(turma.id),
      });

      return {
        id: turma.id,
        nome: turma.nome,
        status: turma.status,
        capacidade: turma.capacidade,
        matriculados,
        jaEstouNela,
        podeEntrar: motivo === null && !jaEstouNela,
        motivo,
        nivelId: turma.nivelId,
        nivelNome: turma.nivel ? turma.nivel.nome : null,
        encontros: turma.encontros.map((encontro) => ({
          diaSemana: encontro.diaSemana,
          horaInicio: encontro.horaInicio.toISOString().slice(11, 16),
          horaFim: encontro.horaFim.toISOString().slice(11, 16),
        })),
      };
    });
  }

  /**
   * A ordem das checagens **é a mensagem**: quem já está na turma não precisa
   * ouvir que ela está cheia, e aluno não aprovado ouve isso antes de
   * qualquer coisa sobre vaga — o problema dele não é a vaga.
   */
  private motivoDeBloqueio(dados: {
    jaEstouNela: boolean;
    status: string;
    matriculados: number;
    capacidade: number;
    vinculo: string;
    noLimite: boolean;
    aulaLotada: boolean;
  }): string | null {
    if (dados.jaEstouNela) return null;
    if (dados.vinculo !== 'aprovado') return 'ALUNO_NAO_APROVADO';
    if (dados.status !== 'ativa') return 'TURMA_INATIVA';
    if (dados.noLimite) return 'LIMITE_DE_TURMAS';
    if (dados.matriculados >= dados.capacidade) return 'TURMA_CHEIA';
    if (dados.aulaLotada) return 'TURMA_CHEIA';
    return null;
  }

  /**
   * REQ-002/REQ-003 — entrar.
   *
   * Tudo dentro da transação que trava a linha da turma. Checar antes de
   * abrir a transação deixaria janela entre a checagem e a escrita — é a
   * mesma razão pela qual `allocateStudent` já fazia assim.
   */
  async entrar(companyId: string, usuarioId: string, turmaId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    return this.prisma.$transaction(async (tx) => {
      // SPEC-075/D13 — a trava de nível da empresa, PRIMEIRA instrução, antes
      // do `FOR UPDATE` da turma que o `entrarNaTransacao` toma. O
      // `entrarNaTransacao` não a toma: quem o chama já a tomou (este `entrar`
      // e o `confirmar` da fila) — e a AC-029 fixa quem pode chamá-lo.
      await travarNivelDaEmpresa(tx, companyId);
      return this.entrarNaTransacao(tx, companyId, aluno, turmaId);
    });
  }

  /**
   * O mesmo gesto, **sob uma transação de fora** (SPEC-064).
   *
   * A confirmação da fila de espera precisa matricular **dentro da transação
   * dela**, junto com o `UPDATE` da linha para `atendida`. Um `$transaction`
   * aninhado não daria atomicidade, e duplicar as cinco checagens daria
   * drift — a mesma razão que partiu o `ReposicaoService.marcar`.
   *
   * Toma `turmas` (nível 1) e **não toma `alunos`**: o aluno é lido, não
   * escrito. A ordem canônica da SPEC-064 conta com isso.
   */
  async entrarNaTransacao(
    tx: Prisma.TransactionClient,
    companyId: string,
    aluno: { id: string; vinculo: string },
    turmaId: string,
  ) {
    const turmaRows = await tx.$queryRaw<
      {
        id: string;
        capacidade: number;
        status: string;
        nivel_id: string | null;
      }[]
    >`
      SELECT id, capacidade, status::text AS status, nivel_id::text AS nivel_id
        FROM turmas
      WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
      FOR UPDATE
    `;
    const turma = turmaRows[0];
    // 404 e não 403: dizer "existe mas não é sua" já entrega informação
    // sobre a outra empresa (INV-023b).
    if (!turma) {
      throw new NotFoundException();
    }

    // Idempotente por decisão de desenho: toque duplo em conexão ruim é o
    // caso real, e entrar duas vezes é o mesmo estado.
    const jaAlocado = await tx.turmaAluno.findFirst({
      where: { turmaId, alunoId: aluno.id },
    });
    if (jaAlocado) {
      return jaAlocado;
    }

    if (aluno.vinculo !== 'aprovado') {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'ALUNO_NAO_APROVADO',
        message:
          'Seu cadastro ainda está aguardando a aprovação do clube. Assim que for aprovado, você poderá entrar nas turmas.',
      });
    }

    if (turma.status !== 'ativa') {
      throw new ConflictException({
        statusCode: 409,
        code: 'TURMA_INATIVA',
        message: 'Esta turma não está ativa.',
      });
    }

    const empresa = await tx.empresa.findUniqueOrThrow({
      where: { id: companyId },
      select: { limiteTurmasPorAluno: true },
    });
    if (empresa.limiteTurmasPorAluno !== null) {
      const minhas = await tx.turmaAluno.count({
        where: { alunoId: aluno.id },
      });
      if (minhas >= empresa.limiteTurmasPorAluno) {
        throw new ConflictException({
          statusCode: 409,
          code: 'LIMITE_DE_TURMAS',
          message: `Você já está em ${minhas} turma(s), que é o limite deste clube.`,
        });
      }
    }

    // SPEC-075/D3 — **o nível, a última recusa antes da de capacidade.** Depois
    // do `jaAlocado` (tocar de novo numa turma em que já está devolve a
    // matrícula que existe, D6) e antes de `TURMA_CHEIA`: "cheia" é passageira
    // e leva à fila, que recusaria por nível — dizer "cheia" a quem nunca
    // poderia entrar é mandá-lo a uma porta trancada. Lido pelo `tx`, sem lock
    // novo; lançado depois de leituras e antes de escrever, que é o que faz a
    // confirmação da fila encerrar a linha em vez de abortar (SPEC-064).
    const doAluno = await tx.aluno.findUniqueOrThrow({
      where: { id: aluno.id },
      select: { nivelId: true },
    });
    const recusa = await recusaPorNivel(
      tx,
      companyId,
      turma.nivel_id,
      doAluno.nivelId,
      'aluno',
    );
    if (recusa) throw new UnprocessableEntityException(recusa);

    // Sob a trava: é a checagem que a concorrência ataca.
    const alocados = await tx.turmaAluno.count({ where: { turmaId } });
    if (alocados >= turma.capacidade) {
      throw new ConflictException({
        statusCode: 409,
        code: 'TURMA_CHEIA',
        message: 'Esta turma já está com todas as vagas ocupadas.',
      });
    }

    // E cabe em TODAS as próximas aulas, contando as reposições já marcadas
    // (decisão do Israel, 2026-09-26): a vaga de um dia já dada a uma
    // reposição não pode ser dada de novo a quem entra na turma. Mesmo `code`
    // de turma cheia — é o que o Cliente no ar sabe mostrar —, com o dia.
    const lotaria = await aulaQueAMatriculaLotaria(
      tx,
      companyId,
      { id: turmaId, capacidade: turma.capacidade },
      aluno.id,
      new Date(),
    );
    if (lotaria) {
      throw new ConflictException({
        statusCode: 409,
        code: 'TURMA_CHEIA',
        message: `A aula de ${diaEMes(lotaria.data)} desta turma já está com todas as vagas ocupadas, contando as reposições marcadas.`,
      });
    }

    return tx.turmaAluno.create({ data: { turmaId, alunoId: aluno.id } });
  }

  /**
   * SPEC-031/REQ-003 — sair da turma, com o prazo que o clube configurou.
   *
   * **Substitui a regra `AULA_HOJE` da SPEC-023.** O `FOR UPDATE` continua
   * sendo o par do lock que `PresencaService.salvarChamada` pega: sem este
   * lado, o de lá não trava nada — quem não pede lock não respeita lock.
   *
   * ## A sequência do D16, e ela é dentro da MESMA transação
   *
   * | # | Passo |
   * |---|---|
   * | 1 | `turmas … FOR UPDATE` |
   * | 2 | conferir matrícula — 404 antes de qualquer regra |
   * | 3 | `ocorrenciaRelevante(tx, …)`, **depois** do lock |
   * | 4 | ler a configuração pelo mesmo `tx`, **sem `FOR UPDATE`** |
   * | 5 | `avaliarSaidaDeTurma(…)` |
   * | 7 | `DELETE turma_alunos` |
   *
   * *(O passo 6 — registrar a ação administrativa — é do caminho do GESTOR,
   * TASK-005. O aluno saindo por conta própria não gera ação administrativa.)*
   *
   * **Ler a ocorrência FORA do bloco seria decidir sobre a grade antiga:** o
   * gestor edita o horário da turma, `cancelFutureClassOccupancies` cancela as
   * futuras em massa, e a política já leu.
   *
   * **O passo 4 não leva `FOR UPDATE` de propósito.** O `SELECT` dentro da
   * transação já dá a garantia que importa — vale o prazo commitado antes
   * desta leitura; um `PUT /operacao` que commite depois vale para a próxima
   * operação. Travar a configuração faria toda saída de turma serializar
   * contra toda outra saída da mesma empresa.
   */
  async sair(companyId: string, usuarioId: string, turmaId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    // Injetado uma vez e usado nos passos 3 e 5: duas leituras de relógio na
    // mesma decisão poderiam cair em minutos diferentes.
    const agora = new Date();

    await this.prisma.$transaction(async (tx) => {
      const turmaRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;
      if (!turmaRows[0]) {
        throw new NotFoundException();
      }

      const alocacao = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId: aluno.id },
      });
      // Sair de onde não se está é engano, e merece 404 — silenciar
      // esconderia bug de tela.
      if (!alocacao) {
        throw new NotFoundException();
      }

      const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);

      /**
       * **Rollout passo 3 (D11): o `AULA_HOJE` deixou de existir.**
       *
       * Até aqui havia um ramo para empresa **sem** prazo configurado, que
       * mantinha a regra antiga ("tem aula hoje") e o código antigo, para o
       * cliente publicado não quebrar. Os passos 1 e 2 fecharam — o back
       * emitiu os dois códigos, e os três frontends foram publicados
       * classificando a resposta —, então o ramo saiu.
       *
       * **Isto muda comportamento em produção, e a mudança é deliberada
       * (AC-003).** Quem nunca configurou prazo era barrado por "tem aula
       * hoje", que é MAIS restritivo: o aluno não saía no dia da aula nem às
       * 6h da manhã. Agora só o corte de `minutos <= 0` age (D5b), e ele sai
       * até a aula começar.
       *
       * É a única mudança que esta spec impõe a quem não pediu nada — e a
       * tela do gestor a anuncia desde a TASK-009a, no cartão do prazo.
       *
       * A política é chamada **sempre**, inclusive com `SEM_PRAZO`. Pular a
       * chamada quando não há prazo devolveria o `if` pela porta dos fundos e
       * perderia o corte do D5b, que não depende de configuração nenhuma.
       */
      const veredicto = avaliarSaidaDeTurma({
        papelDoAutor: 'aluno',
        agora,
        ocorrenciaRelevante: await ocorrenciaRelevante(
          tx,
          companyId,
          turmaId,
          agora,
        ),
        prazo: prazos.aula,
      });
      if (!veredicto.permitido) {
        throw new ConflictException({
          statusCode: 409,
          code: veredicto.code,
          // AC-006: dizer QUANTAS horas o clube exige. "Fora do prazo" sem o
          // número obriga o aluno a descobrir por tentativa.
          //
          // Sem prazo configurado não há número a dizer: a recusa só acontece
          // depois de a aula começar, e a frase certa é essa. Mesmo par de
          // mensagens do `falta-avisada.service.ts`.
          message:
            prazos.aula.regra === 'HORAS'
              ? `Esta turma exige ${prazos.aula.horas}h de antecedência para sair.`
              : 'Esta aula já começou.',
          ...(prazos.aula.regra === 'HORAS'
            ? { horasExigidas: prazos.aula.horas }
            : {}),
        });
      }

      await tx.turmaAluno.delete({ where: { id: alocacao.id } });

      // SPEC-064/D6 — sair da turma tira da fila dela. Sem aviso: foi ele
      // quem pediu.
      await encerrarFila(
        tx,
        companyId,
        { turmaEAluno: { turmaId, alunoId: aluno.id } },
        MOTIVO.SAIU_DA_TURMA,
      );
    });
  }
}
