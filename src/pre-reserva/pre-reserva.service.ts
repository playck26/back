import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { HorarioFuncionamentoService } from '../courts/horario-funcionamento.service';
import { StudentsService } from '../people/students.service';
import {
  aulaJaComecou,
  formatDateOnly,
  formatTimeOnly,
  instanteNoFusoDoClube,
  parseDateOnly,
  parseTimeOnly,
} from '../courts/date-time.util';
import type {
  PedirPreReservaDto,
  PreReservaResponseDto,
} from './dto/pre-reserva.dto';

/**
 * SPEC-074/D9 — **o teto de pedidos vivos por aluno.** Decisão 5 do Israel.
 *
 * Conta só `aguardando`. **Não é invariante:** a contagem é leitura, e duas
 * criações simultâneas no 10º podem chegar a 11 (LIM-074e). Travar o aluno
 * para contar poria o nível 2 da ordem canônica num caminho que não precisa
 * dele.
 */
export const PRE_RESERVAS_ATIVAS_MAX = 10;

/**
 * SPEC-074/D1 — o fim do slot, derivado do início: o slot é de **1 hora**
 * (SPEC-010, `gerarSlots`). O cliente não escolhe o tamanho.
 *
 * `'23:00'` produz `'24:00'`, que o `parseTimeOnly` monta como meia-noite do
 * dia seguinte — e que o expediente recusa, porque ele vai no máximo até
 * `23:00` (`definir-horarios.dto.ts`). Nunca chega ao banco.
 */
function fimDoSlot(horaInicio: string): string {
  const hora = Number(horaInicio.slice(0, 2));
  return `${String(hora + 1).padStart(2, '0')}:00`;
}

function paraResposta(p: {
  id: string;
  quadraId: string;
  data: Date;
  horaInicio: Date;
  horaFim: Date;
  estado: string;
  criadaEm: Date;
}): PreReservaResponseDto {
  return {
    id: p.id,
    quadraId: p.quadraId,
    data: formatDateOnly(p.data),
    horaInicio: formatTimeOnly(p.horaInicio),
    horaFim: formatTimeOnly(p.horaFim),
    estado: p.estado,
    criadaEm: p.criadaEm.toISOString(),
  };
}

function ehConflitoDeUnicidade(erro: unknown): boolean {
  const e = erro as { code?: string; meta?: { code?: string } };
  return e?.code === 'P2002' || e?.meta?.code === '23505';
}

/**
 * SPEC-074/TASK-002 — **pedir, listar e cancelar o aviso de horário.**
 *
 * ## Esta classe NÃO avisa ninguém
 *
 * Ela só grava que a pessoa quer o horário. **Quem avisa é o varredor** (D3),
 * que olha o estado da grade — e é por isso que nenhum dos cinco caminhos que
 * liberam horário (fato 3 da spec) precisou mudar.
 *
 * ## As guardas são as de reservar, com os mesmos códigos (D2)
 *
 * Um horário que o servidor recusaria reservar não pode ser prometido pelo
 * aviso. A ordem é a da tabela da D2, e ela importa pelo mesmo motivo que
 * importa no `createBooking`: a resposta tem de dizer o motivo **verdadeiro**
 * — responder "fora do expediente" para quem pediu ontem às 19h mentiria.
 *
 * ## Por que não há `FOR UPDATE` aqui
 *
 * A checagem "está ocupado" é leitura, e a corrida é inofensiva: se o horário
 * vagar entre a leitura e o `INSERT`, o pedido nasce para um horário livre e o
 * próximo ciclo do varredor avisa. **O erro se corrige sozinho em até um
 * ciclo.** Duplicidade é do índice parcial, não de uma consulta antes.
 */
@Injectable()
export class PreReservaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly horarios: HorarioFuncionamentoService,
    private readonly alunos: StudentsService,
  ) {}

  /** `alunoId` nunca vem do corpo nem da URL — é derivado do token. */
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
   * REQ-001 — pedir aviso de um horário OCUPADO.
   *
   * `agora` é injetável pelo mesmo motivo do varredor: a regra do passado é
   * provável **sem esperar o relógio**.
   */
  async pedir(
    companyId: string,
    usuarioId: string,
    dto: PedirPreReservaDto,
    agora: Date = new Date(),
  ): Promise<PreReservaResponseDto> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    // 1 — o aluno opera: vínculo aprovado e conta ativa, os mesmos 403/422 de
    // reservar.
    await this.alunos.exigirAlunoOperante(companyId, aluno.id);

    // 2 e 3 — a quadra existe na empresa, e está em operação.
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: dto.quadraId, companyId },
      select: { status: true },
    });
    if (!quadra) throw new NotFoundException();
    if (quadra.status !== 'ativa') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'QUADRA_INATIVA',
        message:
          'Esta quadra está fora de operação, e não dá para pedir aviso de horário nela.',
      });
    }

    const data = parseDateOnly(dto.data);
    const horaInicio = parseTimeOnly(dto.horaInicio);
    const horaFim = parseTimeOnly(fimDoSlot(dto.horaInicio));

    // 4 — não começou. A mesma função do `createBooking` (SPEC-042), no fuso
    // do clube.
    if (aulaJaComecou(data, horaInicio, agora)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'HORARIO_NO_PASSADO',
        message: 'Não dá para pedir aviso de um horário que já começou.',
      });
    }

    // 5 — dentro do expediente daquele dia: a mesma resolução da grade e da
    // criação de reserva (SPEC-010, INV-011).
    const horario = await this.horarios.resolverParaData(
      companyId,
      dto.quadraId,
      data,
    );
    if (!this.horarios.dentroDoExpediente(horario, horaInicio, horaFim)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'FORA_DO_EXPEDIENTE',
        message: `O horário ${dto.horaInicio}–${fimDoSlot(dto.horaInicio)} está fora do funcionamento da quadra.`,
      });
    }

    // 6 e 7 — está ocupado, e não pela reserva do próprio aluno. **A mesma
    // forma da grade** (`availability`): as ocupações não canceladas do dia,
    // e o conflito SEMIABERTO — uma ocupação que começa às 11:00 não ocupa o
    // slot que termina às 11:00.
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        quadraId: dto.quadraId,
        data,
        statusPagamento: { not: 'cancelado' },
      },
      select: {
        horaInicio: true,
        horaFim: true,
        origemTipo: true,
        alunoId: true,
      },
    });
    const conflitos = ocupacoes.filter(
      (o) => o.horaInicio < horaFim && o.horaFim > horaInicio,
    );
    if (conflitos.length === 0) {
      throw new ConflictException({
        statusCode: 409,
        code: 'HORARIO_LIVRE',
        message: 'Este horário está livre: reserve direto.',
      });
    }
    if (
      conflitos.some((o) => o.origemTipo === 'AVULSO' && o.alunoId === aluno.id)
    ) {
      throw new ConflictException({
        statusCode: 409,
        code: 'HORARIO_JA_E_SEU',
        message: 'Este horário já é seu.',
      });
    }

    // 8 — o teto (D9). Contagem, não invariante: ver o docstring da constante.
    const vivos = await this.prisma.preReserva.count({
      where: { companyId, alunoId: aluno.id, estado: 'aguardando' },
    });
    if (vivos >= PRE_RESERVAS_ATIVAS_MAX) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'LIMITE_DE_PRE_RESERVAS',
        message: `Você já tem ${PRE_RESERVAS_ATIVAS_MAX} avisos de horário ativos. Cancele um para pedir outro.`,
      });
    }

    // 9 — um pedido vivo por aluno e slot: **o índice é o mecanismo**
    // (INV-074a), e o `23505` vira `409`. Os três campos do slot e o instante
    // saem daqui, da mesma entrada — a metade da INV-074h que é da aplicação.
    try {
      const criada = await this.prisma.preReserva.create({
        data: {
          id: crypto.randomUUID(),
          companyId,
          alunoId: aluno.id,
          quadraId: dto.quadraId,
          data,
          horaInicio,
          horaFim,
          inicioEm: instanteNoFusoDoClube(data, horaInicio),
        },
      });
      return paraResposta(criada);
    } catch (erro) {
      if (ehConflitoDeUnicidade(erro)) {
        throw new ConflictException({
          statusCode: 409,
          code: 'PRE_RESERVA_DUPLICADA',
          message: 'Você já pediu aviso deste horário.',
        });
      }
      throw erro;
    }
  }

  /**
   * REQ-001 — os pedidos VIVOS do próprio aluno, por início.
   *
   * **Ordem total**: o `id` no fim impede dois pedidos do mesmo instante de
   * trocarem de lugar entre duas leituras.
   */
  async meus(
    companyId: string,
    usuarioId: string,
  ): Promise<PreReservaResponseDto[]> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    const pedidos = await this.prisma.preReserva.findMany({
      where: { companyId, alunoId: aluno.id, estado: 'aguardando' },
      orderBy: [{ inicioEm: 'asc' }, { id: 'asc' }],
    });
    return pedidos.map(paraResposta);
  }

  /**
   * REQ-001 — cancelar um pedido vivo.
   *
   * Pedido de outro aluno, inexistente ou **já terminado** caem no mesmo
   * `404` — o precedente é o `sair` da fila: responder `204` para um pedido
   * avisado diria que a ação aconteceu agora, e ela não aconteceu. E `404`,
   * não `403`: não revela que o pedido de outra pessoa existe.
   */
  async cancelar(
    companyId: string,
    usuarioId: string,
    id: string,
  ): Promise<void> {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    const { count } = await this.prisma.preReserva.updateMany({
      where: { id, companyId, alunoId: aluno.id, estado: 'aguardando' },
      data: {
        estado: 'cancelada',
        concluidaEm: new Date(),
        motivoFim: 'cancelada pelo aluno',
      },
    });
    if (count === 0) throw new NotFoundException();
  }
}
