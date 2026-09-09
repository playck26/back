import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { Prisma, type OrigemTipo, type StatusPagamento } from '@prisma/client';
import { StudentsService } from '../people/students.service';
import {
  CreditosService,
  saldoInsuficiente,
} from '../creditos/creditos.service';
import {
  julgarInvariantesDiferidas,
  traduzirRecusaDeCancelamento,
} from '../creditos/set-constraints';
import { agruparEmBlocos, fingerprintDoPedido } from './slots.util';
import { HorarioFuncionamentoService } from './horario-funcionamento.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  novaTransicao,
  RegistradorDeAcao,
} from '../common/auditoria/registrador-de-acao';
import { ImagemDaQuadraService } from './imagem-da-quadra.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import {
  avaliarCancelamentoDeReserva,
  type PapelDoAutor,
} from '../company-settings/prazo-de-cancelamento';
import { antecedenciaEmMinutos } from '../classes/ocorrencia-relevante';
import {
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
  parseTimeOnly,
  recorteTemporal,
  aulaJaComecou,
} from './date-time.util';

/**
 * SPEC-041/D7 — **a ordem de cada aba, e por que a terceira ficou como estava.**
 *
 * São perguntas opostas: em `futuras` interessa **a próxima**; em `anteriores`,
 * **a mais recente**. Cada uma com direção uniforme nos três campos — não é
 * simetria estética, é o que permite a um único índice all-ASC servir as duas,
 * a segunda por varredura para trás.
 *
 * `anteriores` segue o precedente que o projeto já firmou duas vezes para lista
 * paginada de ocupação no passado: `avaliacao-de-aula.service.ts` e
 * `presenca.service.ts`, os dois em `data desc, hora desc, id desc`.
 *
 * **O caso sem `quando` continua `desc/asc/asc`, e isso é deliberado.** É a
 * única ordem mista do projeto e contradiz o próprio comentário que ela tinha
 * — mas quem consome a rota sem `quando` é a lista do **Admin**, que não tem
 * spec neste ciclo. Consertar aqui seria mudar uma tela de outro app sem
 * pedido. Fica em LIM-041e, com dono.
 */
/**
 * SPEC-041/AC-010 — **"fui eu que cancelei?", e os três estados são de
 * propósito.**
 *
 * | Devolve | Quando |
 * |---|---|
 * | `true` | o autor do cancelamento é quem está pedindo |
 * | `false` | foi outra pessoa — a tela dirá "Cancelada pelo clube" |
 * | `null` | não foi cancelada, **ou** não há evento, **ou** quem pede é o gestor |
 *
 * **`null` significa "não sei responder", e a tela cala nos três casos.** Um
 * deles é o estado normal de quase toda linha antiga: as canceladas antes da
 * SPEC-032 não têm evento (LIM-041b), e inventar autor para elas seria o mesmo
 * erro do "criada por —" que a SPEC-032 recusou.
 *
 * **O gestor recebe `null` por decisão, não por limitação.** A pergunta dele
 * não é "fui eu?", é "quem foi?" — e para isso já existe a agenda com o
 * histórico completo. Um booleano ali diria "não fui eu" sem dizer quem foi,
 * que é pior que não dizer nada. Ver a matriz de falha e autoridade da spec.
 *
 * **Não engole falha.** Se a consulta de auditoria quebrar, o erro sobe: `null`
 * já significa "não há registro", e usá-lo para "não consegui ler o registro"
 * faria a tela afirmar com confiança uma coisa que ela não sabe.
 */
function quemCancelou(
  eventos: { acao: { autorId: string } }[],
  usuarioIdAtual: string | undefined,
): boolean | null {
  if (!usuarioIdAtual) return null;
  const ultimo = eventos[0];
  if (!ultimo) return null;
  // `usuarios.id` contra `usuarios.id`. Ver o docstring de `listBookings`
  // sobre por que isto NÃO pode ser `alunoIdScope`.
  return ultimo.acao.autorId === usuarioIdAtual;
}

function ordemDaListagem(
  quando?: 'futuras' | 'anteriores',
): Prisma.OcupacaoQuadraOrderByWithRelationInput[] {
  if (quando === 'futuras') {
    return [{ data: 'asc' }, { horaInicio: 'asc' }, { id: 'asc' }];
  }
  if (quando === 'anteriores') {
    return [{ data: 'desc' }, { horaInicio: 'desc' }, { id: 'desc' }];
  }
  // SPEC-027 — `id` como desempate. Ver LIM-041e sobre a direção mista.
  return [{ data: 'desc' }, { horaInicio: 'asc' }, { id: 'asc' }];
}
import {
  OcupacaoPaginadaResponseDto,
  OcupacaoResponseDto,
} from './dto/booking-response.dto';
import { DisponibilidadeResponseDto } from './dto/horarios-response.dto';
import type { CreateBookingDto } from './dto/create-booking.dto';
import type { CreateCourtDto } from './dto/create-court.dto';
import type { ListBookingsQueryDto } from './dto/list-bookings-query.dto';
import type { MoveBookingDto } from './dto/move-booking.dto';
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

/** O destino composto por `moveBooking` dentro da transação. */
interface DestinoDeMovimento {
  quadraId: string;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
}

/** Forma mínima de uma ocupação para virar resposta de API. */
interface OcupacaoParaResposta {
  id: string;
  companyId: string;
  quadraId: string;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
  // DEF-016 — **os dois campos passaram a carregar o enum do Prisma, e nao
  // `string`.** Com `string`, o `tsc` nao tinha como comparar o valor que o
  // banco devolve com o que o contrato promete, e foi por essa folga que o
  // `statusPagamento` publicado saiu como `'pendente'` — valor que nao
  // existe. Agora o DTO so compila se a uniao dele bater com o enum do
  // banco: o contrato publicado fica **amarrado ao schema**, nao a memoria.
  origemTipo: OrigemTipo;
  alunoId: string | null;
  statusPagamento: StatusPagamento;
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
    // SPEC-031/D17: o segundo verbo do AC-013 passa pela mesma política.
    private readonly operacao: ConfigOperacaoService,
    // SPEC-033: a carteira. O ledger é escrito **dentro** da transação que
    // cria ou cancela a reserva — sem isso haveria janela entre a reserva
    // existir e o dinheiro sair.
    private readonly creditos: CreditosService,
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

  async availability(
    companyId: string,
    quadraId: string,
    data: string,
  ): Promise<DisponibilidadeResponseDto> {
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
    autorId: string,
    clientRequestId?: string,
    /**
     * SPEC-042 — **o papel decide se o passado é permitido.**
     *
     * O aluno nunca reserva um horário que já começou. O gestor reserva,
     * porque registrar jogo que já aconteceu é trabalho real de fechar caixa
     * — e o projeto já trata essa assimetria assim na presença, com janela
     * retroativa para o professor.
     *
     * Opcional com padrão `company_admin` para não quebrar chamador interno:
     * quem gera ocupação de turma passa por outro caminho
     * (`registerClassOccupancy`) e não por aqui.
     */
    papelDoAutor: 'aluno' | 'company_admin' = 'company_admin',
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
      /**
       * SPEC-042/INV-093 — **o aluno não reserva o que já começou.**
       *
       * Antes desta guarda não havia **uma linha** de comparação temporal em
       * todo o caminho de `POST /bookings`: o DTO valida só o formato da
       * data, o expediente confere **dia da semana** (uma quarta de 1998 abre
       * igual), e a `EXCLUDE` de sobreposição não pega passado porque passado
       * não colide com nada. Sete ocupações chegaram a nascer assim em
       * produção.
       *
       * Vem **antes** do expediente pela mesma razão que o comentário abaixo
       * dá para o conflito: responder "fora do expediente" para quem tentou
       * ontem às 19h mentiria sobre o motivo da recusa.
       */
      if (
        papelDoAutor === 'aluno' &&
        aulaJaComecou(dataDate, parseTimeOnly(bloco.horaInicio))
      ) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'HORARIO_NO_PASSADO',
          message: 'Não é possível reservar um horário que já começou.',
          bloco,
        });
      }

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

    // DEF-023 — achado pelo FIT-001 (a) da SPEC-043 (run 33790414789, CI em
    // postgres:18): duas criações concorrentes do mesmo slot podem terminar
    // em DEADLOCK (`40P01`) em vez de violação da EXCLUDE. A transação
    // escreve ocupação, ação administrativa e evento (SPEC-032), e as duas
    // se esperam em ordem cruzada; o Postgres aborta UMA. A abortada é
    // "corrida perdida" — mas quando ela procura o conflito, a vencedora
    // ainda não commitou: nada visível, e o erro cru virava **500** para o
    // aluno. Uma segunda tentativa resolve os dois desfechos possíveis: a
    // vencedora já commitou (409 limpo, pela pré-checagem ou pela EXCLUDE)
    // ou ela também abortou (a segunda tentativa ganha o slot). Duas
    // tentativas, não N: se a segunda também perde sem conflito visível, o
    // erro sobe cru — 409 sem conflito seria mentira (DEF-013).
    for (let tentativa = 1; ; tentativa++) {
      try {
        // Tudo ou nada (AC-005): um pedido de 3 blocos com 1 inválido não
        // pode deixar 2 criados. A transação também cobre o pedido em si —
        // sem ela, uma falha no meio deixaria a chave de idempotência
        // gravada sem as reservas correspondentes.
        const criadas = await this.prisma.$transaction(async (tx) => {
          /**
           * **Passo 1 dos cinco (SPEC-033): travar, ainda sem decidir.**
           *
           * `alunos` é o nível 2 da ordem global (INV-029) e
           * `ocupacoes_quadra` é o nível 3 — então a carteira trava **antes**
           * da primeira ocupação nascer. A ordem inversa foi ensaiada e dá
           * `40P01` sob concorrência; esta não deu deadlock nenhum.
           *
           * Também não é opcional por outro motivo: o `INSERT` da ocupação
           * pega `FOR KEY SHARE` na linha do aluno (a FK `aluno_id`).
           * Travar depois seria pedir `FOR UPDATE` sobre uma linha em que a
           * própria transação já segura `KEY SHARE` — upgrade de trava, que
           * deadlocka dois pedidos do MESMO aluno sem disputa real.
           */
          const saldoCentavos = dto.alunoId
            ? await this.creditos.travarESaber(tx, companyId, dto.alunoId)
            : null;

          const pedido = clientRequestId
            ? await tx.pedidoReserva.create({
                data: { companyId, clientRequestId, fingerprint },
              })
            : null;

          // SPEC-032/AC-001 e INV-078 — **UMA ação para o pedido inteiro**, N
          // eventos. A identidade do comando lógico aqui é o PEDIDO, não o
          // bloco: três blocos são um gesto do usuário, não três.
          const registrador = new RegistradorDeAcao(
            tx,
            companyId,
            autorId,
            'reserva_criada',
          );

          const resultado: OcupacaoParaResposta[] = [];
          for (const bloco of blocos) {
            const transicaoId = novaTransicao();
            const ocupacao = await tx.ocupacaoQuadra.create({
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
                transicaoId,
              },
            });
            await registrador.registrar(ocupacao.id, 'criada', transicaoId);
            resultado.push(ocupacao);
          }

          await this.debitarCarteira({
            tx,
            companyId,
            alunoId: dto.alunoId,
            autorId,
            papelDoAutor,
            saldoCentavos,
            ocupacoes: resultado,
            registrador,
          });

          // **Última instrução** (D7): força as diferidas a julgarem aqui,
          // onde o Prisma ainda traduz o erro em `P2010` + `meta.code`.
          await julgarInvariantesDiferidas(tx);
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
          // Corrida perdida e NENHUM conflito visível: é o deadlock acima.
          if (tentativa === 1) {
            continue;
          }
        }
        throw error;
      }
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

  /**
   * SPEC-041/B1 — **dois ids de pessoa, e eles NÃO são intercambiáveis.**
   *
   * | Parâmetro | Que tabela | Para quê |
   * |---|---|---|
   * | `alunoIdScope` | `alunos.id` | **autoriza** — limita as linhas ao próprio aluno |
   * | `usuarioIdAtual` | `usuarios.id` | **identifica** — decide "fui eu que cancelei?" |
   *
   * **A armadilha que a validação cruzada apontou:** `acoes_administrativas.
   * autor_id` referencia `usuarios.id`, e quem fosse implementar
   * `canceladaPorMim` aqui dentro tinha **um único id de pessoa à mão** — o
   * `alunoIdScope`, que é de outra tabela. As duas colunas são `@db.Uuid`,
   * então TypeScript e Postgres aceitam a comparação **calados**, e ela é
   * sempre falsa: o aluno leria *"Cancelada pelo clube"* justamente na reserva
   * que ele mesmo cancelou.
   *
   * Colapsar os dois num parâmetro só é o próximo defeito da mesma família.
   */
  async listBookings(
    companyId: string,
    query: ListBookingsQueryDto,
    alunoIdScope?: string,
    usuarioIdAtual?: string,
  ): Promise<OcupacaoPaginadaResponseDto> {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    // SPEC-041/D8 — **as condições entram num `AND` acumulado, não por
    // spread.**
    //
    // O ramo de status abaixo já ocupa a chave `AND`, e o corte temporal é a
    // segunda condição composta desta rota. Dois spreads disputando `AND` se
    // apagariam em silêncio — que é exatamente o defeito que o comentário do
    // bloco de status documenta ter custado caro (`?status=pago&
    // excluirCanceladas=true` devolvia pendente também).
    //
    // Com um array, uma condição nova nunca apaga a anterior: ela empilha.
    const condicoes: Prisma.OcupacaoQuadraWhereInput[] = [];

    // SPEC-041/AC-016 — **o instante é capturado UMA vez, aqui.**
    //
    // Da 2ª página em diante ele vem do cliente, que o recebeu na 1ª. É o que
    // impede a fronteira de andar no meio de uma travessia: às 20h59 a reserva
    // que termina às 21h é a primeira da lista, e sem congelar o instante ela
    // sai do conjunto na página 2, empurrando todos os outros uma posição.
    //
    // `new Date(...)` de string ISO é seguro aqui — o DTO já validou o
    // formato. O que ele NÃO valida é plausibilidade, e não precisa: um valor
    // forjado só reordena as próprias reservas de quem pediu, e não afrouxa
    // regra nenhuma (as guardas da SPEC-042 leem o relógio do servidor).
    const referenciaTemporal = query.referenciaTemporal
      ? new Date(query.referenciaTemporal)
      : new Date();

    // INV-091 — o recorte é calculado uma vez e vai para o mesmo objeto
    // `where` que serve o `findMany` e o `count`. Contar com um instante e
    // listar com outro é como a paginação passa a mentir.
    if (query.quando) {
      condicoes.push(recorteTemporal(query.quando, referenciaTemporal));
    }

    // SPEC-027 — **o filtro de canceladas saiu da tela e veio para cá.**
    //
    // O app do aluno filtrava `statusPagamento !== 'cancelado'` DEPOIS de
    // receber a página. Sem paginação isso era só desperdício; com ela vira
    // mentira: uma página de 20 mostraria 12 itens, e o rodapé diria "1–20 de
    // 47". Quem pagina precisa contar exatamente o que mostra.
    //
    // **Os dois filtros vivem na MESMA chave `statusPagamento`**, e a primeira
    // versão disto usava dois spreads — o segundo apagava o primeiro em
    // silêncio, então `?status=pago&excluirCanceladas=true` devolvia tudo que
    // não fosse cancelado, inclusive pendente.
    //
    // SPEC-041 — os dois viraram entradas do array acima, e é por isso que o
    // corte temporal pôde entrar sem tocar nesta regra: **cada condição é uma
    // linha, e linhas não se sobrescrevem.**
    if (query.status) {
      condicoes.push({ statusPagamento: query.status });
    }
    if (query.excluirCanceladas) {
      condicoes.push({ statusPagamento: { not: 'cancelado' as const } });
    }

    const where: Prisma.OcupacaoQuadraWhereInput = {
      companyId,
      ...(alunoIdScope ? { alunoId: alunoIdScope } : {}),
      ...(query.data ? { data: parseDateOnly(query.data) } : {}),
      ...(condicoes.length ? { AND: condicoes } : {}),
    };

    // SPEC-041/AC-010 — **`autorId` escalar, e nada mais.**
    //
    // A relação com `usuarios` NÃO é atravessada: não há `autor: { nome }` no
    // `select`, porque `acoes_administrativas.autor_id` já é a coluna que
    // interessa. É o que sustenta a INV-092 por construção — o nome não tem
    // por onde chegar ao payload, nem por descuido de um `select` amplo.
    //
    // `take: 1` com `criadoEm desc` porque a pergunta é sobre o cancelamento
    // ATUAL. Reativar (SPEC-035) vai produzir uma segunda transição, e aí o
    // último é o que vale.
    const [data, total] = await Promise.all([
      this.prisma.ocupacaoQuadra.findMany({
        where,
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: ordemDaListagem(query.quando),
        include: {
          eventos: {
            where: { tipo: 'cancelada' },
            orderBy: { criadoEm: 'desc' },
            take: 1,
            select: { acao: { select: { autorId: true } } },
          },
        },
      }),
      this.prisma.ocupacaoQuadra.count({ where }),
    ]);

    return {
      data: data.map((ocupacao) => ({
        ...this.toOcupacaoResponse(ocupacao),
        canceladaPorMim: quemCancelou(ocupacao.eventos, usuarioIdAtual),
      })),
      page,
      pageSize,
      total,
      referenciaTemporal: referenciaTemporal.toISOString(),
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
    registrador: RegistradorDeAcao,
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

    // SPEC-032/TASK-005b — **A ORDENACAO MORA AQUI**, no dono final da
    // escrita, e nao no chamador.
    //
    // `classes.service.ts` entregava a lista na ordem dos encontros, com um
    // comentario afirmando que "a ordem nao importa: o EXCLUDE decide
    // conflito por intervalo, nao por posicao". Isso e verdade para
    // CORRETUDE e **falso para deadlock**: `createMany` vira um
    // `INSERT ... VALUES` unico, o Postgres avalia as tuplas na ordem do
    // array, e e essa ordem que decide quem espera quem na `EXCLUDE`.
    //
    // Duas turmas com encontros em ordens opostas na mesma quadra travam uma
    // a outra e uma aborta com `40P01`. Ordenar no chamador deixaria o
    // proximo chamador livre para errar — por isso e aqui.
    const emOrdem = [...ocorrencias].sort(
      (a, b) =>
        a.data.getTime() - b.data.getTime() ||
        a.horaInicio.getTime() - b.horaInicio.getTime(),
    );

    const transicaoId = novaTransicao();
    try {
      // `createManyAndReturn` e nao `createMany`: o evento precisa do `id` de
      // cada ocorrencia, e `createMany` devolve so a contagem. Continua sendo
      // **uma** instrucao SQL (NFR-002).
      const criadas = await tx.ocupacaoQuadra.createManyAndReturn({
        data: emOrdem.map((ocorrencia) => ({
          companyId,
          quadraId,
          data: ocorrencia.data,
          horaInicio: ocorrencia.horaInicio,
          horaFim: ocorrencia.horaFim,
          origemTipo: 'TURMA' as const,
          origemTurmaId: turmaId,
          transicaoId,
        })),
        select: { id: true },
      });
      // Uma acao por TURMA (INV-078), N eventos. O registrador vem de fora
      // justamente para que editar o horario — que cancela as antigas e cria
      // as novas — seja UM gesto com dois tipos de evento, e nao dois gestos.
      // UMA instrucao para os N eventos — ver `registrarMuitos`. O laco
      // custaria N idas ao banco dentro da transacao e quebraria o orcamento
      // do DEF-013, que existe porque isso ja estourou P2028 em producao.
      await registrador.registrarMuitos(
        criadas.map((l) => l.id),
        'criada',
        transicaoId,
      );
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
    registrador: RegistradorDeAcao,
  ): Promise<void> {
    const transicaoId = novaTransicao();
    // `updateManyAndReturn` e nao `updateMany`: a trigger
    // `ocupacao_cancelada_exige_evento` e `FOR EACH ROW` e exige um evento
    // por linha cancelada — e `updateMany` devolve so a contagem, sem dizer
    // QUAIS linhas tocou. Era o furo que a validacao cruzada apontou como
    // "irrealizavel como escrito"; nao e, mas exige a variante que retorna.
    const canceladas = await tx.ocupacaoQuadra.updateManyAndReturn({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        statusPagamento: { not: 'cancelado' },
        data: { gte: aPartirDe },
      },
      data: { statusPagamento: 'cancelado', transicaoId },
      select: { id: true },
    });
    await registrador.registrarMuitos(
      canceladas.map((l) => l.id),
      'cancelada',
      transicaoId,
    );
  }

  /**
   * SPEC-034/TASK-004 — cancelar **uma** ocorrência de turma.
   *
   * **Só a escrita. Quem decide é o `ClassesService`**, porque a decisão
   * depende de segurar `turmas FOR UPDATE` — e `ocupacoes_quadra` é de
   * MOD-005, que é quem escreve nela (`TARGET_ARCHITECTURE.md`, ownership).
   * Mesma divisão de `cancelFutureClassOccupancies`, logo acima.
   *
   * A trigger `ocupacao_cancelada_exige_evento` cobre este caminho sem
   * mudança: ela não filtra por `origem_tipo`, e já exige o evento com o
   * `transicao_id` casado no `COMMIT` (INV-064).
   */
  async cancelOneClassOccurrence(
    tx: Prisma.TransactionClient,
    companyId: string,
    ocupacaoId: string,
    registrador: RegistradorDeAcao,
  ): Promise<void> {
    const transicaoId = novaTransicao();
    await tx.ocupacaoQuadra.update({
      where: { id: ocupacaoId },
      // Só o status e a transição. `valor` é nulo em ocupação de turma
      // (CHECK `ocupacoes_valor_por_origem`) e continua nulo — cancelar não
      // é o momento de descobrir preço.
      data: { statusPagamento: 'cancelado', transicaoId },
    });
    await registrador.registrar(ocupacaoId, 'cancelada', transicaoId);
  }

  // `alunoIdScope` (SPEC-005): quando o chamador é `aluno`, só pode
  // cancelar reserva onde `aluno_id` bate com o próprio — "dono da reserva
  // ou company_admin" (API_CONTRACTS.md CON-005.6).
  /**
   * SPEC-032/TASK-002 — **passou a rodar dentro de uma transação**, e isso
   * não é refinamento: eram duas instruções soltas (`findFirst` + `update`),
   * e a trigger `ocupacao_cancelada_exige_evento` exige o evento **no mesmo
   * `COMMIT`** do cancelamento. Sem transação, não há mesmo COMMIT.
   *
   * A SPEC-033 depende deste mesmo passo para debitar e devolver crédito com
   * segurança, e por isso ele está declarado lá como TASK-000.
   */
  /**
   * SPEC-033, passos 3 a 5 da criação — **o débito, e o papel decidindo.**
   *
   * ## Por que o valor vem do banco, e não da memória
   *
   * `createBooking` calcula `precoHora * horas` em `Prisma.Decimal`, e
   * `horas = minutos/60`. Um bloco de 20 min a R$ 80/h dá `26,6666…` em
   * memória e vira `26,67` só quando o Postgres grava em `numeric(10,2)`.
   * **Multiplicar o número de memória por 100 debitaria 2666 contra uma
   * reserva de 2667.** Por isso a soma é sobre o `valor` DEVOLVIDO pelo
   * `INSERT`, e por isso o passo 2 (inserir) vem antes do 3 (somar) — decidir
   * sobre um número que o banco ainda não confirmou foi achado bloqueante.
   *
   * ## Os cinco ramos do AC-007c, e nenhum deles é exceção
   *
   * | ramo | movimento | `status_pagamento` |
   * |---|---|---|
   * | aluno **com** saldo | `consumo` | `pago` |
   * | gestor, aluno **com** saldo | `consumo` | `pago` |
   * | gestor, aluno **sem** saldo (PA-04) | nenhum | `pendente_pagamento` |
   * | **aluno sem saldo** (AC-007) | nenhum — a reserva **não nasce** | `422` |
   * | `valor = 0,00` (PA-07) | nenhum | `pago` — não há o que cobrar |
   *
   * **O papel é parâmetro, não exceção (D12).** O gestor não é bloqueado por
   * falta de saldo de um aluno — o clube não pode ficar impedido de operar por
   * isso —, e ninguém fica com saldo negativo, porque nesse ramo não nasce
   * movimento nenhum.
   *
   * ## E a reserva que consumiu nasce `pago`
   *
   * O default da coluna é `pendente_pagamento`. Sem o AC-007c isto produziria
   * **reserva com saldo debitado e cobrança em aberto** — a carteira paga e o
   * clube cobra de novo.
   */
  private async debitarCarteira(args: {
    tx: Prisma.TransactionClient;
    companyId: string;
    alunoId: string | undefined;
    autorId: string;
    papelDoAutor: 'aluno' | 'company_admin';
    saldoCentavos: number | null;
    ocupacoes: {
      id: string;
      valor?: Prisma.Decimal | null;
      statusPagamento?: StatusPagamento;
    }[];
    registrador: RegistradorDeAcao;
  }): Promise<void> {
    const { tx, companyId, alunoId, ocupacoes } = args;

    // Sem aluno não há carteira. Não é caso especial: é a ausência do
    // recurso, e reserva sem `aluno_id` continua válida.
    const comValor = alunoId
      ? ocupacoes
          .filter((o) => o.valor != null)
          .map((o) => ({ id: o.id, centavos: paraCentavos(o.valor) }))
          .filter((o) => o.centavos > 0)
      : [];

    // PA-07: ocupação de zero centavos não emite movimento — zero não move
    // saldo e sujaria o extrato. Ela nasce `pago` do mesmo jeito: não há o
    // que cobrar.
    //
    // **`valor` AUSENTE não é `valor = 0`**, e conflatá-los marcaria `pago`
    // uma ocupação que não é gratuita. Em produção o caso é inalcançável — o
    // `CHECK ocupacoes_valor_por_origem` exige `valor` em AVULSO —, mas
    // "inalcançável" é premissa, e esta spec já reprovou uma versão inteira
    // por confiar em premissa desse tipo. Achado por um unitário que passava
    // um objeto sem `valor`.
    const gratuitas = alunoId
      ? ocupacoes
          .filter((o) => o.valor != null && paraCentavos(o.valor) === 0)
          .map((o) => o.id)
      : [];
    if (gratuitas.length > 0) {
      await tx.ocupacaoQuadra.updateMany({
        where: { id: { in: gratuitas } },
        data: { statusPagamento: 'pago' },
      });
      marcarComoPagas(ocupacoes, gratuitas);
    }

    if (comValor.length === 0) {
      return;
    }

    const total = comValor.reduce((soma, o) => soma + o.centavos, 0);
    if ((args.saldoCentavos ?? 0) < total) {
      // AC-007: o pedido é tudo-ou-nada, e a mensagem fala do TOTAL, não do
      // bloco — dizer "faltam X" por bloco esconderia o custo real do gesto.
      if (args.papelDoAutor === 'aluno') {
        throw saldoInsuficiente(args.saldoCentavos ?? 0, total);
      }
      // PA-04: o gestor segue, sem movimento e sem débito.
      return;
    }

    // Um consumo por OCUPAÇÃO (D4) — é o que faz cancelar um bloco devolver
    // aquele bloco. Não um por pedido.
    // A ação já existe: o registrador é preguiçoso, mas o laço acima
    // registrou N eventos antes de chegarmos aqui. Se fosse `null`, o
    // movimento seria órfão — e `movimentos_acao_fkey` recusaria de todo
    // jeito. A asserção troca `23503` por uma frase.
    const acaoId = args.registrador.idDaAcao;
    if (!acaoId) {
      throw new Error(
        'consumo sem ação administrativa: o registrador não foi usado antes do débito',
      );
    }
    for (const ocupacao of comValor) {
      await this.creditos.consumir(tx, {
        companyId,
        alunoId: alunoId as string,
        valorCentavos: ocupacao.centavos,
        autorId: args.autorId,
        acaoId,
        ocupacaoId: ocupacao.id,
      });
    }

    // AC-007c: quem consumiu crédito nasce `pago`.
    await tx.ocupacaoQuadra.updateMany({
      where: { id: { in: comValor.map((o) => o.id) } },
      data: { statusPagamento: 'pago' },
    });
    marcarComoPagas(
      ocupacoes,
      comValor.map((o) => o.id),
    );
  }

  async cancelBooking(
    companyId: string,
    id: string,
    autorId: string,
    // SPEC-031/D17 — **obrigatório e ANTES do opcional**, de propósito: assim
    // o `tsc --noEmit`, que já é gate do CI, recusa toda chamada que não o
    // passe. `alunoIdScope` continua sendo escopo de autorização; ele deixa de
    // ser, também, o papel.
    papelDoAutor: PapelDoAutor,
    alunoIdScope?: string,
  ): Promise<void> {
    const agora = new Date();

    /**
     * **Passo 2 (SPEC-033): ler SEM trava, e só para descobrir o `aluno_id`.**
     *
     * A ordem global manda `alunos` (nível 2) antes de `ocupacoes_quadra`
     * (nível 3), e o `aluno_id` mora na ocupação — parece um impasse e não é.
     * `SELECT` simples **não pega lock de linha**, então isto não é aquisição
     * de trava e não inverte ordem nenhuma. O que esta leitura não pode fazer
     * é **decidir**: nem prazo, nem status, nem valor. Ela só diz qual linha
     * travar, e o passo 5 confere que era a certa.
     */
    const espiada = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
      select: { alunoId: true },
    });
    const alunoParaTravar = espiada?.alunoId ?? null;

    try {
      await this.prisma.$transaction(async (tx) => {
        /**
         * **Passo 3: a carteira trava primeiro** — e só quando existe. Reserva
         * sem aluno não tem carteira, e pular este passo é o certo, não uma
         * exceção. A ordem inversa (ocupação antes de aluno) foi ensaiada e dá
         * `40P01`.
         */
        if (alunoParaTravar) {
          await this.creditos.travarESaber(tx, companyId, alunoParaTravar);
        }
        /**
         * **A leitura TRAVA a linha, e isso foi defeito reproduzido.**
         *
         * Até 2026-09-05 este `SELECT` era um `findFirst` sem lock, e a
         * validação cruzada da SPEC-031 montou a corrida em PostgreSQL 18.4,
         * com duas conexões:
         *
         * 1. `cancelBooking` lê uma reserva **futura**, sem travá-la;
         * 2. `moveBooking` move a mesma reserva para uma data **passada**, e
         *    commita — ele sempre travou (`courts.service.ts`, `moveBooking`);
         * 3. o cancelamento decide com o horário **velho**, passa no corte
         *    temporal e escreve. **Uma reserva já consumida termina cancelada.**
         *
         * Em execução sequencial nada disso acontece: mover primeiro impede
         * cancelar, cancelar primeiro impede mover. **É a corrida que abre a
         * janela**, e por isso dois controles sequenciais passavam enquanto o
         * defeito existia — ler, decidir e escrever precisavam ser um ato só.
         *
         * `FOR UPDATE` e não `findFirst`: o lock não é expressável no query
         * builder do Prisma, mesmo idioma de `moveBooking` e de
         * `classes.service.ts:335`.
         */
        const travadas = await tx.$queryRaw<
          {
            id: string;
            company_id: string;
            aluno_id: string | null;
            origem_tipo: 'AVULSO' | 'TURMA';
            status_pagamento: StatusPagamento;
            data: Date;
            hora_inicio: Date;
          }[]
        >`
        SELECT id, company_id, aluno_id, origem_tipo, status_pagamento,
               data, hora_inicio
          FROM ocupacoes_quadra
         WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
         FOR UPDATE
      `;
        const bruta = travadas[0];
        if (!bruta) {
          throw new NotFoundException();
        }
        // Mesma forma que o resto do método já esperava, agora vinda da linha
        // travada em vez de uma leitura solta.
        const ocupacao = {
          id: bruta.id,
          alunoId: bruta.aluno_id,
          origemTipo: bruta.origem_tipo,
          statusPagamento: bruta.status_pagamento,
          data: bruta.data,
          horaInicio: bruta.hora_inicio,
        };
        if (alunoIdScope && ocupacao.alunoId !== alunoIdScope) {
          throw new ForbiddenException();
        }

        /**
         * **Passo 5: a linha travada tem o aluno que foi travado?**
         *
         * Hoje nenhum código muda `aluno_id` de ocupação — conferido por
         * comando. Mas *"não existe caminho que mude"* é **premissa**, e esta
         * spec já reprovou uma versão inteira por confiar em premissa desse
         * tipo. A conferência custa uma comparação e transforma a premissa em
         * fato verificado em tempo de execução; sem ela, a carteira travada
         * poderia não ser a da reserva, e decidir assim seria debitar estranho.
         */
        if ((ocupacao.alunoId ?? null) !== alunoParaTravar) {
          throw new ConflictException({
            statusCode: 409,
            code: 'RESERVA_MUDOU_DE_ALUNO',
            message: 'A reserva mudou durante o cancelamento. Tente novamente.',
          });
        }

        // SPEC-012:TASK-000 — cancelar ocorrência de turma não é suportado
        // (GAP-008): a ocupação de origem TURMA é a aula inteira, compartilhada
        // por todos os matriculados, sem `aluno_id` próprio. Cancelá-la por
        // esta rota apagaria a aula da agenda de todo mundo a partir de uma
        // ação pensada para reserva individual.
        this.assertOcupacaoAvulsa(ocupacao.origemTipo);

        // Cancelar o que já está cancelado é idempotente: sem escrita, sem
        // erro. Repetir a ação não é engano do usuário, é rede instável.
        //
        // SPEC-032/AC-002: sair aqui não grava ação NEM evento — é por isso que
        // o registrador é preguiçoso. Criá-lo antes gravaria uma ação vazia a
        // cada retentativa de rede.
        if (ocupacao.statusPagamento === 'cancelado') {
          return;
        }

        /**
         * **Ninguém cancela o que já começou — e "ninguém" passou a incluir o
         * gestor.**
         *
         * ## O corte, e de quem ele vale
         *
         * SPEC-042/INV-094, decisão do Israel (D-I5): o horário foi consumido,
         * a quadra ficou ocupada, e cancelar depois é apagar uma cobrança
         * legítima. **Até a SPEC-031 isso valia só para o aluno** — a guarda
         * era `if (alunoIdScope && ...)`, e `alunoIdScope` é `undefined` para o
         * gestor: `undefined` funcionava como papel administrativo, **por
         * omissão e sem nome**.
         *
         * A SPEC-031/D17 revoga a metade que dizia *"o gestor continua podendo,
         * ele precisa corrigir lançamento errado"*. O papel virou valor de
         * entrada, e o gestor entra na política com `SEM_PRAZO`: herda o corte
         * de `minutos <= 0` (D5b) **sem** herdar a antecedência do clube
         * (AC-013). Corrigir lançamento errado passa a ter outro caminho, e não
         * este — com a SPEC-033 vindo, cancelar quadra já usada e receber o
         * dinheiro de volta é abuso.
         *
         * É a única mudança de comportamento que esta spec impõe a quem nunca
         * configurou nada (AC-003).
         *
         * ## Duas coisas que a posição desta guarda carrega
         *
         * **Depois da saída idempotente, de propósito.** Uma retentativa de
         * rede de um cancelamento que já deu certo tem de continuar devolvendo
         * sucesso; posta antes, ela passaria a devolver erro pelo simples fato
         * de o horário ter chegado nesse meio-tempo.
         *
         * **E depois da linha TRAVADA.** Decidir sobre uma leitura sem lock foi
         * defeito reproduzido (ver o `FOR UPDATE` acima e o FIT-024): o
         * `moveBooking` empurrava a reserva para o passado entre a leitura e a
         * escrita, e o cancelamento decidia com o horário velho.
         *
         * ## O corte é pelo INÍCIO, não pelo fim
         *
         * Diferente do corte das abas (SPEC-041/D-I4), e não é incoerência: lá
         * a pergunta é "onde isto aparece", aqui é "ainda dá para desfazer".
         * Uma reserva das 19h às 21h consultada às 20h continua na aba
         * `Reservas` **e** já não é cancelável, porque a pessoa está na quadra.
         *
         * ## O código de erro
         *
         * `RESERVA_JA_COMECOU` deu lugar a `PRAZO_DE_CANCELAMENTO`
         * (AC-007/AC-010b). Não precisou de passo de rollout: `grep` nos três
         * frontends não acha o código antigo em lugar nenhum — só o `back` o
         * conhecia.
         */
        const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);
        const veredicto = avaliarCancelamentoDeReserva({
          papelDoAutor,
          agora,
          ocorrenciaRelevante: {
            tipo: 'MINUTOS',
            minutos: antecedenciaEmMinutos(
              ocupacao.data,
              ocupacao.horaInicio,
              agora,
            ),
          },
          // O prazo da RESERVA, não o da aula — são dois campos por decisão
          // (REQ-001), e trocá-los faria o clube configurar um e ver o outro.
          prazo: prazos.reserva,
        });
        if (!veredicto.permitido) {
          throw new ConflictException({
            statusCode: 409,
            code: veredicto.code,
            message:
              prazos.reserva.regra === 'HORAS'
                ? `Esta reserva exige ${prazos.reserva.horas}h de antecedência para cancelar.`
                : 'Esta reserva já começou e não pode mais ser cancelada.',
          });
        }

        const transicaoId = novaTransicao();
        const registrador = new RegistradorDeAcao(
          tx,
          companyId,
          autorId,
          'reserva_cancelada',
        );

        // AC-003: cancelar libera o slot imediatamente — a constraint EXCLUDE
        // já ignora linhas com status_pagamento = 'cancelado' (WHERE da
        // migration), então essa escrita sozinha já resolve.
        await tx.ocupacaoQuadra.update({
          where: { id },
          data: { statusPagamento: 'cancelado', transicaoId },
        });

        // A ordem entre esta linha e o `update` acima **não importa**: a
        // trigger é `DEFERRABLE INITIALLY DEFERRED` e só julga no COMMIT.
        // Fosse imediata, gravar a ocupação antes do evento falharia sempre.
        await registrador.registrar(id, 'cancelada', transicaoId);

        /**
         * **Passo 7, e ele é UM movimento — não dois.**
         *
         * A versão anterior desta sequência mandava `UPDATE alunos` **e** o
         * movimento, e isso **dobrava o crédito**: com a trigger do D1,
         * inserir o movimento já atualiza o saldo. Consumo de R$ 120,
         * cancelamento somando 120 à mão e a trigger somando outros 120 —
         * saldo 240 contra um ledger de 120. **A trigger é a única escrita no
         * saldo, em todos os caminhos.**
         *
         * Quem não devolve: ocupação de `TURMA` (não tem `valor`, o `CHECK`
         * proíbe) e reserva sem `aluno_id`. Nos dois casos grava-se a ocupação
         * e o evento, e nenhum movimento — **a ausência dele é a resposta**
         * (AC-010).
         */
        await this.devolverCarteira(tx, {
          companyId,
          ocupacaoId: id,
          autorId,
          registrador,
        });

        // Última instrução (D7).
        await julgarInvariantesDiferidas(tx);
      });
    } catch (erro) {
      // A INV-096 recusando vira `409`, não `500`: no `back` revertido ela
      // dispara **por desenho** (saída B do rollout), e responder erro de
      // servidor transformaria contingência planejada em incidente.
      traduzirRecusaDeCancelamento(erro);
    }
  }

  /**
   * A devolução do consumo ATIVO de uma ocupação, se houver.
   *
   * **"Ativo" é consumo sem devolução** — a mesma definição da INV-098, e a
   * que faz `consumo → devolução → consumo` (cancelar, reativar, cancelar)
   * continuar possível, com as quatro linhas legítimas (AC-011).
   *
   * Devolver o mesmo consumo duas vezes é impossível pelo índice parcial
   * `ux_movimentos_devolucao_por_consumo`; esta busca é o que impede a
   * tentativa, e o índice é o que impede o resultado.
   */
  private async devolverCarteira(
    tx: Prisma.TransactionClient,
    args: {
      companyId: string;
      ocupacaoId: string;
      autorId: string;
      registrador: RegistradorDeAcao;
    },
  ): Promise<void> {
    const consumo = await this.creditos.consumoAtivoDaOcupacao(
      tx,
      args.companyId,
      args.ocupacaoId,
    );
    if (!consumo) {
      return;
    }
    const acaoId = args.registrador.idDaAcao;
    if (!acaoId) {
      throw new Error(
        'devolução sem ação administrativa: o registrador não foi usado antes do estorno',
      );
    }
    await this.creditos.devolver(tx, {
      companyId: args.companyId,
      alunoId: consumo.alunoId,
      valorCentavos: consumo.valorCentavos,
      autorId: args.autorId,
      acaoId,
      ocupacaoId: args.ocupacaoId,
      movimentoOrigemId: consumo.id,
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
    autorId: string,
  ) {
    // INV-069 — a hora entra UMA vez e e injetada na conta, nunca lida dentro
    // dela: duas leituras na mesma decisao podem cair em minutos diferentes.
    const agora = new Date();

    // SPEC-032 — esta rota tambem CANCELA (`status = 'cancelado'`), entao ela
    // dispara a trigger `ocupacao_cancelada_exige_evento` e precisa da mesma
    // atomicidade que o `cancelBooking`. O `pago` nao dispara a trigger, mas
    // grava evento pela mesma razao do resto: sem autor, `updated_at` responde
    // "quando" e ninguem responde "quem".
    /**
     * **PA-02: a mesma sequência da SPEC-033 vale aqui.**
     *
     * `updatePaymentStatus` é o segundo caminho que põe reserva avulsa em
     * `cancelado`. Escrever "os dois caminhos" seria repetir o erro que
     * produziu o DEF-VC031-01 — aquele defeito nasceu de uma spec que
     * enumerava caminhos e esqueceu um. **A garantia não é esta linha: é a
     * INV-096**, que julga o COMMIT e não conhece rota. Os passos 2, 3 e 5
     * entram aqui porque sem eles a transação **falharia** na trigger, não
     * porque a lista de caminhos esteja completa.
     */
    const espiada = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id, companyId },
      select: { alunoId: true },
    });
    const alunoParaTravar = espiada?.alunoId ?? null;

    const atualizada = await this.prisma
      .$transaction(async (tx) => {
        if (alunoParaTravar) {
          await this.creditos.travarESaber(tx, companyId, alunoParaTravar);
        }
        /**
         * **A leitura entra na transação, e trava — mesmo conserto do
         * `cancelBooking`, e pelo mesmo motivo.**
         *
         * Até este commit a leitura era `this.prisma.ocupacaoQuadra.findFirst`
         * **fora** de qualquer transação, e as três guardas abaixo decidiam
         * sobre ela. A auditoria adversarial de 2026-09-05 reproduziu a corrida
         * em banco real, duas vezes:
         *
         * 1. reserva futura `pendente_pagamento`; o gestor manda "marcar como
         *    pago" e a leitura devolve `pendente_pagamento` — passa pela guarda
         *    do AC-012;
         * 2. nesse intervalo o aluno cancela pelo `cancelBooking` **já
         *    corrigido**, que trava, grava `cancelado` + evento e commita;
         * 3. o `update` do pagamento grava `pago`.
         *
         * Estado final medido: `{ meio: 'cancelado', fim: 'pago' }`. **A reserva
         * cancelada ressuscita, volta ao índice `EXCLUDE`, e o aluno que
         * cancelou não fica sabendo** — exatamente o que o comentário do AC-012
         * abaixo descreve como o dano que a guarda existe para impedir.
         *
         * E se alguém pegou o slot liberado no meio-tempo, o `UPDATE` viola
         * `no_overlap_por_quadra` e sobe **cru**: `23P01` vira `500`, não `409`
         * — esta rota não tem o `ehCorridaPerdida`/retry do `createBooking`.
         *
         * O `FOR UPDATE` não é expressável no query builder do Prisma. Travar
         * pelo `id` e reler a linha inteira **dentro** da mesma transação é o
         * mínimo: o `findFirstOrThrow` seguinte já lê a linha travada.
         */
        const travadas = await tx.$queryRaw<{ id: string }[]>`
        SELECT id
          FROM ocupacoes_quadra
         WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
         FOR UPDATE
      `;
        if (!travadas[0]) {
          throw new NotFoundException();
        }
        const ocupacao = await tx.ocupacaoQuadra.findFirstOrThrow({
          where: { id, companyId },
        });

        // Passo 5 (SPEC-033): a linha travada é a do aluno que foi travado.
        if ((ocupacao.alunoId ?? null) !== alunoParaTravar) {
          throw new ConflictException({
            statusCode: 409,
            code: 'RESERVA_MUDOU_DE_ALUNO',
            message: 'A reserva mudou durante a operação. Tente novamente.',
          });
        }

        // AC-007/AC-011: pagamento é coisa de reserva avulsa (CON-006). Aula
        // recorrente não tem cobrança própria no modelo, então marcar "pago"
        // numa ocupação de turma é estado sem significado.
        this.assertOcupacaoAvulsa(ocupacao.origemTipo);

        if (ocupacao.statusPagamento === status) {
          return ocupacao;
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

        /**
         * **DEF-VC031-01 — este caminho CANCELA, e não avaliava o D5b.**
         *
         * Achado pela validação cruzada de 2026-09-06, e era bypass em
         * produção: existem **dois** caminhos para cancelar uma reserva —
         * `cancelBooking` e este `PATCH .../payment-status` com
         * `status: 'cancelado'` — e só o primeiro aplicava a regra.
         *
         * Para a MESMA reserva já iniciada, `cancelBooking` recusava com `409`
         * e o caminho do pagamento **aceitava**. A regra que a SPEC-031 impõe
         * ("depois do início não se cancela, em qualquer configuração") tinha
         * uma porta aberta ao lado.
         *
         * Eu mexi neste método no mesmo dia — para consertar a leitura sem
         * lock — e **não vi a segunda metade do problema**: travar a linha
         * garante que a decisão é sobre o estado certo, não que exista decisão.
         *
         * `papelDoAutor: 'company_admin'` porque a rota é `@Roles('company_admin')`.
         * Pelo INV-066 o gestor não é barrado pela ANTECEDÊNCIA — mas é barrado
         * junto com o aluno **depois do início** (AC-010b). É exatamente o corte
         * que faltava.
         */
        if (status === 'cancelado') {
          const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);
          const veredicto = avaliarCancelamentoDeReserva({
            papelDoAutor: 'company_admin',
            agora,
            ocorrenciaRelevante: {
              tipo: 'MINUTOS',
              minutos: antecedenciaEmMinutos(
                ocupacao.data,
                ocupacao.horaInicio,
                agora,
              ),
            },
            prazo: prazos.reserva,
          });
          if (!veredicto.permitido) {
            throw new ConflictException({
              statusCode: 409,
              code: veredicto.code,
              message: 'Esta reserva já começou e não pode mais ser cancelada.',
            });
          }
        }

        const transicaoId = novaTransicao();
        const registrador = new RegistradorDeAcao(
          tx,
          companyId,
          autorId,
          status === 'pago' ? 'pagamento_confirmado' : 'reserva_cancelada',
        );
        const linha = await tx.ocupacaoQuadra.update({
          where: { id },
          data: { statusPagamento: status, transicaoId },
        });
        await registrador.registrar(
          id,
          status === 'pago' ? 'pagamento_confirmado' : 'cancelada',
          transicaoId,
        );

        // Passo 7: a devolução, quando este caminho cancela. Marcar como
        // `pago` não devolve nada — não é cancelamento.
        if (status === 'cancelado') {
          await this.devolverCarteira(tx, {
            companyId,
            ocupacaoId: id,
            autorId,
            registrador,
          });
        }

        // Última instrução (D7).
        await julgarInvariantesDiferidas(tx);
        return linha;
      })
      .catch(traduzirRecusaDeCancelamento);
    return this.toOcupacaoResponse(atualizada);
  }

  /**
   * SPEC-012:TASK-000 — ações de reserva avulsa não se aplicam a ocupação
   * gerada por turma. Um método só para as duas chamadas, em vez da mesma
   * condição escrita duas vezes: a regra é uma, e regra duplicada
   * diverge no primeiro ajuste.
   */
  /**
   * SPEC-034/TASK-003 — **mover** uma reserva avulsa.
   *
   * ### A ordem aqui é o mecanismo, e cada passo tem um achado atrás
   *
   * **1. Trava, DEPOIS compõe (D6).** Dois `PATCH` parciais concorrentes
   * sobre o mesmo `id` — um mandando `{horaInicio,horaFim}`, outro
   * `{quadraId}` — compunham destinos diferentes a partir da mesma leitura
   * antiga, e o estado final podia violar o expediente que **nenhuma das
   * duas transações chegou a avaliar**. Compor a partir da linha travada
   * elimina a classe: a segunda transação lê o resultado da primeira.
   *
   * **2. Origem, terminal, passado — nesta ordem.** Ocupação de turma se
   * ajusta pela turma; cancelada é estado terminal; e **reserva que já
   * começou não se move** (D5). Esta última fecha o bypass do crédito: sem
   * ela, mover às 20h a reserva das 19h para amanhã a faz "não ter começado",
   * e o cancelamento seguinte devolveria crédito de quadra usada — exatamente
   * o que a SPEC-031 existe para impedir. Mover **para** o passado continua
   * permitido; é fechar caixa (SPEC-042/D-I5).
   *
   * **3. Expediente antes do conflito (INV-011).** Responder "conflito" para
   * quem moveu para fora do expediente mentiria sobre o motivo — mesmo
   * raciocínio do `createBooking`.
   *
   * **4. A pré-checagem não é a garantia.** Quem recusa sobreposição é a
   * `EXCLUDE no_overlap_por_quadra`, que vale para `UPDATE` tanto quanto para
   * `INSERT`. A pré-checagem existe para dar `conflictWith` a quem perdeu.
   *
   * ### O retry, e por que ele existe de verdade
   *
   * **Duas reservas movidas para o mesmo slot livre entram em espera
   * circular.** As duas pré-checagens passam — o destino está vazio quando
   * cada uma olha — e os dois `UPDATE` se esperam. `40P01` reproduzido em
   * PostgreSQL 18.4 na validação cruzada, sem remover pré-checagem e sem
   * injetar nada.
   *
   * Duas tentativas, não N: se a segunda também perde sem conflito visível, o
   * erro sobe cru — `409` sem conflito seria mentira (DEF-013).
   */
  /**
   * SPEC-034/AC-020 — **quantas retentativas o `moveBooking` já fez.**
   *
   * Existe porque "exatamente uma retentativa" não é aferível de fora: a
   * resposta de uma transação que perdeu e refez é idêntica à de uma que
   * ganhou de primeira. Sem este contador, o FIT-022b provaria "não deu 500",
   * que é metade do critério.
   *
   * **Não é só andaime de teste.** É a métrica que diz quantas vezes o
   * caminho de mover encostou no deadlock em produção — e o DEF-023 existiu
   * porque ninguém tinha esse número quando o `40P01` apareceu.
   */
  private _retentativasDeMover = 0;

  get retentativasDeMover(): number {
    return this._retentativasDeMover;
  }

  async moveBooking(
    companyId: string,
    id: string,
    dto: MoveBookingDto,
    autorId: string,
  ) {
    if (
      dto.data === undefined &&
      dto.horaInicio === undefined &&
      dto.horaFim === undefined &&
      dto.quadraId === undefined
    ) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'NADA_A_MOVER',
        message: 'Informe ao menos um de: data, horaInicio, horaFim, quadraId.',
      });
    }

    // O destino e composto DENTRO da transacao, a partir da linha travada, e o
    // `catch` precisa dele para perguntar ao banco "quem ganhou?" — essa
    // pergunta e a diferenca entre responder 409 e responder 500. Ele vive
    // DENTRO do laco: ver o comentario da declaracao, logo abaixo.
    for (let tentativa = 1; ; tentativa += 1) {
      // **Nasce vazio a cada tentativa** (ressalva R7 do veredito de
      // 2026-09-05). Antes ele vivia fora do laço: se a 2ª tentativa falhasse
      // ANTES de compor o destino, o `catch` consultaria o conflito no destino
      // da 1ª — e a linha travada pode ter mudado nesse intervalo, já que a
      // transação anterior soltou o lock ao abortar. Vazio, o `catch` pula a
      // consulta e deixa o erro subir, que é o desfecho honesto: sem destino
      // DESTA tentativa, não há o que afirmar sobre conflito.
      //
      // Num objeto, e não numa `let`: a atribuição acontece dentro do closure
      // do `$transaction`, que o controle de fluxo do TypeScript não enxerga.
      const tentativaAtual: { destino?: DestinoDeMovimento } = {};
      try {
        return await this.prisma.$transaction(async (tx) => {
          // `FOR UPDATE` não é expressável no query builder do Prisma —
          // raw necessária, mesmo idioma de `classes.service.ts:335`.
          const linhas = await tx.$queryRaw<
            {
              id: string;
              quadra_id: string;
              data: Date;
              hora_inicio: Date;
              hora_fim: Date;
              origem_tipo: 'AVULSO' | 'TURMA';
              status_pagamento: string;
            }[]
          >`
            SELECT id, quadra_id, data, hora_inicio, hora_fim,
                   origem_tipo, status_pagamento
              FROM ocupacoes_quadra
             WHERE id = ${id}::uuid AND company_id = ${companyId}::uuid
             FOR UPDATE
          `;
          const atual = linhas[0];
          if (!atual) throw new NotFoundException();

          this.assertOcupacaoAvulsa(atual.origem_tipo);

          if (atual.status_pagamento === 'cancelado') {
            throw new UnprocessableEntityException({
              statusCode: 422,
              code: 'OCUPACAO_CANCELADA',
              message: 'Reserva cancelada não pode ser movida.',
            });
          }

          // D5/AC-010b — o corte é pelo INÍCIO da reserva de origem, o mesmo
          // predicado do `cancelBooking` (SPEC-042/INV-094). Usar outro aqui
          // criaria duas regras temporais divergentes para o mesmo fato.
          if (aulaJaComecou(atual.data, atual.hora_inicio)) {
            throw new ConflictException({
              statusCode: 409,
              code: 'PRAZO_DE_CANCELAMENTO',
              message: 'Esta reserva já começou e não pode mais ser movida.',
            });
          }

          const destino = {
            quadraId: dto.quadraId ?? atual.quadra_id,
            data: dto.data ? parseDateOnly(dto.data) : atual.data,
            horaInicio: dto.horaInicio
              ? parseTimeOnly(dto.horaInicio)
              : atual.hora_inicio,
            horaFim: dto.horaFim ? parseTimeOnly(dto.horaFim) : atual.hora_fim,
          };

          if (destino.horaFim <= destino.horaInicio) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              code: 'INTERVALO_INVALIDO',
              message: 'horaFim deve ser maior que horaInicio.',
            });
          }
          tentativaAtual.destino = destino;

          // **Quadra da empresa E ATIVA — agora o código faz o que a frase
          // sempre prometeu.** A FK composta impede empresa alheia; ela não
          // impede quadra inativa, e `buscarQuadraDaEmpresa` não filtrava
          // `status`: mover para uma quadra inativa respondia 200 e sumia com
          // a reserva da agenda, que não mostra quadra inativa.
          //
          // **E as duas leituras usam `tx`, não `this.prisma`.** Fora da
          // transação elas pegam OUTRA conexão do pool enquanto esta segura o
          // `FOR UPDATE` — com N movimentações concorrentes e pool de N, cada
          // uma espera por uma conexão que só sai quando outra terminar, e
          // ninguém termina. Medido: com `connection_limit=2`, seis
          // movimentações para destinos DISTINTOS davam 0/6 em ~5,1 s
          // (`P2024`); com `tx`, 6/6 em 114 ms. O parâmetro `tx?` de
          // `resolverParaData` existia para isto desde sempre e nenhum
          // chamador usava.
          const quadraDestino = await tx.quadra.findFirst({
            where: { id: destino.quadraId, companyId, status: 'ativa' },
          });
          if (!quadraDestino) throw new NotFoundException();

          const horarioDoDia = await this.horarios.resolverParaData(
            companyId,
            destino.quadraId,
            destino.data,
            tx,
          );
          if (
            !this.horarios.dentroDoExpediente(
              horarioDoDia,
              destino.horaInicio,
              destino.horaFim,
            )
          ) {
            throw new UnprocessableEntityException({
              statusCode: 422,
              code: 'FORA_DO_EXPEDIENTE',
              message:
                'O horário de destino está fora do funcionamento da quadra.',
            });
          }

          // A própria linha não conflita consigo mesma.
          const conflito = await tx.ocupacaoQuadra.findFirst({
            where: {
              companyId,
              quadraId: destino.quadraId,
              data: destino.data,
              id: { not: id },
              statusPagamento: { not: 'cancelado' },
              horaInicio: { lt: destino.horaFim },
              horaFim: { gt: destino.horaInicio },
            },
          });
          if (conflito) {
            throw new ConflictException({
              message: 'Conflito de horário no destino (INV-001)',
              conflictWith: this.toConflictWith(conflito),
            });
          }

          const transicaoId = novaTransicao();
          const registrador = new RegistradorDeAcao(
            tx,
            companyId,
            autorId,
            'reserva_movida',
          );
          const movida = await tx.ocupacaoQuadra.update({
            where: { id },
            // `alunoId`, `valor` e `statusPagamento` ficam de fora **de
            // propósito** (REQ-002): mover não é recontratar.
            data: {
              quadraId: destino.quadraId,
              data: destino.data,
              horaInicio: destino.horaInicio,
              horaFim: destino.horaFim,
              transicaoId,
            },
          });
          await registrador.registrar(id, 'movida', transicaoId);
          return this.toOcupacaoResponse(movida);
        });
      } catch (error) {
        if (ehCorridaPerdida(error)) {
          // **Mesma disciplina do `createBooking` (linhas 573-612), e ela
          // faltava aqui.** Corrida perdida com o conflito JA VISIVEL e 409
          // em QUALQUER tentativa: alguem ganhou o slot, e mandar o gestor
          // investigar um 500 seria mentir sobre o que aconteceu.
          //
          // O FIT-022 pegou isto na PRIMEIRA execucao em CI, e o caminho e o
          // do deadlock: no `40P01` o Postgres aborta uma das transacoes
          // ANTES de a outra commitar. A 2a tentativa entao passa no
          // pre-check (o vencedor ainda nao esta la), esbarra na `EXCLUDE`
          // quando ele commita, e — sem esta traducao — o `23P01` subia cru
          // como 500. Localmente o escalonador nao produzia o ciclo e o
          // teste passava; no CI, produziu.
          // Tipo explícito na leitura: o `tsc` estreita a propriedade para
          // `undefined` porque a única atribuição está no closure.
          const destinoLido: DestinoDeMovimento | undefined =
            tentativaAtual.destino;
          if (destinoLido) {
            const conflito = await this.findConflito(
              companyId,
              destinoLido.quadraId,
              destinoLido.data,
              destinoLido.horaInicio,
              destinoLido.horaFim,
              id,
            );
            if (conflito) {
              throw new ConflictException({
                message: 'Conflito de horário no destino (INV-001)',
                conflictWith: conflito,
              });
            }
          }
          // Corrida perdida e NENHUM conflito visivel: e o deadlock. Uma
          // retentativa, como antes.
          if (tentativa === 1) {
            this._retentativasDeMover += 1;
            continue;
          }
        }
        throw error;
      }
    }
  }

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
    // `moveBooking` precisa excluir a PROPRIA linha: ela ainda ocupa a
    // origem, e sem isto toda mudanca de horario acharia "conflito" consigo
    // mesma. `createBooking` nao passa nada, e nada muda para ele.
    excetoId?: string,
  ): Promise<ConflitoDetectado | null> {
    const conflito = await this.prisma.ocupacaoQuadra.findFirst({
      where: {
        companyId,
        quadraId,
        data,
        ...(excetoId ? { id: { not: excetoId } } : {}),
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

  private toOcupacaoResponse(
    ocupacao: OcupacaoParaResposta,
  ): OcupacaoResponseDto {
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

/**
 * `numeric(10,2)` em centavos inteiros.
 *
 * A multiplicação é feita em `Decimal`, nunca em `number`: o valor já veio do
 * banco com duas casas, então `mul(100)` é exato — e `Number(valor) * 100`
 * não seria, porque passaria por ponto flutuante antes.
 */
function paraCentavos(valor: Prisma.Decimal | null | undefined): number {
  if (!valor) return 0;
  return valor.mul(100).toNumber();
}

/**
 * **A RESPOSTA também tem de dizer `pago` — e não dizia.**
 *
 * O `updateMany` do AC-007c acontece DEPOIS de as ocupações serem criadas, e
 * os objetos que voltam para o cliente são os do `create`: com
 * `pendente_pagamento`, o valor do `DEFAULT` da coluna. O banco ficava certo e
 * **a resposta mentia** — o app do aluno mostraria "pendente de pagamento"
 * numa reserva que a carteira acabou de quitar.
 *
 * Achado pelo smoke da Neon, não pelos testes daqui: o db-spec afirmava o
 * estado no BANCO e o e2e não olhava este campo. A lição é a de sempre neste
 * projeto — **provar o efeito onde o usuário o vê**, não só onde é conveniente
 * medir.
 */
function marcarComoPagas(
  ocupacoes: { id: string; statusPagamento?: StatusPagamento }[],
  ids: string[],
): void {
  const pagas = new Set(ids);
  for (const o of ocupacoes) {
    if (pagas.has(o.id)) {
      o.statusPagamento = 'pago';
    }
  }
}
