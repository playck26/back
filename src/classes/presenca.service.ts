import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { OcupacaoQuadra, StatusPresenca } from '@prisma/client';
import { formatDateOnly, formatTimeOnly } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';

/** SPEC-014/INV-017: janela em que a chamada pode ser lançada. */
export const JANELA_RETROATIVA_DIAS = 7;

export interface ItemChamada {
  alunoId: string;
  status: StatusPresenca;
}

/**
 * SPEC-014 — chamada por ocorrência de aula.
 *
 * Mora em MOD-004 (turmas), que é o dono de `presencas`. MOD-005 (quadras)
 * só é lido: a INV-016 ser regra de **escrita** — e não estado permanente —
 * é o que mantém essa direção. Se presença tivesse de continuar válida para
 * sempre, `cancelFutureClassOccupancies` precisaria conhecer presença, e
 * MOD-005 passaria a depender de MOD-004.
 */
@Injectable()
export class PresencaService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SPEC-014/INV-017 — "hoje" na única data operacional que o produto tem.
   *
   * Não há fuso configurável (gap declarado na `ARCHITECTURE.md`), e esta
   * spec **não** introduz um: fuso atravessa empresa, agenda, dashboard e
   * disponibilidade. Segue a mesma convenção UTC-truncada que
   * `gerarDatasSemanaisFuturas` e o resto do domínio já usam — o importante
   * é ser a **mesma** convenção, não uma nova.
   */
  private hoje(): Date {
    const agora = new Date();
    return new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()),
    );
  }

  /**
   * INV-018 — o professor vem do **banco**, pelo usuário autenticado. O JWT
   * não carrega `professorId` (SPEC-013/ACHADO-003): claim é fotografia do
   * login, e autorização precisa do presente.
   */
  private async professorDoUsuario(companyId: string, usuarioId: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { usuarioId, companyId },
      select: { id: true },
    });
    if (!professor) {
      throw new ForbiddenException();
    }
    return professor;
  }

  /**
   * A versão da chamada (INV-019). Deriva do estado, em vez de virar coluna:
   * uma coluna `versao` precisaria ser incrementada por quem escreve, e
   * quem esquecesse de incrementar criaria um controle de concorrência que
   * não controla nada.
   */
  private versaoDe(linhas: { updatedAt: Date }[]): string {
    if (linhas.length === 0) {
      return '0';
    }
    const maior = linhas.reduce(
      (max, l) => (l.updatedAt > max ? l.updatedAt : max),
      linhas[0].updatedAt,
    );
    return `${linhas.length}:${maior.getTime()}`;
  }

  /** Ocorrência + turma, já verificando que a turma é do professor (AC-005). */
  private async ocorrenciaDoProfessor(
    companyId: string,
    professorId: string,
    ocupacaoId: string,
  ): Promise<OcupacaoQuadra & { origemTurmaId: string }> {
    // `professorId` no WHERE, e não conferido depois de buscar: ocorrência
    // de colega devolve 404, não 403 — 403 confirmaria que existe.
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: {
        id: ocupacaoId,
        companyId,
        origemTipo: 'TURMA',
        origemTurma: { professorId },
      },
    });
    if (!ocupacao?.origemTurmaId) {
      throw new NotFoundException();
    }
    return ocupacao as OcupacaoQuadra & { origemTurmaId: string };
  }

  async ocorrenciasDaTurma(
    companyId: string,
    usuarioId: string,
    turmaId: string,
    janelaDias: number,
  ) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId, professorId: professor.id },
      select: { id: true, nome: true, _count: { select: { alunos: true } } },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    const desde = new Date(this.hoje());
    desde.setUTCDate(desde.getUTCDate() - janelaDias);

    const ocorrencias = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        data: { gte: desde },
      },
      include: { _count: { select: { presencas: true } } },
      orderBy: [{ data: 'desc' }, { horaInicio: 'desc' }],
    });

    const hoje = this.hoje();
    return ocorrencias.map((o) => ({
      ocupacaoId: o.id,
      data: formatDateOnly(o.data),
      horaInicio: formatTimeOnly(o.horaInicio),
      horaFim: formatTimeOnly(o.horaFim),
      cancelada: o.statusPagamento === 'cancelado',
      // O que o professor precisa ver de relance: o que falta lançar.
      chamadaFeita: o._count.presencas > 0,
      marcados: o._count.presencas,
      totalAlunos: turma._count.alunos,
      podeLancar:
        o.statusPagamento !== 'cancelado' &&
        o.data.getTime() <= hoje.getTime() &&
        o.data.getTime() >=
          hoje.getTime() - JANELA_RETROATIVA_DIAS * 24 * 60 * 60 * 1000,
    }));
  }

  async chamada(companyId: string, usuarioId: string, ocupacaoId: string) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);
    const ocupacao = await this.ocorrenciaDoProfessor(
      companyId,
      professor.id,
      ocupacaoId,
    );

    const [presencas, matriculados] = await Promise.all([
      this.prisma.presenca.findMany({
        where: { ocupacaoId },
        include: {
          aluno: { include: { usuario: { select: { nome: true } } } },
        },
      }),
      this.prisma.turmaAluno.findMany({
        where: { turmaId: ocupacao.origemTurmaId },
        include: {
          aluno: { include: { usuario: { select: { nome: true } } } },
        },
      }),
    ]);

    // INV-020 — chamada salva é o retrato da turma naquela aula. Se já
    // existe, ela manda; reabrir **não** reconcilia com a turma de hoje.
    // Sem isso, uma chamada de 3 dias atrás ganharia aluno que entrou
    // ontem, como se ele estivesse lá.
    const alunos =
      presencas.length > 0
        ? presencas.map((p) => ({
            alunoId: p.alunoId,
            nome: p.aluno.usuario.nome,
            status: p.status,
            naTurmaHoje: matriculados.some((m) => m.alunoId === p.alunoId),
          }))
        : matriculados.map((m) => ({
            alunoId: m.alunoId,
            nome: m.aluno.usuario.nome,
            status: null as StatusPresenca | null,
            naTurmaHoje: true,
          }));

    return {
      ocupacaoId,
      turmaId: ocupacao.origemTurmaId,
      data: formatDateOnly(ocupacao.data),
      horaInicio: formatTimeOnly(ocupacao.horaInicio),
      horaFim: formatTimeOnly(ocupacao.horaFim),
      cancelada: ocupacao.statusPagamento === 'cancelado',
      versao: this.versaoDe(presencas),
      alunos: alunos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    };
  }

  async salvarChamada(
    companyId: string,
    usuarioId: string,
    ocupacaoId: string,
    versao: string,
    itens: ItemChamada[],
  ) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);
    const ocupacao = await this.ocorrenciaDoProfessor(
      companyId,
      professor.id,
      ocupacaoId,
    );

    // INV-016 (a metade que o banco não impõe): é regra de escrita.
    if (ocupacao.statusPagamento === 'cancelado') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_CANCELADA',
        message: 'Esta aula foi cancelada e não recebe chamada.',
      });
    }

    // INV-017. O limite futuro impede a chamada de virar previsão — o caso
    // real é banal: o professor abre a grade da semana e toca na linha
    // errada. O limite passado existe porque a turma de hoje deixa de ser
    // um retrato confiável do que era há muito tempo (LIM-003).
    const hoje = this.hoje().getTime();
    const dia = ocupacao.data.getTime();
    if (dia > hoje) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_FUTURA',
        message: 'Esta aula ainda não aconteceu.',
      });
    }
    if (dia < hoje - JANELA_RETROATIVA_DIAS * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_ANTIGA',
        message: `A chamada pode ser lançada em até ${JANELA_RETROATIVA_DIAS} dias após a aula.`,
      });
    }

    const idsRecebidos = itens.map((i) => i.alunoId);
    if (new Set(idsRecebidos).size !== idsRecebidos.length) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'ALUNO_REPETIDO',
        message: 'O mesmo aluno apareceu duas vezes na chamada.',
      });
    }

    // AC-006 — alocação é o **único** requisito. `alunos.status` e
    // `vinculo` não bloqueiam, e isso é decisão registrada na spec:
    // presença registra o que aconteceu, e quem assistiu segunda e foi
    // desligado terça esteve lá na segunda.
    const matriculados = await this.prisma.turmaAluno.findMany({
      where: { turmaId: ocupacao.origemTurmaId },
      select: { alunoId: true },
    });
    const permitidos = new Set(matriculados.map((m) => m.alunoId));
    const forasteiros = idsRecebidos.filter((id) => !permitidos.has(id));
    if (forasteiros.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'ALUNO_FORA_DA_TURMA',
        message: 'Há aluno que não está nesta turma.',
        alunoIds: forasteiros,
      });
    }

    return this.prisma.$transaction(async (tx) => {
      const atuais = await tx.presenca.findMany({
        where: { ocupacaoId },
        select: { updatedAt: true },
      });

      // INV-019 — controle otimista. A versão é conferida **dentro** da
      // transação: conferir fora deixaria a janela entre ler e gravar, que
      // é exatamente a corrida que este controle existe para fechar.
      if (this.versaoDe(atuais) !== versao) {
        throw new ConflictException({
          statusCode: 409,
          code: 'CHAMADA_DESATUALIZADA',
          message:
            'Esta chamada mudou desde que você abriu. Recarregue para ver o estado atual.',
        });
      }

      for (const item of itens) {
        await tx.presenca.upsert({
          where: {
            ocupacaoId_alunoId: { ocupacaoId, alunoId: item.alunoId },
          },
          create: {
            companyId,
            ocupacaoId,
            origemTipo: 'TURMA',
            alunoId: item.alunoId,
            status: item.status,
            registradoPor: usuarioId,
          },
          update: { status: item.status, registradoPor: usuarioId },
        });
      }

      const depois = await tx.presenca.findMany({
        where: { ocupacaoId },
        select: { updatedAt: true },
      });
      return { ocupacaoId, versao: this.versaoDe(depois), total: itens.length };
    });
  }

  /**
   * SPEC-014/AC-009 e LIM-002 — o histórico do gestor. **Só leitura.**
   *
   * O gestor não corrige chamada nesta spec, e o custo está declarado: se o
   * professor sair do clube, uma chamada errada dele não tem quem conserte.
   * Preferi isso a expor um contrato de escrita sem tela que o use.
   */
  async historicoDaTurma(companyId: string, turmaId: string, dias: number) {
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: { id: true },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    const desde = new Date(this.hoje());
    desde.setUTCDate(desde.getUTCDate() - dias);

    const ocorrencias = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        data: { gte: desde },
      },
      include: {
        presencas: {
          include: {
            aluno: { include: { usuario: { select: { nome: true } } } },
            registrante: { select: { nome: true } },
          },
        },
      },
      orderBy: [{ data: 'desc' }],
    });

    const matriculados = await this.prisma.turmaAluno.findMany({
      where: { turmaId },
      select: { alunoId: true },
    });
    const naTurma = new Set(matriculados.map((m) => m.alunoId));

    return ocorrencias.map((o) => ({
      ocupacaoId: o.id,
      data: formatDateOnly(o.data),
      horaInicio: formatTimeOnly(o.horaInicio),
      horaFim: formatTimeOnly(o.horaFim),
      // AC-012: aula cancelada depois não desfaz quem esteve lá — por isso
      // a chamada continua aqui, com a aula marcada como cancelada.
      cancelada: o.statusPagamento === 'cancelado',
      chamadaFeita: o.presencas.length > 0,
      registradoPor: o.presencas[0]?.registrante.nome ?? null,
      alunos: o.presencas
        .map((p) => ({
          alunoId: p.alunoId,
          nome: p.aluno.usuario.nome,
          status: p.status,
          // Sinalizadores em vez de bloqueio: a spec decidiu que alocação é
          // o único requisito para marcar presença, e que o gestor vê quem
          // já não está ativo ou já não está na turma.
          naTurmaHoje: naTurma.has(p.alunoId),
          alunoAtivo: p.aluno.status === 'ativo',
        }))
        .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    }));
  }
}
