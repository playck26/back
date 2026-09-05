import { Injectable, NotFoundException } from '@nestjs/common';
import {
  DiaComItensResponseDto,
  DiaDaAgendaResponseDto,
  ItemDaAgendaResponseDto,
} from './dto/booking-response.dto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatDateOnly,
  formatTimeOnly,
  parseDateOnly,
} from './date-time.util';
import {
  HorarioFuncionamentoService,
  type LinhaHorario,
} from './horario-funcionamento.service';

/** SPEC-021/TASK-005 — a forma canonica vive no DTO. Ver `booking-response.dto.ts`. */
export type DiaDaAgenda = DiaDaAgendaResponseDto;

/** SPEC-021/TASK-005 — idem. */
export type ItemDoDia = ItemDaAgendaResponseDto;

/** SPEC-034/CON-034.1 — a forma canônica vive no DTO. */
export type DiaComItens = DiaComItensResponseDto;

/**
 * SPEC-012 (MOD-005) — agenda do gestor.
 *
 * Leitura agregada, sem tabela própria: mesmo papel de MOD-007
 * (`TARGET_ARCHITECTURE.md`, seção de ownership). **Não cria nenhum
 * endpoint de escrita** — cancelar e marcar pago já existem, com suas
 * regras de autorização e as transições corrigidas em SPEC-012:TASK-000.
 */
/**
 * O nome de quem provocou um tipo de evento numa ocupação.
 *
 * `qual` decide a ponta: `criada` só acontece uma vez, mas `cancelada` pode
 * repetir (cancelar → reativar → cancelar, SPEC-035), e aí o que interessa é
 * o último. Os eventos chegam ordenados por `criado_em` ascendente.
 */
function autorDo(
  eventos: { tipo: string; acao: { autor: { nome: string } } }[] | undefined,
  tipo: string,
  qual: 'primeiro' | 'ultimo' = 'primeiro',
): string | null {
  // `undefined` e lista vazia significam a mesma coisa aqui — **sem autor
  // registrado** —, e as duas acontecem de verdade: a lista vazia é a linha
  // anterior à spec (LIM-032a), e o `undefined` é qualquer chamador que não
  // pediu o `include`. Devolver `null` nos dois casos é o que impede a tela
  // de mostrar "criada por —" no lugar de "sem histórico".
  const doTipo = (eventos ?? []).filter((e) => e.tipo === tipo);
  const alvo = qual === 'ultimo' ? doTipo.at(-1) : doTipo.at(0);
  return alvo?.acao.autor.nome ?? null;
}

/**
 * SPEC-034 — o `include` do item, em UM lugar só.
 *
 * Era literal dentro de `detalheDoDia`. A rota da semana precisa exatamente
 * do mesmo, e duplicá-lo faria o AC-001 ("os itens do dia batem campo a campo
 * com `GET /agenda/:data`") virar promessa sobre duas consultas que alguém
 * teria de lembrar de manter iguais.
 *
 * NFR-002: `include` explícito resolve os nomes de uma vez — sem N+1 para
 * descobrir quem reservou.
 *
 * **Fica no módulo, não na classe**, para que o tipo do payload possa ser
 * derivado dele — é isso que faz `mapearItem` recusar em compilação um
 * `include` que perdeu um campo.
 */
const INCLUDE_DO_ITEM = {
  quadra: { select: { nome: true } },
  aluno: { include: { usuario: { select: { nome: true } } } },
  origemTurma: { select: { nome: true } },
  // SPEC-032/AC-009 — o autor entra no MESMO `include`, sem N+1. É a razão do
  // NFR-002 desta rota: descobrir quem criou cada item com uma consulta por
  // item transformaria um dia cheio em dezenas de idas.
  eventos: {
    select: {
      tipo: true,
      criadoEm: true,
      acao: { select: { autor: { select: { nome: true } } } },
    },
    orderBy: { criadoEm: 'asc' },
  },
} satisfies Prisma.OcupacaoQuadraInclude;

type OcupacaoDoItem = Prisma.OcupacaoQuadraGetPayload<{
  include: typeof INCLUDE_DO_ITEM;
}>;

@Injectable()
export class AgendaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly horarios: HorarioFuncionamentoService,
  ) {}

  /**
   * Resumo do mês: por dia, quantas ocupações e quantas pendentes.
   *
   * NFR-001 — **três consultas, independentemente do tamanho do mês ou do
   * número de quadras**: a agregação por dia, as quadras ativas e as
   * regras semanais. A agregação acontece no banco (`groupBy`), não em
   * memória sobre a lista de ocupações.
   */
  async resumoDoMes(companyId: string, mes: string): Promise<DiaDaAgenda[]> {
    const [ano, mesNum] = mes.split('-').map(Number);
    const inicio = new Date(Date.UTC(ano, mesNum - 1, 1));
    const fim = new Date(Date.UTC(ano, mesNum, 0));

    const [grupos, quadrasAtivas, linhas] = await Promise.all([
      this.prisma.ocupacaoQuadra.groupBy({
        by: ['data', 'statusPagamento'],
        where: {
          companyId,
          data: { gte: inicio, lte: fim },
          // Cancelada não ocupa a quadra (a constraint EXCLUDE a ignora),
          // então não deve aparecer como compromisso na agenda.
          statusPagamento: { not: 'cancelado' },
          // Quadra inativa não é agenda de ninguém.
          quadra: { status: 'ativa' },
        },
        _count: { _all: true },
      }),
      this.prisma.quadra.findMany({
        where: { companyId, status: 'ativa' },
        select: { id: true },
      }),
      this.prisma.horarioFuncionamento.findMany({
        where: { companyId },
        select: {
          quadraId: true,
          diaSemana: true,
          fechado: true,
          horaInicio: true,
          horaFim: true,
        },
      }),
    ]);

    const porDia = new Map<string, { total: number; pendentes: number }>();
    for (const g of grupos) {
      const chave = formatDateOnly(g.data);
      const atual = porDia.get(chave) ?? { total: 0, pendentes: 0 };
      atual.total += g._count._all;
      if (g.statusPagamento === 'pendente_pagamento') {
        atual.pendentes += g._count._all;
      }
      porDia.set(chave, atual);
    }

    const dias: DiaDaAgenda[] = [];
    for (
      const dia = new Date(inicio);
      dia <= fim;
      dia.setUTCDate(dia.getUTCDate() + 1)
    ) {
      const chave = formatDateOnly(dia);
      const contagem = porDia.get(chave) ?? { total: 0, pendentes: 0 };
      dias.push({
        data: chave,
        total: contagem.total,
        pendentes: contagem.pendentes,
        fechado: this.tudoFechado(quadrasAtivas, linhas, dia.getUTCDay()),
      });
    }
    return dias;
  }

  /**
   * SPEC-032/CON-016 — o histórico completo de uma ocupação.
   *
   * Separado do detalhe do dia de propósito: aquele traz **quem criou e quem
   * cancelou** porque é o que cabe numa lista; este traz a linha do tempo
   * inteira, e é consulta sob demanda de quem foi investigar um caso.
   */
  async eventosDaOcupacao(companyId: string, ocupacaoId: string) {
    const existe = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id: ocupacaoId, companyId },
      select: { id: true },
    });
    // 404 e não lista vazia: "não existe" e "existe e não tem histórico" são
    // respostas diferentes, e a segunda é o estado normal das linhas
    // anteriores à spec (LIM-032a).
    if (!existe) throw new NotFoundException();

    const eventos = await this.prisma.eventoDeOcupacao.findMany({
      where: { companyId, ocupacaoId },
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

    return eventos.map((e) => ({
      tipo: e.tipo,
      em: e.criadoEm.toISOString(),
      acao: e.acao.tipo,
      motivo: e.acao.motivo,
      autor: { id: e.acao.autor.id, nome: e.acao.autor.nome },
    }));
  }

  /** Detalhe de um dia: o que aparece no pop-up (REQ-002). */
  async detalheDoDia(companyId: string, data: string): Promise<ItemDoDia[]> {
    const dataDate = parseDateOnly(data);

    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        data: dataDate,
        statusPagamento: { not: 'cancelado' },
        quadra: { status: 'ativa' },
      },
      include: INCLUDE_DO_ITEM,
      orderBy: [{ horaInicio: 'asc' }, { quadraId: 'asc' }],
    });

    return ocupacoes.map((o) => this.mapearItem(o));
  }

  /**
   * SPEC-034/REQ-001 — os sete dias, com o detalhe de cada um.
   *
   * **NFR-001: UMA consulta de ocupações para a semana inteira.** Sete
   * chamadas a `detalheDoDia` produziriam resposta idêntica e passariam no
   * AC-001 sem que ninguém percebesse — foi exatamente esse o achado da 2ª
   * validação cruzada, e é por isso que o AC ganhou um espião que **conta**
   * as chamadas em vez de só comparar o resultado.
   *
   * As outras duas consultas (quadras ativas e regras semanais) são as mesmas
   * do `resumoDoMes` e não escalam com o tamanho da semana. O NFR diz "uma
   * consulta de **ocupações**", não "uma consulta", de propósito.
   *
   * **D10 — a semana começa no dia que o cliente mandar.** O servidor não
   * adivinha convenção de semana; o Admin já calcula o domingo dele por
   * `getUTCDay()` (`agenda-view.tsx:60`).
   */
  async semanaDe(companyId: string, inicio: string): Promise<DiaComItens[]> {
    const primeiro = parseDateOnly(inicio);
    const ultimo = new Date(primeiro);
    ultimo.setUTCDate(ultimo.getUTCDate() + 6);

    const [ocupacoes, quadrasAtivas, linhas] = await Promise.all([
      this.prisma.ocupacaoQuadra.findMany({
        where: {
          companyId,
          data: { gte: primeiro, lte: ultimo },
          // Mesmos dois filtros do dia e do mês: cancelada não ocupa a quadra
          // (a EXCLUDE a ignora) e quadra inativa não é agenda de ninguém.
          statusPagamento: { not: 'cancelado' },
          quadra: { status: 'ativa' },
        },
        include: INCLUDE_DO_ITEM,
        orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }, { quadraId: 'asc' }],
      }),
      this.prisma.quadra.findMany({
        where: { companyId, status: 'ativa' },
        select: { id: true },
      }),
      this.prisma.horarioFuncionamento.findMany({
        where: { companyId },
        select: {
          quadraId: true,
          diaSemana: true,
          fechado: true,
          horaInicio: true,
          horaFim: true,
        },
      }),
    ]);

    const porDia = new Map<string, ItemDoDia[]>();
    for (const o of ocupacoes) {
      const chave = formatDateOnly(o.data);
      const lista = porDia.get(chave);
      if (lista) lista.push(this.mapearItem(o));
      else porDia.set(chave, [this.mapearItem(o)]);
    }

    // **Exatamente sete, sempre** (REQ-001): dia sem ocupação entra com
    // `itens: []`. Devolver só os dias com movimento faria a grade da semana
    // ter de adivinhar os buracos, e o `fechado` do dia vazio é informação —
    // é a mesma decisão da SPEC-010 que o mês já toma.
    const dias: DiaComItens[] = [];
    for (let i = 0; i < 7; i += 1) {
      const dia = new Date(primeiro);
      dia.setUTCDate(dia.getUTCDate() + i);
      const chave = formatDateOnly(dia);
      dias.push({
        data: chave,
        fechado: this.tudoFechado(quadrasAtivas, linhas, dia.getUTCDay()),
        itens: porDia.get(chave) ?? [],
      });
    }
    return dias;
  }

  /** SPEC-034 — o mapeamento do item, também em um lugar só. Ver acima. */
  private mapearItem(o: OcupacaoDoItem): ItemDoDia {
    return {
      id: o.id,
      quadraNome: o.quadra.nome,
      horaInicio: formatTimeOnly(o.horaInicio),
      horaFim: formatTimeOnly(o.horaFim),
      origemTipo: o.origemTipo,
      // AC-004: ocupação de turma não tem `aluno_id` — quem responde por
      // ela é a turma. Mesma razão do AC-019 de SPEC-010.
      responsavel:
        o.origemTipo === 'TURMA'
          ? (o.origemTurma?.nome ?? null)
          : (o.aluno?.usuario.nome ?? null),
      statusPagamento: o.statusPagamento,
      // O gestor decide onde cobrar olhando a agenda — o valor precisa
      // estar ali, e precisa ser o **congelado**, não o recalculado.
      valor: o.valor != null ? Number(o.valor) : null,
      // SPEC-032/AC-009. **Nulo é o estado normal das linhas antigas**
      // (LIM-032a): elas nasceram antes da spec e não têm evento. A tela
      // mostra "sem histórico registrado", nunca "criada por —".
      criadaPor: autorDo(o.eventos, 'criada'),
      // O ÚLTIMO cancelamento, não o primeiro: com a reativação da SPEC-035
      // uma ocupação pode ser cancelada mais de uma vez, e quem pergunta
      // "quem cancelou isto?" quer saber do estado atual.
      canceladaPor: autorDo(o.eventos, 'cancelada', 'ultimo'),
    };
  }

  /**
   * AC-010 — resolvido **em memória**, sobre listas carregadas uma vez.
   *
   * Chamar `HorarioFuncionamentoService.resolver` por quadra e por dia
   * seriam até `31 × quadras` consultas (248 com 8 quadras) para dizer
   * quais dias do mês estão fechados. É o mesmo N+1 que a validação
   * cruzada da SPEC-010 baniu no KPI do dashboard, e que a validação da
   * SPEC-012 pegou tentando voltar por outra spec.
   */
  private tudoFechado(
    quadras: { id: string }[],
    linhas: LinhaHorario[],
    diaSemana: number,
  ): boolean {
    if (quadras.length === 0) {
      // Sem quadra ativa não há o que abrir — mas "fechado" aqui
      // descreveria mal a situação: a empresa não tem quadra, não está de
      // portas fechadas. A tela trata o caso vazio antes de chegar aqui.
      return false;
    }
    return quadras.every(
      (q) =>
        this.horarios.resolverDeLinhas(linhas, q.id, diaSemana).estado ===
        'fechado',
    );
  }
}
