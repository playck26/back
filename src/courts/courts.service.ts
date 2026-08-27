import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { StudentsService } from '../people/students.service';
import { agruparEmBlocos, fingerprintDoPedido } from './slots.util';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import { PrismaService } from '../prisma/prisma.service';
import { ImagemDaQuadraService } from './imagem-da-quadra.service';
import {
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
  parseTimeOnly,
} from './date-time.util';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { CreateCourtDto } from './dto/create-court.dto';
import type { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import type { UpdateCourtDto } from './dto/update-court.dto';
import type { QuadraResponseDto } from './dto/quadra-response.dto';

interface ConflitoDetectado {
  ocupacaoId: string;
  origemTipo: string;
}

/**
 * Códigos do Prisma que falam da **vida da transação ou da conexão**, não do
 * dado que se tentou gravar.
 *
 * Ver `ehCorridaPerdida`. A lista é curta de propósito: o que não estiver
 * aqui continua tratado como corrida, que é o comportamento conservador
 * (recusar a escrita) e o que a INV-001 exige.
 */
const CODIGOS_DE_INFRA_NAO_SAO_CONFLITO = new Set([
  'P1001', // servidor inalcançável
  'P1002', // timeout ao abrir conexão
  'P1008', // timeout de operação
  'P1017', // o servidor encerrou a conexão
  'P2024', // esgotou o pool esperando conexão
  'P2028', // transação expirada ou já fechada
]);

/**
 * DEF-013 — **nem todo erro do Prisma é corrida perdida.**
 *
 * A violação da constraint `EXCLUDE` (INV-001) não tem P-código dedicado:
 * o `23P01` do Postgres chega como erro genérico do Prisma. Por isso os dois
 * caminhos de escrita de ocupação traduziam *qualquer* erro do Prisma em 409
 * — e enquanto a transação cabia no tempo, isso descrevia a realidade.
 *
 * Não cabe mais. Em 2026-08-27 o `P2028` (transação expirada) começou a cair
 * dentro dessa tradução, e o gestor passou a ler **"conflito de horário com
 * ocupação existente"** numa quadra vazia. É pior que o 500 que o defeito
 * causava do outro lado: 500 manda investigar, esse 409 manda desistir.
 */
function ehCorridaPerdida(error: unknown): boolean {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    return !CODIGOS_DE_INFRA_NAO_SAO_CONFLITO.has(error.code);
  }
  return error instanceof Prisma.PrismaClientUnknownRequestError;
}

/** Forma mínima de uma ocupação para virar resposta de API. */
interface OcupacaoParaResposta {
  id: string;
  companyId: string;
  quadraId: string;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
  origemTipo: string;
  alunoId: string | null;
  statusPagamento: string;
  /** SPEC-011: quanto foi cobrado, congelado na criação. Nulo em turma. */
  valor?: Prisma.Decimal | null;
}

@Injectable()
export class CourtsService {
  constructor(
    private readonly prisma: PrismaService,
    // SPEC-009/INV-010: reserva ocupa horário real (INV-001) — cadastro
    // não aprovado não bloqueia a agenda da empresa.
    private readonly studentsService: StudentsService,
    // SPEC-010: única fonte de verdade sobre "estar aberto".
    private readonly horarios: HorarioFuncionamentoService,
    // SPEC-018/TASK-005: única fonte que traduz `imagem_key` em URL. Quatro
    // caminhos de leitura chamam o mesmo `resolver()` em vez de repetirem a
    // conferência da chave — repetida, uma delas ficaria para trás.
    private readonly imagens: ImagemDaQuadraService,
  ) {}

  /**
   * SPEC-020/TASK-003 — o que toda leitura de quadra precisa trazer.
   *
   * **Declarado uma vez e reusado**, pelo mesmo motivo do
   * `COM_FOTO_DA_CONTA` de professores: consulta que esqueça o `include`
   * não quebra — devolve `esporte: null` numa quadra que tem esporte, e o
   * filtro do aluno perde a quadra sem ninguém errar nada.
   */
  private static readonly COM_CATALOGOS = {
    esporteRef: { select: { id: true, nome: true } },
    categoriaRef: { select: { id: true, nome: true } },
  } as const;

  /**
   * Resolve uma opção de catálogo **da própria empresa**.
   *
   * **422 e não 404**, ao contrário de `GET /court-sports/:id`. A diferença
   * é o que a pessoa está fazendo: ler uma opção que não é dela é "não
   * existe" (e o 404 esconde a existência); mandar essa opção no corpo de
   * uma quadra é payload inválido, e dizer isso ajuda quem integra.
   *
   * O banco também recusa, pela FK composta (INV-054). Esta checagem existe
   * para a mensagem — o erro do banco diria "violates foreign key
   * constraint" e nada sobre qual campo.
   */
  private async resolverOpcao(
    tipo: 'esporte' | 'categoria',
    companyId: string,
    id: string,
  ): Promise<{ id: string; nome: string }> {
    // Os dois `findFirst` gerados pelo Prisma têm assinaturas genéricas
    // diferentes, e a UNIÃO delas não é chamável. Ramificar a chamada
    // custa três linhas e mantém o typecheck de pé — um `as never` para
    // unificar tiraria exatamente a checagem que interessa aqui.
    const where = { id, companyId };
    const select = { id: true, nome: true };
    const opcao =
      tipo === 'esporte'
        ? await this.prisma.esporteDeQuadra.findFirst({ where, select })
        : await this.prisma.categoriaDeQuadra.findFirst({ where, select });

    if (opcao === null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: `${tipo.toUpperCase()}_INVALIDO`,
        message: `A opção de ${tipo} informada não existe nesta empresa.`,
        campo: tipo === 'esporte' ? 'esporteId' : 'categoriaId',
      });
    }
    return opcao;
  }

  async list(companyId: string, page = 1, pageSize = 20) {
    const [data, total] = await Promise.all([
      this.prisma.quadra.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: CourtsService.COM_CATALOGOS,
      }),
      this.prisma.quadra.count({ where: { companyId } }),
    ]);

    return {
      data: data.map((quadra) => this.toQuadraResponse(quadra)),
      page,
      pageSize,
      total,
    };
  }

  async create(companyId: string, dto: CreateCourtDto) {
    const esporte = await this.resolverOpcao(
      'esporte',
      companyId,
      dto.esporteId,
    );
    if (dto.categoriaId !== undefined) {
      await this.resolverOpcao('categoria', companyId, dto.categoriaId);
    }

    const quadra = await this.prisma.quadra.create({
      data: {
        companyId,
        nome: dto.nome,
        // A escrita dupla em `quadras.esporte` acabou na TASK-004: a coluna
        // de texto não existe mais. **Ela era a origem de toda esta spec** —
        // texto livre digitado no Admin, e a barra de filtro do app do aluno
        // montada com os valores distintos dela.
        esporteId: esporte.id,
        categoriaId: dto.categoriaId ?? null,
        precoHora: dto.precoHora,
      },
      include: CourtsService.COM_CATALOGOS,
    });
    return this.toQuadraResponse(quadra);
  }

  async findOne(companyId: string, id: string) {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id, companyId },
      include: CourtsService.COM_CATALOGOS,
    });
    if (!quadra) {
      throw new NotFoundException();
    }
    return this.toQuadraResponse(quadra);
  }

  async update(companyId: string, id: string, dto: UpdateCourtDto) {
    await this.assertQuadraDaEmpresa(companyId, id);

    const esporte =
      dto.esporteId === undefined
        ? undefined
        : await this.resolverOpcao('esporte', companyId, dto.esporteId);

    if (dto.categoriaId !== undefined && dto.categoriaId !== null) {
      await this.resolverOpcao('categoria', companyId, dto.categoriaId);
    }

    const quadra = await this.prisma.quadra.update({
      where: { id },
      data: {
        nome: dto.nome,
        // `undefined` significa "não mexe no esporte". Não existe caminho
        // para LIMPAR o esporte, e é por desenho: desde a TASK-004 a coluna
        // é `NOT NULL` no banco.
        ...(esporte === undefined ? {} : { esporteId: esporte.id }),
        // `null` explícito LIMPA; ausente não mexe. São coisas diferentes,
        // e é o que permite desclassificar uma quadra.
        ...(dto.categoriaId === undefined
          ? {}
          : { categoriaId: dto.categoriaId }),
        precoHora: dto.precoHora,
        status: dto.status,
      },
      include: CourtsService.COM_CATALOGOS,
    });
    return this.toQuadraResponse(quadra);
  }

  async availability(companyId: string, quadraId: string, data: string) {
    await this.assertQuadraDaEmpresa(companyId, quadraId);

    const dataDate = parseDateOnly(data);
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        quadraId,
        data: dataDate,
        statusPagamento: { not: 'cancelado' },
      },
    });

    // SPEC-010/REQ-004: a grade vem do horário efetivo da quadra naquele
    // dia da semana, não mais de constante. Mesma função usada pela
    // validação de criação (AC-015) — é o que impede a tela oferecer um
    // horário que o servidor recusaria depois.
    const horario = await this.horarios.resolverParaData(
      companyId,
      quadraId,
      dataDate,
    );

    const slots = this.horarios.gerarSlots(horario).map((slot) => {
      // Conflito é **semiaberto** (REQ-010/AC-020): uma ocupação que
      // começa às 10:00 não ocupa o slot que termina às 10:00.
      const conflito = ocupacoes.find(
        (ocupacao) =>
          ocupacao.horaInicio < slot.fim && ocupacao.horaFim > slot.inicio,
      );

      return {
        slot: `${formatTimeOnly(slot.inicio)}-${formatTimeOnly(slot.fim)}`,
        status: !conflito
          ? ('livre' as const)
          : conflito.origemTipo === 'TURMA'
            ? ('ocupado_turma' as const)
            : ('ocupado_avulso' as const),
      };
    });

    // AC-008: `estado` distingue "fechado" de "aberto sem nada livre" — as
    // duas situações produzem lista vazia depois que a tela filtra os
    // slots ocupados, e sem isto o app do aluno mostraria a mesma grade
    // vazia sem explicação nos dois casos.
    return { quadraId, data, estado: horario.estado, slots };
  }

  /**
   * SPEC-011 — cria uma ou mais reservas a partir de uma seleção de
   * horários no mesmo dia.
   *
   * Ordem das validações fixada na spec, para a mensagem de erro dizer a
   * verdade: normalizar → recusar duplicado/sobreposto → agrupar → limite
   * de 6h → expediente (INV-011) → conflito (INV-001) → inserir em
   * transação. A constraint `EXCLUDE` segue sendo a garantia final; a
   * pré-checagem existe para a resposta apontar **qual** bloco falhou.
   */
  async createBooking(
    companyId: string,
    dto: CreateBookingDto,
    clientRequestId?: string,
  ) {
    const quadra = await this.buscarQuadraDaEmpresa(companyId, dto.quadraId);

    // Formato antigo (uma hora por pedido) continua aceito durante a
    // transição: os frontends em produção ainda enviam assim, e o `back`
    // sobe antes das telas. A resposta acompanha o formato do pedido —
    // devolver array para quem mandou o formato antigo quebraria o app do
    // aluno que está no ar agora.
    const formatoAntigo = !dto.slots;
    const slots = dto.slots ?? [
      { horaInicio: dto.horaInicio as string, horaFim: dto.horaFim as string },
    ];
    if (formatoAntigo && (!dto.horaInicio || !dto.horaFim)) {
      throw new UnprocessableEntityException(
        'Informe `slots` ou `horaInicio` e `horaFim`.',
      );
    }

    const blocos = agruparEmBlocos(slots);
    const fingerprint = fingerprintDoPedido(dto.quadraId, dto.data, slots);

    if (clientRequestId) {
      const jaFeito = await this.pedidoJaAtendido(
        companyId,
        clientRequestId,
        fingerprint,
      );
      if (jaFeito) {
        return this.responderReservas(jaFeito, formatoAntigo);
      }
    }

    if (dto.alunoId) {
      await this.studentsService.exigirVinculoAprovado(companyId, dto.alunoId);
    }

    const dataDate = parseDateOnly(dto.data);
    const horarioDoDia = await this.horarios.resolverParaData(
      companyId,
      dto.quadraId,
      dataDate,
    );

    for (const bloco of blocos) {
      // INV-011 antes do conflito: horário fora do expediente é inválido
      // mesmo com a quadra livre, e responder "conflito" mentiria sobre o
      // motivo. O bloco precisa caber **inteiro** — meia reserva aceita
      // faria a pessoa pagar duas horas e ter uma.
      if (
        !this.horarios.dentroDoExpediente(
          horarioDoDia,
          parseTimeOnly(bloco.horaInicio),
          parseTimeOnly(bloco.horaFim),
        )
      ) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'FORA_DO_EXPEDIENTE',
          message: `O horário ${bloco.horaInicio}–${bloco.horaFim} está fora do funcionamento da quadra.`,
          bloco: `${bloco.horaInicio}-${bloco.horaFim}`,
        });
      }
    }

    for (const bloco of blocos) {
      const conflito = await this.findConflito(
        companyId,
        dto.quadraId,
        dataDate,
        parseTimeOnly(bloco.horaInicio),
        parseTimeOnly(bloco.horaFim),
      );
      if (conflito) {
        throw new ConflictException({
          message: `Conflito de horário em ${bloco.horaInicio}–${bloco.horaFim} (INV-001)`,
          bloco: `${bloco.horaInicio}-${bloco.horaFim}`,
          conflictWith: conflito,
        });
      }
    }

    try {
      // Tudo ou nada (AC-005): um pedido de 3 blocos com 1 inválido não
      // pode deixar 2 criados. A transação também cobre o pedido em si —
      // sem ela, uma falha no meio deixaria a chave de idempotência
      // gravada sem as reservas correspondentes.
      const criadas = await this.prisma.$transaction(async (tx) => {
        const pedido = clientRequestId
          ? await tx.pedidoReserva.create({
              data: { companyId, clientRequestId, fingerprint },
            })
          : null;

        const resultado: OcupacaoParaResposta[] = [];
        for (const bloco of blocos) {
          resultado.push(
            await tx.ocupacaoQuadra.create({
              data: {
                companyId,
                quadraId: dto.quadraId,
                data: dataDate,
                horaInicio: parseTimeOnly(bloco.horaInicio),
                horaFim: parseTimeOnly(bloco.horaFim),
                origemTipo: 'AVULSO',
                alunoId: dto.alunoId,
                // Congelado na criação (AC-004): reajustar o preço da
                // quadra depois não mexe em reserva existente.
                valor: new Prisma.Decimal(quadra.precoHora).mul(bloco.horas),
                pedidoId: pedido?.id,
              },
            }),
          );
        }
        return resultado;
      });

      return this.responderReservas(criadas, formatoAntigo);
    } catch (error) {
      // A constraint EXCLUDE (INV-001) e os índices únicos não têm código
      // Prisma dedicado — a violação de EXCLUDE (23P01) chega como
      // PrismaClientUnknownRequestError. Depois dos pré-checks acima, só
      // pode ser corrida: outra requisição ganhou o slot ou a mesma chave.
      // **Só pode** — desde que o erro seja de dado. Transação expirada e
      // conexão caída não são corrida, e virar 409 aqui faria a reserva do
      // aluno mentir do mesmo jeito que a da turma (DEF-013).
      if (ehCorridaPerdida(error)) {
        if (clientRequestId) {
          const jaFeito = await this.pedidoJaAtendido(
            companyId,
            clientRequestId,
            fingerprint,
          );
          if (jaFeito) {
            return this.responderReservas(jaFeito, formatoAntigo);
          }
        }

        for (const bloco of blocos) {
          const conflito = await this.findConflito(
            companyId,
            dto.quadraId,
            dataDate,
            parseTimeOnly(bloco.horaInicio),
            parseTimeOnly(bloco.horaFim),
          );
          if (conflito) {
            throw new ConflictException({
              message: `Conflito de horário em ${bloco.horaInicio}–${bloco.horaFim} (INV-001)`,
              bloco: `${bloco.horaInicio}-${bloco.horaFim}`,
              conflictWith: conflito,
            });
          }
        }
      }
      throw error;
    }
  }

  /**
   * AC-006/AC-010 — a idempotência é do **pedido**.
   *
   * Mesma chave e mesmo payload devolve as reservas originais; mesma chave
   * e payload diferente é erro explícito. "Encaixar" blocos novos numa
   * chave antiga produziria um pedido que ninguém fez.
   */
  private async pedidoJaAtendido(
    companyId: string,
    clientRequestId: string,
    fingerprint: string,
  ) {
    const pedido = await this.prisma.pedidoReserva.findUnique({
      where: { companyId_clientRequestId: { companyId, clientRequestId } },
      include: { ocupacoes: true },
    });

    if (pedido) {
      if (pedido.fingerprint !== fingerprint) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'IDEMPOTENCY_KEY_REUSED',
          message:
            'Esta chave de pedido já foi usada com outra seleção de horários.',
        });
      }
      return pedido.ocupacoes;
    }

    // Compatibilidade com o mecanismo anterior à SPEC-011: reservas criadas
    // antes desta versão guardam a chave na própria ocupação. Sem esta
    // consulta, um retry que atravessasse o deploy criaria duplicata.
    const legado = await this.prisma.ocupacaoQuadra.findFirst({
      where: { companyId, clientRequestId },
    });
    return legado ? [legado] : null;
  }

  /**
   * A resposta acompanha o formato do pedido: quem mandou o formato antigo
   * recebe um objeto, quem mandou `slots` recebe a lista. Devolver array
   * para todo mundo quebraria os frontends que estão em produção agora.
   */
  private responderReservas(
    ocupacoes: OcupacaoParaResposta[],
    formatoAntigo: boolean,
  ) {
    const reservas = ocupacoes.map((o) => this.toOcupacaoResponse(o));
    return formatoAntigo ? reservas[0] : { reservas };
  }

  private async buscarQuadraDaEmpresa(companyId: string, quadraId: string) {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId },
    });
    if (!quadra) {
      throw new NotFoundException();
    }
    return quadra;
  }

  async listBookings(
    companyId: string,
    query: ListBookingsQueryDto,
    alunoIdScope?: string,
  ) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const where: Prisma.OcupacaoQuadraWhereInput = {
      companyId,
      ...(alunoIdScope ? { alunoId: alunoIdScope } : {}),
      ...(query.status ? { statusPagamento: query.status } : {}),
      ...(query.data ? { data: parseDateOnly(query.data) } : {}),
    };

    const [data, total] = await Promise.all([
      this.prisma.ocupacaoQuadra.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: [{ data: 'desc' }, { horaInicio: 'asc' }],
      }),
      this.prisma.ocupacaoQuadra.count({ where }),
    ]);

    return {
      data: data.map((ocupacao) => this.toOcupacaoResponse(ocupacao)),
      page,
      pageSize,
      total,
    };
  }

  // Método público chamado por MOD-004 (ClassesService) para registrar o
  // compromisso de horário recorrente de uma turma — nunca por escrita
  // direta em `ocupacoes_quadra` (DATA_MODEL.md, TARGET_ARCHITECTURE.md
  // seção 6: MOD-005 continua dono exclusivo da tabela, evita o ciclo
  // MOD-004↔MOD-005). Recebe o `tx` da transação aberta por quem chama
  // (ClassesService.create/update) para que turma + ocupações sejam
  // all-or-nothing na mesma transação (NFR-001). `createMany` insere as N
  // ocorrências numa única instrução SQL (NFR-002), não N chamadas.
  async registerClassOccupancy(
    tx: Prisma.TransactionClient,
    companyId: string,
    quadraId: string,
    turmaId: string,
    ocorrencias: { data: Date; horaInicio: Date; horaFim: Date }[],
  ): Promise<void> {
    // SPEC-010/INV-011 (AC-018): **todas** as ocorrências são validadas
    // antes de qualquer escrita. Hoje elas compartilham dia e hora, então
    // conferir só a primeira daria o mesmo resultado — mas este método é
    // público e reutilizável, e uma implementação que confere só a
    // primeira grava as demais fora do expediente sem ninguém notar.
    //
    // DEF-013: **carregado uma vez, resolvido em memória.** Uma chamada a
    // `resolverParaData` por ocorrência é uma ida ao banco por ocorrência, e
    // desde a SPEC-019 são `8 × N`, dentro de uma transação aberta — foi o
    // que estourou o timeout de 5000 ms do Prisma em produção. O horário só
    // depende do dia da semana, então há no máximo 7 respostas a carregar.
    const linhasDeHorario = await this.horarios.carregarLinhas(
      companyId,
      quadraId,
      ocorrencias.map((ocorrencia) => ocorrencia.data.getUTCDay()),
      tx,
    );

    const foraDoExpediente: { data: Date; horaInicio: Date }[] = [];
    for (const ocorrencia of ocorrencias) {
      const horarioDoDia = this.horarios.resolverDeLinhas(
        linhasDeHorario,
        quadraId,
        ocorrencia.data.getUTCDay(),
      );
      if (
        !this.horarios.dentroDoExpediente(
          horarioDoDia,
          ocorrencia.horaInicio,
          ocorrencia.horaFim,
        )
      ) {
        foraDoExpediente.push({
          data: ocorrencia.data,
          horaInicio: ocorrencia.horaInicio,
        });
      }
    }
    if (foraDoExpediente.length > 0) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'FORA_DO_EXPEDIENTE',
        message:
          'A turma cai fora do horário de funcionamento da quadra em ao menos uma data.',
        ocorrencias: foraDoExpediente.map((o) => ({
          data: formatDateOnly(o.data),
          horaInicio: formatTimeOnly(o.horaInicio),
        })),
      });
    }

    // DEF-013: **uma consulta para todas as ocorrências.** O `OR` repete,
    // por ocorrência, exatamente a mesma condição de sobreposição
    // semiaberta que o laço anterior fazia uma a uma — o que muda é o
    // número de idas ao banco, não a regra.
    //
    // Efeito colateral desejado: o `findFirst` de antes trazia **uma**
    // ocupação por ocorrência, então uma data com duas colisões só mostrava
    // a primeira. `findMany` traz todas, e o gestor vê o estrago inteiro de
    // uma vez em vez de descobrir a segunda depois de resolver a primeira.
    //
    // `orderBy` porque a ordem física do Postgres muda sem nada mudar, e
    // uma lista de conflitos que troca de ordem entre duas tentativas
    // parece bug de tela — a mesma lição da ordem dos encontros.
    const conflitantes =
      ocorrencias.length === 0
        ? []
        : await tx.ocupacaoQuadra.findMany({
            where: {
              companyId,
              quadraId,
              statusPagamento: { not: 'cancelado' },
              OR: ocorrencias.map((ocorrencia) => ({
                data: ocorrencia.data,
                horaInicio: { lt: ocorrencia.horaFim },
                horaFim: { gt: ocorrencia.horaInicio },
              })),
            },
            orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
          });
    const conflitos: ConflitoDetectado[] = conflitantes.map((conflito) =>
      this.toConflictWith(conflito),
    );
    if (conflitos.length > 0) {
      throw new ConflictException({
        message:
          'Conflito de horário com ocupação existente na quadra (INV-001)',
        conflicts: conflitos,
      });
    }

    try {
      await tx.ocupacaoQuadra.createMany({
        data: ocorrencias.map((ocorrencia) => ({
          companyId,
          quadraId,
          data: ocorrencia.data,
          horaInicio: ocorrencia.horaInicio,
          horaFim: ocorrencia.horaFim,
          origemTipo: 'TURMA' as const,
          origemTurmaId: turmaId,
        })),
      });
    } catch (error) {
      // Mesma corrida perdida de createBooking (INV-001): a violação da
      // EXCLUDE constraint não tem P-código dedicado no Prisma. O que **não**
      // é corrida — transação expirada, conexão caída — passa direto e
      // continua sendo 500, ver `ehCorridaPerdida` (DEF-013).
      if (ehCorridaPerdida(error)) {
        throw new ConflictException({
          message:
            'Conflito de horário com ocupação existente na quadra (INV-001)',
        });
      }
      throw error;
    }
  }

  // Cancela (libera) as ocupações futuras ainda não canceladas geradas por
  // uma turma — usado por MOD-004 quando o admin edita o horário
  // recorrente (quadra/dia/hora), antes de gerar as novas ocorrências via
  // registerClassOccupancy, dentro da mesma transação.
  async cancelFutureClassOccupancies(
    tx: Prisma.TransactionClient,
    companyId: string,
    turmaId: string,
    aPartirDe: Date,
  ): Promise<void> {
    await tx.ocupacaoQuadra.updateMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        statusPagamento: { not: 'cancelado' },
        data: { gte: aPartirDe },
      },
      data: { statusPagamento: 'cancelado' },
    });
  }

  // `alunoIdScope` (SPEC-005): quando o chamador é `aluno`, só pode
  // cancelar reserva onde `aluno_id` bate com o próprio — "dono da reserva
  // ou company_admin" (API_CONTRACTS.md CON-005.6).
  async cancelBooking(
    companyId: string,
    id: string,
    alunoIdScope?: string,
  ): Promise<void> {
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
    });
    if (!ocupacao) {
      throw new NotFoundException();
    }
    if (alunoIdScope && ocupacao.alunoId !== alunoIdScope) {
      throw new ForbiddenException();
    }

    // SPEC-012:TASK-000 — cancelar ocorrência de turma não é suportado
    // (GAP-008): a ocupação de origem TURMA é a aula inteira, compartilhada
    // por todos os matriculados, sem `aluno_id` próprio. Cancelá-la por
    // esta rota apagaria a aula da agenda de todo mundo a partir de uma
    // ação pensada para reserva individual.
    this.assertOcupacaoAvulsa(ocupacao.origemTipo);

    // Cancelar o que já está cancelado é idempotente: sem escrita, sem
    // erro. Repetir a ação não é engano do usuário, é rede instável.
    if (ocupacao.statusPagamento === 'cancelado') {
      return;
    }

    // AC-003: cancelar libera o slot imediatamente — a constraint EXCLUDE
    // já ignora linhas com status_pagamento = 'cancelado' (WHERE da
    // migration), então essa escrita sozinha já resolve.
    await this.prisma.ocupacaoQuadra.update({
      where: { id },
      data: { statusPagamento: 'cancelado' },
    });
  }

  // CON-006.3 (SPEC-006, MOD-006 via PaymentStatusController): único
  // caminho para mudar `status_pagamento` fora de criar/cancelar reserva
  // — `ocupacoes_quadra` continua propriedade exclusiva de MOD-005
  // (TARGET_ARCHITECTURE.md seção 5), MOD-006 nunca escreve na tabela
  // direto. AC-002: idempotente — marcar o mesmo status de novo não
  // dispara um update supérfluo nem erro.
  //
  // SPEC-012:TASK-000 fechou dois buracos que estavam em produção:
  // marcar ocorrência de turma como paga, e ressuscitar reserva cancelada.
  async updatePaymentStatus(
    companyId: string,
    id: string,
    status: 'pago' | 'cancelado',
  ) {
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
    });
    if (!ocupacao) {
      throw new NotFoundException();
    }

    // AC-007/AC-011: pagamento é coisa de reserva avulsa (CON-006). Aula
    // recorrente não tem cobrança própria no modelo, então marcar "pago"
    // numa ocupação de turma é estado sem significado.
    this.assertOcupacaoAvulsa(ocupacao.origemTipo);

    if (ocupacao.statusPagamento === status) {
      return this.toOcupacaoResponse(ocupacao);
    }

    // AC-012: `cancelado` é terminal.
    //
    // Não é preciosismo de máquina de estados: a constraint EXCLUDE de
    // INV-001 tem `WHERE (status_pagamento <> 'cancelado')`, ou seja,
    // cancelar **libera o slot de verdade**. Voltar de `cancelado` para
    // `pago` tenta recolocar a reserva na linha do tempo — se alguém já
    // reservou aquele horário no meio-tempo, o UPDATE viola a constraint e
    // devolve erro cru do Postgres; se ninguém reservou, a reserva
    // ressuscita em silêncio e o aluno que cancelou não fica sabendo.
    if (ocupacao.statusPagamento === 'cancelado') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'RESERVA_CANCELADA',
        message:
          'Esta reserva foi cancelada e o horário pode já ter sido ocupado. Recarregue a agenda.',
      });
    }

    const atualizada = await this.prisma.ocupacaoQuadra.update({
      where: { id },
      data: { statusPagamento: status },
    });
    return this.toOcupacaoResponse(atualizada);
  }

  /**
   * SPEC-012:TASK-000 — ações de reserva avulsa não se aplicam a ocupação
   * gerada por turma. Um método só para as duas chamadas, em vez da mesma
   * condição escrita duas vezes: a regra é uma, e regra duplicada
   * diverge no primeiro ajuste.
   */
  private assertOcupacaoAvulsa(origemTipo: 'AVULSO' | 'TURMA') {
    if (origemTipo === 'TURMA') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'OCUPACAO_DE_TURMA',
        message:
          'Esta ocupação vem de uma turma. Ajuste a turma, não a reserva.',
      });
    }
  }

  // Resolve o registro de Aluno do usuário autenticado, escopado à empresa
  // (SPEC-005) — usado pelo controller para decidir o `alunoId` efetivo em
  // rotas que a role `aluno` compartilha com `company_admin`. 403 (não 404)
  // porque a ausência de vínculo aluno é uma falha de autorização do
  // chamador, não um recurso não encontrado.
  async findAlunoDoUsuario(companyId: string, usuarioId: string) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }
    return aluno;
  }

  private async assertQuadraDaEmpresa(
    companyId: string,
    quadraId: string,
  ): Promise<void> {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId },
    });
    if (!quadra) {
      throw new NotFoundException();
    }
  }

  private async findConflito(
    companyId: string,
    quadraId: string,
    data: Date,
    horaInicio: Date,
    horaFim: Date,
  ): Promise<ConflitoDetectado | null> {
    const conflito = await this.prisma.ocupacaoQuadra.findFirst({
      where: {
        companyId,
        quadraId,
        data,
        statusPagamento: { not: 'cancelado' },
        horaInicio: { lt: horaFim },
        horaFim: { gt: horaInicio },
      },
    });
    return conflito ? this.toConflictWith(conflito) : null;
  }

  private toConflictWith(ocupacao: {
    id: string;
    origemTipo: string;
  }): ConflitoDetectado {
    return { ocupacaoId: ocupacao.id, origemTipo: ocupacao.origemTipo };
  }

  /**
   * **AC-002 — o `GET` da quadra devolve URL de CDN, sem assinatura.** Ela
   * sai por `imagemUrl`, e a chave crua **não sai**: montá-la no cliente
   * contornaria a conferência do `StorageService` (INV-037), e a resposta
   * de uma quadra é lida também pelo app do aluno.
   *
   * `imagemKey` é opcional no tipo porque este mapper é chamado de caminhos
   * que já existiam antes da SPEC-018 e que criam a quadra na hora (`create`
   * devolve a linha recém-inserida, e ali a imagem é sempre nula). Ausente,
   * o resultado é `imagemUrl: null` — que é o mesmo que a coluna nula diria.
   */
  private toQuadraResponse(quadra: {
    id: string;
    companyId: string;
    nome: string;
    precoHora: Prisma.Decimal;
    status: string;
    createdAt: Date;
    imagemKey?: string | null;
    esporteRef?: { id: string; nome: string } | null;
    categoriaRef?: { id: string; nome: string } | null;
    // SPEC-020/TASK-007 — o retorno anotado é o que amarra este método ao
    // contrato publicado. Sem a anotação, `QuadraResponseDto` seria só mais
    // um tipo escrito à mão, e envelheceria calado como o do Cliente
    // envelheceu (DEF-012). Com ela, mudar a forma da resposta quebra o
    // typecheck AQUI, antes de qualquer frontend.
  }): QuadraResponseDto {
    return {
      id: quadra.id,
      companyId: quadra.companyId,
      nome: quadra.nome,
      // **SPEC-020/TASK-003 — era `esporte: string`.** Quebra de contrato
      // assumida: os três clientes são nossos e sobem juntos (ADR-001).
      // Devolver a string ao lado do objeto deixaria duas fontes para a
      // mesma pergunta, que é o que esta spec veio desfazer.
      //
      // `null` só acontece com quadra de `esporte` em branco, que o
      // backfill não teve como catalogar — a TASK-004 vai cobrar.
      esporte: quadra.esporteRef ?? null,
      categoria: quadra.categoriaRef ?? null,
      precoHora: quadra.precoHora.toNumber(),
      status: quadra.status,
      createdAt: quadra.createdAt,
      imagemUrl: this.imagens.resolver({
        id: quadra.id,
        companyId: quadra.companyId,
        imagemKey: quadra.imagemKey ?? null,
      }).imagemUrl,
    };
  }

  private toOcupacaoResponse(ocupacao: OcupacaoParaResposta) {
    return {
      id: ocupacao.id,
      companyId: ocupacao.companyId,
      quadraId: ocupacao.quadraId,
      data: formatDateOnly(ocupacao.data),
      horaInicio: formatTimeOnly(ocupacao.horaInicio),
      horaFim: formatTimeOnly(ocupacao.horaFim),
      origemTipo: ocupacao.origemTipo,
      alunoId: ocupacao.alunoId,
      statusPagamento: ocupacao.statusPagamento,
      // SPEC-011: o valor **congelado**, não recalculado pelo preço atual
      // da quadra. Sem devolvê-lo, as telas continuariam multiplicando
      // `preco_hora × horas` por conta própria — e mostrariam um número
      // diferente do cobrado assim que a escola reajustasse o preço.
      valor: ocupacao.valor != null ? Number(ocupacao.valor) : null,
    };
  }
}
