import { Injectable, NotFoundException } from '@nestjs/common';
import {
  EvasaoResponseDto,
  FrequenciaDaTurmaResponseDto,
  FrequenciaDoAlunoResponseDto,
} from './dto/frequencia-response.dto';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-015 — os três relatórios de frequência (TASK-001, 002 e 003).
 *
 * **O denominador é a decisão que carrega esta spec inteira**, e são as
 * chamadas em que o aluno consta — não as ocorrências da turma, nem as
 * ocorrências desde a matrícula. As outras duas mentem: a primeira dá 20%
 * para quem matriculou semana passada; a segunda depende de
 * `turma_alunos.createdAt`, que **não é vigência** — remover e recolocar o
 * aluno cria linha nova com data nova.
 *
 * A INV-020 já tinha decidido que a chamada salva é o retrato da turma
 * naquela aula, então as linhas gravadas dizem quem era esperado. Isso só
 * é seguro porque a TASK-000 corrigiu a DEF-002 antes.
 *
 * **AC-015 — no máximo 2 queries por agregação, e nenhuma por aluno.** É o
 * que dita a forma de tudo aqui: uma query traz as ocorrências (com o
 * cabeçalho e a contagem de presenças), outra traz as presenças. O resto é
 * feito em memória, sobre volume que a janela de 90 dias limita.
 */

export const JANELA_PADRAO_DIAS = 30;
export const JANELA_MAXIMA_DIAS = 90;

/** INV-023 — régua de risco do PRODUTO, não da empresa (LIM-005). */
export const REGUA = {
  faltasSeguidas: 3,
  frequenciaPct: 60,
  baseMinima: 4,
  /** AC-014 — piso de confiança, sobre `completas / aconteceram`. */
  pisoDeConfiancaPct: 50,
} as const;

type StatusPresenca = 'presente' | 'ausente' | 'justificado';
type Confianca = 'alta' | 'baixa';

interface Registro {
  quando: number;
  status: StatusPresenca;
}

/** Uma ocorrência, do ponto de vista de quem calcula cobertura. */
interface Ocorrencia {
  id: string;
  data: Date;
  cancelada: boolean;
  temChamada: boolean;
  temPresenca: boolean;
  completa: boolean;
  desconhecida: boolean;
}

export interface Cobertura {
  aconteceram: number;
  lancadas: number;
  completas: number;
  pctCompletas: number | null;
  confianca: Confianca;
  /** AC-016 — o texto existe porque o número sozinho engana. */
  aviso: string | null;
}

@Injectable()
export class FrequenciaService {
  constructor(private readonly prisma: PrismaService) {}

  /** Mesma convenção UTC-truncada do resto do domínio (não há fuso configurável). */
  private hoje(): Date {
    const agora = new Date();
    return new Date(
      Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), agora.getUTCDate()),
    );
  }

  private janela(dias: number) {
    const hoje = this.hoje();
    const desde = new Date(hoje);
    desde.setUTCDate(desde.getUTCDate() - dias);
    return { hoje, desde };
  }

  /**
   * O `select` de ocorrência que os três relatórios usam. `chamadas` é
   * **lista** no Prisma (a FK é composta, `[id, origemTipo]`), então vem
   * como array de zero ou um.
   */
  private static readonly SELECT_OCORRENCIA = {
    id: true,
    data: true,
    statusPagamento: true,
    origemTurmaId: true,
    chamadas: { select: { completude: true } },
    _count: { select: { presencas: true } },
  } as const;

  private normaliza(o: {
    id: string;
    data: Date;
    statusPagamento: string;
    chamadas: { completude: string }[];
    _count: { presencas: number };
  }): Ocorrencia {
    const cab = o.chamadas[0];
    return {
      id: o.id,
      data: o.data,
      cancelada: o.statusPagamento === 'cancelado',
      temChamada: cab !== undefined,
      temPresenca: o._count.presencas > 0,
      completa: cab?.completude === 'completa',
      desconhecida: cab?.completude === 'desconhecida',
    };
  }

  /**
   * AC-005 — cancelada **com** chamada conta normalmente; cancelada **sem**
   * chamada não aparece em lugar nenhum. Uma aula que não aconteceu e da
   * qual ninguém registrou nada não é ausência de ninguém, e contá-la
   * puniria o professor por uma aula que o clube cancelou.
   */
  private aconteceram(ocorrencias: Ocorrencia[]) {
    return ocorrencias.filter((o) => !o.cancelada || o.temChamada);
  }

  /**
   * AC-013 — cobertura em **três números, não um**. "Lançada" não equivale
   * a "confiável": a v2 tratava as duas como a mesma coisa, e era o mesmo
   * defeito que a INV-022 corrigiu, um nível acima.
   *
   * AC-014 — o piso usa `completas / aconteceram`, **não** `lancadas`. O
   * contra-exemplo que derrubou a versão anterior: 10 aulas, todas com
   * chamada parcial de 1 aluno numa turma de 10, davam cobertura 10/10 e
   * liberavam o percentual sobre base furada.
   */
  private cobertura(ocorrencias: Ocorrencia[]): Cobertura {
    const validas = this.aconteceram(ocorrencias);
    const aconteceram = validas.length;
    const lancadas = validas.filter((o) => o.temPresenca).length;
    const completas = validas.filter((o) => o.completa).length;
    const desconhecidas = validas.filter((o) => o.desconhecida).length;

    const pctCompletas =
      aconteceram === 0
        ? null
        : Math.round((completas / aconteceram) * 1000) / 10;
    const confianca: Confianca =
      pctCompletas !== null && pctCompletas >= REGUA.pisoDeConfiancaPct
        ? 'alta'
        : 'baixa';

    // AC-016 — o relatório DIZ, em texto, quando há completude
    // desconhecida. Sem isso, o primeiro mês de uso mostra `completas: 0`,
    // percentual suprimido, e o gestor conclui que ninguém lançou chamada:
    // conclusão errada a partir de dado certo, que é o defeito mais caro
    // de todos.
    let aviso: string | null = null;
    if (desconhecidas > 0) {
      aviso =
        `${desconhecidas} de ${aconteceram} aulas têm completude ` +
        'desconhecida (chamadas anteriores à correção de completude). ' +
        'Elas contam como lançadas, mas não como completas, e por isso ' +
        'a confiança do período pode ficar baixa sem que ninguém tenha ' +
        'deixado de lançar chamada.';
    } else if (aconteceram > 0 && confianca === 'baixa') {
      aviso =
        `Só ${completas} de ${aconteceram} aulas têm chamada completa. ` +
        'Os percentuais de frequência ficam suprimidos até a cobertura ' +
        `passar de ${REGUA.pisoDeConfiancaPct}%.`;
    }

    return { aconteceram, lancadas, completas, pctCompletas, confianca, aviso };
  }

  /**
   * AC-006 — faltas seguidas, da aula mais recente para trás, parando no
   * primeiro `presente`.
   *
   * **Aula sem chamada não interrompe a sequência**, e isso é decisão, não
   * consequência: a sequência é de comparecimento, e chamada não lançada
   * não é prova de que ele foi.
   */
  private sequenciaDeFaltas(registros: Registro[]) {
    const ordenados = [...registros].sort((a, b) => b.quando - a.quando);
    let faltasSeguidas = 0;
    const composicao = { ausente: 0, justificado: 0 };
    for (const r of ordenados) {
      if (r.status === 'presente') break;
      faltasSeguidas += 1;
      composicao[r.status === 'ausente' ? 'ausente' : 'justificado'] += 1;
    }
    return { faltasSeguidas, composicao };
  }

  /**
   * AC-003 — sem registro é `null`, nunca `0%`: zero por cento afirma algo
   * sobre o comportamento do aluno, e a verdade é que não há dado.
   *
   * AC-014 — com confiança baixa também é `null`. O percentual existiria,
   * mas sobre base furada; publicá-lo é pior que suprimi-lo.
   */
  private agrega(registros: Registro[], confianca: Confianca) {
    const conta = (s: StatusPresenca) =>
      registros.filter((r) => r.status === s).length;
    const presente = conta('presente');
    const base = registros.length;
    const { faltasSeguidas, composicao } = this.sequenciaDeFaltas(registros);
    const bruto = base === 0 ? null : Math.round((presente / base) * 1000) / 10;
    return {
      frequenciaPct: confianca === 'baixa' ? null : bruto,
      confianca,
      base,
      presente,
      ausente: conta('ausente'),
      justificado: conta('justificado'),
      faltasSeguidas,
      faltasSeguidasComposicao: composicao,
    };
  }

  /**
   * INV-023 — a régua. Devolve o motivo, ou `null` se não é risco.
   *
   * **A régua de faltas seguidas continua valendo com confiança baixa**
   * (AC-014): três não-comparecimentos registrados são três,
   * independentemente de quantas aulas deixaram de ser lançadas. A de
   * percentual, não — ela depende da base.
   */
  private motivoDeRisco(
    agregado: {
      frequenciaPct: number | null;
      base: number;
      faltasSeguidas: number;
    },
    confianca: Confianca,
    alunoAtivo: boolean,
    vinculo: string,
  ): 'faltas_seguidas' | 'frequencia_baixa' | null {
    // AC-011 — quem já foi desligado, ou nunca foi reconhecido, não é
    // risco de evasão: é outra coisa, e poluir o alerta com ele faz o
    // gestor parar de olhar o alerta.
    if (!alunoAtivo || vinculo !== 'aprovado') return null;
    if (agregado.faltasSeguidas >= REGUA.faltasSeguidas) {
      return 'faltas_seguidas';
    }
    if (
      confianca === 'alta' &&
      agregado.base >= REGUA.baseMinima &&
      agregado.frequenciaPct !== null &&
      agregado.frequenciaPct < REGUA.frequenciaPct
    ) {
      return 'frequencia_baixa';
    }
    return null;
  }

  // ================================================================
  // TASK-001 — relatório da turma
  // ================================================================
  async daTurma(
    companyId: string,
    turmaId: string,
    dias: number,
  ): Promise<FrequenciaDaTurmaResponseDto> {
    const { hoje, desde } = this.janela(dias);

    // Query 1: a turma (que é o escopo de empresa, AC-009), as ocorrências
    // da janela com cabeçalho e contagem de presenças, e a matrícula de
    // hoje — com nome, status e vínculo, para que o aluno sem registro
    // nenhum (AC-003) não exija uma terceira query.
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: {
        id: true,
        nome: true,
        alunos: {
          select: {
            alunoId: true,
            aluno: {
              select: {
                status: true,
                vinculo: true,
                usuario: { select: { nome: true } },
              },
            },
          },
        },
        ocupacoes: {
          where: { data: { gte: desde, lte: hoje }, origemTipo: 'TURMA' },
          select: FrequenciaService.SELECT_OCORRENCIA,
          orderBy: { data: 'desc' },
        },
      },
    });
    // AC-009 — turma de outra empresa é 404, não 403: 403 confirmaria que
    // ela existe.
    if (!turma) {
      throw new NotFoundException();
    }

    const ocorrencias = this.aconteceram(
      turma.ocupacoes.map((o) => this.normaliza(o)),
    );
    const cobertura = this.cobertura(
      turma.ocupacoes.map((o) => this.normaliza(o)),
    );
    const dataDaOcorrencia = new Map(
      ocorrencias.map((o) => [o.id, o.data.getTime()]),
    );

    // Query 2: as presenças dessas ocorrências.
    const presencas = ocorrencias.length
      ? await this.prisma.presenca.findMany({
          where: { ocupacaoId: { in: ocorrencias.map((o) => o.id) } },
          select: {
            alunoId: true,
            ocupacaoId: true,
            status: true,
            aluno: {
              select: {
                status: true,
                vinculo: true,
                usuario: { select: { nome: true } },
              },
            },
          },
        })
      : [];

    const naTurmaHoje = new Set(turma.alunos.map((a) => a.alunoId));

    // AC-004 — quem saiu da turma mas tem registro na janela continua
    // aparecendo. Por isso o agrupamento parte das PRESENÇAS, e não da
    // matrícula de hoje: a matrícula só decide o sinalizador.
    const porAluno = new Map<
      string,
      {
        nome: string;
        alunoAtivo: boolean;
        vinculo: string;
        registros: Registro[];
      }
    >();
    for (const p of presencas) {
      let linha = porAluno.get(p.alunoId);
      if (!linha) {
        linha = {
          nome: p.aluno.usuario.nome,
          alunoAtivo: p.aluno.status === 'ativo',
          vinculo: p.aluno.vinculo,
          registros: [],
        };
        porAluno.set(p.alunoId, linha);
      }
      linha.registros.push({
        quando: dataDaOcorrencia.get(p.ocupacaoId) ?? 0,
        status: p.status,
      });
    }
    for (const m of turma.alunos) {
      if (porAluno.has(m.alunoId)) continue;
      porAluno.set(m.alunoId, {
        nome: m.aluno.usuario.nome,
        alunoAtivo: m.aluno.status === 'ativo',
        vinculo: m.aluno.vinculo,
        registros: [],
      });
    }

    const alunos = [...porAluno.entries()]
      .map(([alunoId, d]) => ({
        alunoId,
        nome: d.nome,
        naTurmaHoje: naTurmaHoje.has(alunoId),
        // AC-011 — os dois sinalizadores viajam no payload.
        alunoAtivo: d.alunoAtivo,
        vinculo: d.vinculo,
        ...this.agrega(d.registros, cobertura.confianca),
      }))
      .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    return {
      turmaId: turma.id,
      turmaNome: turma.nome,
      janelaDias: dias,
      cobertura,
      alunos,
    };
  }

  // ================================================================
  // TASK-002 — relatório do aluno
  // ================================================================
  /**
   * AC-007 — **o agregado nunca sai sozinho.** Um número único somando
   * turmas esconde o caso que interessa: o aluno que vai bem numa turma e
   * sumiu da outra aparece "mediano" e ninguém olha.
   */
  async doAluno(
    companyId: string,
    alunoId: string,
    dias: number,
  ): Promise<FrequenciaDoAlunoResponseDto> {
    const { hoje, desde } = this.janela(dias);

    // Query 1: o aluno (escopo de empresa, AC-009) e as turmas de hoje.
    const aluno = await this.prisma.aluno.findFirst({
      where: { id: alunoId, companyId },
      select: {
        id: true,
        status: true,
        vinculo: true,
        usuario: { select: { nome: true } },
        turmaAlunos: {
          select: { turma: { select: { id: true, nome: true } } },
        },
      },
    });
    if (!aluno) {
      throw new NotFoundException();
    }

    const turmasHoje = new Map(
      aluno.turmaAlunos.map((t) => [t.turma.id, t.turma.nome]),
    );

    // Query 2: as ocorrências que interessam a ele — as das turmas de hoje
    // **e** aquelas em que ele tem registro, mesmo de turma que já deixou
    // (AC-004). O `OR` é o que permite fazer isso sem uma terceira query:
    // sem ele, seria preciso descobrir as turmas pelos registros primeiro.
    //
    // As presenças vêm filtradas ao próprio aluno; a contagem e o
    // cabeçalho vêm da ocorrência inteira, que é o que a cobertura exige.
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        data: { gte: desde, lte: hoje },
        OR: [
          { origemTurmaId: { in: [...turmasHoje.keys()] } },
          { presencas: { some: { alunoId } } },
        ],
      },
      select: {
        ...FrequenciaService.SELECT_OCORRENCIA,
        origemTurma: { select: { nome: true } },
        presencas: { where: { alunoId }, select: { status: true } },
      },
      orderBy: { data: 'desc' },
    });

    const porTurma = new Map<
      string,
      { nome: string | null; ocorrencias: Ocorrencia[]; registros: Registro[] }
    >();
    const ocorrenciasDoAluno: {
      turmaId: string;
      turmaNome: string | null;
      ocupacaoId: string;
      data: string;
      cancelada: boolean;
      status: StatusPresenca;
    }[] = [];

    for (const o of ocupacoes) {
      const turmaId = o.origemTurmaId as string;
      const nome = turmasHoje.get(turmaId) ?? o.origemTurma?.nome ?? null;
      let grupo = porTurma.get(turmaId);
      if (!grupo) {
        grupo = { nome, ocorrencias: [], registros: [] };
        porTurma.set(turmaId, grupo);
      }
      const norm = this.normaliza(o);
      grupo.ocorrencias.push(norm);
      // AC-005 já está garantida aqui: cancelada sem chamada não tem
      // presença (FK `presencas_chamada_fkey`, INV-027), e `aconteceram`
      // a descarta da cobertura.
      for (const p of o.presencas) {
        grupo.registros.push({
          quando: o.data.getTime(),
          status: p.status,
        });
        ocorrenciasDoAluno.push({
          turmaId,
          turmaNome: nome,
          ocupacaoId: o.id,
          data: o.data.toISOString().slice(0, 10),
          cancelada: norm.cancelada,
          status: p.status,
        });
      }
    }
    for (const [turmaId, nome] of turmasHoje) {
      if (!porTurma.has(turmaId)) {
        porTurma.set(turmaId, { nome, ocorrencias: [], registros: [] });
      }
    }

    const quebra = [...porTurma.entries()]
      .map(([turmaId, g]) => {
        // A cobertura é POR TURMA: cada uma tem a sua grade e o seu
        // professor, e misturá-las esconderia a turma que ninguém lança.
        const cob = this.cobertura(g.ocorrencias);
        return {
          turmaId,
          turmaNome: g.nome,
          naTurmaHoje: turmasHoje.has(turmaId),
          cobertura: cob,
          ...this.agrega(g.registros, cob.confianca),
        };
      })
      .sort((a, b) =>
        (a.turmaNome ?? '').localeCompare(b.turmaNome ?? '', 'pt-BR'),
      );

    // O agregado soma as turmas, e a confiança dele é a pior delas: se uma
    // turma tem cobertura furada, o número somado herda o furo.
    const confiancaGeral: Confianca = quebra.some(
      (q) => q.cobertura.confianca === 'baixa',
    )
      ? 'baixa'
      : 'alta';
    const todos = [...porTurma.values()].flatMap((g) => g.registros);

    return {
      alunoId: aluno.id,
      nome: aluno.usuario.nome,
      alunoAtivo: aluno.status === 'ativo',
      vinculo: aluno.vinculo,
      janelaDias: dias,
      // Sai SEMPRE acompanhado de `porTurma` (AC-007) — quem consumir um
      // sem o outro está lendo metade.
      agregado: this.agrega(todos, confiancaGeral),
      porTurma: quebra,
      // Da mais recente para trás. A query já pede `orderBy` — ordenar de
      // novo aqui é de propósito: a ordem é parte do contrato do payload,
      // e deixá-la depender do plano da query é o tipo de garantia
      // implícita que já custou caro nesta spec.
      ocorrencias: ocorrenciasDoAluno.sort((a, b) =>
        a.data < b.data ? 1 : a.data > b.data ? -1 : 0,
      ),
    };
  }

  // ================================================================
  // TASK-003 — lista de evasão (dashboard)
  // ================================================================
  /**
   * A rota mais cara e a mais aberta da spec. AC-015 vale aqui como nas
   * outras: **2 queries para a empresa inteira**, e nenhuma por aluno.
   */
  async evasao(companyId: string, dias: number): Promise<EvasaoResponseDto> {
    const { hoje, desde } = this.janela(dias);

    // Query 1: todas as ocorrências de turma da empresa na janela.
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        data: { gte: desde, lte: hoje },
      },
      select: {
        ...FrequenciaService.SELECT_OCORRENCIA,
        origemTurma: { select: { nome: true } },
      },
    });

    const porTurma = new Map<
      string,
      { nome: string | null; ocorrencias: Ocorrencia[] }
    >();
    const dataDaOcorrencia = new Map<string, number>();
    const turmaDaOcorrencia = new Map<string, string>();
    for (const o of ocupacoes) {
      const turmaId = o.origemTurmaId as string;
      let g = porTurma.get(turmaId);
      if (!g) {
        g = { nome: o.origemTurma?.nome ?? null, ocorrencias: [] };
        porTurma.set(turmaId, g);
      }
      const norm = this.normaliza(o);
      g.ocorrencias.push(norm);
      if (!norm.cancelada || norm.temChamada) {
        dataDaOcorrencia.set(o.id, o.data.getTime());
        turmaDaOcorrencia.set(o.id, turmaId);
      }
    }

    const coberturaDaTurma = new Map(
      [...porTurma.entries()].map(([id, g]) => [
        id,
        this.cobertura(g.ocorrencias),
      ]),
    );

    // Query 2: as presenças de todas elas, com o aluno.
    const ids = [...dataDaOcorrencia.keys()];
    const presencas = ids.length
      ? await this.prisma.presenca.findMany({
          where: { ocupacaoId: { in: ids } },
          select: {
            alunoId: true,
            ocupacaoId: true,
            status: true,
            aluno: {
              select: {
                status: true,
                vinculo: true,
                usuario: { select: { nome: true } },
              },
            },
          },
        })
      : [];

    // Agrupado por (aluno, turma): a régua é por turma, não por aluno. Um
    // aluno pode estar em risco numa e bem em outra, e o gestor precisa
    // saber em qual — por isso `turmaId` é obrigatório no item (AC-012).
    const chaves = new Map<
      string,
      {
        alunoId: string;
        nome: string;
        turmaId: string;
        alunoAtivo: boolean;
        vinculo: string;
        registros: Registro[];
      }
    >();
    for (const p of presencas) {
      const turmaId = turmaDaOcorrencia.get(p.ocupacaoId);
      if (!turmaId) continue;
      const chave = `${p.alunoId}:${turmaId}`;
      let linha = chaves.get(chave);
      if (!linha) {
        linha = {
          alunoId: p.alunoId,
          nome: p.aluno.usuario.nome,
          turmaId,
          alunoAtivo: p.aluno.status === 'ativo',
          vinculo: p.aluno.vinculo,
          registros: [],
        };
        chaves.set(chave, linha);
      }
      linha.registros.push({
        quando: dataDaOcorrencia.get(p.ocupacaoId) ?? 0,
        status: p.status,
      });
    }

    const emRisco = [...chaves.values()]
      .map((linha) => {
        const cob = coberturaDaTurma.get(linha.turmaId) ?? this.cobertura([]);
        const agregado = this.agrega(linha.registros, cob.confianca);
        const motivo = this.motivoDeRisco(
          { ...agregado, frequenciaPct: agregado.frequenciaPct },
          cob.confianca,
          linha.alunoAtivo,
          linha.vinculo,
        );
        return { linha, agregado, cob, motivo };
      })
      .filter((x) => x.motivo !== null)
      .map((x) => ({
        alunoId: x.linha.alunoId,
        nome: x.linha.nome,
        turmaId: x.linha.turmaId,
        turmaNome: porTurma.get(x.linha.turmaId)?.nome ?? null,
        // AC-012 — o motivo é o que o gestor lê primeiro.
        motivo: x.motivo as 'faltas_seguidas' | 'frequencia_baixa',
        frequenciaPct: x.agregado.frequenciaPct,
        base: x.agregado.base,
        faltasSeguidas: x.agregado.faltasSeguidas,
        // A composição existe para a UI não transformar o alerta em
        // verdade absoluta: "5 seguidas: 3 ausências, 2 justificadas" é
        // outra conversa que "5 faltas".
        faltasSeguidasComposicao: x.agregado.faltasSeguidasComposicao,
        confianca: x.cob.confianca,
      }))
      // AC-008 — faltas seguidas desc, depois frequência asc. O desempate
      // por nome existe só para a ordem ser estável entre chamadas.
      .sort(
        (a, b) =>
          b.faltasSeguidas - a.faltasSeguidas ||
          (a.frequenciaPct ?? 101) - (b.frequenciaPct ?? 101) ||
          a.nome.localeCompare(b.nome, 'pt-BR'),
      );

    // AC-008 — empresa sem ninguém em risco devolve a forma vazia, não 404
    // nem 204: o dashboard sempre desenha o cartão.
    return { total: emRisco.length, janelaDias: dias, alunos: emRisco };
  }
}
