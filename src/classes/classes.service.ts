import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  formatDateOnly,
  formatTimeOnly,
  gerarDatasSemanaisFuturas,
  hojeNoFusoDoClube,
  parseTimeOnly,
} from '../courts/date-time.util';
import { StudentsService } from '../people/students.service';
import { CourtsService } from '../courts/courts.service';
import { RegistradorDeAcao } from '../common/auditoria/registrador-de-acao';
import { PrismaService } from '../prisma/prisma.service';
import { AulaDoAlunoResponseDto } from './dto/me-response.dto';
import type { CreateClassDto } from './dto/create-class.dto';
import type { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import type { UpdateClassDto } from './dto/update-class.dto';
import { validarEncontros, type EncontroDaTurma } from './encontros';
import type {
  TurmaDoProfessorDetalheResponseDto,
  TurmaDoProfessorResponseDto,
  TurmaResponseDto,
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

@Injectable()
export class ClassesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courtsService: CourtsService,
    // SPEC-009/INV-010: a regra de vínculo é de MOD-003; aqui só se
    // pergunta a ela.
    private readonly studentsService: StudentsService,
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

    return {
      data: rows.map((turma) => this.toResponse(turma)),
      page,
      pageSize,
      total,
    };
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
      await this.courtsService.registerClassOccupancy(
        tx,
        companyId,
        dto.quadraId,
        criada.id,
        ocorrencias,
        new RegistradorDeAcao(tx, companyId, autorId, 'turma_criada'),
      );

      return criada;
    });

    return this.toResponse({ ...turma, _count: { alunos: 0 } });
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
    return {
      ...this.toResponse(turma),
      alunos: turma.alunos.map((alocacao) => ({
        alunoId: alocacao.alunoId,
        nome: alocacao.aluno.usuario.nome,
        email: alocacao.aluno.usuario.email,
      })),
    };
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

    const quadraId = dto.quadraId ?? existente.quadraId;

    // `null` enquanto a recorrência não for necessária. **A consulta só
    // acontece dentro do `if`**: renomear a turma não pode custar uma ida ao
    // banco para ler encontros que ninguém vai usar.
    let encontros: EncontroDaTurma[] | null = null;

    if (mudouHorario) {
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
      const atualizada = await tx.turma.update({
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

      if (mudouHorario) {
        // DEF-020: o corte (`gte`) é hoje NO FUSO DO CLUBE. Em UTC, uma
        // edição feita às 21h30 de segunda tinha corte na terça — e a
        // ocupação de segunda escapava do cancelamento, sobrevivendo com o
        // horário ANTIGO enquanto a grade nova era gerada a partir de terça.
        //
        // O corte precisa ser o mesmo que `gerarDatasSemanaisFuturas` usa
        // logo abaixo para regerar: são as duas metades da mesma operação, e
        // é por isso que as duas passaram a chamar a mesma função.
        const hojeUTC = hojeNoFusoDoClube();

        // SPEC-032/D2 e INV-078 — **UM registrador para as duas metades.**
        // Editar o horario cancela as antigas e cria as novas dentro do
        // MESMO `$transaction`, a partir de UM `PATCH`. E uma acao
        // (`turma_horario_editado`) com eventos `cancelada` e `criada`.
        // Dois registradores aqui criariam duas acoes para um gesto — e o
        // banco nao reclamaria, e por isso a instancia unica e o mecanismo.
        const registrador = new RegistradorDeAcao(
          tx,
          companyId,
          autorId,
          'turma_horario_editado',
        );

        await this.courtsService.cancelFutureClassOccupancies(
          tx,
          companyId,
          id,
          hojeUTC,
          registrador,
        );

        await this.courtsService.registerClassOccupancy(
          tx,
          companyId,
          quadraId,
          id,
          this.ocorrenciasDosEncontros(encontros ?? []),
          registrador,
        );
      }

      return atualizada;
    });

    return this.findOne(companyId, turma.id);
  }

  async allocateStudent(companyId: string, turmaId: string, alunoId: string) {
    return this.prisma.$transaction(async (tx) => {
      // REQ-004/INV-003 (DATA_MODEL.md): SELECT ... FOR UPDATE na linha da
      // turma serializa checagens de capacidade concorrentes — não
      // expressável no query builder do Prisma, raw query necessária.
      const turmaRows = await tx.$queryRaw<
        { id: string; capacidade: number }[]
      >`
        SELECT id, capacidade FROM turmas
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
      this.studentsService.garantirVinculoAprovado(aluno);

      const jaAlocado = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId },
      });
      if (jaAlocado) {
        return jaAlocado;
      }

      const alocados = await tx.turmaAluno.count({ where: { turmaId } });
      if (alocados >= turma.capacidade) {
        throw new ConflictException(
          'Capacidade da turma excedida (INV-003, AC-002)',
        );
      }

      return tx.turmaAluno.create({ data: { turmaId, alunoId } });
    });
  }

  async removeStudent(
    companyId: string,
    turmaId: string,
    alunoId: string,
  ): Promise<void> {
    await this.assertTurmaDaEmpresa(companyId, turmaId);

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

      await tx.turmaAluno.delete({ where: { id: alocacao.id } });
    });
  }

  // CON-004.5 (SPEC-005): próximas aulas do aluno logado — escopado por
  // aluno_id via turma_alunos, não só por company_id (AC-002: um aluno
  // não pode ver aula de outro aluno da mesma empresa). View-only: uma
  // ocupação de turma é compartilhada por todos os alunos matriculados
  // (não tem aluno_id próprio), então remarcar/cancelar uma ocorrência
  // individual não é suportado nesta rodada (GAP-008,
  // TARGET_ARCHITECTURE.md) — CON-004.6/004.7 ficam para depois do MVP.
  async myUpcomingClasses(
    companyId: string,
    usuarioId: string,
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
        data: { gte: hojeUTC },
      },
      // SPEC-044 — `select`, e não `include`. Com `include: { origemTurma:
      // true, quadra: true }` cada ocorrência trazia a turma e a quadra
      // INTEIRAS, e o `map` abaixo usa **um** campo de cada. Medido em
      // produção em 2026-09-03: 55 ocorrências carregavam as mesmas 4 turmas
      // 55 vezes, com todas as colunas, do banco até a serialização.
      //
      // A lista de campos é exatamente a que o `map` consome — acrescentar
      // campo aqui sem usar embaixo é reabrir o mesmo buraco em miniatura.
      select: {
        id: true,
        origemTurmaId: true,
        quadraId: true,
        data: true,
        horaInicio: true,
        horaFim: true,
        origemTurma: { select: { nome: true } },
        quadra: { select: { nome: true } },
        // SPEC-030 / achado 2 — o aluno precisa saber que a aula não
        // aconteceu. Sem isto ela aparecia como aula normal em "Próximas" e
        // sumia das "Anteriores" no dia seguinte (o filtro da avaliação),
        // sem nunca dizer o que houve.
        chamadas: { select: { completude: true } },
      },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    });

    return ocupacoes.map((ocupacao) => ({
      ocupacaoId: ocupacao.id,
      turmaId: ocupacao.origemTurmaId,
      turmaNome: ocupacao.origemTurma?.nome ?? null,
      quadraId: ocupacao.quadraId,
      quadraNome: ocupacao.quadra.nome,
      // Um booleano, e não o `estado` inteiro: o aluno não precisa
      // distinguir `completa` de `legada` — isso é registro do professor. O
      // que muda a vida dele é só "a aula não aconteceu".
      naoRealizada: ocupacao.chamadas[0]?.completude === 'nao_houve',
      data: formatDateOnly(ocupacao.data),
      horaInicio: formatTimeOnly(ocupacao.horaInicio),
      horaFim: formatTimeOnly(ocupacao.horaFim),
    }));
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

  private async assertQuadraDaEmpresa(
    companyId: string,
    quadraId: string,
  ): Promise<void> {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId },
    });
    if (!quadra) {
      throw new NotFoundException('Quadra não encontrada');
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

  private async assertProfessorDaEmpresa(
    companyId: string,
    professorId: string,
  ): Promise<void> {
    const professor = await this.prisma.professor.findFirst({
      where: { id: professorId, companyId },
    });
    if (!professor) {
      throw new NotFoundException('Professor não encontrado');
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
  ): Promise<TurmaDoProfessorResponseDto[]> {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    const turmas = await this.prisma.turma.findMany({
      where: { companyId, professorId: professor.id, status: 'ativa' },
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
    }));
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
    };
  }
}
