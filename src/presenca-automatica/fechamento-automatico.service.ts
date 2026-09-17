import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { FUSO_DO_CLUBE } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import {
  CODIGO_CREDENCIAL_NAO_SEPARADA,
  verificarCredencialDoWorker,
  type VeredictoDeCredencial,
} from './credencial-do-worker';

/** SPEC-057/TASK-001/D2 — no máximo 100 ocorrências por lote. */
export const TAMANHO_DO_LOTE = 100;
/** SPEC-057/TASK-001/D2 — a aula precisa ter terminado há pelo menos isto. */
export const ESPERA_APOS_TERMINO_MS = 60 * 60 * 1000;

export interface ResultadoDoTick {
  /** `false` quando a trava de credencial recusou; nada foi processado. */
  credencialSeparada: boolean;
  motivosDaCredencial: string[];
  /** Linha singleton presente. `false` desliga o job com log de erro. */
  configPresente: boolean;
  /** Lida antes do primeiro lote; `false` = pausado ou nunca ativado. */
  habilitada: boolean;
  lotes: number;
  fechadas: number;
  semParticipantes: number;
  /** Deixaram de ser elegíveis entre a busca e a releitura sob o lock. */
  ignoradas: number;
  lotesFalhos: number;
  /** Maior distância entre o término da aula e o fechamento, em ms. */
  atrasoMaximoMs: number;
  duracaoMs: number;
}

interface Candidata {
  id: string;
  turmaId: string;
  companyId: string;
}

interface Config {
  habilitada: boolean;
  ativadaEm: Date | null;
}

/**
 * SPEC-057/TASK-001/D2 — **o fechamento automático da chamada.**
 *
 * A aula que terminou há mais de uma hora, depois do corte, sem cabeçalho,
 * ganha uma chamada completa com todo o conjunto observável `M ∪ V` presente,
 * origem `automatica` e autor nulo. O professor corrige faltas por sete dias a
 * partir do fechamento (D5).
 *
 * ## Ordem e atomicidade
 *
 * **Uma turma por transação**, na raiz da INV-029: `turmas FOR UPDATE` →
 * `alunos` por ID (`FOR KEY SHARE`, a mesma força que as rotas de reposição
 * usam) → `ocupacoes_quadra` por ID → filhos. Depois da raiz, **relê** a
 * elegibilidade num statement novo: o que a busca achou pode ter recebido
 * chamada humana, ter sido cancelado ou mudado de conjunto enquanto a
 * transação esperava o lock. Cabeçalho e presenças nascem na mesma
 * transação; a PK de `chamadas` impede duplicata entre instâncias, e o
 * rollback impede filho sem pai.
 *
 * ## O que ele nunca faz
 *
 * - Preencher cabeçalho existente, mesmo parcial ou legado (AC-002).
 * - Escrever falta avisada, reposição ou crédito (D8, AC-009).
 * - Ler a configuração com lock: a pausa não espera o lote em andamento, e o
 *   lote seguinte relê a flag e não começa (D3).
 */
@Injectable()
export class FechamentoAutomaticoService {
  private readonly logger = new Logger(FechamentoAutomaticoService.name);

  constructor(private readonly prisma: PrismaService) {}

  async executarTick(opcoes: { agora?: Date } = {}): Promise<ResultadoDoTick> {
    const inicio = Date.now();
    const agora = opcoes.agora ?? new Date();
    const resultado: ResultadoDoTick = {
      credencialSeparada: false,
      motivosDaCredencial: [],
      configPresente: false,
      habilitada: false,
      lotes: 0,
      fechadas: 0,
      semParticipantes: 0,
      ignoradas: 0,
      lotesFalhos: 0,
      atrasoMaximoMs: 0,
      duracaoMs: 0,
    };

    const credencial: VeredictoDeCredencial = await verificarCredencialDoWorker(
      this.prisma,
    );
    resultado.credencialSeparada = credencial.separada;
    resultado.motivosDaCredencial = credencial.motivos;
    if (!credencial.separada) {
      this.logger.error({
        evento: 'presenca_automatica_tick',
        codigo: CODIGO_CREDENCIAL_NAO_SEPARADA,
        motivos: credencial.motivos,
      });
      return this.fechar(resultado, inicio);
    }

    const limite = new Date(agora.getTime() - ESPERA_APOS_TERMINO_MS);
    let cursor: { turmaId: string; id: string } | null = null;

    for (;;) {
      const config = await this.lerConfig();
      if (!config) {
        this.logger.error({
          evento: 'presenca_automatica_tick',
          codigo: 'PRESENCA_CONFIG_AUSENTE',
        });
        return this.fechar(resultado, inicio);
      }
      resultado.configPresente = true;
      if (!config.habilitada || !config.ativadaEm) {
        // Pausado, ou nunca ativado. No primeiro lote isso é o estado do
        // ambiente; depois dele, é a pausa chegando entre dois lotes.
        return this.fechar(resultado, inicio);
      }
      resultado.habilitada = true;

      const pagina = await this.buscarCandidatas(
        config.ativadaEm,
        limite,
        cursor,
      );
      if (pagina.length === 0) break;
      // O cursor avança pela PÁGINA, não pelo que foi fechado: lote vazio,
      // falho ou todo `sem_participantes` não pode prender o job no lugar.
      const ultima = pagina[pagina.length - 1];
      cursor = { turmaId: ultima.turmaId, id: ultima.id };

      for (const [indice, lote] of agruparPorTurma(pagina).entries()) {
        // A pausa vale entre lotes, inclusive dentro da mesma página. O
        // primeiro lote da página acabou de ler a configuração acima.
        if (indice > 0) {
          const releitura = await this.lerConfig();
          if (!releitura?.habilitada) return this.fechar(resultado, inicio);
        }
        resultado.lotes += 1;
        try {
          const saida = await this.comUmaRetentativa(() =>
            this.fecharLote(lote, config.ativadaEm as Date, limite, agora),
          );
          resultado.fechadas += saida.fechadas;
          resultado.semParticipantes += saida.semParticipantes;
          resultado.ignoradas += saida.ignoradas;
          resultado.atrasoMaximoMs = Math.max(
            resultado.atrasoMaximoMs,
            saida.atrasoMaximoMs,
          );
        } catch (causa) {
          // Falha de um lote não interrompe as outras turmas; o próximo tick
          // retenta, porque nada foi gravado.
          resultado.lotesFalhos += 1;
          this.logger.error({
            evento: 'presenca_automatica_lote_falhou',
            detalhe: codigoDoErro(causa),
          });
        }
      }
      if (pagina.length < TAMANHO_DO_LOTE) break;
    }

    return this.fechar(resultado, inicio);
  }

  private fechar(resultado: ResultadoDoTick, inicio: number): ResultadoDoTick {
    resultado.duracaoMs = Date.now() - inicio;
    return resultado;
  }

  /** Sem lock, e sem INSERT implícito quando a linha falta (D3). */
  private async lerConfig(): Promise<Config | null> {
    const linhas = await this.prisma.$queryRaw<Config[]>`
      SELECT habilitada, ativada_em AS "ativadaEm"
        FROM public.config_presenca_automatica
       WHERE id = 1
    `;
    return linhas[0] ?? null;
  }

  /**
   * Paginação por chave `(turma, ocorrência)`, até 100. O término é o
   * instante no fuso do clube: `data + hora_fim` interpretado lá.
   */
  private async buscarCandidatas(
    corte: Date,
    limite: Date,
    cursor: { turmaId: string; id: string } | null,
  ): Promise<Candidata[]> {
    const aPartirDe = cursor
      ? Prisma.sql`AND (o.origem_turma_id, o.id) > (${cursor.turmaId}::uuid, ${cursor.id}::uuid)`
      : Prisma.empty;
    return this.prisma.$queryRaw<Candidata[]>`
      SELECT o.id, o.origem_turma_id AS "turmaId", o.company_id AS "companyId"
        FROM ocupacoes_quadra o
       WHERE o.origem_tipo = 'TURMA'
         AND o.origem_turma_id IS NOT NULL
         AND o.status_pagamento <> 'cancelado'
         AND NOT EXISTS (SELECT 1 FROM chamadas c WHERE c.ocupacao_id = o.id)
         AND ((o.data + o.hora_fim) AT TIME ZONE ${FUSO_DO_CLUBE}) <= ${limite}::timestamptz
         AND ((o.data + o.hora_fim) AT TIME ZONE ${FUSO_DO_CLUBE}) > ${corte}::timestamptz
         ${aPartirDe}
       ORDER BY o.origem_turma_id, o.id
       LIMIT ${TAMANHO_DO_LOTE}
    `;
  }

  private async fecharLote(
    lote: Candidata[],
    corte: Date,
    limite: Date,
    agora: Date,
  ): Promise<{
    fechadas: number;
    semParticipantes: number;
    ignoradas: number;
    atrasoMaximoMs: number;
  }> {
    const { turmaId, companyId } = lote[0];
    const ids = lote.map((c) => c.id).sort();

    return this.prisma.$transaction(
      async (tx) => {
        // (1) A RAIZ. Quem fecha, quem salva e quem marca reposição passam aqui.
        const travada = await tx.$queryRaw<{ id: string }[]>`
          SELECT id FROM turmas
           WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
           FOR UPDATE
        `;
        if (travada.length === 0) {
          return {
            fechadas: 0,
            semParticipantes: 0,
            ignoradas: ids.length,
            atrasoMaximoMs: 0,
          };
        }

        // `M` e `V`, lidos com a raiz na mão: os escritores de matrícula e de
        // reposição também começam por ela, então este é o conjunto final.
        const matriculados = await tx.$queryRaw<{ alunoId: string }[]>`
          SELECT aluno_id AS "alunoId" FROM turma_alunos
           WHERE turma_id = ${turmaId}::uuid
        `;
        const visitas = await tx.$queryRaw<
          { ocupacaoId: string; alunoId: string }[]
        >`
          SELECT ocupacao_id AS "ocupacaoId", aluno_id AS "alunoId"
            FROM reposicoes_de_aula
           WHERE company_id = ${companyId}::uuid
             AND ocupacao_id = ANY(${ids}::uuid[])
        `;

        // (2) ALUNOS por ID crescente, (3) OCORRÊNCIAS por ID crescente.
        const todos = [
          ...new Set([
            ...matriculados.map((m) => m.alunoId),
            ...visitas.map((v) => v.alunoId),
          ]),
        ].sort();
        if (todos.length > 0) {
          await tx.$queryRaw`
            SELECT id FROM alunos
             WHERE id = ANY(${todos}::uuid[])
             ORDER BY id
             FOR KEY SHARE
          `;
        }
        await tx.$queryRaw`
          SELECT id FROM ocupacoes_quadra
           WHERE id = ANY(${ids}::uuid[])
           ORDER BY id
           FOR UPDATE
        `;

        // Releitura da elegibilidade, em statement novo, com tudo travado.
        const elegiveis = await tx.$queryRaw<{ id: string; termino: Date }[]>`
          SELECT o.id,
                 ((o.data + o.hora_fim) AT TIME ZONE ${FUSO_DO_CLUBE}) AS termino
            FROM ocupacoes_quadra o
           WHERE o.id = ANY(${ids}::uuid[])
             AND o.origem_turma_id = ${turmaId}::uuid
             AND o.status_pagamento <> 'cancelado'
             AND NOT EXISTS (SELECT 1 FROM chamadas c WHERE c.ocupacao_id = o.id)
             AND ((o.data + o.hora_fim) AT TIME ZONE ${FUSO_DO_CLUBE}) <= ${limite}::timestamptz
             AND ((o.data + o.hora_fim) AT TIME ZONE ${FUSO_DO_CLUBE}) > ${corte}::timestamptz
           ORDER BY o.id
        `;

        const naTurma = matriculados.map((m) => m.alunoId);
        let fechadas = 0;
        let semParticipantes = 0;
        let atrasoMaximoMs = 0;
        for (const o of elegiveis) {
          const participantes = [
            ...new Set([
              ...naTurma,
              ...visitas
                .filter((v) => v.ocupacaoId === o.id)
                .map((v) => v.alunoId),
            ]),
          ].sort();
          if (participantes.length === 0) {
            // D4: vazio não fecha — o resolvedor mostra `sem_participantes`.
            semParticipantes += 1;
            continue;
          }

          // Cabeçalho primeiro (FK `presencas_chamada_fkey`). O instante vem
          // do relógio do BANCO, e é ele que ancora os sete dias (INV-143).
          // `updated_at`/`registrada_em` seguem a convenção do Prisma: UTC.
          await tx.$executeRaw`
            INSERT INTO chamadas (
              ocupacao_id, origem_tipo, company_id, registrada_em,
              registrada_por, updated_at, completude, esperados,
              origem, origem_inicial, fechada_automaticamente_em
            ) VALUES (
              ${o.id}::uuid, 'TURMA'::origem_tipo, ${companyId}::uuid,
              timezone('UTC', clock_timestamp()),
              NULL, timezone('UTC', clock_timestamp()),
              'completa'::completude_chamada, ${participantes.length}::int,
              'automatica', 'automatica', clock_timestamp()
            )
          `;
          await tx.$executeRaw`
            INSERT INTO presencas (
              id, company_id, ocupacao_id, origem_tipo, aluno_id, status,
              registrado_por, created_at, updated_at
            )
            SELECT gen_random_uuid(), ${companyId}::uuid, ${o.id}::uuid,
                   'TURMA'::origem_tipo, aluno, 'presente'::status_presenca,
                   NULL, timezone('UTC', clock_timestamp()),
                   timezone('UTC', clock_timestamp())
              FROM unnest(${participantes}::uuid[]) AS aluno
          `;
          fechadas += 1;
          atrasoMaximoMs = Math.max(
            atrasoMaximoMs,
            agora.getTime() - new Date(o.termino).getTime(),
          );
        }

        return {
          fechadas,
          semParticipantes,
          ignoradas: ids.length - elegiveis.length,
          atrasoMaximoMs,
        };
      },
      // A raiz pode estar com um `PUT` ou uma reposição: esperar é o
      // comportamento certo, e o padrão de 5s do Prisma derrubaria o lote.
      { maxWait: 10_000, timeout: 60_000 },
    );
  }

  /** D2 — `40P01` admite UMA nova transação; a segunda falha sobe. */
  private async comUmaRetentativa<T>(fazer: () => Promise<T>): Promise<T> {
    try {
      return await fazer();
    } catch (causa) {
      if (!ehDeadlock(causa)) throw causa;
      this.logger.warn({ evento: 'presenca_automatica_deadlock_retentativa' });
      return fazer();
    }
  }
}

/** Agrupa a página ordenada por turma: cada grupo é um lote, uma transação. */
function agruparPorTurma(pagina: Candidata[]): Candidata[][] {
  const lotes: Candidata[][] = [];
  for (const c of pagina) {
    const atual = lotes[lotes.length - 1];
    if (atual && atual[0].turmaId === c.turmaId) atual.push(c);
    else lotes.push([c]);
  }
  return lotes;
}

export function ehDeadlock(causa: unknown): boolean {
  if (causa instanceof Prisma.PrismaClientKnownRequestError) {
    if (causa.code === 'P2034') return true;
    const meta = causa.meta as { code?: string } | undefined;
    if (meta?.code === '40P01') return true;
  }
  return (
    causa instanceof Error && /40P01|deadlock detected/i.test(causa.message)
  );
}

/** NFR-003 — o log leva o código, nunca nome, ID de aluno ou credencial. */
function codigoDoErro(causa: unknown): string {
  if (causa instanceof Prisma.PrismaClientKnownRequestError) {
    const meta = causa.meta as { code?: string } | undefined;
    return meta?.code ? `${causa.code}/${meta.code}` : causa.code;
  }
  return causa instanceof Error ? causa.name : 'desconhecido';
}
