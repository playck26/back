import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  EXPEDIENTE_FIM_HORA,
  EXPEDIENTE_INICIO_HORA,
  formatDateOnly,
  formatTimeOnly,
  parseTimeOnly,
} from './date-time.util';
import {
  HorariosDaQuadraResponseDto,
  OcupacaoAfetadaResponseDto,
} from './dto/horarios-response.dto';
import type { DefinirHorariosDto } from './dto/definir-horarios.dto';

/** Teto da amostra do relatório de impacto (SPEC-010/AC-011). */
const AMOSTRA_MAXIMA = 20;

/**
 * SPEC-021/TASK-005 — a forma canonica vive no DTO; isto aqui e o apelido
 * que o resto do modulo ja usava. Duas declaracoes divergiriam.
 */
export type OcupacaoAfetada = OcupacaoAfetadaResponseDto;

export interface ResultadoDefinicao {
  afetadasCount: number;
  amostra: OcupacaoAfetada[];
}

export interface SlotCanonico {
  inicio: Date;
  fim: Date;
}

/** Forma mínima de uma linha de `horarios_funcionamento` para resolução. */
export interface LinhaHorario {
  quadraId: string | null;
  diaSemana: number;
  fechado: boolean;
  horaInicio: Date | null;
  horaFim: Date | null;
}

export type HorarioEfetivo =
  { estado: 'fechado' } | { estado: 'aberto'; horaInicio: Date; horaFim: Date };

type PrismaLike = Pick<PrismaService, 'horarioFuncionamento'>;

/**
 * SPEC-010 (MOD-005) — **a única fonte de verdade sobre "estar aberto"**.
 *
 * `availability` e a validação de criação de ocupação usam este mesmo
 * serviço de propósito. Se cada uma resolvesse o horário por conta
 * própria, elas divergiriam com o tempo — e o sintoma seria o pior
 * possível: o app oferece um horário que o servidor recusa depois
 * (REQ-008/AC-015).
 */
@Injectable()
export class HorarioFuncionamentoService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Resolve o horário de uma quadra num dia da semana, aplicando a herança:
   * horário próprio da quadra, se existir; senão o padrão da empresa.
   *
   * **Uma consulta só** (NFR-001): busca as duas linhas possíveis de uma
   * vez e escolhe em memória. Duas consultas em sequência custariam o dobro
   * numa rota chamada a cada troca de dia na tela do aluno.
   */
  async resolver(
    companyId: string,
    quadraId: string,
    diaSemana: number,
    tx: PrismaLike | Prisma.TransactionClient = this.prisma,
  ): Promise<HorarioEfetivo> {
    const linhas = await (tx as PrismaLike).horarioFuncionamento.findMany({
      where: {
        companyId,
        diaSemana,
        OR: [{ quadraId }, { quadraId: null }],
      },
    });

    return this.resolverDeLinhas(linhas, quadraId, diaSemana);
  }

  /**
   * DEF-013 — as linhas de uma quadra para **vários dias da semana**, numa
   * consulta só, para quem depois resolve em memória com `resolverDeLinhas`.
   *
   * `resolver` é a forma certa para **uma** pergunta. Quem tem muitas —
   * `registerClassOccupancy` resolve o horário de cada ocorrência da turma —
   * paga uma ida ao banco por pergunta, e desde a SPEC-019 são `8 × N`
   * ocorrências dentro de uma transação aberta. Foi assim que a criação de
   * turma com dois encontros passou a estourar o timeout de 5000 ms do
   * Prisma em produção.
   *
   * O horário **só depende do dia da semana**: as `8 × N` perguntas têm no
   * máximo 7 respostas distintas. Este método carrega essas 7 de uma vez.
   *
   * É o mesmo N+1 que a validação cruzada da SPEC-010 baniu no KPI do
   * dashboard e a da SPEC-012 pegou voltando na agenda. **Da terceira vez
   * ele entrou pelo caminho de escrita**, onde ninguém procurava — e por
   * isso a saída deixou de ser um cuidado de quem escreve a leitura e virou
   * método público aqui.
   */
  async carregarLinhas(
    companyId: string,
    quadraId: string,
    diasSemana: number[],
    tx: PrismaLike | Prisma.TransactionClient = this.prisma,
  ): Promise<LinhaHorario[]> {
    const dias = [...new Set(diasSemana)];
    if (dias.length === 0) {
      return [];
    }
    return (tx as PrismaLike).horarioFuncionamento.findMany({
      where: {
        companyId,
        diaSemana: { in: dias },
        OR: [{ quadraId }, { quadraId: null }],
      },
      select: {
        quadraId: true,
        diaSemana: true,
        fechado: true,
        horaInicio: true,
        horaFim: true,
      },
    });
  }

  /**
   * A mesma herança, sobre linhas **já carregadas**.
   *
   * Existe porque quem precisa resolver muitas combinações de quadra e dia
   * — o KPI do dashboard (SPEC-010/REQ-009), o resumo mensal da agenda
   * (SPEC-012) e o registro de ocupações de turma (DEF-013) — não pode
   * consultar o banco por combinação: seriam centenas de consultas para
   * produzir uma tela, ou para gravar uma turma. Carregam tudo uma vez
   * (`carregarLinhas`) e chamam isto.
   *
   * É a mesma regra de `resolver`, num lugar só. Três cópias da herança
   * divergiriam no primeiro ajuste, e o sintoma seria a agenda dizer que a
   * quadra está aberta enquanto a reserva é recusada.
   */
  resolverDeLinhas(
    linhas: LinhaHorario[],
    quadraId: string,
    diaSemana: number,
  ): HorarioEfetivo {
    // Herança: a linha da quadra vence a da empresa. Quadra que segue o
    // padrão simplesmente não tem linha própria — por isso a herança
    // acompanha mudanças no padrão sem nenhuma escrita nas quadras
    // (REQ-003/AC-005).
    const doQuadra = linhas.find(
      (l) => l.quadraId === quadraId && l.diaSemana === diaSemana,
    );
    const daEmpresa = linhas.find(
      (l) => l.quadraId === null && l.diaSemana === diaSemana,
    );
    const efetivo = doQuadra ?? daEmpresa;

    if (!efetivo) {
      // Rede de segurança para empresa sem configuração alguma: mantém o
      // comportamento anterior à SPEC-010 (6h–22h) em vez de fechar a
      // agenda. Fechar seria "seguro" e erraria feio — uma empresa sem
      // linha configurada ficaria invisível para os próprios alunos sem
      // ninguém entender por quê. `CompaniesService` semeia o padrão na
      // criação, então isto só cobre dado legado ou corrompido.
      return {
        estado: 'aberto',
        horaInicio: parseTimeOnly(
          `${String(EXPEDIENTE_INICIO_HORA).padStart(2, '0')}:00`,
        ),
        horaFim: parseTimeOnly(
          `${String(EXPEDIENTE_FIM_HORA).padStart(2, '0')}:00`,
        ),
      };
    }

    if (efetivo.fechado || !efetivo.horaInicio || !efetivo.horaFim) {
      return { estado: 'fechado' };
    }

    return {
      estado: 'aberto',
      horaInicio: efetivo.horaInicio,
      horaFim: efetivo.horaFim,
    };
  }

  /** Conveniência: resolve a partir de uma data (0 = domingo, `getUTCDay`). */
  resolverParaData(
    companyId: string,
    quadraId: string,
    data: Date,
    tx?: PrismaLike | Prisma.TransactionClient,
  ): Promise<HorarioEfetivo> {
    return this.resolver(companyId, quadraId, data.getUTCDay(), tx);
  }

  /**
   * Slots canônicos de 1 hora dentro do expediente. Dia fechado não tem
   * slot — e isso é resposta legítima, não erro (AC-008).
   *
   * A duração fixa de 1 hora é decisão do usuário registrada na SPEC-010
   * (GAP-003 segue aberto). Como o horário só existe em hora cheia
   * (AC-014), o último slot sempre termina exatamente no fechamento.
   */
  gerarSlots(horario: HorarioEfetivo): SlotCanonico[] {
    if (horario.estado === 'fechado') {
      return [];
    }

    const slots: SlotCanonico[] = [];
    const inicioHora = horario.horaInicio.getUTCHours();
    const fimHora = horario.horaFim.getUTCHours();

    for (let hora = inicioHora; hora < fimHora; hora++) {
      slots.push({
        inicio: parseTimeOnly(`${String(hora).padStart(2, '0')}:00`),
        fim: parseTimeOnly(`${String(hora + 1).padStart(2, '0')}:00`),
      });
    }
    return slots;
  }

  /**
   * SPEC-010/REQ-010 — estar dentro do expediente é **fechado nas duas
   * pontas**: `horaInicio >= abertura` e `horaFim <= fechamento`.
   *
   * Não confundir com a detecção de conflito entre ocupações, que é
   * **semiaberta** (`09:00–10:00` não colide com `10:00–11:00`). As duas
   * regras estão certas e são diferentes: com expediente `06:00–10:00`, a
   * ocupação `10:00–11:00` não conflita com `09:00–10:00`, mas está fora
   * do expediente (AC-020 a AC-022).
   */
  dentroDoExpediente(
    horario: HorarioEfetivo,
    horaInicio: Date,
    horaFim: Date,
  ): boolean {
    if (horario.estado === 'fechado') {
      return false;
    }
    return (
      horaInicio.getTime() >= horario.horaInicio.getTime() &&
      horaFim.getTime() <= horario.horaFim.getTime()
    );
  }

  /**
   * SPEC-010/REQ-001 — define o horário padrão da empresa (os 7 dias).
   */
  async definirPadraoDaEmpresa(
    companyId: string,
    dto: DefinirHorariosDto,
  ): Promise<ResultadoDefinicao> {
    return this.definir(companyId, null, dto);
  }

  /**
   * SPEC-010/REQ-002 — define o horário próprio de uma quadra, que passa a
   * sobrepor o padrão da empresa.
   */
  async definirDaQuadra(
    companyId: string,
    quadraId: string,
    dto: DefinirHorariosDto,
  ): Promise<ResultadoDefinicao> {
    await this.assertQuadraDaEmpresa(companyId, quadraId);
    return this.definir(companyId, quadraId, dto);
  }

  /**
   * SPEC-010/AC-004 — remove o horário próprio: a quadra **volta a
   * herdar** o padrão da empresa.
   *
   * Devolve o mesmo relatório de impacto das outras operações: voltar ao
   * padrão também pode deixar reservas fora do expediente, se o padrão for
   * mais curto que o horário próprio que existia.
   */
  async removerDaQuadra(
    companyId: string,
    quadraId: string,
  ): Promise<ResultadoDefinicao> {
    await this.assertQuadraDaEmpresa(companyId, quadraId);
    await this.prisma.horarioFuncionamento.deleteMany({
      where: { companyId, quadraId },
    });
    return this.relatorioDeImpacto(companyId, quadraId);
  }

  /** Configuração atual: o padrão da empresa e os overrides por quadra. */
  async listarConfiguracao(companyId: string) {
    const linhas = await this.prisma.horarioFuncionamento.findMany({
      where: { companyId },
      orderBy: [{ quadraId: 'asc' }, { diaSemana: 'asc' }],
    });

    const serializar = (l: (typeof linhas)[number]) => ({
      diaSemana: l.diaSemana,
      fechado: l.fechado,
      horaInicio: l.horaInicio ? formatTimeOnly(l.horaInicio) : null,
      horaFim: l.horaFim ? formatTimeOnly(l.horaFim) : null,
    });

    const porQuadra = new Map<string, ReturnType<typeof serializar>[]>();
    for (const l of linhas.filter((x) => x.quadraId !== null)) {
      const atual = porQuadra.get(l.quadraId as string) ?? [];
      atual.push(serializar(l));
      porQuadra.set(l.quadraId as string, atual);
    }

    return {
      padrao: linhas.filter((l) => l.quadraId === null).map(serializar),
      // Só aparecem aqui as quadras que **têm** horário próprio. As demais
      // herdam, e herança é ausência de registro — listar todas com o
      // padrão copiado daria a impressão errada de que elas foram
      // configuradas individualmente.
      quadrasComHorarioProprio: [...porQuadra.entries()].map(
        ([quadraId, dias]) => ({ quadraId, dias }),
      ),
    };
  }

  /**
   * O que vale para uma quadra hoje, e **de onde vem**.
   *
   * A tela precisa distinguir "esta quadra tem horário próprio" de "esta
   * quadra segue o padrão": sem `origem`, o admin não saberia se está
   * editando a quadra ou vendo o reflexo da configuração da empresa — e
   * mudar o padrão depois pareceria não ter efeito.
   */
  async listarDaQuadra(
    companyId: string,
    quadraId: string,
  ): Promise<HorariosDaQuadraResponseDto> {
    await this.assertQuadraDaEmpresa(companyId, quadraId);

    const linhas = await this.prisma.horarioFuncionamento.findMany({
      where: { companyId, OR: [{ quadraId }, { quadraId: null }] },
      orderBy: { diaSemana: 'asc' },
    });

    const proprios = linhas.filter((l) => l.quadraId === quadraId);
    const origem = proprios.length > 0 ? 'proprio' : 'herdado';
    const efetivos = proprios.length > 0 ? proprios : linhas;

    return {
      origem,
      dias: efetivos.map((l) => ({
        diaSemana: l.diaSemana,
        fechado: l.fechado,
        horaInicio: l.horaInicio ? formatTimeOnly(l.horaInicio) : null,
        horaFim: l.horaFim ? formatTimeOnly(l.horaFim) : null,
      })),
    };
  }

  private async definir(
    companyId: string,
    quadraId: string | null,
    dto: DefinirHorariosDto,
  ): Promise<ResultadoDefinicao> {
    const dias = [...dto.dias].sort((a, b) => a.diaSemana - b.diaSemana);
    if (new Set(dias.map((d) => d.diaSemana)).size !== 7) {
      throw new UnprocessableEntityException(
        'Envie exatamente um registro para cada dia da semana (0 a 6).',
      );
    }

    for (const dia of dias) {
      if (dia.fechado) continue;
      if (!dia.horaInicio || !dia.horaFim) {
        throw new UnprocessableEntityException(
          `Dia ${dia.diaSemana}: informe horaInicio e horaFim, ou marque como fechado.`,
        );
      }
      // AC-002: o banco também recusa (CHECK), mas devolver 422 com o dia
      // no texto é a diferença entre corrigir o formulário e ligar para o
      // suporte.
      if (dia.horaFim <= dia.horaInicio) {
        throw new UnprocessableEntityException(
          `Dia ${dia.diaSemana}: o fechamento precisa ser depois da abertura.`,
        );
      }
    }

    // Substitui a semana inteira numa transação: estado parcial aqui
    // significaria agenda inconsistente entre dois dias da mesma semana.
    await this.prisma.$transaction(async (tx) => {
      await tx.horarioFuncionamento.deleteMany({
        where: { companyId, quadraId },
      });
      await tx.horarioFuncionamento.createMany({
        data: dias.map((dia) => ({
          companyId,
          quadraId,
          diaSemana: dia.diaSemana,
          fechado: dia.fechado,
          horaInicio: dia.fechado
            ? null
            : parseTimeOnly(dia.horaInicio as string),
          horaFim: dia.fechado ? null : parseTimeOnly(dia.horaFim as string),
        })),
      });
    });

    return this.relatorioDeImpacto(companyId, quadraId);
  }

  /**
   * SPEC-010/REQ-006 — o que ficou fora do novo horário.
   *
   * Não bloqueia e não cancela: devolve a conta e uma amostra para o
   * gerente decidir. Cancelar reserva de aluno em silêncio para manter o
   * banco "consistente" é o tipo de consistência que destrói confiança no
   * produto (INV-011 é invariante de escrita, não de estado).
   *
   * NFR-002: só ocupações **futuras** — o passado não interessa e cresce
   * para sempre.
   */
  private async relatorioDeImpacto(
    companyId: string,
    quadraId: string | null,
  ): Promise<ResultadoDefinicao> {
    const hoje = new Date();
    const hojeUTC = new Date(
      Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate()),
    );

    const [ocupacoes, horarios] = await Promise.all([
      this.prisma.ocupacaoQuadra.findMany({
        where: {
          companyId,
          data: { gte: hojeUTC },
          statusPagamento: { not: 'cancelado' },
          ...(quadraId ? { quadraId } : {}),
        },
        include: {
          quadra: { select: { nome: true } },
          aluno: { include: { usuario: { select: { nome: true } } } },
          origemTurma: { select: { nome: true } },
        },
        orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }],
      }),
      this.prisma.horarioFuncionamento.findMany({ where: { companyId } }),
    ]);

    const afetadas = ocupacoes.filter((ocupacao) => {
      const diaSemana = ocupacao.data.getUTCDay();
      const daQuadra = horarios.find(
        (h) => h.quadraId === ocupacao.quadraId && h.diaSemana === diaSemana,
      );
      const daEmpresa = horarios.find(
        (h) => h.quadraId === null && h.diaSemana === diaSemana,
      );
      const efetivo = daQuadra ?? daEmpresa;
      if (!efetivo) return false;
      const horario: HorarioEfetivo =
        efetivo.fechado || !efetivo.horaInicio || !efetivo.horaFim
          ? { estado: 'fechado' }
          : {
              estado: 'aberto',
              horaInicio: efetivo.horaInicio,
              horaFim: efetivo.horaFim,
            };
      return !this.dentroDoExpediente(
        horario,
        ocupacao.horaInicio,
        ocupacao.horaFim,
      );
    });

    return {
      afetadasCount: afetadas.length,
      // AC-011: amostra com teto. Lista sem limite cresce com a agenda e
      // transforma uma resposta de configuração num dump.
      amostra: afetadas.slice(0, AMOSTRA_MAXIMA).map((o) => ({
        origemTipo: o.origemTipo,
        quadraNome: o.quadra.nome,
        data: formatDateOnly(o.data),
        horaInicio: formatTimeOnly(o.horaInicio),
        horaFim: formatTimeOnly(o.horaFim),
        // AC-019: ocupação de turma não tem `aluno_id` — pedir "o aluno"
        // ali seria nulo ou um join com a turma inteira. Quem responde
        // pela ocupação é a turma.
        responsavel:
          o.origemTipo === 'TURMA'
            ? (o.origemTurma?.nome ?? null)
            : (o.aluno?.usuario.nome ?? null),
      })),
    };
  }

  private async assertQuadraDaEmpresa(companyId: string, quadraId: string) {
    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId },
      select: { id: true },
    });
    if (!quadra) {
      throw new NotFoundException();
    }
  }
}
