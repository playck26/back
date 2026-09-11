import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { DisponibilidadeProfessorService } from '../people/disponibilidade-professor.service';
import { PrecoDeAulaService } from '../people/preco-de-aula.service';
import { CourtsService } from './courts.service';
import {
  aulaJaComecou,
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
  parseTimeOnly,
} from './date-time.util';
import type { HorariosDeAulaResponseDto } from './dto/horarios-de-aula-response.dto';

/**
 * SPEC-047/REQ-005 — **os horários em que o aluno REALMENTE consegue marcar
 * aula com este professor.**
 *
 * ## Por que esta rota existe (e por que a tela não podia fazer isso sozinha)
 *
 * A LIM-047e declarou: *"o aluno não escolhe a quadra da aula. Ele escolhe
 * professor, dia e hora; a quadra vem da disponibilidade. Fica declarado
 * porque a tela vai precisar decidir isso."*
 *
 * A tela foi decidir e **descobriu que não pode**. Marcar uma aula depende de
 * três fatos, e o aluno enxerga um:
 *
 * | Fato | Rota do aluno antes desta |
 * |---|---|
 * | a quadra está livre | `GET /courts/:id/availability` |
 * | o professor atende neste dia e hora | nenhuma — é `CompanyAdminGuard` |
 * | o professor não tem outro compromisso | nenhuma |
 *
 * Uma tela com um terço da informação ofereceria horário que o `POST
 * /bookings` recusa — e o docstring do `MeProfessoresController` já chama isso
 * pelo nome: *"oferecer o que a criação vai negar é a forma mais barata de
 * perder a confiança de quem usa."* A alternativa seria o aluno descobrir a
 * agenda do professor por tentativa e erro, uma recusa por vez.
 *
 * ## Os portões são os MESMOS da criação, e é o ponto
 *
 * `404` de outra empresa, `PROFESSOR_INATIVO`, `AULA_SEM_PRECO`: os três
 * códigos são os do `createBooking`, com as mesmas mensagens. Esta rota não
 * inventa política — ela **antecipa** a que já existe. Se um dia divergirem, o
 * db-spec que compara as duas fica vermelho.
 *
 * ## Onde mora, e por quê
 *
 * Em `CourtsModule`, apesar de a rota ser `/me/professores/:id/horarios`: a
 * resposta é feita de **ocupação e horário de quadra**, que são deste módulo,
 * e `CourtsModule` já importa `PeopleModule`. O contrário seria import
 * circular — e `forwardRef` para evitar uma pasta é conserto pior que a doença.
 */
@Injectable()
export class HorariosDeAulaParticularService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly courts: CourtsService,
    private readonly disponibilidade: DisponibilidadeProfessorService,
    private readonly precos: PrecoDeAulaService,
  ) {}

  async horariosDoProfessor(
    companyId: string,
    professorId: string,
    data: string,
  ): Promise<HorariosDeAulaResponseDto> {
    // **Existência antes de tudo.** Mesma ordem do `exigirProfessorDisponivel`,
    // e `404` (não `403`) para professor de outra empresa: `403` confirmaria
    // que o id existe em algum lugar, e a resposta viraria um oráculo.
    const professor = await this.prisma.professor.findFirst({
      where: { id: professorId, companyId },
      select: { status: true },
    });
    if (!professor) {
      throw new NotFoundException();
    }
    if (professor.status !== 'ativo') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PROFESSOR_INATIVO',
        message: 'Este professor está inativo e não recebe aula.',
      });
    }

    const precoAula = await this.precos.doProfessor(companyId, professorId);
    if (precoAula == null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_SEM_PRECO',
        message:
          'Este professor ainda não tem preço de aula definido. Fale com a recepção.',
      });
    }

    const dataDate = parseDateOnly(data);
    // `getUTCDay` e não `getDay`: `parseDateOnly` produz meia-noite UTC, e ler
    // em horário local moveria o dia da semana para quem está a oeste de
    // Greenwich. É o mesmo `getUTCDay` do `exigirProfessorDisponivel`.
    const semana = await this.disponibilidade.carregarSemana(
      companyId,
      professorId,
    );
    const janela = semana.get(dataDate.getUTCDay());

    if (!janela) {
      // Dia sem linha é "não atende" (SPEC-040/D3). Sai cedo: sem janela não
      // há o que cruzar, e varrer as quadras seria trabalho para devolver
      // lista vazia de qualquer jeito.
      return { data, atende: false, janela: null, precoAula, slots: [] };
    }

    const janelaInicio = formatTimeOnly(janela.horaInicio);
    const janelaFim = formatTimeOnly(janela.horaFim);

    const quadras = await this.prisma.quadra.findMany({
      where: { companyId, status: 'ativa' },
      select: { id: true, nome: true },
      // A ordem é o desempate: quando duas quadras estão livres na mesma hora,
      // o aluno recebe sempre a primeira por nome. **Determinístico de
      // propósito** — sem ordem, dois carregamentos da mesma tela ofereceriam
      // quadras diferentes para o mesmo horário, e o "mudou sozinho" é o tipo
      // de coisa que ninguém reporta e todo mundo desconfia.
      orderBy: [{ nome: 'asc' }, { id: 'asc' }],
    });

    const [ocupacoesDoProfessor, grades] = await Promise.all([
      this.ocupacoesDoProfessorNoDia(companyId, professorId, dataDate),
      Promise.all(
        quadras.map(async (quadra) => ({
          quadra,
          grade: await this.courts.availability(companyId, quadra.id, data),
        })),
      ),
    ]);

    // Primeira quadra livre vence; as seguintes não sobrescrevem.
    const porHora = new Map<
      string,
      {
        horaInicio: string;
        horaFim: string;
        quadraId: string;
        quadraNome: string;
      }
    >();

    for (const { quadra, grade } of grades) {
      for (const slot of grade.slots) {
        if (slot.status !== 'livre') continue;
        if (porHora.has(slot.slot)) continue;
        const [horaInicio, horaFim] = slot.slot.split('-');

        // 1. cabe INTEIRO na janela do professor — meia aula fora da janela é
        //    a recusa `FORA_DA_DISPONIBILIDADE` esperando para acontecer.
        if (horaInicio < janelaInicio || horaFim > janelaFim) continue;

        // 2. o professor não tem outro compromisso (turma ou aula) na hora.
        //    Semiaberto, como todo conflito neste projeto: quem termina às
        //    10:00 não ocupa o slot que começa às 10:00.
        const ocupado = ocupacoesDoProfessor.some(
          (o) => o.inicio < horaFim && o.fim > horaInicio,
        );
        if (ocupado) continue;

        // 3. não começou ainda. **O aluno nunca marca o que já começou**
        //    (SPEC-042/INV-093) — a mesma função da guarda de criação, para as
        //    duas não discordarem sobre que horas são.
        if (aulaJaComecou(dataDate, parseTimeOnly(horaInicio))) continue;

        porHora.set(slot.slot, {
          horaInicio,
          horaFim,
          quadraId: quadra.id,
          quadraNome: quadra.nome,
        });
      }
    }

    return {
      data,
      atende: true,
      janela: { horaInicio: janelaInicio, horaFim: janelaFim },
      precoAula,
      slots: [...porHora.values()].sort((a, b) =>
        a.horaInicio.localeCompare(b.horaInicio),
      ),
    };
  }

  /**
   * Os compromissos do professor no dia — **uma consulta, não uma por hora.**
   *
   * SQL cru porque `ocupacoes_quadra.origem_turma_id` é coluna solta, sem
   * relação no Prisma: a aula que o professor dá para a turma dele ocupa a
   * agenda igual, e o `LEFT JOIN turmas` é a única forma de alcançá-la.
   *
   * **A data vai como TEXTO.** Um parâmetro `Date` chega como timestamp e o
   * `::date` passa a depender do fuso da sessão — a dependência que a DEF-020
   * já cobrou neste projeto, e que no `exigirProfessorDisponivel` fez a
   * ocupação de turma não casar e a aula passar.
   */
  private async ocupacoesDoProfessorNoDia(
    companyId: string,
    professorId: string,
    data: Date,
  ): Promise<{ inicio: string; fim: string }[]> {
    const dataIso = formatDateOnly(data);
    const linhas = await this.prisma.$queryRaw<
      { hora_inicio: Date; hora_fim: Date }[]
    >`
      SELECT o.hora_inicio, o.hora_fim
        FROM ocupacoes_quadra o
        LEFT JOIN turmas t ON t.id = o.origem_turma_id
       WHERE o.company_id = ${companyId}::uuid
         AND o.data = ${dataIso}::date
         AND o.status_pagamento <> 'cancelado'
         AND (o.professor_id = ${professorId}::uuid
              OR t.professor_id = ${professorId}::uuid)`;
    return linhas.map((l) => ({
      inicio: formatTimeOnly(l.hora_inicio),
      fim: formatTimeOnly(l.hora_fim),
    }));
  }
}
