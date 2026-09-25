import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import {
  calcularOcupacao,
  carregarConjuntos,
} from '../classes/ocupacao-da-ocorrencia';
import { montarAvisoDoChamado, TIPO_LISTA_ESPERA } from './aviso-do-chamado';
import {
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
} from '../courts/date-time.util';

/**
 * SPEC-064/D3 + D4 — **o varredor: quem chama é ele, nunca o gesto.**
 *
 * ## Por que um varredor, e não chamar dentro da transação do gesto
 *
 * Chamar no gesto exigiria tomar `turmas` **depois** de `ocupacoes_quadra` no
 * caminho da falta avisada (que toma `2→3`) — inversão da ordem canônica, e
 * deadlock. Foi o segundo bloqueio da 1ª rodada de validação.
 *
 * **O gesto só grava o fato.** O varredor percorre os alvos com fila e, para
 * cada alvo, **em transação própria**, toma a ordem canônica de quatro níveis:
 *
 * ```
 * 1  turmas               FOR UPDATE   (o alvo, ou a turma da ocorrência)
 * 2  alunos                            -- o varredor NÃO entra aqui
 * 3  ocupacoes_quadra     FOR UPDATE   (só na fila de aula)
 * 4  lista_de_espera      FOR UPDATE   (a linha escolhida, POR ÚLTIMO)
 * ```
 *
 * **O nível 2 fica de fora com razão nomeada:** o varredor só marca `chamado` e
 * enfileira o aviso — não escreve no aluno nem cria reposição. Quem cria é a
 * confirmação, e por isso só ela toma `alunos FOR KEY SHARE`.
 *
 * **O nível 4 é sempre o último, sem exceção.** A `lista_de_espera` é a tabela
 * mais nova e a menos disputada; pô-la no fim não custa nada a ninguém e fecha
 * o ciclo por construção.
 *
 * ## Duas contas de capacidade, e elas não se misturam
 *
 * - fila de **turma** → `|matriculados| >= turmas.capacidade`, a mesma de
 *   `allocateStudent`;
 * - fila de **aula** → `calcularOcupacao`, que trabalha por **conjuntos**.
 *
 * **Não é a fórmula da SPEC-046**, que a SPEC-057/D17 abandonou por dar vaga
 * fantasma (capacidade 2, zero matriculados e uma falta → *três* vagas). A v1
 * desta spec a citava, e um varredor com ela chamaria gente para vaga
 * inexistente. *Vaga de reposição não vira vaga de matrícula.*
 *
 * ## Não há advisory lock, e isso é deliberado (D8)
 *
 * Duas réplicas varrem ao mesmo tempo. **Chamar duas vezes é impossível por
 * construção:** o `UNIQUE (turma_id) WHERE estado='chamado'` recusa o segundo
 * com `23505`, e a réplica perdedora desiste daquele alvo e segue. A constraint
 * já é o lock; um advisory lock por cima serializaria o que pode correr em
 * paralelo. Diferente da purga da SPEC-065, que **apaga** — apagar duas vezes é
 * trabalho perdido em transação longa.
 */

/** D4 — a vez dura no máximo 12 h. */
export const PRAZO_DO_CHAMADO_MS = 12 * 60 * 60 * 1000;

/**
 * D4 — e nunca passa de **X horas** antes da aula.
 *
 * **SPEC-064/TASK-008: o X deixou de ser uma constante daqui.** Era
 * `ANTECEDENCIA_MINIMA_MS = 2 h`, fixo, e o card 5331 pede (RN3) *"Admin define
 * a antecedência"*. Agora vem de `ConfigOperacaoService.antecedenciaDaFilaDeAula`,
 * que devolve o valor do clube ou o padrão — e o padrão continua sendo 2 h,
 * para o clube que nunca configurou ver exatamente o comportamento de antes.
 */
const UMA_HORA_MS = 60 * 60 * 1000;

export interface ResultadoDaVarredura {
  /** Alvos com fila que o ciclo olhou. */
  alvos: number;
  chamados: number;
  /** Chamados cujo prazo venceu. */
  expirados: number;
  /** Linhas encerradas pela rede de alvo morto. */
  encerradosPorAlvoMorto: number;
  /** Prazo que já nascia vencido — encerra sem chamar. */
  prazoImpossivel: number;
  /** Alvos onde não havia vaga na hora de chamar. */
  semVaga: number;
  /** Alvos perdidos para outra réplica no `23505`. */
  perdidosNaDisputa: number;
  duracaoMs: number;
}

/** Um alvo com pelo menos uma linha `aguardando` e nenhum `chamado` vivo. */
interface AlvoComFila {
  companyId: string;
  turmaId: string | null;
  ocupacaoId: string | null;
}

@Injectable()
export class VarredorDaFilaService {
  private readonly logger = new Logger(VarredorDaFilaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigOperacaoService,
  ) {}

  async executarCiclo(
    agora: () => number = Date.now,
  ): Promise<ResultadoDaVarredura> {
    const inicio = agora();
    const r: ResultadoDaVarredura = {
      alvos: 0,
      chamados: 0,
      expirados: 0,
      encerradosPorAlvoMorto: 0,
      prazoImpossivel: 0,
      semVaga: 0,
      perdidosNaDisputa: 0,
      duracaoMs: 0,
    };

    // **A ordem importa, e as três primeiras são varreduras de conjunto.**
    // Expirar antes de chamar libera alvos no mesmo ciclo: o chamado vencido
    // deixa de ocupar o `UNIQUE`, e o próximo da fila pode ser chamado agora em
    // vez de daqui a um minuto.
    r.expirados = await this.expirarVencidos();
    // **A data de "hoje" vem do FUSO DO CLUBE, derivada do relogio injetado** —
    // ver `encerrarAlvoMorto`.
    r.encerradosPorAlvoMorto = await this.encerrarAlvoMorto(
      hojeNoFusoDoClube(new Date(inicio)),
    );

    const alvos = await this.alvosComFila();
    r.alvos = alvos.length;

    for (const alvo of alvos) {
      const desfecho = await this.chamarNoAlvo(alvo, agora);
      switch (desfecho) {
        case 'chamou':
          r.chamados += 1;
          break;
        case 'sem_vaga':
          r.semVaga += 1;
          break;
        case 'prazo_impossivel':
          r.prazoImpossivel += 1;
          break;
        case 'perdeu_a_disputa':
          r.perdidosNaDisputa += 1;
          break;
        case 'nada':
          break;
      }
    }

    r.duracaoMs = agora() - inicio;
    return r;
  }

  /**
   * AC-004 — a vez vencida vira `expirada`.
   *
   * Um `UPDATE` de conjunto, sem lock explícito e sem laço: a linha só sai de
   * `chamado` por aqui ou pela confirmação, e as duas competem pelo mesmo
   * `WHERE estado = 'chamado'` — quem chegar depois não acha nada.
   *
   * **A tela não depende disto.** A confirmação confere `chamado_ate` por conta
   * própria, então um varredor desligado (`FILA_DE_ESPERA_INTERVALO_MS=0`) não
   * deixa ninguém confirmar uma vez vencida.
   */
  private async expirarVencidos(): Promise<number> {
    return this.prisma.$executeRaw`
      UPDATE lista_de_espera
         SET estado = 'expirada', concluida_em = now(), motivo_fim = 'prazo vencido'
       WHERE estado = 'chamado' AND chamado_ate < now()`;
  }

  /**
   * D3 — **a rede que pega o que escapar dos caminhos de domínio.**
   *
   * Os sete caminhos de encerramento da D6 são da TASK-004 e fecham a fila no
   * ato do gesto. Esta varredura existe porque *"a rede pega o que escapar"*:
   * turma inativada, aula cancelada ou aula que já passou, em qualquer linha
   * ainda ativa.
   *
   * **Não substitui a TASK-004**, e a diferença importa: lá o encerramento é
   * imediato e avisa quando precisa; aqui é até um ciclo depois e silencioso.
   *
   * ## `hoje` vem de fora, e a primeira versão usava `CURRENT_DATE`
   *
   * **A CI da própria PR pegou.** `CURRENT_DATE` é a data do **servidor de
   * banco**, que roda em UTC; o clube vive em `America/Sao_Paulo`. Entre 21h e
   * meia-noite locais (00h–03h UTC) o banco já virou o dia, e **toda aula de
   * hoje à noite seria encerrada como "já passou"** — fila viva morta por
   * acidente de fuso, às vésperas da aula.
   *
   * Não foi teoria: a CI rodou às 02:55 UTC — 23:55 em São Paulo — e o caso do
   * prazo ficou vermelho porque a linha havia sido encerrada antes de o
   * varredor chegar a chamar.
   *
   * `CURRENT_DATE` aparecia **só neste arquivo**; o resto do projeto usa
   * `hojeNoFusoDoClube()` desde sempre. Recebê-la por parâmetro é o que torna
   * o caso provável com relógio fixo, em vez de só entre 21h e meia-noite.
   */
  private async encerrarAlvoMorto(hoje: Date): Promise<number> {
    const hojeIso = hoje.toISOString().slice(0, 10);
    return this.prisma.$executeRaw`
      UPDATE lista_de_espera f
         SET estado = 'encerrada', concluida_em = now(), motivo_fim = 'alvo indisponivel'
       WHERE f.estado IN ('aguardando', 'chamado')
         AND (
           EXISTS (
             SELECT 1 FROM turmas t
              WHERE t.id = f.turma_id AND t.company_id = f.company_id
                AND t.status <> 'ativa'
           )
           OR EXISTS (
             SELECT 1 FROM ocupacoes_quadra o
              WHERE o.id = f.ocupacao_id AND o.company_id = f.company_id
                AND (o.status_pagamento = 'cancelado' OR o.data < ${hojeIso}::date)
           )
         )`;
  }

  /**
   * Os alvos que valem uma transação: têm alguém `aguardando` e **não** têm
   * `chamado` vivo.
   *
   * O `NOT EXISTS` é economia, não garantia — a garantia é o `UNIQUE` parcial,
   * e entre esta leitura e o `INSERT` cabe outra réplica. É por isso que
   * `chamarNoAlvo` trata o `23505` como desfecho normal, e não como erro.
   */
  private async alvosComFila(): Promise<AlvoComFila[]> {
    return this.prisma.$queryRaw<AlvoComFila[]>`
      SELECT DISTINCT f.company_id AS "companyId",
                      f.turma_id   AS "turmaId",
                      f.ocupacao_id AS "ocupacaoId"
        FROM lista_de_espera f
       WHERE f.estado = 'aguardando'
         AND NOT EXISTS (
           SELECT 1 FROM lista_de_espera c
            WHERE c.estado = 'chamado'
              AND c.company_id = f.company_id
              AND c.turma_id IS NOT DISTINCT FROM f.turma_id
              AND c.ocupacao_id IS NOT DISTINCT FROM f.ocupacao_id
         )`;
  }

  /**
   * Um alvo, uma transação, a ordem canônica inteira.
   *
   * **O orçamento de idas ao banco é fixo** (DEF-013 conta idas): 1 lock de
   * turma, 1 de ocupação (só fila de aula), 3 do `carregarConjuntos` (só fila
   * de aula), 1 contagem de matrícula (só fila de turma), 1 `FOR UPDATE` da
   * linha, 1 leitura do usuário, 1 `UPDATE`, 1 `INSERT`. **Nenhum laço por
   * linha** — o alvo é um só.
   */
  private async chamarNoAlvo(
    alvo: AlvoComFila,
    agora: () => number,
  ): Promise<
    'chamou' | 'sem_vaga' | 'prazo_impossivel' | 'perdeu_a_disputa' | 'nada'
  > {
    try {
      return await this.prisma.$transaction(async (tx) => {
        const fila = alvo.ocupacaoId ? 'aula' : 'turma';

        // ---- nível 3 antes? NÃO: a ocorrência só é lida aqui para descobrir
        // a TURMA dela, sem lock. O `FOR UPDATE` dela vem depois do nível 1.
        let ocupacao: {
          id: string;
          data: Date;
          horaInicio: Date;
          origemTurmaId: string | null;
        } | null = null;
        if (alvo.ocupacaoId) {
          ocupacao = await tx.ocupacaoQuadra.findFirst({
            where: { id: alvo.ocupacaoId, companyId: alvo.companyId },
            select: {
              id: true,
              data: true,
              horaInicio: true,
              origemTurmaId: true,
            },
          });
          if (!ocupacao?.origemTurmaId) return 'nada';
        }

        const turmaId = alvo.turmaId ?? ocupacao?.origemTurmaId;
        if (!turmaId) return 'nada';

        // ---- 1. TURMA
        const turmas = await tx.$queryRaw<
          { id: string; capacidade: number; status: string }[]
        >`
          SELECT id, capacidade, status::text AS status
            FROM turmas
           WHERE id = ${turmaId}::uuid AND company_id = ${alvo.companyId}::uuid
           FOR UPDATE`;
        const turma = turmas[0];
        if (!turma || turma.status !== 'ativa') return 'nada';

        // ---- 3. OCUPAÇÃO (só fila de aula)
        if (ocupacao) {
          await tx.$queryRaw`
            SELECT id FROM ocupacoes_quadra
             WHERE id = ${ocupacao.id}::uuid
               AND company_id = ${alvo.companyId}::uuid
             FOR UPDATE`;
        }

        // ---- a conta, com os locks na mão
        const temVaga = ocupacao
          ? await this.vagaNaAula(
              tx,
              alvo.companyId,
              ocupacao.id,
              turmaId,
              turma.capacidade,
            )
          : await this.vagaNaTurma(tx, turmaId, turma.capacidade);
        if (!temVaga) return 'sem_vaga';

        // ---- 4. A LINHA, por último. Ordem de chegada, com desempate por id:
        // duas entradas no mesmo instante existem (a de turma nasce de um
        // gesto que remove alguém, e o aviso é em lote).
        const linhas = await tx.$queryRaw<{ id: string; alunoId: string }[]>`
          SELECT id, aluno_id AS "alunoId"
            FROM lista_de_espera
           WHERE estado = 'aguardando'
             AND company_id = ${alvo.companyId}::uuid
             AND turma_id IS NOT DISTINCT FROM ${alvo.turmaId}::uuid
             AND ocupacao_id IS NOT DISTINCT FROM ${alvo.ocupacaoId}::uuid
           ORDER BY criada_em, id
           LIMIT 1
           FOR UPDATE`;
        const linha = linhas[0];
        if (!linha) return 'nada';

        const chamadoEm = new Date(agora());
        // SPEC-064/TASK-008 — **pelo `tx`**, e so quando ha aula: a fila de
        // turma nao tem antecedencia (D4), e ler por outra conexao segurando
        // os locks de turma e ocorrencia e o defeito que a SPEC-034 pagou caro.
        const antecedenciaMs = ocupacao
          ? (await this.config.antecedenciaDaFilaDeAula(alvo.companyId, tx)) *
            UMA_HORA_MS
          : 0;
        const chamadoAte = this.prazoDoChamado(
          chamadoEm,
          ocupacao,
          antecedenciaMs,
        );

        if (chamadoAte === null) {
          // D4 — prazo que já nasce vencido **não chama ninguém**: a linha
          // vira `encerrada`, e a vaga fica para quem chegar pela tela.
          await tx.$executeRaw`
            UPDATE lista_de_espera
               SET estado = 'encerrada', concluida_em = now(),
                   motivo_fim = 'prazo impossivel'
             WHERE id = ${linha.id}::uuid`;
          return 'prazo_impossivel';
        }

        // O destinatário do aviso é o USUÁRIO do aluno: a FK de `notificacoes`
        // aponta para `usuarios`, não para `alunos` — e é por isso que enfileirar
        // aviso não exige o nível 2.
        const aluno = await tx.aluno.findFirst({
          where: { id: linha.alunoId, companyId: alvo.companyId },
          select: { usuarioId: true },
        });
        if (!aluno) return 'nada';

        await tx.$executeRaw`
          UPDATE lista_de_espera
             SET estado = 'chamado', chamado_em = ${chamadoEm},
                 chamado_ate = ${chamadoAte}
           WHERE id = ${linha.id}::uuid`;

        const aviso = montarAvisoDoChamado({
          fila,
          turmaId,
          data: ocupacao?.data ?? null,
          horaInicio: ocupacao?.horaInicio ?? null,
          chamadoAte,
        });

        // **Na MESMA transação que o `chamado`** — a mesma regra do
        // `EnfileiradorDeAvisos` da SPEC-063: aviso sobre gesto que voltou
        // atrás é pior que aviso nenhum.
        await tx.$executeRaw`
          INSERT INTO notificacoes
            (id, company_id, destinatario_id, origem_id, tipo, titulo, corpo,
             destino_url, expira_em)
          VALUES (${randomUUID()}::uuid, ${alvo.companyId}::uuid,
                  ${aluno.usuarioId}::uuid, ${linha.id}::uuid,
                  ${TIPO_LISTA_ESPERA}, ${aviso.titulo}, ${aviso.corpo},
                  ${aviso.destinoUrl}, ${aviso.expiraEm})`;

        return 'chamou';
      });
    } catch (erro) {
      if (ehChamadoDuplicado(erro)) {
        // Outra réplica chamou primeiro. **Desfecho normal, não erro:** a
        // constraint é o lock, e perder a disputa é o comportamento declarado
        // na matriz de falha.
        return 'perdeu_a_disputa';
      }
      throw erro;
    }
  }

  /** `|matriculados| >= capacidade` — a mesma conta de `allocateStudent`. */
  private async vagaNaTurma(
    tx: Prisma.TransactionClient,
    turmaId: string,
    capacidade: number,
  ): Promise<boolean> {
    const matriculados = await tx.turmaAluno.count({ where: { turmaId } });
    return matriculados < capacidade;
  }

  /**
   * `calcularOcupacao`, por conjuntos — e **dentro da transação**, sob os locks
   * (achado v3-02): ler faltas e reposições sem travar deixaria a contagem
   * correr entre a conta e a escrita.
   */
  private async vagaNaAula(
    tx: Prisma.TransactionClient,
    companyId: string,
    ocupacaoId: string,
    turmaId: string,
    capacidade: number,
  ): Promise<boolean> {
    const conjuntos = await carregarConjuntos(tx, companyId, [
      { id: ocupacaoId, turmaId },
    ]);
    const c = conjuntos.get(ocupacaoId);
    if (!c) return false;
    return calcularOcupacao(capacidade, c).vagasNaOcorrencia > 0;
  }

  /**
   * D4 — `chamado_ate = min(chamado_em + 12h, início da aula − X)`, com o X do
   * clube (SPEC-064/TASK-008; padrão 2 h).
   *
   * **A antecedência vale só para a fila de AULA, e isso é
   * interpretação declarada.** A D4 escreve a fórmula uma vez, sem distinguir
   * as duas filas — mas a fila de turma **não tem "a aula"**: o alvo é a turma,
   * e entrar nela não é comparecer a uma ocorrência específica.
   *
   * Aplicar a regra ali amarraria a vaga de matrícula à próxima ocorrência e,
   * pior, `prazo_impossivel` é **terminal**: uma turma cujo próximo encontro
   * fosse dali a uma hora mataria a posição de quem esperava há uma semana,
   * por um acidente de relógio. Na fila de turma vale só o teto de 12 h.
   *
   * @returns `null` quando o prazo já nasce vencido.
   */
  private prazoDoChamado(
    chamadoEm: Date,
    ocupacao: { data: Date; horaInicio: Date } | null,
    /** A antecedência do clube, já em ms. Ignorada sem `ocupacao` (D4). */
    antecedenciaMs: number,
  ): Date | null {
    const teto = new Date(chamadoEm.getTime() + PRAZO_DO_CHAMADO_MS);
    if (!ocupacao) return teto;

    // **`instanteNoFusoDoClube`, e nao aritmetica minha.** A primeira versao
    // deste arquivo somava `data` (DATE, meia-noite UTC) com `horaInicio`
    // (TIME, 1970-01-01) e chamava o resultado de instante — **errado por 3
    // horas**, porque o clube vive em `America/Sao_Paulo`. Um prazo de "2 h
    // antes" calculado no fuso errado e um prazo de 5 h antes, ou de 1.
    //
    // O helper le o deslocamento do proprio fuso para aquela data, em vez de
    // fixar UTC-3: Sao Paulo nao tem horario de verao desde 2019, e uma regra
    // que embutisse o numero quebraria calada no dia em que voltar a ter.
    const inicio = instanteNoFusoDoClube(ocupacao.data, ocupacao.horaInicio);
    const limite = new Date(inicio.getTime() - antecedenciaMs);
    const prazo = limite < teto ? limite : teto;
    return prazo > chamadoEm ? prazo : null;
  }
}

/** O `23505` dos dois índices de `chamado`, venha ele do Prisma ou cru. */
function ehChamadoDuplicado(erro: unknown): boolean {
  const e = erro as { code?: string; meta?: { code?: string } };
  return e?.code === 'P2002' || e?.meta?.code === '23505';
}
