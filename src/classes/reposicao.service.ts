import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { avaliarSaidaDeTurma } from '../company-settings/prazo-de-cancelamento';
import { antecedenciaEmMinutos } from './ocorrencia-relevante';
import { formatDateOnly, formatTimeOnly } from '../courts/date-time.util';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import type {
  CreditoDeReposicaoResponseDto,
  OportunidadeDeReposicaoResponseDto,
  ReposicaoCriadaResponseDto,
} from './dto/reposicao-response.dto';

/**
 * SPEC-046 — **a reposição de aula, que fecha o GAP-008.**
 *
 * ## O crédito é DERIVADO, e é a decisão que organiza o arquivo inteiro (D1)
 *
 * Não há coluna de saldo. Falta avisada sem reposição **é** o crédito:
 *
 * ```
 * crédito = faltas avisadas (dentro da validade, de aula não cancelada)
 *         − reposições feitas (em aula não cancelada)
 * ```
 *
 * Uma coluna de saldo seria uma terceira verdade sobre os mesmos dois fatos, e
 * a primeira a divergir — mesma decisão do `descontoCentavos` da SPEC-037. E é
 * o oposto da carteira da SPEC-033, onde o saldo É gravado, porque **dinheiro**
 * precisa de extrato com ordem e este crédito não é dinheiro.
 *
 * **A INV-118 (`UNIQUE (falta_id)`) é o que torna a subtração segura.** Sem
 * ela, dois `POST` simultâneos da mesma falta produziriam duas reposições para
 * uma falta e o crédito ficaria **negativo** — "derivado" viraria "inventado".
 *
 * Efeito colateral bom, e deliberado: a aula onde ele ia repor sendo cancelada
 * pelo clube **devolve o crédito sozinha** (D7), porque a reposição para de
 * contar. Nenhum estado, nenhum job.
 *
 * ## A ordem dos locks ganhou um nível em relação à SPEC-031 (D8)
 *
 * `turmas` (1) → `alunos` (2) → `ocupacoes_quadra` (3) → escrita.
 *
 * A `FaltaAvisadaService` toma **2 → 3** e declara aceita a corrida com
 * `removeStudent`, porque a elegibilidade é linearizada na consulta. **Aqui não
 * dá para aceitar a corrida análoga:** capacidade é contagem, e um
 * `allocateStudent` concorrente entre a contagem e a escrita produz turma acima
 * da capacidade — um corpo a mais numa quadra que tem tamanho. Então esta rota
 * toma `turmas FOR UPDATE` antes, em ordem crescente. Sem deadlock com a
 * SPEC-031: 1 antes de 2 antes de 3.
 */
@Injectable()
export class ReposicaoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operacao: ConfigOperacaoService,
  ) {}

  /** `alunoId` nunca vem do corpo nem da URL — é derivado do token. */
  private async alunoDoUsuario(
    companyId: string,
    usuarioId: string,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<{ id: string }> {
    const aluno = await tx.aluno.findFirst({
      where: { companyId, usuarioId },
      select: { id: true },
    });
    if (!aluno) throw new NotFoundException();
    return aluno;
  }

  /**
   * REQ-001 — o que o aluno tem para repor.
   *
   * Uma consulta só, com as reposições vindo por `include`: o N+1 aqui seria
   * uma ida ao banco por falta, numa tela que ele abre para ver todas.
   */
  async meuCredito(
    companyId: string,
    usuarioId: string,
  ): Promise<CreditoDeReposicaoResponseDto> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    const regra = await this.operacao.reposicaoDaEmpresa(companyId);
    const hoje = hojeNoFusoDoClube();

    const faltas = await this.prisma.faltaAvisada.findMany({
      where: { companyId, alunoId: aluno.id },
      include: {
        ocupacao: {
          select: {
            id: true,
            data: true,
            horaInicio: true,
            horaFim: true,
            statusPagamento: true,
            origemTurmaId: true,
            origemTurma: { select: { nome: true } },
          },
        },
        reposicao: {
          include: {
            ocupacao: {
              select: {
                data: true,
                horaInicio: true,
                statusPagamento: true,
                origemTurma: { select: { nome: true } },
              },
            },
          },
        },
      },
      orderBy: { avisadaEm: 'desc' },
    });

    let creditos = 0;
    const linhas = faltas.map((f) => {
      const expiraEm = new Date(f.ocupacao.data);
      expiraEm.setUTCDate(expiraEm.getUTCDate() + regra.validadeDias);
      const expirada = expiraEm < hoje;
      // AC-003 — aula que o clube cancelou não gera crédito: ele não perdeu
      // nada. E a falta continua listada (SPEC-031/D14) — sumir com ela faria
      // o aluno achar que nunca avisou.
      const aulaCancelada = f.ocupacao.statusPagamento === 'cancelado';
      // D7 — reposição em aula cancelada não conta, e o crédito volta sozinho.
      const reposta =
        f.reposicao !== null &&
        f.reposicao.ocupacao.statusPagamento !== 'cancelado';

      if (!expirada && !aulaCancelada && !reposta) creditos += 1;

      return {
        faltaId: f.id,
        turmaNome: f.ocupacao.origemTurma?.nome ?? null,
        data: formatDateOnly(f.ocupacao.data),
        horaInicio: formatTimeOnly(f.ocupacao.horaInicio),
        horaFim: formatTimeOnly(f.ocupacao.horaFim),
        expiraEm: formatDateOnly(expiraEm),
        expirada,
        aulaCancelada,
        reposicao: reposta
          ? {
              id: f.reposicao!.id,
              turmaNome: f.reposicao!.ocupacao.origemTurma?.nome ?? null,
              data: formatDateOnly(f.reposicao!.ocupacao.data),
              horaInicio: formatTimeOnly(f.reposicao!.ocupacao.horaInicio),
            }
          : null,
      };
    });

    return {
      creditos,
      porMes: regra.porMes,
      validadeDias: regra.validadeDias,
      usadasNoMes: await this.usadasNoMes(companyId, aluno.id, hoje),
      faltas: linhas,
    };
  }

  /**
   * D6 — o teto conta pelo **mês da FALTA**, não pelo da reposição.
   *
   * Quem faltou duas vezes em março tem duas reposições de março, e usá-las em
   * abril não consome o teto de abril. Contar pela reposição faria o aluno
   * perder crédito por causa da agenda do clube — ele avisou no prazo, e a
   * única turma com vaga era no mês seguinte.
   */
  private async usadasNoMes(
    companyId: string,
    alunoId: string,
    hoje: Date,
    tx: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<number> {
    // **O recorte do mês é do POSTGRES, e não daqui.**
    //
    // A primeira versão montava as bordas com `Date.UTC(hoje.getUTCFullYear(),
    // …)` — e o gate `fuso-do-clube.spec.ts` reprovou, pela **quarta vez neste
    // projeto**. Ele tem razão: `getUTCFullYear()` só aparece quando alguém
    // está montando data de "agora", e "mês" em UTC não é o mês do clube.
    //
    // `date_trunc` compara os dois lados no mesmo fuso da coluna `DATE`, e é o
    // mesmo caminho que a SPEC-037 escolheu para somar meses ao `fim` da
    // matrícula: aritmética de data no banco, não em JavaScript.
    const [linha] = await tx.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n
        FROM reposicoes_de_aula r
        JOIN faltas_avisadas f  ON f.id = r.falta_id
        JOIN ocupacoes_quadra o ON o.id = f.ocupacao_id
       WHERE r.company_id = ${companyId}::uuid
         AND r.aluno_id   = ${alunoId}::uuid
         AND date_trunc('month', o.data) = date_trunc('month', ${formatDateOnly(hoje)}::date)
    `;
    // `count(*)` volta como **bigint** do Postgres (a lição do
    // `make_interval` da SPEC-037): sem o `Number`, a comparação com o teto
    // seria `bigint >= number` e o TypeScript nem deixaria.
    return Number(linha.n);
  }

  /**
   * REQ-002 — onde ele pode repor.
   *
   * A vaga é o cálculo da D2, e ele é a razão de a LIM-031d deixar de ser o fim
   * da história: `matriculados − faltas avisadas nela + reposições nela`. Sem
   * subtrair as faltas, turma cheia nunca teria reposição — e a
   * funcionalidade nasceria morta onde ela mais importa.
   */
  async oportunidades(
    companyId: string,
    usuarioId: string,
  ): Promise<OportunidadeDeReposicaoResponseDto[]> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    const hoje = hojeNoFusoDoClube();

    // AC-005 — turma em que ele JÁ está não aparece: ele já é esperado lá, e a
    // chamada o mostraria duas vezes.
    const minhas = await this.prisma.turmaAluno.findMany({
      where: { alunoId: aluno.id },
      select: { turmaId: true },
    });
    const minhasIds = minhas.map((m) => m.turmaId);

    const ocorrencias = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        statusPagamento: { not: 'cancelado' },
        data: { gte: hoje },
        origemTurmaId: { notIn: minhasIds.length > 0 ? minhasIds : undefined },
        // AC-006 — turma inativa não recebe visita (SPEC-035): ela está fora de
        // operação, e a grade dela só existe por legado.
        origemTurma: { status: 'ativa' },
      },
      select: {
        id: true,
        data: true,
        horaInicio: true,
        horaFim: true,
        origemTurmaId: true,
        origemTurma: {
          select: {
            nome: true,
            capacidade: true,
            _count: { select: { alunos: true } },
          },
        },
        quadra: { select: { nome: true } },
        _count: { select: { faltas: true, reposicoes: true } },
      },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
      take: 200,
    });

    return ocorrencias
      .map((o) => {
        const ocupados =
          (o.origemTurma?._count.alunos ?? 0) -
          o._count.faltas +
          o._count.reposicoes;
        return {
          ocupacaoId: o.id,
          turmaId: o.origemTurmaId as string,
          turmaNome: o.origemTurma?.nome ?? '',
          quadraNome: o.quadra.nome,
          data: formatDateOnly(o.data),
          horaInicio: formatTimeOnly(o.horaInicio),
          horaFim: formatTimeOnly(o.horaFim),
          vagas: (o.origemTurma?.capacidade ?? 0) - ocupados,
        };
      })
      .filter((o) => o.vagas > 0);
  }

  /**
   * REQ-003 — marcar.
   *
   * A ordem dos locks é a da D8, e cada passo está numerado porque a ordem
   * **é** a regra: inverter dois deles é o caminho para deadlock com a
   * SPEC-031, que roda no mesmo par de tabelas.
   */
  async marcar(
    companyId: string,
    usuarioId: string,
    faltaId: string,
    ocupacaoId: string,
  ): Promise<ReposicaoCriadaResponseDto> {
    const agora = new Date();
    const hoje = hojeNoFusoDoClube();

    return this.prisma.$transaction(async (tx) => {
      // (0) A ocorrência de destino, e a TURMA dela — precisamos do id da turma
      // para travá-la primeiro.
      const alvo = await tx.ocupacaoQuadra.findFirst({
        where: { id: ocupacaoId, companyId, origemTipo: 'TURMA' },
        select: {
          id: true,
          data: true,
          horaInicio: true,
          horaFim: true,
          origemTurmaId: true,
          statusPagamento: true,
        },
      });
      if (!alvo?.origemTurmaId) throw new NotFoundException();

      // (1) TURMA — nível 1 do INV-029, e o motivo da D8: sem ele um
      // `allocateStudent` concorrente entra entre a contagem e a escrita.
      const turmas = await tx.$queryRaw<
        { id: string; capacidade: number; status: string }[]
      >`
        SELECT id, capacidade, status::text AS status
          FROM turmas
         WHERE id = ${alvo.origemTurmaId}::uuid
           AND company_id = ${companyId}::uuid
         FOR UPDATE
      `;
      const turma = turmas[0];
      if (!turma) throw new NotFoundException();
      if (turma.status !== 'ativa') {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'TURMA_INATIVA',
          message: 'Esta turma está fora de operação.',
        });
      }

      // (2) ALUNO — `FOR KEY SHARE` e não `FOR UPDATE`: esta rota **lê** o
      // aluno, e o que precisa é que ele não suma enquanto a reposição nasce.
      // Mesma escolha da `FaltaAvisadaService`.
      const alunos = await tx.$queryRaw<{ id: string }[]>`
        SELECT a.id
          FROM alunos a
         WHERE a.company_id = ${companyId}::uuid
           AND a.usuario_id = ${usuarioId}::uuid
         FOR KEY SHARE
      `;
      const aluno = alunos[0];
      if (!aluno) throw new NotFoundException();

      // (3) A OCORRÊNCIA de destino — nível 3. Trava o que estamos contando.
      await tx.$queryRaw`
        SELECT id FROM ocupacoes_quadra
         WHERE id = ${ocupacaoId}::uuid AND company_id = ${companyId}::uuid
         FOR UPDATE
      `;

      // AC-006 — não se repõe no que não vai acontecer, nem no passado.
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

      // AC-011 — já matriculado na turma de destino: ele já é esperado lá, e a
      // chamada o mostraria DUAS vezes (D5). A INV-120 não alcança este caso —
      // ela só cobre duplicata dentro da própria tabela.
      const jaNaTurma = await tx.turmaAluno.findFirst({
        where: { turmaId: alvo.origemTurmaId, alunoId: aluno.id },
        select: { turmaId: true },
      });
      if (jaNaTurma) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'JA_MATRICULADO_NA_TURMA',
          message: 'Você já faz parte desta turma — não precisa repor nela.',
        });
      }

      // A falta que ele quer usar. Tem de ser DELE, e a consulta carrega o
      // `companyId` de propósito: `faltaId` vem do corpo.
      const falta = await tx.faltaAvisada.findFirst({
        where: { id: faltaId, companyId, alunoId: aluno.id },
        include: {
          ocupacao: { select: { data: true, statusPagamento: true } },
          reposicao: { select: { id: true } },
        },
      });
      if (!falta) throw new NotFoundException();

      // AC-009 — a pré-checagem existe para a MENSAGEM; a garantia é a
      // INV-118. Mesma divisão de trabalho da `EXCLUDE` na INV-001.
      if (falta.reposicao) {
        throw new ConflictException({
          statusCode: 409,
          code: 'FALTA_JA_REPOSTA',
          message: 'Esta falta já foi reposta.',
        });
      }

      const regra = await this.operacao.reposicaoDaEmpresa(companyId, tx);

      // AC-008 — sem crédito: a falta que ele escolheu não vale.
      if (falta.ocupacao.statusPagamento === 'cancelado') {
        throw new ConflictException({
          statusCode: 409,
          code: 'SEM_CREDITO_DE_REPOSICAO',
          message:
            'O clube cancelou esta aula — você não a perdeu, e não há o que repor.',
        });
      }
      const expiraEm = new Date(falta.ocupacao.data);
      expiraEm.setUTCDate(expiraEm.getUTCDate() + regra.validadeDias);
      if (expiraEm < hoje) {
        throw new ConflictException({
          statusCode: 409,
          code: 'SEM_CREDITO_DE_REPOSICAO',
          message: `O prazo para repor esta falta era até ${formatDateOnly(expiraEm)}.`,
        });
      }

      // AC-012 — o teto, contado pelo mês da FALTA (D6).
      const usadas = await this.usadasNoMes(companyId, aluno.id, hoje, tx);
      if (usadas >= regra.porMes) {
        throw new ConflictException({
          statusCode: 409,
          code: 'TETO_DE_REPOSICAO',
          message: `Você já usou ${usadas} de ${regra.porMes} reposições deste mês.`,
          usadas,
          teto: regra.porMes,
        });
      }

      // AC-014 — o prazo, o mesmo da falta e com o mesmo código (SPEC-031/D23).
      const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);
      const veredicto = avaliarSaidaDeTurma({
        papelDoAutor: 'aluno',
        agora,
        ocorrenciaRelevante: {
          tipo: 'MINUTOS',
          minutos: antecedenciaEmMinutos(alvo.data, alvo.horaInicio, agora),
        },
        prazo: prazos.aula,
      });
      if (!veredicto.permitido) {
        throw new ConflictException({
          statusCode: 409,
          code: veredicto.code,
          message:
            prazos.aula.regra === 'HORAS'
              ? `Marcar reposição exige ${prazos.aula.horas}h de antecedência.`
              : 'Esta aula já começou.',
        });
      }

      // AC-010 — a vaga, pelo cálculo da D2. Com `turmas` e a ocorrência
      // travadas, esta contagem é a verdade até o COMMIT.
      const [matriculados, faltasNela, reposicoesNela] = await Promise.all([
        tx.turmaAluno.count({ where: { turmaId: alvo.origemTurmaId } }),
        tx.faltaAvisada.count({ where: { ocupacaoId } }),
        tx.reposicaoDeAula.count({ where: { ocupacaoId } }),
      ]);
      if (matriculados - faltasNela + reposicoesNela >= turma.capacidade) {
        throw new ConflictException({
          statusCode: 409,
          code: 'TURMA_SEM_VAGA',
          message: 'Esta aula já está cheia. Escolha outro horário.',
        });
      }

      const criada = await tx.reposicaoDeAula.create({
        data: {
          companyId,
          alunoId: aluno.id,
          faltaId: falta.id,
          ocupacaoId,
        },
        select: { id: true },
      });

      return {
        id: criada.id,
        faltaId: falta.id,
        ocupacaoId,
        data: formatDateOnly(alvo.data),
        horaInicio: formatTimeOnly(alvo.horaInicio),
        horaFim: formatTimeOnly(alvo.horaFim),
      };
    });
  }

  /**
   * AC-013/AC-014 — desmarcar, com o **mesmo prazo** e o mesmo código.
   *
   * *"Uma ação barrada com a inversa livre não é regra, é rodeio"*
   * (SPEC-031/D23). Sem o prazo aqui, o aluno desmarcaria cinco minutos antes
   * da aula e a vaga voltaria tarde demais para qualquer um usar.
   */
  async desmarcar(
    companyId: string,
    usuarioId: string,
    id: string,
  ): Promise<void> {
    const agora = new Date();

    await this.prisma.$transaction(async (tx) => {
      const aluno = await this.alunoDoUsuario(companyId, usuarioId, tx);
      const reposicao = await tx.reposicaoDeAula.findFirst({
        where: { id, companyId, alunoId: aluno.id },
        include: {
          ocupacao: { select: { data: true, horaInicio: true } },
        },
      });
      if (!reposicao) throw new NotFoundException();

      const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);
      const veredicto = avaliarSaidaDeTurma({
        papelDoAutor: 'aluno',
        agora,
        ocorrenciaRelevante: {
          tipo: 'MINUTOS',
          minutos: antecedenciaEmMinutos(
            reposicao.ocupacao.data,
            reposicao.ocupacao.horaInicio,
            agora,
          ),
        },
        prazo: prazos.aula,
      });
      if (!veredicto.permitido) {
        throw new ConflictException({
          statusCode: 409,
          code: veredicto.code,
          message:
            prazos.aula.regra === 'HORAS'
              ? `Desmarcar exige ${prazos.aula.horas}h de antecedência.`
              : 'Esta aula já começou.',
        });
      }

      await tx.reposicaoDeAula.delete({ where: { id: reposicao.id } });
    });
  }
}
