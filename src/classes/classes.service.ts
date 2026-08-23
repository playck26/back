import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  formatDateOnly,
  formatTimeOnly,
  gerarDatasSemanaisFuturas,
  parseTimeOnly,
} from '../courts/date-time.util';
import { StudentsService } from '../people/students.service';
import { CourtsService } from '../courts/courts.service';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateClassDto } from './dto/create-class.dto';
import type { PaginationQueryDto } from '../people/dto/pagination-query.dto';
import type { UpdateClassDto } from './dto/update-class.dto';

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
        include: { _count: { select: { alunos: true } } },
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

  async create(companyId: string, dto: CreateClassDto) {
    if (dto.horaFim <= dto.horaInicio) {
      throw new UnprocessableEntityException(
        'horaFim precisa ser depois de horaInicio',
      );
    }
    await this.assertQuadraDaEmpresa(companyId, dto.quadraId);
    if (dto.nivelId) {
      await this.assertNivelDaEmpresa(companyId, dto.nivelId);
    }
    if (dto.professorId) {
      await this.assertProfessorDaEmpresa(companyId, dto.professorId);
    }

    const horaInicioDate = parseTimeOnly(dto.horaInicio);
    const horaFimDate = parseTimeOnly(dto.horaFim);
    const ocorrencias = gerarDatasSemanaisFuturas(dto.diaSemana).map(
      (data) => ({ data, horaInicio: horaInicioDate, horaFim: horaFimDate }),
    );

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
          diaSemana: dto.diaSemana,
          horaInicio: horaInicioDate,
          horaFim: horaFimDate,
          capacidade: dto.capacidade,
        },
      });

      await this.courtsService.registerClassOccupancy(
        tx,
        companyId,
        dto.quadraId,
        criada.id,
        ocorrencias,
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

  async update(companyId: string, id: string, dto: UpdateClassDto) {
    const existente = await this.prisma.turma.findFirst({
      where: { id, companyId },
    });
    if (!existente) {
      throw new NotFoundException();
    }

    const mudouHorario =
      dto.quadraId !== undefined ||
      dto.diaSemana !== undefined ||
      dto.horaInicio !== undefined ||
      dto.horaFim !== undefined;

    const quadraId = dto.quadraId ?? existente.quadraId;
    const diaSemana = dto.diaSemana ?? existente.diaSemana;
    const horaInicioStr =
      dto.horaInicio ?? formatTimeOnly(existente.horaInicio);
    const horaFimStr = dto.horaFim ?? formatTimeOnly(existente.horaFim);

    if (mudouHorario) {
      if (horaFimStr <= horaInicioStr) {
        throw new UnprocessableEntityException(
          'horaFim precisa ser depois de horaInicio',
        );
      }
      await this.assertQuadraDaEmpresa(companyId, quadraId);
    }
    if (dto.nivelId) {
      await this.assertNivelDaEmpresa(companyId, dto.nivelId);
    }
    if (dto.professorId) {
      await this.assertProfessorDaEmpresa(companyId, dto.professorId);
    }

    const horaInicioDate = parseTimeOnly(horaInicioStr);
    const horaFimDate = parseTimeOnly(horaFimStr);

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
          diaSemana: dto.diaSemana,
          horaInicio: dto.horaInicio ? horaInicioDate : undefined,
          horaFim: dto.horaFim ? horaFimDate : undefined,
          capacidade: dto.capacidade,
          status: dto.status,
        },
      });

      if (mudouHorario) {
        const hojeUTC = new Date(
          Date.UTC(
            new Date().getUTCFullYear(),
            new Date().getUTCMonth(),
            new Date().getUTCDate(),
          ),
        );
        await this.courtsService.cancelFutureClassOccupancies(
          tx,
          companyId,
          id,
          hojeUTC,
        );

        const ocorrencias = gerarDatasSemanaisFuturas(diaSemana).map(
          (data) => ({
            data,
            horaInicio: horaInicioDate,
            horaFim: horaFimDate,
          }),
        );
        await this.courtsService.registerClassOccupancy(
          tx,
          companyId,
          quadraId,
          id,
          ocorrencias,
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
  async myUpcomingClasses(companyId: string, usuarioId: string) {
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

    const hojeUTC = new Date(
      Date.UTC(
        new Date().getUTCFullYear(),
        new Date().getUTCMonth(),
        new Date().getUTCDate(),
      ),
    );

    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: { in: turmaIds },
        statusPagamento: { not: 'cancelado' },
        data: { gte: hojeUTC },
      },
      include: { origemTurma: true, quadra: true },
      orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
    });

    return ocupacoes.map((ocupacao) => ({
      ocupacaoId: ocupacao.id,
      turmaId: ocupacao.origemTurmaId,
      turmaNome: ocupacao.origemTurma?.nome ?? null,
      quadraId: ocupacao.quadraId,
      quadraNome: ocupacao.quadra.nome,
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

  private toResponse(turma: {
    id: string;
    companyId: string;
    nome: string;
    nivelId: string | null;
    professorId: string | null;
    quadraId: string;
    diaSemana: number;
    horaInicio: Date;
    horaFim: Date;
    capacidade: number;
    status: string;
    _count: { alunos: number };
  }) {
    return {
      id: turma.id,
      companyId: turma.companyId,
      nome: turma.nome,
      nivelId: turma.nivelId,
      professorId: turma.professorId,
      quadraId: turma.quadraId,
      diaSemana: turma.diaSemana,
      horaInicio: formatTimeOnly(turma.horaInicio),
      horaFim: formatTimeOnly(turma.horaFim),
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

  async myTeachingClasses(companyId: string, usuarioId: string) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    const turmas = await this.prisma.turma.findMany({
      where: { companyId, professorId: professor.id, status: 'ativa' },
      include: {
        quadra: { select: { nome: true } },
        nivel: { select: { nome: true } },
        _count: { select: { alunos: true } },
      },
      orderBy: [{ diaSemana: 'asc' }, { horaInicio: 'asc' }],
    });

    return turmas.map((turma) => ({
      id: turma.id,
      nome: turma.nome,
      diaSemana: turma.diaSemana,
      horaInicio: formatTimeOnly(turma.horaInicio),
      horaFim: formatTimeOnly(turma.horaFim),
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
  ) {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    // `professorId` no WHERE, e nao conferido depois de buscar: turma de
    // colega devolve 404, nao 403. 403 confirmaria que a turma existe.
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId, professorId: professor.id },
      include: {
        quadra: { select: { nome: true } },
        nivel: { select: { nome: true } },
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
      diaSemana: turma.diaSemana,
      horaInicio: formatTimeOnly(turma.horaInicio),
      horaFim: formatTimeOnly(turma.horaFim),
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
