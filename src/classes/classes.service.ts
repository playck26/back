import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  aulaJaComecou,
  formatDateOnly,
  formatTimeOnly,
  gerarDatasSemanaisFuturas,
  hojeNoFusoDoClube,
  parseTimeOnly,
  parseDateOnly,
} from '../courts/date-time.util';
import { StudentsService } from '../people/students.service';
import {
  ALUNO_NOVO,
  aulaQueAMatriculaLotaria,
  aulasQueAMatriculaLotaria,
  diaEMes,
} from './ocupacao-da-ocorrencia';
import {
  conferirEdicaoDeNivel,
  recusaPorNivel,
  travarNivelDaEmpresa,
} from '../people/nivel-efetivo';
import { CourtsService } from '../courts/courts.service';
import { RegistradorDeAcao } from '../common/auditoria/registrador-de-acao';
import { EnfileiradorDeAvisos } from '../push/enfileirador-de-avisos';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import {
  avaliarSaidaDeTurma,
  type PapelDoAutor,
} from '../company-settings/prazo-de-cancelamento';
import { ocorrenciaRelevante } from './ocorrencia-relevante';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  avisarChamadosQuePerderamOAlvo,
  encerrarFila,
  MOTIVO,
} from '../fila-de-espera/encerramento-da-fila';
import { AulaDoAlunoResponseDto } from './dto/me-response.dto';
import { PAGINA_PADRAO } from './dto/proximas-aulas-query.dto';
import type { CreateClassDto } from './dto/create-class.dto';
import type { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import type { UpdateClassDto } from './dto/update-class.dto';
import { validarEncontros, type EncontroDaTurma } from './encontros';
import type {
  TurmaDoProfessorDetalheResponseDto,
  TurmaDoProfessorResponseDto,
  TurmaResponseDto,
  TurmaDoAlunoDetalheResponseDto,
} from './dto/turma-response.dto';

/**
 * SPEC-019/TASK-002 — a forma de um encontro na resposta, num lugar só.
 *
 * As telas do gestor, do professor e do aluno mostram a mesma coisa, e três
 * cópias divergiriam no primeiro ajuste — como divergiram a leitura do logo e
 * a do `logo_url` antes do `resolver()`.
 */
function paraEncontrosDaResposta(
  encontros: { diaSemana: number; horaInicio: Date; horaFim: Date }[],
) {
  return encontros.map((encontro) => ({
    diaSemana: encontro.diaSemana,
    horaInicio: formatTimeOnly(encontro.horaInicio),
    horaFim: formatTimeOnly(encontro.horaFim),
  }));
}

/**
 * SPEC-019/TASK-002 — a ordem dos encontros na resposta, num lugar só.
 *
 * **Ordem estável importa mais do que parece.** Sem `orderBy`, o Postgres
 * devolve na ordem física, que muda quando a recorrência é reescrita — a tela
 * mostraria "sábado, terça" hoje e "terça, sábado" amanhã, sem nada ter
 * mudado. Parece bug de tela, e o rastro leva a lugar nenhum.
 */
const ORDEM_DOS_ENCONTROS = {
  // `as const` no objeto inteiro produziria tupla readonly, que o Prisma
  // recusa. O `as const` fica só nos literais.
  orderBy: [{ diaSemana: 'asc' as const }, { horaInicio: 'asc' as const }],
};

/**
 * SPEC-066/TASK-001 — **o `select` da aula do aluno, num lugar so.**
 *
 * Duas rotas devolvem `AulaDoAlunoResponseDto`: a janela
 * (`myUpcomingClasses`) e a pagina (`listProximasAulasPaginadas`). Antes desta
 * task havia uma so, e o `select` morava dentro dela.
 *
 * **Copiar seria escrever a mesma regra duas vezes, e este projeto ja pagou
 * por isso.** O DEF-036 nasceu exatamente assim: a regra de credito vivia em
 * dois lugares, um mudou e o outro nao, e o saldo passou a mostrar um credito
 * que o `marcar` recusava gastar.
 *
 * A lista de campos e **exatamente** a que `paraAulaDoAluno` consome.
 * Acrescentar campo aqui sem usar la e reabrir o buraco que o comentario da
 * SPEC-044 descreve: 55 ocorrencias carregando as mesmas 4 turmas inteiras.
 */
function selectDaAulaDoAluno(alunoId: string) {
  return {
    id: true,
    origemTurmaId: true,
    quadraId: true,
    data: true,
    horaInicio: true,
    horaFim: true,
    origemTurma: { select: { nome: true } },
    quadra: { select: { nome: true } },
    // SPEC-030 — o aluno precisa saber que a aula nao aconteceu.
    chamadas: { select: { completude: true } },
    // SPEC-031/REQ-006 — o aviso DESTE aluno, e so dele. Sem o `where`
    // viriam os avisos da turma inteira para o `map` usar um booleano.
    faltas: { where: { alunoId }, select: { id: true } },
  } as const;
}

/** O `map` que acompanha o `select` acima. Ver a nota dele. */
function paraAulaDoAluno(ocupacao: {
  id: string;
  origemTurmaId: string | null;
  quadraId: string;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
  origemTurma: { nome: string } | null;
  quadra: { nome: string };
  chamadas: { completude: string | null }[];
  faltas: { id: string }[];
}): AulaDoAlunoResponseDto {
  return {
    ocupacaoId: ocupacao.id,
    turmaId: ocupacao.origemTurmaId,
    turmaNome: ocupacao.origemTurma?.nome ?? null,
    quadraId: ocupacao.quadraId,
    quadraNome: ocupacao.quadra.nome,
    // Um booleano, e nao o `estado` inteiro: o aluno nao precisa distinguir
    // `completa` de `legada` — isso e registro do professor.
    naoRealizada: ocupacao.chamadas[0]?.completude === 'nao_houve',
    faltaAvisada: ocupacao.faltas.length > 0,
    data: formatDateOnly(ocupacao.data),
    horaInicio: formatTimeOnly(ocupacao.horaInicio),
    horaFim: formatTimeOnly(ocupacao.horaFim),
  };
}

@Injectable()
export class ClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courtsService: CourtsService,
    // SPEC-009/INV-010: a regra de vínculo é de MOD-003; aqui só se
    // pergunta a ela.
    private readonly studentsService: StudentsService,
    // SPEC-031/TASK-005: a remoção administrativa passa pela mesma política
    // do aluno (D12) e lê a configuração pelo mesmo `tx` (D16, passo 4).
    private readonly operacao: ConfigOperacaoService,
  ) {}

  async list(companyId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [rows, total] = await Promise.all([
      this.prisma.turma.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: {
          encontros: ORDEM_DOS_ENCONTROS,
          _count: { select: { alunos: true } },
        },
      }),
      this.prisma.turma.count({ where: { companyId } }),
    ]);

    const lotadas = await this.proximasAulasLotadas(companyId, rows);
    return {
      data: rows.map((turma) => ({
        ...this.toResponse(turma),
        proximaAulaLotada: lotadas.get(turma.id) ?? null,
      })),
      page,
      pageSize,
      total,
    };
  }

  /**
   * ADR-027 (achado A-04) — a primeira aula em que um aluno NOVO não caberia,
   * por turma, **só para as que têm vaga de matrícula**: sem vaga, a turma já
   * aparece cheia. A mesma função da alocação, numa ida só para a página.
   */
  private async proximasAulasLotadas(
    companyId: string,
    turmas: readonly {
      id: string;
      capacidade: number;
      _count: { alunos: number };
    }[],
  ): Promise<Map<string, string>> {
    const lotadas = await aulasQueAMatriculaLotaria(
      this.prisma,
      companyId,
      turmas.filter((t) => t._count.alunos < t.capacidade),
      ALUNO_NOVO,
      new Date(),
    );
    return new Map(
      [...lotadas].map(([turmaId, aula]) => [
        turmaId,
        formatDateOnly(aula.data),
      ]),
    );
  }

  /**
   * SPEC-019/TASK-002 — as ocorrências de **todos** os encontros, achatadas.
   *
   * `registerClassOccupancy` já aceita lista heterogênea e valida todas antes
   * de escrever — a SPEC-010 a escreveu assim de propósito, e a validação
   * cruzada da SPEC-019 confirmou no código. **O gate de concorrência não
   * muda; muda de onde vem a lista.**
   *
   * A ordem é por encontro e depois por data, e não importa: o `EXCLUDE` de
   * `ocupacoes_quadra` decide conflito por intervalo, não por posição.
   */
  private ocorrenciasDosEncontros(encontros: EncontroDaTurma[]) {
    return encontros.flatMap((encontro) => {
      const horaInicio = parseTimeOnly(encontro.horaInicio);
      const horaFim = parseTimeOnly(encontro.horaFim);
      return gerarDatasSemanaisFuturas(encontro.diaSemana).map((data) => ({
        data,
        horaInicio,
        horaFim,
      }));
    });
  }

  async create(companyId: string, dto: CreateClassDto, autorId: string) {
    // AC-003/005/006 — a lista inteira é julgada antes de qualquer escrita, e
    // a recusa é sempre da turma inteira. Ver `encontros.ts`.
    validarEncontros(dto.encontros);
    await this.assertQuadraDaEmpresa(companyId, dto.quadraId);
    if (dto.nivelId) {
      await this.assertNivelDaEmpresa(companyId, dto.nivelId);
    }
    if (dto.professorId) {
      await this.assertProfessorDaEmpresa(companyId, dto.professorId);
    }

    const ocorrencias = this.ocorrenciasDosEncontros(dto.encontros);

    // NFR-001: turma + geração de ocupações futuras é all-or-nothing —
    // qualquer conflito (AC-001) ou falha aborta a transação inteira, a
    // turma não fica órfã sem seu compromisso de horário.
    const turma = await this.prisma.$transaction(async (tx) => {
      const criada = await tx.turma.create({
        data: {
          companyId,
          nome: dto.nome,
          nivelId: dto.nivelId,
          professorId: dto.professorId,
          quadraId: dto.quadraId,
          // A escrita dupla viveu entre a TASK-002 e a TASK-003, e acabou:
          // `dia_semana`, `hora_inicio` e `hora_fim` não existem mais em
          // `turmas`. A recorrência é `encontros`, e ela cabe 1..N dias.
          capacidade: dto.capacidade,
          encontros: {
            create: dto.encontros.map((encontro) => ({
              diaSemana: encontro.diaSemana,
              horaInicio: parseTimeOnly(encontro.horaInicio),
              horaFim: parseTimeOnly(encontro.horaFim),
            })),
          },
        },
        include: { encontros: ORDEM_DOS_ENCONTROS },
      });

      // SPEC-032/INV-078 — UMA acao por TURMA. Criar a turma e um gesto, e as
      // N ocorrencias geradas sao N eventos dele.
      const registrador = new RegistradorDeAcao(
        tx,
        companyId,
        autorId,
        'turma_criada',
      );
      await this.courtsService.registerClassOccupancy(
        tx,
        companyId,
        dto.quadraId,
        criada.id,
        ocorrencias,
        registrador,
      );

      // SPEC-063/AC-005 — avisa o professor com conta, e **nenhum aluno**:
      // ninguém está matriculado ainda. Não é um público diferente do dos
      // outros gestos de turma — é o mesmo público num momento em que só o
      // professor existe.
      const avisos = new EnfileiradorDeAvisos(
        tx,
        companyId,
        autorId,
        'turma_criada',
      );
      avisos.comTurma(criada.id);
      await avisos.despachar(registrador.idDaAcao);

      return criada;
    });

    return this.toResponse({ ...turma, _count: { alunos: 0 } });
  }

  /**
   * SPEC-069/D2 — o extrato administrativo da turma.
   *
   * **Espelha o `eventosDaOcupacao`**, inclusive nas duas respostas que
   * parecem uma só: turma que **não existe** é `404`; turma que existe e
   * ainda não tem histórico é **`200 []`**. Confundi-las esconderia o estado
   * normal de toda turma anterior a esta spec — e um `if (eventos.length ===
   * 0) throw NotFound` passaria em todas as outras provas desta rota, que foi
   * o que a 1ª rodada de validação apontou.
   *
   * **O 404 cross-empresa nasce AQUI, e não no guard** (D7): o
   * `CompanyAdminGuard` da classe confere papel, e declaradamente não faz
   * escopo de tenant. Quem impede o gestor da empresa A de ler a turma da B é
   * o `{ id, companyId }` deste `findFirst` — tirar o `companyId` daqui abre
   * o vazamento sem que nenhum guard reclame.
   *
   * A ordem `criadoEm desc` é contrato (AC-006), não conveniência de tela.
   */
  async eventosDaTurma(companyId: string, turmaId: string) {
    const existe = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: { id: true },
    });
    if (!existe) throw new NotFoundException();

    const eventos = await this.prisma.eventoDeTurma.findMany({
      where: { companyId, turmaId },
      select: {
        tipo: true,
        criadoEm: true,
        acao: {
          select: {
            tipo: true,
            motivo: true,
            autor: { select: { id: true, nome: true } },
          },
        },
      },
      orderBy: { criadoEm: 'desc' },
    });

    return eventos.map((evento) => ({
      tipo: evento.tipo,
      em: evento.criadoEm.toISOString(),
      acao: evento.acao.tipo,
      motivo: evento.acao.motivo,
      autor: { id: evento.acao.autor.id, nome: evento.acao.autor.nome },
    }));
  }

  async findOne(companyId: string, id: string) {
    const turma = await this.prisma.turma.findFirst({
      where: { id, companyId },
      include: {
        alunos: {
          include: { aluno: { include: { usuario: true } } },
        },
        encontros: ORDEM_DOS_ENCONTROS,
        _count: { select: { alunos: true } },
      },
    });
    if (!turma) {
      throw new NotFoundException();
    }
    const lotadas = await this.proximasAulasLotadas(companyId, [turma]);
    return {
      ...this.toResponse(turma),
      proximaAulaLotada: lotadas.get(turma.id) ?? null,
      alunos: turma.alunos.map((alocacao) => ({
        alunoId: alocacao.alunoId,
        nome: alocacao.aluno.usuario.nome,
        email: alocacao.aluno.usuario.email,
      })),
    };
  }

  /**
   * SPEC-035/TASK-004 — as aulas canceladas que ainda dá para trazer de volta.
   *
   * **Existe porque a agenda esconde o cancelado**, nos três filtros de
   * `agenda.service.ts`. Isso está certo para o que a agenda é — o que vai
   * acontecer —, e o efeito colateral é que a aula cancelada some da tela.
   * Reativar sem esta lista seria uma rota sem porta: o mesmo defeito que a
   * SPEC-039 levou para a tela.
   *
   * **Só o futuro** (`data >= hoje`, o mesmo corte de tudo que decide sobre
   * ocorrência): o passado não reativa, e oferecê-lo seria mostrar um botão
   * que só sabe recusar.
   *
   * `horarioLivre` é calculado aqui e **pode envelhecer** entre esta leitura e
   * o clique — quem decide é a `EXCLUDE` no `POST`. Ele existe para a tela
   * avisar antes, como a janela do professor avisa na aula particular.
   */
  async ocorrenciasCanceladas(companyId: string, turmaId: string) {
    await this.assertTurmaDaEmpresa(companyId, turmaId);

    const canceladas = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        statusPagamento: 'cancelado',
        data: { gte: hojeNoFusoDoClube() },
      },
      select: {
        id: true,
        quadraId: true,
        data: true,
        horaInicio: true,
        horaFim: true,
        quadra: { select: { nome: true } },
      },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    });
    if (canceladas.length === 0) return [];

    /**
     * **Uma consulta para todas, e não uma por aula.** O `OR` repete por
     * ocorrência a mesma sobreposição semiaberta que um laço faria uma a uma;
     * o que muda é o número de idas ao banco. É o mesmo N+1 que o DEF-013
     * baniu em `registerClassOccupancy`, e que já voltou por caminho
     * diferente três vezes neste projeto.
     */
    const ocupados = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        statusPagamento: { not: 'cancelado' },
        OR: canceladas.map((c) => ({
          quadraId: c.quadraId,
          data: c.data,
          horaInicio: { lt: c.horaFim },
          horaFim: { gt: c.horaInicio },
        })),
      },
      select: { quadraId: true, data: true, horaInicio: true, horaFim: true },
    });

    return canceladas.map((c) => ({
      ocupacaoId: c.id,
      data: formatDateOnly(c.data),
      horaInicio: formatTimeOnly(c.horaInicio),
      horaFim: formatTimeOnly(c.horaFim),
      quadraNome: c.quadra.nome,
      horarioLivre: !ocupados.some(
        (o) =>
          o.quadraId === c.quadraId &&
          o.data.getTime() === c.data.getTime() &&
          o.horaInicio < c.horaFim &&
          o.horaFim > c.horaInicio,
      ),
    }));
  }

  async update(
    companyId: string,
    id: string,
    dto: UpdateClassDto,
    autorId: string,
  ) {
    const existente = await this.prisma.turma.findFirst({
      where: { id, companyId },
    });
    if (!existente) {
      throw new NotFoundException();
    }

    // **`encontros` ausente NÃO mexe na recorrência.** Renomear a turma ou
    // mudar a capacidade não pode cancelar e regerar oito ocupações — e,
    // pior, apagar as que já têm chamada marcada.
    const mudouHorario =
      dto.quadraId !== undefined || dto.encontros !== undefined;

    /**
     * SPEC-035 — **o `status` passa a AGIR, e até aqui ele não agia.**
     *
     * Medido antes de escrever (`ensaio-035-estado.db-spec.ts`): o `status`
     * era gravado na turma e mais nada acontecia. A turma sumia das listas e
     * **a quadra ficava bloqueada para sempre** — `availability` respondia
     * `ocupado_turma` apontando para uma turma fora de operação. O item 12 do
     * backlog dizia "50%, a coluna existe"; a coluna sozinha não é soft
     * delete.
     *
     * **Comparado com `existente.status`, não com `undefined`.** `PATCH` com
     * o status que a turma já tem é retentativa de rede, não gesto — e criar
     * ação por retentativa faria a auditoria contar tentativas em vez de
     * gestos, que é a razão de o `RegistradorDeAcao` ser preguiçoso.
     */
    const inativando =
      dto.status === 'inativa' && existente.status !== 'inativa';
    const ativando = dto.status === 'ativa' && existente.status !== 'ativa';
    const statusFinal = dto.status ?? existente.status;

    /**
     * **INV-107 — grade viva existe se, e somente se, a turma está ativa.**
     *
     * As duas metades saem daqui, e a segunda conserta um defeito irmão que
     * ninguém tinha pedido: editar o horário de uma turma **inativa** gerava
     * ocupações vivas para ela. Amarrar a regeneração ao status resolve os
     * dois casos com uma condição só, em vez de dois `if` que podem divergir.
     */
    const precisaCancelar = mudouHorario || inativando || ativando;
    const precisaRegerar = precisaCancelar && statusFinal === 'ativa';

    const quadraId = dto.quadraId ?? existente.quadraId;

    // `null` enquanto a recorrência não for necessária. **A consulta só
    // acontece dentro do `if`**: renomear a turma não pode custar uma ida ao
    // banco para ler encontros que ninguém vai usar.
    let encontros: EncontroDaTurma[] | null = null;

    if (precisaRegerar) {
      // Só trocar de quadra, sem mexer nos encontros, também regera — as
      // ocupações apontam para a quadra antiga. Aí a recorrência vem do que
      // já está gravado.
      encontros =
        dto.encontros ??
        (
          await this.prisma.turmaEncontro.findMany({
            where: { turmaId: id },
            ...ORDEM_DOS_ENCONTROS,
          })
        ).map((encontro) => ({
          diaSemana: encontro.diaSemana,
          horaInicio: formatTimeOnly(encontro.horaInicio),
          horaFim: formatTimeOnly(encontro.horaFim),
        }));

      // AC-003/005/006 — inclusive quando a lista veio do banco: se ela
      // estivesse inválida, trocar de quadra propagaria o estado inválido.
      validarEncontros(encontros);
      await this.assertQuadraDaEmpresa(companyId, quadraId);
    }
    if (dto.nivelId) {
      await this.assertNivelDaEmpresa(companyId, dto.nivelId);
    }
    if (dto.professorId) {
      await this.assertProfessorDaEmpresa(companyId, dto.professorId);
    }

    // NFR-001: mesma garantia all-or-nothing da criação — se o horário
    // muda, cancelar as ocupações futuras antigas e gerar as novas
    // acontece na mesma transação da atualização da turma.
    const turma = await this.prisma.$transaction(async (tx) => {
      // SPEC-075/D13 — quando o corpo traz `nivelId`, a trava de nível da
      // empresa é a PRIMEIRA instrução, antes do `FOR UPDATE` da turma logo
      // abaixo. Sem `nivelId` a edição não mexe em nível, e não trava.
      if (dto.nivelId !== undefined) await travarNivelDaEmpresa(tx, companyId);

      // SPEC-068/D6 — **o professor anterior sai da linha TRAVADA**, e só
      // quando o `PATCH` traz `professorId`.
      //
      // Ler `existente.professorId` (buscado antes da transação) não serve, e
      // a 2ª rodada de validação mostrou o traço: sob `Read Committed` duas
      // trocas simultâneas leem `P0`, a primeira grava `P1` e avisa `P0`, a
      // segunda acorda, grava `P2` e **avisa `P0` de novo** — enquanto quem
      // perdeu a turma foi `P1`. O `FOR UPDATE` faz a segunda esperar e
      // reler. Medido: `LOCK_OLD_1=P0`, `LOCK_OLD_2=P1`.
      //
      // **Condicional**: sem `professorId` no corpo não há professor anterior
      // a capturar, e travar a linha em toda edição de turma seria uma ida e
      // um lock antecipado sem proveito. Com `professorId` presente — mesmo
      // igual ao atual — a comparação acontece sob o lock, senão "troca" e
      // "retentativa" deixam de ser distinguíveis.
      //
      // **"Trocou" e "quem saiu" são duas perguntas**, e confundi-las custa um
      // caso: turma que não tinha professor e passa a ter **trocou**, e não há
      // ninguém a avisar da saída.
      let trocouProfessor = false;
      let professorAnteriorId: string | null = null;
      if (dto.professorId !== undefined) {
        const travadas = await tx.$queryRaw<{ professor_id: string | null }[]>`
          SELECT professor_id FROM turmas
           WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
           FOR UPDATE`;
        const antes = travadas[0]?.professor_id ?? null;
        if (antes !== dto.professorId) {
          trocouProfessor = true;
          professorAnteriorId = antes;
        }
      }

      const gravarTurma = () =>
        tx.turma.update({
          where: { id },
          data: {
            nome: dto.nome,
            nivelId: dto.nivelId,
            professorId: dto.professorId,
            quadraId: dto.quadraId,
            capacidade: dto.capacidade,
            status: dto.status,
            ...(dto.encontros === undefined
              ? {}
              : {
                  // **Substitui a lista inteira**, na mesma transação. Não há
                  // edição parcial de recorrência: ver `UpdateClassDto`.
                  encontros: {
                    deleteMany: {},
                    create: dto.encontros.map((encontro) => ({
                      diaSemana: encontro.diaSemana,
                      horaInicio: parseTimeOnly(encontro.horaInicio),
                      horaFim: parseTimeOnly(encontro.horaFim),
                    })),
                  },
                }),
          },
        });

      // SPEC-075/D12 (decisão 6) — **mudar o nível da turma não pode deixar
      // fora do nível um aluno que está nela.** Só quando o corpo traz
      // `nivelId` (inclusive `null`, que nunca recusa: turma sem nível é de
      // todos). Compara os pares antes e depois da escrita, na mesma transação;
      // a recusa desfaz tudo.
      let atualizada: Awaited<ReturnType<typeof gravarTurma>>;
      if (dto.nivelId !== undefined) {
        const r = await conferirEdicaoDeNivel(
          tx,
          companyId,
          { turmaId: id },
          { tipo: 'turma' },
          gravarTurma,
        );
        if (r.recusa) throw new UnprocessableEntityException(r.recusa);
        atualizada = r.resultado;
      } else {
        atualizada = await gravarTurma();
      }

      // SPEC-064/D6 — **turma inativada mata a fila de TURMA dela.**
      //
      // A fila de AULA daquela turma já morre pelo `cancelFutureClassOccupancies`
      // logo abaixo, que cancela as ocorrências; esta aqui é a outra fila — quem
      // esperava uma vaga de MATRÍCULA, que não tem ocorrência nenhuma para
      // morrer junto.
      //
      // Só na inativação: reativar devolve a turma, mas não ressuscita quem já
      // foi encerrado — a posição dele terminou, com motivo escrito.
      if (dto.status === 'inativa') {
        const fila = await encerrarFila(
          tx,
          companyId,
          { turmaId: id },
          MOTIVO.TURMA_INATIVADA,
        );
        await avisarChamadosQuePerderamOAlvo(
          tx,
          companyId,
          fila.chamados,
          MOTIVO.TURMA_INATIVADA,
        );
      }

      if (precisaCancelar) {
        // DEF-020: o corte (`gte`) é hoje NO FUSO DO CLUBE. Em UTC, uma
        // edição feita às 21h30 de segunda tinha corte na terça — e a
        // ocupação de segunda escapava do cancelamento, sobrevivendo com o
        // horário ANTIGO enquanto a grade nova era gerada a partir de terça.
        //
        // O corte precisa ser o mesmo que `gerarDatasSemanaisFuturas` usa
        // logo abaixo para regerar: são as duas metades da mesma operação, e
        // é por isso que as duas passaram a chamar a mesma função.
        //
        // SPEC-035/D2 — **e é o mesmo corte que protege o passado.** Inativar
        // não toca ocorrência que já aconteceu: ela carrega chamada,
        // avaliação e presença, e cancelá-la retroativamente reescreveria
        // história já contada. Quem declara que a aula não houve é a
        // SPEC-030, por afirmação — nunca por cancelamento tardio.
        const hojeUTC = hojeNoFusoDoClube();

        // SPEC-032/D2 e INV-078 — **UM registrador para as duas metades.**
        // Editar o horario cancela as antigas e cria as novas dentro do
        // MESMO `$transaction`, a partir de UM `PATCH`. E uma acao
        // (`turma_horario_editado`) com eventos `cancelada` e `criada`.
        // Dois registradores aqui criariam duas acoes para um gesto — e o
        // banco nao reclamaria, e por isso a instancia unica e o mecanismo.
        //
        // SPEC-035/D7 — **o TIPO da ação é o gesto, não o efeito.** Os três
        // caminhos produzem escritas parecidas em `ocupacoes_quadra` e são
        // gestos diferentes; reusar `turma_horario_editado` para a inativação
        // faria o extrato dizer "horário editado" para quem investigasse uma
        // quadra que ficou livre — mentira barata e cara de descobrir. Quando
        // o `PATCH` faz as duas coisas, vence o gesto maior: ligar ou
        // desligar a turma.
        const gesto = inativando
          ? 'turma_inativada'
          : ativando
            ? 'turma_reativada'
            : 'turma_horario_editado';
        const registrador = new RegistradorDeAcao(
          tx,
          companyId,
          autorId,
          gesto,
        );
        // SPEC-063/AC-002, AC-014 — **um resumo por destinatário**, alunos e
        // professor, sem `expira_em`: o gesto cobre N ocorrências e escolher
        // uma delas descartaria o resto em silêncio.
        const avisos = new EnfileiradorDeAvisos(tx, companyId, autorId, gesto);
        avisos.comTurma(id);

        await this.courtsService.cancelFutureClassOccupancies(
          tx,
          companyId,
          id,
          hojeUTC,
          registrador,
        );

        /**
         * SPEC-035/D3 — **reativar REGENERA; não descancela as linhas
         * antigas.**
         *
         * Entre inativar e reativar passou tempo, e o horizonte de
         * `gerarDatasSemanaisFuturas` andou junto. Descancelar as mesmas
         * linhas ressuscitaria ocorrências que hoje estão no passado e
         * deixaria um buraco à frente — turma "ativa" sem aula nas próximas
         * semanas, e ninguém olhando descobriria por quê.
         *
         * O `cancelFutureClassOccupancies` acima **roda também na
         * reativação**, e não é redundância: turma inativada ANTES desta spec
         * ficou com a grade viva (era o defeito), e regerar por cima dela
         * bateria na `EXCLUDE` contra as próprias linhas. Cancelar primeiro
         * torna o caminho idempotente para os dois estados de mundo.
         */
        if (precisaRegerar) {
          await this.courtsService.registerClassOccupancy(
            tx,
            companyId,
            quadraId,
            id,
            this.ocorrenciasDosEncontros(encontros ?? []),
            registrador,
          );
        }

        // `idDaAcao` é `null` quando nada foi registrado — e aí não houve
        // gesto que avisar. A decisão mora no enfileirador de propósito:
        // quem chama não deveria precisar saber disso.
        await avisos.despachar(registrador.idDaAcao);
      }

      /**
       * SPEC-068/TASK-001 — **a troca de professor é gesto próprio, e sai
       * FORA do `if (precisaCancelar)`.**
       *
       * Era exatamente por estar lá dentro que ela não avisava ninguém: o
       * gatilho de lá é `quadraId` ou `encontros`, e trocar só o professor não
       * toca nenhum dos dois.
       *
       * **Ação SEPARADA, e não o tipo do gesto de grade.** O Admin manda o
       * formulário inteiro no salvar (`nome`, `quadraId`, `professorId`,
       * `encontros`), então trocar professor e regerar grade **co-ocorrem no
       * caminho real**, não como exceção. Escolher um tipo só perderia um
       * fato: ou a turma não fica sabendo que o horário mudou, ou quem saiu
       * não fica sabendo que saiu. São dois fatos com públicos diferentes — e
       * o extrato continua honesto, porque os eventos de ocupação ficam sob a
       * ação da grade e esta aqui não carrega nenhum.
       */
      if (trocouProfessor) {
        const gestoDeProfessor = new RegistradorDeAcao(
          tx,
          companyId,
          autorId,
          'turma_professor_alterado',
        );
        const avisosDaTroca = new EnfileiradorDeAvisos(
          tx,
          companyId,
          autorId,
          'turma_professor_alterado',
        );
        avisosDaTroca.comTurma(id);
        if (professorAnteriorId) {
          avisosDaTroca.comProfessorAnterior(professorAnteriorId);
        }
        // SPEC-069/TASK-002 — **o gesto passa a dizer QUAL turma.** Antes
        // daqui a ação nascia sem efeito nenhum, e o extrato guardava o autor
        // e o instante sem o objeto; agora ela nasce com a linha de
        // `eventos_de_turma` na MESMA transação, que é o que o
        // `acao_exige_alvo` vai exigir no `COMMIT` a partir do Deploy 2.
        //
        // `idDaAcao` em vez do retorno do registrar: é a mesma forma do ramo
        // da grade, dez linhas acima, e quem despacha não precisa saber se
        // houve efeito — só se houve ação.
        await gestoDeProfessor.registrarTurma(id, 'professor_alterado');
        await avisosDaTroca.despachar(gestoDeProfessor.idDaAcao);
      }

      return atualizada;
    });

    return this.findOne(companyId, turma.id);
  }

  async allocateStudent(companyId: string, turmaId: string, alunoId: string) {
    return this.prisma.$transaction(async (tx) => {
      // SPEC-075/D13 — a trava de nível da empresa, PRIMEIRA instrução, antes
      // do `FOR UPDATE` da turma: esta alocação e uma edição de nível da mesma
      // empresa nunca correm juntas.
      await travarNivelDaEmpresa(tx, companyId);

      // REQ-004/INV-003 (DATA_MODEL.md): SELECT ... FOR UPDATE na linha da
      // turma serializa checagens de capacidade concorrentes — não
      // expressável no query builder do Prisma, raw query necessária.
      const turmaRows = await tx.$queryRaw<
        { id: string; capacidade: number; nivel_id: string | null }[]
      >`
        SELECT id, capacidade, nivel_id::text AS nivel_id FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;
      const turma = turmaRows[0];
      if (!turma) {
        throw new NotFoundException();
      }

      const aluno = await tx.aluno.findFirst({
        where: { id: alunoId, companyId },
      });
      if (!aluno) {
        throw new NotFoundException('Aluno não encontrado');
      }
      // SPEC-009/INV-010 — dentro da transação, com a turma já travada por
      // FOR UPDATE: checar vínculo antes de abrir a transação deixaria
      // janela entre a checagem e a escrita.
      //
      // **DEF-027:** passou a olhar `status` junto. Alocar um aluno desligado
      // não era erro de banco — ele entrava na turma e reaparecia na chamada
      // com `alunoAtivo: false`, que a `frequencia.service` já calcula. A
      // LEITURA sabia; a escrita não.
      this.studentsService.garantirAlunoOperante(aluno);

      const jaAlocado = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId },
      });
      if (jaAlocado) {
        return jaAlocado;
      }

      // SPEC-075/D5 (decisão 5 do Israel) — **o gestor também é recusado.**
      // Sem parâmetro, flag ou papel que contorne: o caminho que sobra é mudar
      // o nível do aluno, e a mensagem o diz (D4, o texto do gestor). Depois do
      // `jaAlocado` (a alocação que já existe continua, D6) e antes da
      // capacidade — a mesma posição dos gestos do aluno (D3).
      const recusa = await recusaPorNivel(
        tx,
        companyId,
        turma.nivel_id,
        aluno.nivelId,
        'gestor',
      );
      if (recusa) throw new UnprocessableEntityException(recusa);

      const alocados = await tx.turmaAluno.count({ where: { turmaId } });
      if (alocados >= turma.capacidade) {
        throw new ConflictException(
          'Capacidade da turma excedida (INV-003, AC-002)',
        );
      }

      // E cabe em TODAS as próximas aulas, contando as reposições já marcadas
      // (decisão do Israel, 2026-09-26). Antes, marcar a reposição na última
      // vaga de um dia e DEPOIS alocar deixava aquele dia acima da capacidade
      // — o FIT-035 só passava por sorte de ordem.
      const lotaria = await aulaQueAMatriculaLotaria(
        tx,
        companyId,
        turma,
        alunoId,
        new Date(),
      );
      if (lotaria) {
        throw new ConflictException({
          statusCode: 409,
          code: 'AULA_LOTADA',
          message: `A aula de ${diaEMes(lotaria.data)} desta turma já está lotada, contando as reposições marcadas. Alocar agora deixaria esse dia acima da capacidade.`,
        });
      }

      return tx.turmaAluno.create({ data: { turmaId, alunoId } });
    });
  }

  /**
   * SPEC-031/TASK-005 — a remoção administrativa: **passa pela política e
   * deixa rastro.**
   *
   * ## O gestor é PARÂMETRO, não exceção (D12)
   *
   * `papelDoAutor` entra na assinatura porque um `if (papel === 'aluno')`
   * dentro do serviço do aluno seria a falácia do *"garantido por não existir
   * rota"* — este projeto já reprovou duas specs por ela. No dia em que
   * aparecer um terceiro caminho, ele não passaria pela regra.
   *
   * E o gestor **não pula** `avaliarSaidaDeTurma`: entra nela com
   * `SEM_PRAZO`, herdando a recusa de `minutos <= 0` (AC-010b) sem herdar a
   * antecedência do clube (AC-013). A v2 da spec dizia "nunca é barrado por
   * prazo" **e** mandava não chamar a função — juntas, as duas deixavam o
   * gestor cancelar aula já iniciada.
   *
   * ## E deixa rastro (AC-014b) — hoje a remoção é ANÔNIMA
   *
   * Ação `turma_aluno_removido` com `autor_id`, **e** a linha de
   * `eventos_de_matricula` com `turma_id` + `aluno_id`. As duas: `autor_id`
   * sozinho não responde *quem* foi removido *de onde*, e foi por isso que o
   * veredito da v4 chamou o AC-014b anterior de não realizável.
   */
  async removeStudent(
    companyId: string,
    turmaId: string,
    alunoId: string,
    autorId: string,
    papelDoAutor: PapelDoAutor,
  ): Promise<void> {
    await this.assertTurmaDaEmpresa(companyId, turmaId);
    const agora = new Date();

    // SPEC-015/AC-000i (v9, BLOQ-1 da 7ª rodada) — o par do lock que
    // `PresencaService.salvarChamada` passou a pegar. Sem este lado, o de
    // lá não trava nada: quem não pede lock não respeita lock.
    //
    // A entrada (`allocateStudent`) já estava coberta sem saber — a FK
    // `turma_alunos -> turmas` obriga o INSERT a pegar `FOR KEY SHARE` na
    // linha da turma, que conflita com o `FOR UPDATE` da chamada. A SAÍDA
    // não tem essa proteção: DELETE de filho não checa FK no pai, e
    // passava direto (cenário 5 de `bloq7-concorrencia.ts`).
    //
    // Este método também era o único escritor de `turma_alunos` sem
    // transação nenhuma: `findFirst` e `delete` soltos, com janela entre
    // os dois. Passam a ser um ato só.
    await this.prisma.$transaction(async (tx) => {
      // REQ-004/INV-003 — mesma linha, mesmo lock de `allocateStudent`.
      // `company_id` no WHERE por higiene defensiva (OBSERVAÇÃO da 8ª
      // rodada): `assertTurmaDaEmpresa` já escopou acima, mas ali fora da
      // transação. Repetir o escopo aqui custa nada e mantém a regra de
      // isolamento entre empresas dentro do mesmo ato que trava a linha —
      // o `allocateStudent` já fazia assim.
      await tx.$queryRaw`
        SELECT id FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;

      const alocacao = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId },
      });
      if (!alocacao) {
        throw new NotFoundException();
      }

      // SPEC-031/D16, passos 3 a 5 — dentro da MESMA transação, e o passo 4
      // sem `FOR UPDATE`. Ver `MatriculaDoAlunoService.sair`.
      const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);
      const veredicto = avaliarSaidaDeTurma({
        papelDoAutor,
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
          message:
            'Esta aula já começou. Remover o aluno agora não desfaz a presença dele.',
        });
      }

      // AC-014b — passo 6. Antes do DELETE porque a ação descreve o gesto, e
      // o gesto é este; depois dele, um erro no registro deixaria a remoção
      // feita e sem rastro.
      const registrador = new RegistradorDeAcao(
        tx,
        companyId,
        autorId,
        'turma_aluno_removido',
      );
      await registrador.registrarMatricula(turmaId, alunoId);

      await tx.turmaAluno.delete({ where: { id: alocacao.id } });

      // SPEC-064/D6 — quem sai da turma não continua na fila dela. **Sem
      // aviso**: ele acabou de ser removido, e dizer "sua vez acabou" logo
      // depois seria uma segunda má notícia sobre o mesmo fato.
      await encerrarFila(
        tx,
        companyId,
        { turmaEAluno: { turmaId, alunoId } },
        MOTIVO.SAIU_DA_TURMA,
      );

      // SPEC-063/AC-015 — avisa **só o aluno removido**: nem a turma, nem o
      // professor, nem os gestores. E depois do `DELETE` de propósito: antes
      // dele, a consulta de destinatários do público `turma` ainda o veria
      // matriculado — não é o público aqui, mas a ordem deixa de importar.
      const avisos = new EnfileiradorDeAvisos(
        tx,
        companyId,
        autorId,
        'turma_aluno_removido',
      );
      avisos.comAlunoRemovido(alunoId);
      await avisos.despachar(registrador.idDaAcao);
    });
  }

  // CON-004.5 (SPEC-005): próximas aulas do aluno logado — escopado por
  // aluno_id via turma_alunos, não só por company_id (AC-002: um aluno
  // não pode ver aula de outro aluno da mesma empresa). View-only: uma
  // ocupação de turma é compartilhada por todos os alunos matriculados
  // (não tem aluno_id próprio), então remarcar/cancelar uma ocorrência
  // individual não é suportado nesta rodada (GAP-008,
  // TARGET_ARCHITECTURE.md) — CON-004.6/004.7 ficam para depois do MVP.
  /**
   * SPEC-057/TASK-002/D11 — **a janela por data.**
   *
   * Sem `janela`, o comportamento é o de sempre: do dia corrente em diante. É
   * isso que mantém o Cliente anterior a esta task funcionando enquanto o
   * novo não sobe — o contrato **expande**, não troca.
   */
  async myUpcomingClasses(
    companyId: string,
    usuarioId: string,
    janela?: { de: string; ate: string },
  ): Promise<AulaDoAlunoResponseDto[]> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }

    const alocacoes = await this.prisma.turmaAluno.findMany({
      where: { alunoId: aluno.id },
      select: { turmaId: true },
    });
    const turmaIds = alocacoes.map((alocacao) => alocacao.turmaId);
    if (turmaIds.length === 0) {
      return [];
    }

    // DEF-020 — **este era o ponto que o Israel via.** `date-time.util.ts`
    // chegou a citá-lo pelo nome ("`myUpcomingClasses` faz isso até hoje") e
    // ele ficou em UTC mesmo assim. Das 21h à meia-noite o UTC já está no dia
    // seguinte, então a aula de hoje às 22h desaparecia de "próximas aulas"
    // uma hora antes de começar — no horário de pico de um clube de tênis.
    const hojeUTC = hojeNoFusoDoClube();

    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: { in: turmaIds },
        statusPagamento: { not: 'cancelado' },
        // A janela é **inclusiva nos dois extremos**: `lte` na data, e não
        // `lt` no dia seguinte. As duas dariam o mesmo resultado aqui
        // (`data` é dia, sem hora), e a primeira é a que se lê igual ao
        // contrato publicado.
        data: janela
          ? { gte: parseDateOnly(janela.de), lte: parseDateOnly(janela.ate) }
          : { gte: hojeUTC },
      },
      // SPEC-066/TASK-001 — o `select` mora em `selectDaAulaDoAluno`, que
      // esta rota e a paginada compartilham. A nota de por que ele e `select`
      // e nao `include` esta la, junto do codigo que ela descreve.
      select: selectDaAulaDoAluno(aluno.id),
      // Sem o `id` aqui: esta rota NAO pagina, entao nao ha `OFFSET` para
      // desempatar. A paginada o tem, e a nota do desempate esta nela.
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    });

    return ocupacoes.map(paraAulaDoAluno);
  }

  /**
   * SPEC-066/TASK-001 — **a PAGINA da lista de proximas aulas.**
   *
   * ## Por que e uma rota nova, e nao um parametro na de cima
   *
   * Sao duas perguntas com garantias diferentes. `myUpcomingClasses` responde
   * *"me de a janela inteira"* e **nao pode truncar** — a home desenha um mes
   * e precisa de todas as aulas dele (INV-066e). Esta responde *"me de a
   * pagina N"* e **nunca devolve mais que uma pagina** (INV-066a).
   *
   * A v1 desta spec tentou as duas pela mesma rota. A validacao independente
   * mediu **270 aulas em 90 dias com tres turmas** e derrubou o teto que a
   * rota unica exigia: enquanto as duas perguntas dividiam uma rota, qualquer
   * numero seria chute.
   *
   * ## O `id` no `orderBy` nao e enfeite (INV-066b)
   *
   * Duas aulas do mesmo aluno podem cair na **mesma data e hora** (turmas
   * diferentes, quadras diferentes). Sem desempate estavel, `OFFSET` sobre
   * uma ordem parcial repete e pula linhas — a 1a rodada da validacao mediu
   * isto, e as paginas 1 e 2 devolveram **as mesmas dez**:
   *
   *     sem_id pagina1=12,13,14,15,16,17,18,19,20,11
   *     sem_id pagina2=20,19,18,17,16,15,14,13,12,11
   *     vistos=10   esperados_nas_2_paginas=20
   *
   * ## `$transaction` para a contagem e a pagina concordarem
   *
   * `total` e a pagina saem da **mesma** leitura. Em duas chamadas soltas,
   * uma aula marcada no meio faria o paginador anunciar um numero que a
   * pagina ja nao reflete.
   */
  async listProximasAulasPaginadas(
    companyId: string,
    usuarioId: string,
    page = 1,
    pageSize = PAGINA_PADRAO,
  ): Promise<{
    data: AulaDoAlunoResponseDto[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }

    const alocacoes = await this.prisma.turmaAluno.findMany({
      where: { alunoId: aluno.id },
      select: { turmaId: true },
    });
    const turmaIds = alocacoes.map((alocacao) => alocacao.turmaId);

    // Mesmo `hojeNoFusoDoClube` do metodo de cima, e pelo mesmo motivo: com
    // `CURRENT_DATE` ou UTC, das 21h a meia-noite a aula de hoje as 22h
    // desaparece uma hora antes de comecar. E o DEF-020.
    // Tipado, e nao inferido: sem a anotacao o literal `'cancelado'` alarga
    // para `string` e o Prisma recusa o enum. Tipar aqui tambem garante que o
    // MESMO `where` vai para a pagina e para a contagem.
    const where: Prisma.OcupacaoQuadraWhereInput = {
      companyId,
      origemTipo: 'TURMA',
      origemTurmaId: { in: turmaIds },
      statusPagamento: { not: 'cancelado' },
      data: { gte: hojeNoFusoDoClube() },
    };

    const [ocupacoes, total] = await this.prisma.$transaction([
      this.prisma.ocupacaoQuadra.findMany({
        where,
        select: selectDaAulaDoAluno(aluno.id),
        // INV-066b — a ordem e TOTAL. O `id` e o desempate.
        orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }, { id: 'asc' }],
        // INV-066a — o corte e no BANCO. Cortar na aplicacao traria o futuro
        // inteiro pela rede para jogar fora, que e o defeito que esta spec
        // existe para fechar.
        take: pageSize,
        skip: (page - 1) * pageSize,
      }),
      this.prisma.ocupacaoQuadra.count({ where }),
    ]);

    return {
      data: ocupacoes.map(paraAulaDoAluno),
      page,
      pageSize,
      total,
    };
  }

  private async assertTurmaDaEmpresa(
    companyId: string,
    turmaId: string,
  ): Promise<void> {
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
    });
    if (!turma) {
      throw new NotFoundException();
    }
  }

  /**
   * DEF-026 — a quadra e da empresa **e esta ativa**.
   *
   * Turma nova, ou turma movida para uma quadra fora de operacao, gerava as
   * oito ocorrencias normalmente -- e a agenda nao mostra quadra inativa,
   * entao a aula existia e ninguem a via. Mesmo defeito da reserva, medido no
   * mesmo dia.
   *
   * `422 QUADRA_INATIVA` e nao `404`: a quadra existe, e o gestor sabe -- ele
   * mesmo a desativou.
   */
  private async assertQuadraDaEmpresa(
    companyId: string,
    quadraId: string,
  ): Promise<void> {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId },
      select: { status: true },
    });
    if (!quadra) {
      throw new NotFoundException('Quadra não encontrada');
    }
    if (quadra.status !== 'ativa') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'QUADRA_INATIVA',
        message:
          'Esta quadra está fora de operação. Reative-a antes de marcar turma nela.',
      });
    }
  }

  private async assertNivelDaEmpresa(
    companyId: string,
    nivelId: string,
  ): Promise<void> {
    const nivel = await this.prisma.nivel.findFirst({
      where: { id: nivelId, companyId },
    });
    if (!nivel) {
      throw new NotFoundException('Nível não encontrado');
    }
  }

  /**
   * DEF-027 — **o mesmo portao que a SPEC-039 pos na aula particular, aqui.**
   *
   * `POST /bookings` com `professorId` recusa professor inativo desde a
   * SPEC-039 (`422 PROFESSOR_INATIVO`, AC-005). Dar a ele uma TURMA continuava
   * respondendo `201`, e a turma ficava com um professor que o produto trata
   * como fora de operacao — a agenda dele e o painel do professor filtram
   * `status`, entao a turma existia sem ninguem que a enxergasse como sua.
   *
   * **O codigo e o mesmo de proposito.** Dois codigos para "este professor nao
   * atende" fariam a tela ter de conhecer os dois para dizer a mesma frase.
   */
  private async assertProfessorDaEmpresa(
    companyId: string,
    professorId: string,
  ): Promise<void> {
    const professor = await this.prisma.professor.findFirst({
      where: { id: professorId, companyId },
      select: { status: true },
    });
    if (!professor) {
      throw new NotFoundException('Professor não encontrado');
    }
    if (professor.status !== 'ativo') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PROFESSOR_INATIVO',
        message: 'Este professor está inativo e não assume turma.',
      });
    }
  }

  /**
   * SPEC-019/REQ-006 — **o retorno anotado é o que amarra este método ao
   * contrato publicado.** Sem a anotação, `TurmaResponseDto` seria só mais um
   * tipo escrito à mão, e envelheceria calado como o `Court` do Cliente
   * envelheceu (DEF-012). Com ela, mudar a forma da resposta quebra o
   * typecheck AQUI, antes de qualquer frontend.
   */
  private toResponse(turma: {
    id: string;
    companyId: string;
    nome: string;
    nivelId: string | null;
    professorId: string | null;
    quadraId: string;
    capacidade: number;
    status: string;
    encontros: { diaSemana: number; horaInicio: Date; horaFim: Date }[];
    _count: { alunos: number };
  }): TurmaResponseDto {
    return {
      id: turma.id,
      companyId: turma.companyId,
      nome: turma.nome,
      nivelId: turma.nivelId,
      professorId: turma.professorId,
      quadraId: turma.quadraId,
      // SPEC-019 — `diaSemana`/`horaInicio`/`horaFim` SAÍRAM da resposta.
      // Quebra assumida: os três clientes são nossos e sobem juntos
      // (ADR-001). Mantê-los como alias do primeiro encontro faria uma turma
      // de três dias mentir sobre si mesma para quem não atualizou.
      encontros: turma.encontros.map((encontro) => ({
        diaSemana: encontro.diaSemana,
        horaInicio: formatTimeOnly(encontro.horaInicio),
        horaFim: formatTimeOnly(encontro.horaFim),
      })),
      capacidade: turma.capacidade,
      status: turma.status,
      alunosAlocados: turma._count.alunos,
    };
  }

  /**
   * SPEC-013/INV-012 — resolve o professor a partir do usuario autenticado.
   *
   * O JWT **nao** carrega `professorId`, e isso e deliberado (mesma razao de
   * ACHADO-003 na SPEC-009): claim e fotografia do momento do login, e
   * autorizacao precisa do presente. Um professor desligado da empresa, ou
   * cuja ficha mudou de dono, nao pode continuar lendo turma por causa de um
   * token emitido antes.
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

  // SPEC-019/AC-014 — o retorno anotado amarra estas rotas ao contrato
  // publicado, igual ao `toResponse`. Sem isso o DTO seria decoracao.
  async myTeachingClasses(
    companyId: string,
    usuarioId: string,
    incluirInativas = false,
  ): Promise<TurmaDoProfessorResponseDto[]> {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    // SPEC-056/D2 — **a inativa entra só com aula nos últimos 90 dias ou no
    // futuro**, de qualquer status. É o caso do GAP-015: inativada antes da
    // primeira aula, ela só tem aulas canceladas — e a SPEC-031/AC-019b exige
    // que o professor chegue a elas. Sem janela, a lista cresceria para sempre
    // com turma encerrada há anos. 90 é o teto que a rota de aulas já aceita.
    const inicioDaJanela = hojeNoFusoDoClube();
    inicioDaJanela.setUTCDate(inicioDaJanela.getUTCDate() - 90);
    const filtroDeStatus: Prisma.TurmaWhereInput = incluirInativas
      ? {
          OR: [
            { status: 'ativa' },
            {
              status: 'inativa',
              ocupacoes: { some: { data: { gte: inicioDaJanela } } },
            },
          ],
        }
      : { status: 'ativa' };

    const turmas = await this.prisma.turma.findMany({
      where: { companyId, professorId: professor.id, ...filtroDeStatus },
      include: {
        quadra: { select: { nome: true } },
        nivel: { select: { nome: true } },
        encontros: ORDEM_DOS_ENCONTROS,
        _count: { select: { alunos: true } },
      },
      // **SPEC-019/TASK-003 — ordena por NOME.** As colunas pelas quais esta
      // lista ordenava não existem mais.
      //
      // Ordenar por "o primeiro encontro" exigiria join com a filha e
      // escolheria um critério que a turma não tem: uma turma de terça e
      // sábado não é "uma turma de terça". Nome é estável, previsível, e é o
      // que o professor usa para achar a turma.
      orderBy: { nome: 'asc' },
    });

    return turmas.map((turma) => ({
      id: turma.id,
      nome: turma.nome,
      // SPEC-019 — os três campos soltos saíram; o professor vê os N dias.
      encontros: paraEncontrosDaResposta(turma.encontros),
      quadraNome: turma.quadra.nome,
      nivelNome: turma.nivel?.nome ?? null,
      capacidade: turma.capacidade,
      totalAlunos: turma._count.alunos,
      status: turma.status,
    }));
  }

  /**
   * SPEC-057/TASK-002 (card 5352) — **a ficha da turma, para o ALUNO.**
   *
   * > *"gostaria de ver o que tem na minha turma: professor, outros alunos,
   * > nível da turma"*
   *
   * **O escopo de matrícula vai no `WHERE`**, e não é conferido depois de
   * buscar: turma de que ele não participa responde **404, não 403** — `403`
   * confirmaria que ela existe, e quem está de fora não tem direito nem a
   * essa confirmação. É o mesmo desenho do `myTeachingClassDetail` acima.
   *
   * **A projeção é explícita** (`select`, não `include` largo) porque aqui
   * mora a INV-139: nome e nível dos colegas, e nada mais. Este é o primeiro
   * lugar do produto em que um aluno lê dado de outro aluno — autorizado pelo
   * Israel em 2026-09-16 —, e o limite é **só aplicação**. O que o sustenta é
   * o teste de conjunto exato de chaves, não uma constraint.
   */
  async myStudentClassDetail(
    companyId: string,
    usuarioId: string,
    turmaId: string,
  ): Promise<TurmaDoAlunoDetalheResponseDto> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
      select: { id: true },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }

    const turma = await this.prisma.turma.findFirst({
      where: {
        id: turmaId,
        companyId,
        alunos: { some: { alunoId: aluno.id } },
      },
      select: {
        id: true,
        nome: true,
        status: true,
        capacidade: true,
        quadra: { select: { nome: true } },
        nivel: { select: { nome: true } },
        professor: { select: { nome: true } },
        encontros: {
          select: { diaSemana: true, horaInicio: true, horaFim: true },
          orderBy: [{ diaSemana: 'asc' }, { horaInicio: 'asc' }],
        },
        alunos: {
          select: {
            aluno: {
              select: {
                id: true,
                usuario: { select: { nome: true } },
                nivel: { select: { nome: true } },
              },
            },
          },
        },
      },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    return {
      id: turma.id,
      nome: turma.nome,
      status: turma.status,
      capacidade: turma.capacidade,
      encontros: paraEncontrosDaResposta(turma.encontros),
      quadraNome: turma.quadra.nome,
      nivelNome: turma.nivel ? turma.nivel.nome : null,
      professorNome: turma.professor ? turma.professor.nome : null,
      // O `id` do colega é lido para decidir `souEu` e **não sai na
      // resposta**: a tela precisa marcar a própria linha, não endereçar
      // ninguém.
      colegas: turma.alunos.map((vinculo) => ({
        nome: vinculo.aluno.usuario.nome,
        nivelNome: vinculo.aluno.nivel ? vinculo.aluno.nivel.nome : null,
        souEu: vinculo.aluno.id === aluno.id,
      })),
    };
  }

  async myTeachingClassDetail(
    companyId: string,
    usuarioId: string,
    turmaId: string,
  ): Promise<TurmaDoProfessorDetalheResponseDto> {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    // `professorId` no WHERE, e nao conferido depois de buscar: turma de
    // colega devolve 404, nao 403. 403 confirmaria que a turma existe.
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId, professorId: professor.id },
      include: {
        quadra: { select: { nome: true } },
        nivel: { select: { nome: true } },
        encontros: ORDEM_DOS_ENCONTROS,
        alunos: {
          include: {
            aluno: {
              include: {
                usuario: { select: { nome: true } },
                nivel: { select: { nome: true } },
              },
            },
          },
        },
      },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    return {
      id: turma.id,
      nome: turma.nome,
      // **SPEC-019 — esta rota foi o BLOQUEADOR 1 da validação cruzada.**
      // A 1ª versão da spec listava só `GET /me/teacher/classes` no
      // contrato e esquecia o detalhe. A lista seria atualizada e esta tela
      // continuaria esperando campos removidos — tela branca no app do
      // professor, exatamente o DEF-012.
      encontros: paraEncontrosDaResposta(turma.encontros),
      quadraNome: turma.quadra.nome,
      nivelNome: turma.nivel?.nome ?? null,
      capacidade: turma.capacidade,
      // AC-008 — nome e nivel, e so. Telefone, e-mail e qualquer coisa de
      // pagamento ficam de fora: o professor precisa saber quem esta na
      // quadra, nao a ficha financeira de ninguem.
      alunos: turma.alunos.map((vinculo) => ({
        id: vinculo.aluno.id,
        nome: vinculo.aluno.usuario.nome,
        nivelNome: vinculo.aluno.nivel?.nome ?? null,
      })),
      // SPEC-056 — a ficha abre turma inativa por id desde sempre; agora diz.
      status: turma.status,
    };
  }
  /**
   * SPEC-034/TASK-004 — cancelar UMA ocorrência de turma.
   *
   * ### Este método CANCELA ocorrência de turma — e por isso trava primeiro
   *
   * A invariante mora em `presenca.service.ts`, no comentário logo acima de
   * `travarEValidarOcorrencia`: travar só `turmas` basta **porque** todo
   * caminho que cancela ocorrência de turma passa por esse mesmo lock. **Lá é
   * a fonte; aqui não se repete a contagem** — esta linha já disse "os
   * caminhos são três e este é o quarto" enquanto o outro arquivo dizia
   * "DOIS", no mesmo commit, e foi assim que a validação cruzada de
   * 2026-09-05 achou a divergência. Número duplicado é o que envelhece.
   *
   * O que importa aqui é a consequência: este método **começa** por
   * `turmas FOR UPDATE` (D12) porque sem isso a afirmação de lá vira falsa e
   * `salvarChamada` passa a poder gravar chamada numa aula recém-cancelada.
   * O FIT-023 (AC-016) é o teste que prova isso.
   *
   * ### A ordem dentro da transação
   *
   * **1. Trava a turma.** Nível 1 do INV-029, a raiz única.
   *
   * **2. Relê a ocorrência em statement NOVO**, com o lock na mão — é o
   * padrão que `presenca.service.ts:789` documenta com o caso do
   * `bloq9-snapshot`: um `JOIN` anterior ao lock devolveu
   * `pendente_pagamento` com o banco já em `cancelado`.
   *
   * **3. Idempotência ANTES do corte temporal.** Cancelar o que já está
   * cancelado devolve sucesso sem escrever — inclusive depois de a aula ter
   * começado. Uma retentativa de rede de um cancelamento que deu certo não
   * pode virar erro porque o relógio andou; é o mesmo raciocínio que o
   * `cancelBooking` já documenta.
   *
   * **4. Aula iniciada não se cancela** (D11). Cancelar é prospectivo: diz
   * que a aula **não vai** acontecer. Depois do início o assunto é
   * retrospectivo e tem dono — o `nao-houve` da SPEC-030, do professor.
   * Sem esse corte, cancelar uma aula de ontem com chamada e avaliação
   * lançadas seria reescrever o passado, liberando a quadra e deixando
   * presença e nota valendo (`LIM-034e`).
   */
  async cancelarOcorrencia(
    companyId: string,
    turmaId: string,
    ocupacaoId: string,
    motivo: string,
    autorId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      // Raiz de lock única (INV-029). Raw porque `FOR UPDATE` não é
      // expressável no query builder do Prisma.
      const turmas = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;
      if (turmas.length === 0) throw new NotFoundException();

      // Statement novo, com o lock na mão. Os QUATRO predicados importam:
      // sem `origemTurmaId`, a URL da turma A alcançaria a ocorrência da B.
      const ocupacao = await tx.ocupacaoQuadra.findFirst({
        where: {
          id: ocupacaoId,
          companyId,
          origemTipo: 'TURMA',
          origemTurmaId: turmaId,
        },
        select: {
          id: true,
          data: true,
          horaInicio: true,
          // SPEC-063/D5 — o aviso expira no **fim** da ocorrência, não no
          // início: o tick roda a cada 60 s, e um cancelamento feito dois
          // minutos antes da aula seria varrido como `expirada` sem uma
          // única tentativa de envio (AC-012).
          horaFim: true,
          statusPagamento: true,
        },
      });
      if (!ocupacao) throw new NotFoundException();

      // Idempotente, e ANTES do corte de propósito.
      if (ocupacao.statusPagamento === 'cancelado') return;

      if (aulaJaComecou(ocupacao.data, ocupacao.horaInicio)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'PRAZO_DE_CANCELAMENTO',
          message:
            'Esta aula já começou. Para registrar que ela não aconteceu, use a chamada.',
        });
      }

      // Preguiçoso (SPEC-032): a saída idempotente acima não grava ação
      // nenhuma, e é essa a razão de o registrador nascer aqui embaixo.
      const registrador = new RegistradorDeAcao(
        tx,
        companyId,
        autorId,
        'aula_cancelada',
        motivo,
      );
      await this.courtsService.cancelOneClassOccurrence(
        tx,
        companyId,
        ocupacao.id,
        registrador,
      );

      // SPEC-063/AC-001 — alunos da turma **e** o professor que tem conta.
      const avisos = new EnfileiradorDeAvisos(
        tx,
        companyId,
        autorId,
        'aula_cancelada',
      );
      avisos.comTurma(turmaId);
      avisos.anotarEfeito({
        data: ocupacao.data,
        horaInicio: ocupacao.horaInicio,
        horaFim: ocupacao.horaFim,
      });
      await avisos.despachar(registrador.idDaAcao);
    });
  }

  /**
   * SPEC-035/REQ-003 — **desfazer o cancelamento de UMA aula.**
   *
   * ## Por que aqui é descancelar, e na turma é regerar
   *
   * A D3 diz que reativar a **turma** regenera a grade, porque entre inativar
   * e reativar o horizonte andou. **Aqui não há horizonte que ande:**
   * ocorrência é uma data específica. Quem cancelou a aula de terça por
   * engano quer de volta a aula de terça — não uma grade nova a partir de
   * hoje. É também o único lugar do projeto onde o valor `reativada` do enum
   * (criado especulativamente pela SPEC-032, para esta spec) passa a
   * significar algo.
   *
   * ## A ordem das quatro recusas, e cada uma tem razão de estar onde está
   *
   * 1. **turma `FOR UPDATE`** — raiz de lock única (INV-029), a mesma de
   *    `cancelarOcorrencia`. Sem ela, cancelar e reativar a mesma ocorrência
   *    em paralelo decidiriam sobre leituras que já envelheceram.
   * 2. **os quatro predicados** — sem `origemTurmaId`, a URL da turma A
   *    alcançaria a ocorrência da B.
   * 3. **idempotência ANTES do corte temporal**, como na irmã: reativar o que
   *    já está no ar não é engano do usuário, é rede instável.
   * 4. **o passado não reativa** — mesmo código e mesma frase de
   *    `cancelarOcorrencia`. Ressuscitar uma aula que não aconteceu é
   *    exatamente o que a SPEC-030 existe para impedir: quem declara o que
   *    houve é a chamada.
   */
  async reativarOcorrencia(
    companyId: string,
    turmaId: string,
    ocupacaoId: string,
    motivo: string,
    autorId: string,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      const turmas = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;
      if (turmas.length === 0) throw new NotFoundException();

      const ocupacao = await tx.ocupacaoQuadra.findFirst({
        where: {
          id: ocupacaoId,
          companyId,
          origemTipo: 'TURMA',
          origemTurmaId: turmaId,
        },
        select: {
          id: true,
          quadraId: true,
          data: true,
          horaInicio: true,
          horaFim: true,
          statusPagamento: true,
        },
      });
      if (!ocupacao) throw new NotFoundException();

      // Idempotente, e ANTES do corte de propósito — espelho exato da irmã.
      if (ocupacao.statusPagamento !== 'cancelado') return;

      if (aulaJaComecou(ocupacao.data, ocupacao.horaInicio)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'PRAZO_DE_CANCELAMENTO',
          message:
            'Esta aula já começou. Para registrar que ela não aconteceu, use a chamada.',
        });
      }

      /**
       * **AC-012 — a pré-checagem existe para a MENSAGEM, não para a
       * garantia.**
       *
       * Quem garante é a `EXCLUDE no_overlap_por_quadra`: o `UPDATE` que
       * descancela insere a linha no índice, e o Postgres recusa com `23P01`
       * se houver sobreposição — inclusive contra uma reserva criada por
       * outra conexão entre este `SELECT` e aquele `UPDATE` (FIT-034).
       *
       * O que a pré-checagem acrescenta é **quem** tomou o horário. Sem ela o
       * gestor receberia "ocupado" e teria de caçar na agenda quem ocupou;
       * com ela, a resposta já nomeia a ocupação — que é o "recusar **com
       * aviso**" que o item 13 do backlog pediu, e não só "recusar".
       *
       * Sobreposição **semiaberta** (`lt`/`gt`), a mesma regra do resto do
       * módulo: uma reserva que começa às 10:00 não conflita com uma aula que
       * termina às 10:00.
       */
      const conflitante = await tx.ocupacaoQuadra.findFirst({
        where: {
          companyId,
          quadraId: ocupacao.quadraId,
          data: ocupacao.data,
          id: { not: ocupacao.id },
          statusPagamento: { not: 'cancelado' },
          horaInicio: { lt: ocupacao.horaFim },
          horaFim: { gt: ocupacao.horaInicio },
        },
        select: { id: true, origemTipo: true },
      });
      if (conflitante) {
        throw new ConflictException({
          statusCode: 409,
          code: 'HORARIO_OCUPADO',
          message: 'Este horário foi ocupado enquanto a aula estava cancelada.',
          conflictWith: {
            ocupacaoId: conflitante.id,
            origemTipo: conflitante.origemTipo,
          },
        });
      }

      // Preguiçoso (SPEC-032), pela mesma razão da irmã: as duas saídas
      // idempotentes acima não gravam ação nenhuma.
      const registrador = new RegistradorDeAcao(
        tx,
        companyId,
        autorId,
        'aula_reativada',
        motivo,
      );
      await this.courtsService.reactivateOneClassOccurrence(
        tx,
        companyId,
        ocupacao.id,
        registrador,
      );

      // SPEC-063/AC-013 — espelho exato da irmã: alunos e professor com conta,
      // `titulo = "Sua aula"`, prazo no fim da ocorrência.
      const avisos = new EnfileiradorDeAvisos(
        tx,
        companyId,
        autorId,
        'aula_reativada',
      );
      avisos.comTurma(turmaId);
      avisos.anotarEfeito({
        data: ocupacao.data,
        horaInicio: ocupacao.horaInicio,
        horaFim: ocupacao.horaFim,
      });
      await avisos.despachar(registrador.idDaAcao);
    });
  }
}
