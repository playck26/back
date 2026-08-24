import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-015 — o relatório de frequência da turma (TASK-001).
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
 * é seguro porque a TASK-000 corrigiu a DEF-002 antes: sem "chamada salva
 * é completa", meia chamada viraria meia frequência e ninguém saberia.
 */

export const JANELA_PADRAO_DIAS = 30;
export const JANELA_MAXIMA_DIAS = 90;

type StatusPresenca = 'presente' | 'ausente' | 'justificado';

export interface LinhaDeAluno {
  alunoId: string;
  nome: string;
  frequenciaPct: number | null;
  base: number;
  presente: number;
  ausente: number;
  justificado: number;
  faltasSeguidas: number;
  faltasSeguidasComposicao: { ausente: number; justificado: number };
  naTurmaHoje: boolean;
  alunoAtivo: boolean;
  vinculo: string;
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

  async daTurma(companyId: string, turmaId: string, dias: number) {
    const hoje = this.hoje();
    const desde = new Date(hoje);
    desde.setUTCDate(desde.getUTCDate() - dias);

    // NFR: no máximo 2 queries. A primeira traz a turma (que é o escopo de
    // empresa, AC-009), as ocorrências da janela e a matrícula de hoje.
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
          select: { id: true, data: true, statusPagamento: true },
          orderBy: { data: 'desc' },
        },
      },
    });
    // AC-009 — turma de outra empresa é 404, não 403: 403 confirmaria que
    // ela existe.
    if (!turma) {
      throw new NotFoundException();
    }

    // A segunda query parte das CHAMADAS, não das presenças. Parece
    // indireto e não é: `ocupacoes_quadra` não tem relação `chamada` no
    // Prisma — a FK é composta e escrita à mão na migration (INV-027) —,
    // então buscar "quais aulas têm chamada" e "quais presenças existem"
    // separadamente custaria uma query a mais que o NFR permite. Entrando
    // pelo cabeçalho, as duas respostas vêm juntas e exatas.
    //
    // Exatas importa: derivar "tem chamada" de "tem presença" erraria a
    // turma que ficou sem aluno, e cobertura é o número que diz ao gestor
    // se ele pode confiar nos percentuais.
    const cabecalhos = turma.ocupacoes.length
      ? await this.prisma.chamada.findMany({
          where: { ocupacaoId: { in: turma.ocupacoes.map((o) => o.id) } },
          select: {
            ocupacaoId: true,
            presencas: {
              select: {
                alunoId: true,
                status: true,
                aluno: {
                  select: {
                    status: true,
                    vinculo: true,
                    usuario: { select: { nome: true } },
                  },
                },
              },
            },
          },
        })
      : [];
    const temChamada = new Set(cabecalhos.map((c) => c.ocupacaoId));

    // AC-005 — cancelada **com** chamada conta normalmente; cancelada
    // **sem** chamada não aparece em lugar nenhum. Uma aula que não
    // aconteceu e da qual ninguém registrou nada não é ausência de
    // ninguém, e contá-la no denominador da cobertura puniria o professor
    // por uma aula que o clube cancelou.
    const ocorrencias = turma.ocupacoes.filter(
      (o) => o.statusPagamento !== 'cancelado' || temChamada.has(o.id),
    );
    const comChamada = ocorrencias.filter((o) => temChamada.has(o.id));

    // Mapa de data por ocorrência: as faltas seguidas são contadas pela
    // data da AULA (AC-006), não pela ordem de gravação — o professor pode
    // lançar a chamada de terça antes da de segunda.
    const dataDaOcorrencia = new Map(
      ocorrencias.map((o) => [o.id, o.data.getTime()]),
    );

    // Só as presenças de ocorrências que sobreviveram ao filtro da AC-005.
    const presencas = cabecalhos
      .filter((c) => dataDaOcorrencia.has(c.ocupacaoId))
      .flatMap((c) =>
        c.presencas.map((pr) => ({ ...pr, ocupacaoId: c.ocupacaoId })),
      );

    const naTurmaHoje = new Set(turma.alunos.map((a) => a.alunoId));

    // AC-004 — quem saiu da turma mas tem registro na janela continua
    // aparecendo, marcado. Por isso o agrupamento parte das PRESENÇAS, e
    // não da matrícula de hoje: a matrícula só decide o sinalizador.
    const porAluno = new Map<
      string,
      {
        nome: string;
        alunoAtivo: boolean;
        vinculo: string;
        registros: { quando: number; status: StatusPresenca }[];
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

    // AC-003 — aluno matriculado hoje e sem nenhum registro na janela entra
    // com `frequenciaPct = null`, nunca `0%`. Zero por cento é uma
    // afirmação sobre o comportamento dele; a verdade é que não há dado.
    // Ele não vem das presenças (não tem nenhuma), então vem da matrícula
    // — que a primeira query já trouxe com nome, status e vínculo, de
    // propósito: buscar esses alunos numa terceira query seria estourar o
    // NFR de 2 queries por um caso que a query 1 já podia cobrir.
    for (const m of turma.alunos) {
      if (porAluno.has(m.alunoId)) continue;
      porAluno.set(m.alunoId, {
        nome: m.aluno.usuario.nome,
        alunoAtivo: m.aluno.status === 'ativo',
        vinculo: m.aluno.vinculo,
        registros: [],
      });
    }

    const alunos: LinhaDeAluno[] = [...porAluno.entries()].map(
      ([alunoId, dados]) => {
        const presente = dados.registros.filter(
          (r) => r.status === 'presente',
        ).length;
        const ausente = dados.registros.filter(
          (r) => r.status === 'ausente',
        ).length;
        const justificado = dados.registros.filter(
          (r) => r.status === 'justificado',
        ).length;
        const base = dados.registros.length;

        // AC-006 — da mais recente para trás, parando no primeiro
        // `presente`. Aula SEM chamada não interrompe: a sequência é de
        // comparecimento, e chamada não lançada não é prova de que ele foi.
        // Como só entram aqui as ocorrências com chamada, a regra sai de
        // graça — mas é ela que decide, não a ausência de dado.
        const ordenados = [...dados.registros].sort(
          (a, b) => b.quando - a.quando,
        );
        let faltasSeguidas = 0;
        const composicao = { ausente: 0, justificado: 0 };
        for (const r of ordenados) {
          if (r.status === 'presente') break;
          faltasSeguidas += 1;
          composicao[r.status === 'ausente' ? 'ausente' : 'justificado'] += 1;
        }

        return {
          alunoId,
          nome: dados.nome,
          frequenciaPct:
            base === 0 ? null : Math.round((presente / base) * 1000) / 10,
          base,
          presente,
          ausente,
          justificado,
          faltasSeguidas,
          faltasSeguidasComposicao: composicao,
          naTurmaHoje: naTurmaHoje.has(alunoId),
          // AC-011 — os dois sinalizadores viajam no payload. Quem já foi
          // desligado, ou nunca foi reconhecido, aparece marcado aqui e
          // fica fora da lista de evasão (TASK-003): não é risco de
          // evasão, é outra coisa, e poluir o alerta com ele faz o gestor
          // parar de olhar o alerta.
          alunoAtivo: dados.alunoAtivo,
          vinculo: dados.vinculo,
        };
      },
    );

    alunos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR'));

    return {
      turmaId: turma.id,
      turmaNome: turma.nome,
      janelaDias: dias,
      // AC-002 — cobertura de chamada: aulas com chamada ÷ aulas que
      // aconteceram. É diagnóstico, não cobrança (LIM-007): diz ao gestor
      // o quanto do período tem dado, para ele saber se pode confiar nos
      // percentuais abaixo.
      cobertura: {
        aulasQueAconteceram: ocorrencias.length,
        aulasComChamada: comChamada.length,
        pct:
          ocorrencias.length === 0
            ? null
            : Math.round((comChamada.length / ocorrencias.length) * 1000) / 10,
      },
      alunos,
    };
  }
}
