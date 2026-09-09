import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { formatTimeOnly, parseTimeOnly } from '../courts/date-time.util';
import type { DefinirDisponibilidadeDto } from './dto/definir-disponibilidade.dto';
import type { DiaDisponibilidadeResponseDto } from './dto/disponibilidade-response.dto';

/** Hora cheia, como o horário da quadra (AC-004). */
const HORA_CHEIA = /^([01]\d|2[0-3]):00$/;

/** Os sete dias, sempre — a AC-007 não devolve lista curta. */
const SEMANA = [0, 1, 2, 3, 4, 5, 6] as const;

/**
 * SPEC-040 (MOD-003) — **quando cada professor atende.**
 *
 * A agenda é da **ficha**, não da conta: `professores.usuario_id` é nulável
 * (INV-014) e a maioria dos professores não tem login. Um professor sem conta
 * precisa ter agenda, senão o gestor não consegue montar aula avulsa para ele.
 *
 * **O que este serviço NÃO faz:** dizer que há quadra livre. Disponibilidade é
 * quando o professor atende; ocupação é outro assunto, e `ocupacoes_quadra`
 * continua sendo a única fonte de verdade sobre ela (D4/LIM-040b). Quem cruza
 * os dois é a SPEC-039.
 */
@Injectable()
export class DisponibilidadeProfessorService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * SPEC-040/REQ-001 — substitui a semana inteira.
   *
   * `PUT` e não `PATCH`: a tela edita a grade toda, e substituição total evita
   * o estado meio-salvo que um `PATCH` por dia criaria (AC-001).
   */
  async definir(
    companyId: string,
    professorId: string,
    dto: DefinirDisponibilidadeDto,
  ): Promise<DiaDisponibilidadeResponseDto[]> {
    await this.assertProfessorDaEmpresa(companyId, professorId);

    // AC-005: dia repetido é recusado AQUI, antes do banco. Deixar passar
    // faria o índice único responder `23505`, que vaza como `500` — erro de
    // banco chegando na tela como falha do servidor.
    const vistos = new Set<number>();
    for (const dia of dto.dias) {
      if (vistos.has(dia.diaSemana)) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'DIA_REPETIDO',
          message: `O dia ${dia.diaSemana} aparece mais de uma vez.`,
        });
      }
      vistos.add(dia.diaSemana);

      // AC-004 antes da AC-003 de propósito: `parseTimeOnly` de uma hora com
      // minuto quebrado produziria um `Date` válido, e a comparação de
      // intervalo diria "ok" sobre um dado que o `CHECK` recusaria depois.
      if (!HORA_CHEIA.test(dia.horaInicio) || !HORA_CHEIA.test(dia.horaFim)) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'HORA_NAO_CHEIA',
          message: `Dia ${dia.diaSemana}: use hora cheia (ex.: 08:00).`,
        });
      }

      // AC-003: o mesmo código que `moveBooking` já usa. Inventar um segundo
      // nome para "fim não é depois do início" faria o Admin tratar duas
      // vezes a mesma coisa.
      if (dia.horaFim <= dia.horaInicio) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'INTERVALO_INVALIDO',
          message: `Dia ${dia.diaSemana}: horaFim deve ser maior que horaInicio.`,
        });
      }
    }

    // Substituição numa transação só: estado parcial aqui significaria uma
    // semana com metade da grade nova e metade da velha — e é justamente o
    // que o `PUT` existe para não produzir.
    await this.prisma.$transaction(async (tx) => {
      await tx.disponibilidadeProfessor.deleteMany({
        where: { companyId, professorId },
      });
      if (dto.dias.length > 0) {
        await tx.disponibilidadeProfessor.createMany({
          data: dto.dias.map((dia) => ({
            companyId,
            professorId,
            diaSemana: dia.diaSemana,
            horaInicio: parseTimeOnly(dia.horaInicio),
            horaFim: parseTimeOnly(dia.horaFim),
          })),
        });
      }
    });

    return this.listar(companyId, professorId);
  }

  /**
   * SPEC-040/REQ-002/AC-007 — os **sete** dias, sempre.
   *
   * Os dias sem linha voltam com `indisponivel: true`. A tela não deveria ter
   * de saber que ausência significa algo — e é a assimetria deliberada desta
   * rota: o `PUT` recebe só os dias atendidos (D6), o `GET` devolve a semana
   * fechada. Quem reenviar o que leu filtra os `indisponivel`.
   */
  async listar(
    companyId: string,
    professorId: string,
  ): Promise<DiaDisponibilidadeResponseDto[]> {
    await this.assertProfessorDaEmpresa(companyId, professorId);

    const linhas = await this.prisma.disponibilidadeProfessor.findMany({
      where: { companyId, professorId },
      orderBy: { diaSemana: 'asc' },
    });

    return SEMANA.map((diaSemana) => {
      const linha = linhas.find((l) => l.diaSemana === diaSemana);
      if (!linha) {
        return {
          diaSemana,
          indisponivel: true,
          horaInicio: null,
          horaFim: null,
        };
      }
      return {
        diaSemana,
        indisponivel: false,
        horaInicio: formatTimeOnly(linha.horaInicio),
        horaFim: formatTimeOnly(linha.horaFim),
      };
    });
  }

  /**
   * AC-006 — professor de outra empresa devolve **404**, nunca `403`.
   *
   * É o padrão do projeto: `403` confirmaria que o id existe em algum lugar,
   * e a resposta viraria um oráculo de existência de recurso alheio.
   */
  private async assertProfessorDaEmpresa(companyId: string, id: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { id, companyId },
      select: { id: true },
    });
    if (!professor) {
      throw new NotFoundException();
    }
  }
}
