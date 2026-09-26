import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type {
  CompletudeChamada,
  OcupacaoQuadra,
  Prisma,
  StatusPresenca,
} from '@prisma/client';
import {
  ChamadaResponseDto,
  NaoHouveDesfeitoResponseDto,
  OcorrenciaDaTurmaResponseDto,
} from './dto/me-response.dto';
import { OcorrenciaNoHistoricoResponseDto } from './dto/presenca-historico-response.dto';
import {
  chamadaJaRegistrada,
  resolverEstadoDaChamada,
  type EstadoDaChamada,
} from './estado-da-chamada';
import {
  aulaJaComecou,
  formatDateOnly,
  formatTimeOnly,
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
} from '../courts/date-time.util';
import {
  dentroDaJanelaAutomatica,
  RelogioDaPresenca,
} from './relogio-da-presenca';
import {
  gravarPresencasDoFechamento,
  participantesDaOcorrencia,
} from '../presenca-automatica/fechamento-automatico.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  CorteDaPresenca,
  participantesDasCandidatas,
} from '../presenca-automatica/corte-da-presenca';

/** SPEC-014/INV-017: janela em que a chamada pode ser lançada. */
export const JANELA_RETROATIVA_DIAS = 7;

/**
 * SPEC-057/TASK-001/D5 — a janela de correção da chamada que **nasceu
 * automática**, contada do fechamento automático e não da data da aula.
 * O mesmo número da INV-017, mas outro relógio: retomada tardia fecha aula
 * antiga, e cada fechamento abre a sua própria janela (LIM-057l).
 */
export const JANELA_DA_AUTOMATICA_DIAS = 7;

/** SPEC-057/TASK-001/D1 — as origens que uma pessoa grava. */
export type OrigemHumana = 'professor' | 'gestor';

/** O cabeçalho relido sob o lock da turma, com o relógio do banco. */
export interface CabecalhoSobLock {
  origem: string;
  origemInicial: string;
  completude: CompletudeChamada;
  fechadaAutomaticamenteEm: Date | null;
  /**
   * `fechada_automaticamente_em + 7 dias > agora`. **SPEC-076/D11:** o `agora`
   * é o que o portão leu uma vez, do `RelogioDaPresenca` — em produção, o
   * relógio do banco; era `clock_timestamp()` no próprio SQL, um terceiro
   * relógio no mesmo portão. `null` quando a chamada não nasceu automática.
   */
  dentroDaJanelaAutomatica: boolean | null;
}

/** Uma linha da tela de chamada: o aluno e o que está marcado para ele. */
export interface LinhaDaChamada {
  alunoId: string;
  nome: string;
  status: StatusPresenca | null;
  naTurmaHoje: boolean;
  /**
   * SPEC-046/AC-015 — **este aluno está aqui REPONDO uma falta de outra aula.**
   *
   * Campo próprio, e não `naTurmaHoje` reaproveitado: quem vem repor tem
   * `naTurmaHoje: false` corretamente — ele não é da turma —, e só isso leria
   * como *"saiu da turma"*. São dois estados diferentes com a mesma marca, que
   * é exatamente o defeito que a DEF-002 pagou na completude da chamada.
   *
   * Ele conta na presença como qualquer outro (AC-016): pode ser marcado
   * presente ou ausente. O que NÃO muda é a contagem de matriculados da turma
   * (AC-017) — reposição é visita, não matrícula.
   */
  reposicao: boolean;
  /**
   * SPEC-031/AC-019 — o aluno avisou que ia faltar.
   *
   * **Sobrevive ao cancelamento da aula** (D14): o `GET` devolve a ocorrência
   * cancelada com a lista inteira, e o aviso pertence ali — ele é o registro
   * histórico que responde *"eu avisei, por que fui cobrado?"*, e essa é a
   * única tela onde a pergunta aparece.
   */
  faltaAvisada: boolean;
}

/**
 * SPEC-014 — chamada por ocorrência de aula.
 *
 * Mora em MOD-004 (turmas), que é o dono de `presencas`. MOD-005 (quadras)
 * só é lido: a INV-016 ser regra de **escrita** — e não estado permanente —
 * é o que mantém essa direção. Se presença tivesse de continuar válida para
 * sempre, `cancelFutureClassOccupancies` precisaria conhecer presença, e
 * MOD-005 passaria a depender de MOD-004.
 */
@Injectable()
export class PresencaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly corteDaPresenca: CorteDaPresenca = new CorteDaPresenca(
      prisma,
    ),
    // SPEC-076/D11 — o relógio único do portão. O db-spec o substitui.
    private readonly relogio: RelogioDaPresenca = new RelogioDaPresenca(),
  ) {}

  /**
   * SPEC-014/INV-017 — "hoje" na única data operacional que o produto tem.
   *
   * **DEF-020 mudou a convenção, e o comentário que estava aqui merece ser
   * lembrado em vez de apagado.** Ele dizia: *"esta spec não introduz fuso;
   * o importante é ser a mesma convenção, não uma nova"*. O argumento estava
   * certo — e foi a SPEC-023 que o quebrou, criando `hojeNoFusoDoClube()`
   * para uma regra só e deixando as outras seis em UTC. Ficaram as **duas**
   * convenções que este comentário existia para evitar.
   *
   * Agora há uma de novo, e é a do fuso: das 21h à meia-noite o UTC já está
   * no dia seguinte, então a janela retroativa da chamada abria e fechava um
   * dia adiantada justamente no horário de pico de um clube de tênis.
   */
  private hoje(): Date {
    return hojeNoFusoDoClube();
  }

  /**
   * INV-018 — o professor vem do **banco**, pelo usuário autenticado. O JWT
   * não carrega `professorId` (SPEC-013/ACHADO-003): claim é fotografia do
   * login, e autorização precisa do presente.
   */
  private async professorDoUsuario(companyId: string, usuarioId: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { usuarioId, companyId },
      select: { id: true },
    });
    if (!professor) {
      throw new ForbiddenException();
    }
    return professor;
  }

  /**
   * A versão da chamada (INV-019). Deriva do estado, em vez de virar coluna:
   * uma coluna `versao` precisaria ser incrementada por quem escreve, e
   * quem esquecesse de incrementar criaria um controle de concorrência que
   * não controla nada.
   */
  private versaoDe(
    linhas: { updatedAt: Date }[],
    cabecalho: { updatedAt: Date; completude?: string } | null,
    /**
     * SPEC-057/TASK-001/D4 — `M ∪ V`: matriculados **e** visitantes com
     * reposição nesta ocorrência. Era só `M`, e o visitante que marcava ou
     * desmarcava entre o `GET` e o `PUT` mudava a lista sem mudar a versão.
     * `S` já entra pelas `linhas`.
     */
    observaveis: { alunoId: string }[],
  ): string {
    const base =
      linhas.length === 0
        ? '0'
        : `${linhas.length}:${linhas
            .reduce(
              (max, l) => (l.updatedAt > max ? l.updatedAt : max),
              linhas[0].updatedAt,
            )
            .getTime()}`;

    // SPEC-015/AC-000g — o cabeçalho entra na versão. Sem isso, promover
    // uma chamada de `desconhecida` para `completa` não muda a versão
    // (`completude` vive no cabeçalho, não nas linhas), e duas abas se
    // sobrescreveriam exatamente no caso que o controle otimista existe
    // para pegar. Achado da 3ª validação cruzada.
    const comCabecalho = cabecalho
      ? `${base}#${cabecalho.updatedAt.getTime()}`
      : base;

    // SPEC-015/INV-028 — quando o piso depende da matrícula, a versão
    // precisa enxergá-la. Com cabeçalho `completa` o piso é o snapshot, e
    // matrícula nova não muda o que a tela deve mostrar: incluir a
    // impressão digital ali só produziria 409 falso. Nos outros dois
    // estados o `GET` devolve a união, e matrícula que entra entre a
    // leitura e a escrita muda o conjunto que o professor recebeu —
    // sem isso, ele leva 422 acusando alguém que a tela não mostrou
    // (BLOQ-1 da 6ª validação cruzada).
    if (cabecalho?.completude === 'completa') {
      return comCabecalho;
    }
    const ids = [...new Set(observaveis.map((m) => m.alunoId))].sort();
    const digest = createHash('sha1')
      .update(ids.join(','))
      .digest('hex')
      .slice(0, 12);
    return `${comCabecalho}@${ids.length}:${digest}`;
  }

  /** Ocorrência + turma, já verificando que a turma é do professor (AC-005). */
  private async ocorrenciaDoProfessor(
    companyId: string,
    professorId: string,
    ocupacaoId: string,
  ): Promise<OcupacaoQuadra & { origemTurmaId: string }> {
    // `professorId` no WHERE, e não conferido depois de buscar: ocorrência
    // de colega devolve 404, não 403 — 403 confirmaria que existe.
    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: {
        id: ocupacaoId,
        companyId,
        origemTipo: 'TURMA',
        origemTurma: { professorId },
      },
    });
    if (!ocupacao?.origemTurmaId) {
      throw new NotFoundException();
    }
    return ocupacao as OcupacaoQuadra & { origemTurmaId: string };
  }

  /**
   * SPEC-030:TASK-004 — **o portão da escrita de chamada, num lugar só.**
   *
   * Travar a turma, reler sob o lock e recusar o que não pode receber
   * chamada. Era o começo do `salvarChamada` (que a SPEC-076 removeu); virou
   * método próprio quando `registrarNaoHouve` passou a precisar exatamente
   * das mesmas guardas.
   *
   * **Copiar este bloco teria sido o pior desfecho possível da SPEC-030.**
   * Ele carrega o raciocínio do BLOQUEADOR da 9ª rodada de validação
   * cruzada, e uma cópia que não acompanhasse a próxima correção reabriria
   * uma corrida que já custou caro uma vez.
   *
   * `professorIdScope` é o único parâmetro que muda entre os dois chamadores
   * (D1a): preenchido, só passa ocorrência daquele professor; `undefined`,
   * o gestor alcança qualquer turma **da empresa** — o `company_id` está no
   * `WHERE` das duas queries e não é opcional em nenhum caminho.
   *
   * ## Por que são DOIS statements, e nesta ordem
   *
   * INV-029/AC-011: `presencas` referencia `turma_alunos`, e a exclusão
   * de um lado só não trava nada. A entrada está protegida de graça pela FK
   * `turma_alunos -> turmas`, que obriga o INSERT a pegar `FOR KEY SHARE`
   * na turma; a SAÍDA não, porque DELETE de filho não checa FK no pai.
   *
   * A v10 fazia num ato só — um JOIN com `FOR UPDATE OF t` — e isso parecia
   * bastar. Não basta: em READ COMMITTED o snapshot é do STATEMENT. Quando
   * esse statement esbarra no lock de `turmas` e espera, o Postgres, ao ser
   * liberado, reavalia só a linha travada (EvalPlanQual) — as outras
   * relações do JOIN continuam com o snapshot de antes da espera.
   *
   * Por isso a v10 acertava a troca de professor (`professor_id` vem de `t`,
   * a relação travada) e errava o cancelamento (`status_pagamento` vem de
   * `o`, que não é). Medido em `bloq9-snapshot.ts`: o JOIN devolveu
   * `pendente_pagamento` com o banco já em `cancelado`; uma releitura em
   * statement novo, com o lock na mão, devolveu `cancelado`.
   *
   * Continua travando SÓ `turmas`: raiz única é o que garante ordem de
   * aquisição única (INV-029) e, portanto, ausência de deadlock.
   */
  private async travarEValidarOcorrencia(
    tx: Prisma.TransactionClient,
    companyId: string,
    ocupacaoId: string,
    professorIdScope?: string,
    turmaIdDaRota?: string,
  ): Promise<{
    origemTurmaId: string;
    data: Date;
    horaInicio: Date;
    statusPagamento: string;
    professorId: string | null;
    cabecalho: CabecalhoSobLock | null;
    /** SPEC-076/D11 — o instante que decidiu tudo abaixo, lido uma vez. */
    agora: Date;
  }> {
    // (0a) descobrir a turma da ocorrência e TRAVAR a linha.
    // `origem_turma_id` é gravado na criação e nunca alterado — os três
    // `update` de `ocupacoes_quadra` escrevem apenas `status_pagamento` —,
    // então descobrir por ele não corre risco de travar a turma errada. A
    // releitura em (0b) confere isso de qualquer forma.
    const travadas = await tx.$queryRaw<{ id: string }[]>`
      SELECT t.id
        FROM turmas t
       WHERE t.id = (
               SELECT o.origem_turma_id
                 FROM ocupacoes_quadra o
                WHERE o.id = ${ocupacaoId}::uuid
                  AND o.company_id = ${companyId}::uuid
                  AND o.origem_tipo = 'TURMA'
             )
       FOR UPDATE
    `;
    if (!travadas[0]) {
      throw new NotFoundException();
    }

    // (0b) com o lock na mão, RELER num statement novo. Este snapshot é
    // posterior ao commit de quem estava segurando a turma.
    const linhas = await tx.$queryRaw<
      {
        origemTurmaId: string;
        data: Date;
        // SPEC-027: a janela da chamada passou a olhar a HORA, e esta
        // releitura sob o lock precisa da coluna. Sem ela, o portão
        // compararia `undefined` — o `tsc` pega, mas só porque o tipo acima
        // e a query abaixo andam juntos. Mantenha os dois em par.
        horaInicio: Date;
        statusPagamento: string;
        professorId: string | null;
      }[]
    >`
      SELECT o.origem_turma_id   AS "origemTurmaId",
             o.data              AS "data",
             o.hora_inicio       AS "horaInicio",
             o.status_pagamento  AS "statusPagamento",
             t.professor_id      AS "professorId"
        FROM ocupacoes_quadra o
        JOIN turmas t ON t.id = o.origem_turma_id
       WHERE o.id = ${ocupacaoId}::uuid
         AND o.company_id = ${companyId}::uuid
         AND o.origem_tipo = 'TURMA'
    `;
    const ocupacao = linhas[0];

    // Guarda defensiva: se a ocorrência apontar para outra turma, o lock que
    // está na mão não é o da turma certa. Não deveria acontecer, e por isso
    // a resposta é 404 e não um código próprio.
    if (!ocupacao || ocupacao.origemTurmaId !== travadas[0].id) {
      throw new NotFoundException();
    }

    // Mesma razão do `ocorrenciaDoProfessor`: ocorrência de colega devolve
    // 404, não 403 — 403 confirmaria que existe.
    //
    // **SPEC-030 — e o `if` só roda quando há escopo.** Para o gestor não há
    // "colega": a empresa já está no `WHERE` das duas queries acima, e é ela
    // que o separa de outra empresa. Ausência de escopo aqui é ausência de
    // escopo de PROFESSOR, não ausência de escopo.
    if (professorIdScope && ocupacao.professorId !== professorIdScope) {
      throw new NotFoundException();
    }

    // **Achado 4 da 2ª validação cruzada (MÉDIA).** Esta conferência existia,
    // e rodava DEPOIS do portão — então
    // `PUT /classes/turma-A/presencas/ocupacao-futura-da-turma-B/nao-houve`
    // devolvia `422 AULA_FUTURA` em vez de `404`. Não havia escrita indevida,
    // mas a resposta **contava o estado de uma ocorrência que a URL não
    // deveria alcançar**: quem chuta ids descobre se a aula existe e se já
    // aconteceu.
    //
    // O lugar certo é aqui, no grupo dos `404` de escopo: "esta ocorrência
    // não pertence a este caminho" é a mesma família de "não é sua", e as
    // duas têm de responder antes de qualquer regra de domínio.
    //
    // **Achado 1 da 3ª validação cruzada (MÉDIA) — e o `!==` era o defeito.**
    // `A000…001` e `a000…001` são o MESMO UUID; o Postgres devolve a forma
    // minúscula, e o `ParseUUIDPipe` da rota preservava a grafia que veio.
    // O gestor abria a URL da própria turma em maiúsculas e levava `404`.
    //
    // A correção de verdade é a fronteira — `UuidCanonicoPipe`, que
    // normaliza todo `@Param` de UUID do projeto. Isto aqui é o portão se
    // recusando a depender de um pipe declarado em outro arquivo: quem
    // chama este serviço não é só o controller, e um gate que devolve 404
    // não pode ter a resposta decidida por quem o chamou.
    if (
      turmaIdDaRota &&
      ocupacao.origemTurmaId !== turmaIdDaRota.toLowerCase()
    ) {
      throw new NotFoundException();
    }

    // INV-016 (a metade que o banco não impõe): é regra de escrita.
    if (ocupacao.statusPagamento === 'cancelado') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_CANCELADA',
        message: 'Esta aula foi cancelada e não recebe chamada.',
      });
    }

    // SPEC-057/TASK-001/D5 — o cabeçalho, relido **com o lock na mão** pela
    // mesma razão da releitura acima. A origem inicial decide qual janela
    // vale.
    const [lido] = await tx.$queryRaw<
      Omit<CabecalhoSobLock, 'dentroDaJanelaAutomatica'>[]
    >`
      SELECT c.origem                      AS "origem",
             c.origem_inicial              AS "origemInicial",
             c.completude                  AS "completude",
             c.fechada_automaticamente_em  AS "fechadaAutomaticamenteEm"
        FROM chamadas c
       WHERE c.ocupacao_id = ${ocupacaoId}::uuid
    `;

    // SPEC-076/D11 — **um relógio só**, lido uma vez, depois da raiz. Tudo
    // o que o portão decide sobre tempo sai deste instante: a aula já
    // começou, a janela retroativa e a da automática. Em produção é o
    // relógio do banco; o db-spec injeta um controlado (AC-009 iii).
    const agora = await this.relogio.agora(tx);
    const cabecalho: CabecalhoSobLock | undefined = lido && {
      ...lido,
      dentroDaJanelaAutomatica: lido.fechadaAutomaticamenteEm
        ? dentroDaJanelaAutomatica(lido.fechadaAutomaticamenteEm, agora)
        : null,
    };

    // INV-017. O limite futuro impede a chamada de virar previsão — o caso
    // real é banal: o professor abre a grade da semana e toca na linha
    // errada. O limite passado existe porque a turma de hoje deixa de ser um
    // retrato confiável do que era há muito tempo (LIM-003).
    const hoje = hojeNoFusoDoClube(agora).getTime();
    const dia = ocupacao.data.getTime();
    // SPEC-027 — **o portão passou a olhar a HORA, não só o dia.**
    //
    // Era `dia > hoje`, e por isso a aula das 18h de hoje aceitava chamada às
    // 8h da manhã. **Isto é o portão de verdade, e a tela não substitui:**
    // esconder o botão resolve o engano honesto; só o servidor resolve o
    // pedido montado à mão.
    if (!aulaJaComecou(ocupacao.data, ocupacao.horaInicio, agora)) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_FUTURA',
        message: 'Esta aula ainda não começou.',
      });
    }
    if (dia > hoje) {
      // Rede de segurança: `aulaJaComecou` já cobre o caso, e manter a
      // comparação por dia custa uma linha. Se um dia a função de hora
      // regredir, esta ainda barra a aula de amanhã.
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_FUTURA',
        message: 'Esta aula ainda não aconteceu.',
      });
    }
    // SPEC-057/TASK-001/D5 — **a chamada que nasceu automática usa
    // exclusivamente o relógio do fechamento**, inclusive depois de
    // ratificada. A data da aula não entra: a retomada tardia fecha aula de
    // semanas atrás, e o registro não pode nascer já incorrigível.
    if (cabecalho?.origemInicial === 'automatica') {
      if (!cabecalho.dentroDaJanelaAutomatica) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'AULA_ANTIGA',
          message: `A chamada fechada automaticamente pode ser corrigida em até ${JANELA_DA_AUTOMATICA_DIAS} dias após o fechamento.`,
        });
      }
      return { ...ocupacao, cabecalho, agora };
    }
    if (dia < hoje - JANELA_RETROATIVA_DIAS * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_ANTIGA',
        message: `A chamada pode ser lançada em até ${JANELA_RETROATIVA_DIAS} dias após a aula.`,
      });
    }

    return { ...ocupacao, cabecalho: cabecalho ?? null, agora };
  }

  /**
   * SPEC-027 — **paginada**, a pedido do Israel.
   *
   * Era a lista mais longa do painel do professor: uma turma de 3x por semana
   * enche 38 linhas na janela padrao, e o professor rola tudo para achar a
   * aula de ontem. O `pageSize` e opcional e o padrao preserva o
   * comportamento de quem nao passar nada.
   */
  async ocorrenciasDaTurma(
    companyId: string,
    usuarioId: string,
    turmaId: string,
    janelaDias: number,
    page = 1,
    pageSize = 20,
  ): Promise<{
    data: OcorrenciaDaTurmaResponseDto[];
    page: number;
    pageSize: number;
    total: number;
  }> {
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId, professorId: professor.id },
      select: { id: true, nome: true, _count: { select: { alunos: true } } },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    const desde = new Date(this.hoje());
    desde.setUTCDate(desde.getUTCDate() - janelaDias);

    // O MESMO `where` para a pagina e para a contagem.
    const onde = {
      companyId,
      origemTipo: 'TURMA' as const,
      origemTurmaId: turmaId,
      data: { gte: desde },
    };

    const total = await this.prisma.ocupacaoQuadra.count({ where: onde });
    const ocorrencias = await this.prisma.ocupacaoQuadra.findMany({
      where: onde,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        _count: { select: { presencas: true } },
        // SPEC-030 — **isto passou a ser selecionado aqui.** Antes esta
        // lista decidia "chamada feita" contando presenças, e o calendário
        // decidia pelo cabeçalho: uma ocorrência com cabeçalho e ZERO
        // presenças saía `feita` num e `pendente` no outro, com o mesmo
        // vocabulário na resposta. Agora as duas perguntam ao mesmo
        // resolvedor, e ele precisa do cabeçalho.
        chamadas: {
          select: {
            completude: true,
            origemInicial: true,
            fechadaAutomaticamenteEm: true,
          },
        },
      },
      // SPEC-027 — `id` como desempate: `data` + `horaInicio` não é ordem
      // total, e com `skip`/`take` isso faz linha aparecer em duas páginas e
      // sumir de outra.
      orderBy: [{ data: 'desc' }, { horaInicio: 'desc' }, { id: 'desc' }],
    });

    const hoje = this.hoje();
    const agora = new Date();
    const paraEstado = (o: (typeof ocorrencias)[number]) => ({
      cancelada: o.statusPagamento === 'cancelado',
      completude: o.chamadas[0]?.completude,
      data: o.data,
      horaInicio: o.horaInicio,
      horaFim: o.horaFim,
    });
    // SPEC-057/TASK-001/D4 — corte e `|M ∪ V|` só das candidatas.
    const corte = await this.corteDaPresenca.ler();
    const participantes = await participantesDasCandidatas(
      this.prisma,
      companyId,
      corte,
      ocorrencias.map((o) => ({
        ...paraEstado(o),
        id: o.id,
        turmaId: turmaId,
      })),
      agora,
    );
    const data = ocorrencias.map((o) => {
      const estado = resolverEstadoDaChamada(
        {
          ...paraEstado(o),
          corte,
          participantes: participantes.get(o.id),
        },
        agora,
      );
      const cab = o.chamadas[0];
      return {
        ocupacaoId: o.id,
        data: formatDateOnly(o.data),
        horaInicio: formatTimeOnly(o.horaInicio),
        horaFim: formatTimeOnly(o.horaFim),
        cancelada: o.statusPagamento === 'cancelado',
        // O que o professor precisa ver de relance: o que falta lançar.
        // SPEC-030: deixou de ser `_count.presencas > 0`. Uma turma onde todo
        // mundo faltou tem cabeçalho e zero presenças — e a chamada **foi
        // feita**. A regra antiga mandava o professor lançar de novo.
        chamadaFeita: chamadaJaRegistrada(estado),
        marcados: o._count.presencas,
        totalAlunos: turma._count.alunos,
        // SPEC-027 — **`o.data <= hoje` não bastava.** A aula das 18h de hoje
        // satisfazia a comparação às 8h da manhã, e a tela oferecia lançar
        // presença de uma aula que ninguém tinha dado ainda. Agora o limite de
        // cima é a HORA DE INÍCIO; o limite de baixo (janela retroativa)
        // continua por dia, que é como a INV-017 foi escrita.
        //
        // SPEC-057/TASK-001/D5 — a chamada que nasceu automática usa o prazo
        // do fechamento. Aqui é só a dica da tela; o portão é o do `PUT`,
        // pelo relógio do banco.
        podeLancar:
          o.statusPagamento !== 'cancelado' &&
          aulaJaComecou(o.data, o.horaInicio) &&
          (cab?.origemInicial === 'automatica' && cab.fechadaAutomaticamenteEm
            ? prazoDaAutomatica(cab.fechadaAutomaticamenteEm).getTime() >
              agora.getTime()
            : o.data.getTime() >=
              hoje.getTime() - JANELA_RETROATIVA_DIAS * 24 * 60 * 60 * 1000),
        /**
         * SPEC-027 — o mesmo vocabulário do calendário, para a tela não ter de
         * deduzir. Se ela deduzisse a partir de `podeLancar` + `chamadaFeita`,
         * viraria a segunda cópia da regra — e é sempre a cópia que fica velha.
         *
         * **SPEC-030 — e era exatamente isso que estava acontecendo aqui.** O
         * vocabulário era o mesmo do calendário, a regra não: esta cadeia
         * decidia `feita` por contagem de presenças. Agora vem do resolvedor.
         */
        estado,
      };
    });

    return { data, page, pageSize, total };
  }

  async chamada(
    companyId: string,
    usuarioId: string,
    ocupacaoId: string,
  ): Promise<ChamadaResponseDto> {
    const professor = await this.professorDoUsuario(companyId, usuarioId);
    const ocupacao = await this.ocorrenciaDoProfessor(
      companyId,
      professor.id,
      ocupacaoId,
    );

    const [presencas, matriculados, cabecalho, faltas, reposicoes] =
      await Promise.all([
        this.prisma.presenca.findMany({
          where: { ocupacaoId },
          include: {
            aluno: { include: { usuario: { select: { nome: true } } } },
          },
        }),
        this.prisma.turmaAluno.findMany({
          where: { turmaId: ocupacao.origemTurmaId },
          include: {
            aluno: { include: { usuario: { select: { nome: true } } } },
          },
        }),
        this.prisma.chamada.findUnique({ where: { ocupacaoId } }),
        // SPEC-031/AC-019. Sem filtro de status da ocupação: a falta de uma aula
        // cancelada continua aparecendo, que é o D14.
        this.prisma.faltaAvisada.findMany({
          where: { ocupacaoId },
          select: { alunoId: true },
        }),
        // SPEC-046/AC-015 — quem vem REPOR nesta ocorrência. Sem esta consulta o
        // professor não veria o visitante, e a reposição inteira não serviria
        // para nada: o aluno chegaria e não estaria na lista.
        this.prisma.reposicaoDeAula.findMany({
          where: { ocupacaoId },
          select: {
            alunoId: true,
            aluno: { select: { usuario: { select: { nome: true } } } },
          },
        }),
      ]);
    const avisaram = new Set(faltas.map((f) => f.alunoId));
    const repondo = new Set(reposicoes.map((r) => r.alunoId));
    // SPEC-076/D11 — o mesmo provedor do portão, uma leitura por pedido.
    const agora = await this.relogio.agora(this.prisma);

    // SPEC-015/AC-000c — o que devolver depende da **completude declarada
    // pelo cabeçalho**, não de haver ou não linhas em `presencas`.
    //
    // Era daí que vinha a DEF-002: duas linhas significam tanto "chamada
    // completa de uma turma de 2" quanto "chamada pela metade de uma turma
    // de 10". Devolver sempre o snapshot escondia os alunos que faltavam
    // marcar; devolver sempre a união obrigaria o professor a marcar quem
    // entrou na turma depois da aula (contra-exemplo da 2ª validação
    // cruzada). Com o cabeçalho, os dois casos deixam de se confundir.
    //
    // Cabeçalho ausente **com** presenças é o legado — inclusive o que
    // instâncias antigas possam gravar na janela entre este deploy e o
    // `contract`. Trata igual a `desconhecida`, que é o que o backfill vai
    // registrar.
    // **SPEC-030 / achado 1 da validação cruzada (ALTA) — e este era o pior
    // defeito do ciclo.**
    //
    // Esta cadeia era um ternário de dois casos: `completa`, ou tudo o mais
    // vira `desconhecida`. Quando `nao_houve` nasceu, ele caiu no "tudo o
    // mais" — então o professor registrava que a aula não aconteceu, a tela
    // relia, e recebia `desconhecida`: **o aviso de "chamada legada, confira
    // e salve de novo"**, exatamente o oposto do que ele acabara de dizer.
    //
    // O `GET` prometia `nao_houve` no contrato publicado e devolvia outra
    // coisa. **A prova do `Cliente` não pegou porque ela mockava a releitura
    // já com `nao_houve`** — o teste dublou justamente a parte sob julgamento.
    //
    // Agora o valor do cabeçalho **passa direto**. Ausência de cabeçalho
    // continua sendo `null` quando não há nada, e `desconhecida` quando há
    // presenças sem cabeçalho — que é o legado descrito acima.
    const semRegistro = presencas.length === 0 && !cabecalho;
    const completude: CompletudeChamada | null = semRegistro
      ? null
      : (cabecalho?.completude ?? 'desconhecida');
    const completa = completude === 'completa';

    const doSnapshot: LinhaDaChamada[] = presencas.map((p) => ({
      alunoId: p.alunoId,
      nome: p.aluno.usuario.nome,
      status: p.status,
      naTurmaHoje: matriculados.some((m) => m.alunoId === p.alunoId),
      faltaAvisada: avisaram.has(p.alunoId),
      reposicao: repondo.has(p.alunoId),
    }));
    const noSnapshot = new Set(presencas.map((p) => p.alunoId));
    const naTurma = new Set(matriculados.map((m) => m.alunoId));

    // INV-020, agora estrita: chamada **completa** não ganha aluno novo ao
    // ser reaberta.
    const alunos = completa
      ? doSnapshot
      : [
          ...doSnapshot,
          ...matriculados
            .filter((m) => !noSnapshot.has(m.alunoId))
            .map((m): LinhaDaChamada => ({
              alunoId: m.alunoId,
              nome: m.aluno.usuario.nome,
              status: null,
              naTurmaHoje: true,
              faltaAvisada: avisaram.has(m.alunoId),
              // SPEC-057/TASK-001/D4 — `M ∩ V`: matriculado depois de marcar
              // a reposição. Uma linha só, com as duas marcas verdadeiras.
              reposicao: repondo.has(m.alunoId),
            })),
          // SPEC-046/AC-015 — quem vem REPOR. Entra pela mesma porta dos
          // matriculados e obedece à mesma INV-020: chamada **completa** não
          // ganha visitante ao ser reaberta.
          //
          // `naTurmaHoje: false` é a verdade — ele não é da turma —, e é por
          // isso que `reposicao` precisa existir ao lado: só o primeiro campo
          // faria a tela dizer "saiu da turma" sobre quem nunca esteve nela.
          // SPEC-057/TASK-001/D4 — **a lista nunca repete ID**: quem já está
          // no snapshot ou em `M` não entra de novo por `V`.
          ...reposicoes
            .filter(
              (r) => !noSnapshot.has(r.alunoId) && !naTurma.has(r.alunoId),
            )
            .map((r): LinhaDaChamada => ({
              alunoId: r.alunoId,
              nome: r.aluno.usuario.nome,
              status: null,
              naTurmaHoje: false,
              faltaAvisada: false,
              reposicao: true,
            })),
        ];

    return {
      ocupacaoId,
      turmaId: ocupacao.origemTurmaId,
      data: formatDateOnly(ocupacao.data),
      horaInicio: formatTimeOnly(ocupacao.horaInicio),
      horaFim: formatTimeOnly(ocupacao.horaFim),
      cancelada: ocupacao.statusPagamento === 'cancelado',
      completude,
      origem: cabecalho?.origem ?? null,
      origemInicial: cabecalho?.origemInicial ?? null,
      corrigivelAte:
        cabecalho?.origemInicial === 'automatica' &&
        cabecalho.fechadaAutomaticamenteEm
          ? prazoDaAutomatica(cabecalho.fechadaAutomaticamenteEm).toISOString()
          : null,
      desfazerNaoHouveAte: limiteDoDesfazerNaoHouve(
        cabecalho,
        ocupacao.data,
        agora,
      ),
      // SPEC-057/TASK-001/D4 — `M ∪ V ∪ S`. SPEC-076: sem uso de escrita.
      versao: this.versaoDe(presencas, cabecalho, [
        ...matriculados,
        ...reposicoes,
      ]),
      alunos: alunos.sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
    };
  }

  /**
   * SPEC-030:TASK-004 — **registrar que a aula não aconteceu.**
   *
   * O problema que isto resolve: choveu, e ninguém tinha caminho para dizer
   * isso. A ocorrência ficava sem cabeçalho, a aula já tinha terminado, e o
   * calendário do professor marcava "chamada pendente" **para sempre** — um
   * ponto vermelho que ele não conseguia zerar sem mentir que deu a aula.
   *
   * **Não é cancelar a aula, e a diferença é o eixo da spec.** Cancelar
   * libera o slot da quadra (a `EXCLUDE` ignora `cancelado`) e é decisão do
   * gestor sobre a grade — segue sem caminho para ocorrência de turma
   * (GAP-008/LIM-030b). Aqui a quadra **esteve** ocupada; o que muda é só o
   * que o produto sabe sobre a aula.
   *
   * Escrevemos no cabeçalho e não em `ocupacoes_quadra` porque `chamadas` é
   * de MOD-004, e `ocupacoes_quadra` é propriedade exclusiva de MOD-005
   * (TARGET_ARCHITECTURE.md seção 5).
   */
  async registrarNaoHouve(
    companyId: string,
    ocupacaoId: string,
    usuarioId: string,
    comoProfessor: boolean,
    /**
     * **Ressalva contratual da validação cruzada.** A rota do gestor é
     * aninhada (`/classes/:turmaId/presencas/:ocupacaoId/nao-houve`) e o
     * `turmaId` era ignorado: `PUT /classes/turma-A/.../ocupacao-da-turma-B`
     * devolvia `200` e alterava **B**. Não escalava privilégio — a empresa
     * continua no `WHERE` —, mas uma URL aninhada que altera outro recurso
     * quebra o contrato do próprio caminho, e quem lê o log vê a turma
     * errada.
     *
     * `undefined` para a rota do professor, que não é aninhada em turma.
     */
    turmaIdDaRota?: string,
  ): Promise<{ ocupacaoId: string; completude: string }> {
    // INV-018 — o `professorId` vem do BANCO, pelo usuário autenticado, e
    // **não** do JWT: claim é fotografia do login, autorização precisa do
    // presente. O controller não tem como passar este id, e é por isso que
    // ele passa um booleano de papel em vez do escopo pronto — na primeira
    // versão desta rota eu passei `user.sub` como escopo, que é o id do
    // usuário e nunca bate com `turmas.professor_id`.
    const professorIdScope = comoProfessor
      ? (await this.professorDoUsuario(companyId, usuarioId)).id
      : undefined;

    return this.prisma.$transaction(async (tx) => {
      // O portão comum, e é de propósito: aula cancelada (`AULA_CANCELADA`),
      // aula futura (`AULA_FUTURA`) e janela (`AULA_ANTIGA`) valem igual para
      // registrar e para desfazer (SPEC-076/D3).
      // A URL precisa dizer a verdade sobre o que altera, e a conferência
      // roda DENTRO do portão, no grupo dos 404 — ver o comentário lá.
      const { cabecalho: atual } = await this.travarEValidarOcorrencia(
        tx,
        companyId,
        ocupacaoId,
        professorIdScope,
        turmaIdDaRota,
      );
      const origem: OrigemHumana = comoProfessor ? 'professor' : 'gestor';

      // SPEC-057/TASK-001/D5 — **a exceção estreita.** A chamada automática
      // que ninguém revisou é presunção, não registro de quem esteve lá: se a
      // aula não aconteceu, quem podia lançar pode dizer isso, e as presenças
      // presumidas saem. O prazo (fechamento + 7 dias) já foi conferido pelo
      // portão acima, sob o mesmo lock. Automática **ratificada** não entra
      // aqui: uma pessoa afirmou a lista, e vale a LIM-030d de sempre.
      const automaticaNaoRatificada = atual?.origem === 'automatica';

      // LIM-030d — **não sobrescreve chamada com presença.** O AC-012 já
      // decidiu que cancelar depois não desfaz quem esteve lá; apagar
      // presenças aqui contradiria isso, e em silêncio.
      //
      // Não é o caminho de ninguém por acidente: se há presença, o dia já
      // saiu do vermelho, então não há motivo para vir aqui. Quem vier
      // mesmo assim está corrigindo um engano, e o caminho é apagar a
      // chamada primeiro — explicitamente.
      const comPresenca = await tx.presenca.count({ where: { ocupacaoId } });
      if (comPresenca > 0 && automaticaNaoRatificada) {
        await tx.presenca.deleteMany({ where: { ocupacaoId } });
      } else if (comPresenca > 0) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'CHAMADA_COM_PRESENCA',
          message:
            'Esta aula já tem presenças lançadas. Apague a chamada antes de ' +
            'registrar que a aula não aconteceu.',
        });
      }

      // `upsert`, e não `create`: repetir a ação não é engano do usuário, é
      // rede instável — a mesma razão pela qual `cancelBooking` é
      // idempotente. E cobre a promoção de um cabeçalho `desconhecida` sem
      // presença, que é chamada legada vazia.
      //
      // `esperados: null` é obrigação do CHECK
      // (`chamadas_completude_esperados_check`): quem diz que a aula não
      // aconteceu não afirma sobre quantos alunos eram esperados.
      const cabecalho = await tx.chamada.upsert({
        where: { ocupacaoId },
        create: {
          ocupacaoId,
          origemTipo: 'TURMA',
          companyId,
          registradaPor: usuarioId,
          // SPEC-057/TASK-001/D1 — código novo declara as duas origens.
          origem,
          origemInicial: origem,
          completude: 'nao_houve',
          esperados: null,
        },
        // REQ-004a/D1b — `registradaPor` é reescrito também no update: quem
        // registrou por ÚLTIMO é a resposta útil quando o gestor fecha a
        // aula de um professor que saiu do clube.
        //
        // SPEC-057/TASK-001/D1 — `origemInicial` **não** é escrita no update:
        // como a chamada nasceu não muda (LIM-057j).
        update: {
          registradaPor: usuarioId,
          origem,
          completude: 'nao_houve',
          esperados: null,
        },
        select: { ocupacaoId: true, completude: true },
      });

      return cabecalho;
    });
  }

  /**
   * SPEC-076/D3 — **desfazer "a aula não aconteceu"** (decisões 3 e 5).
   *
   * Era possível só por um `PUT` da chamada por cima (SPEC-030/D4), e esse
   * `PUT` saiu (D1). Agora é rota própria, para o professor e para o gestor,
   * pelo **mesmo portão** de registrar — mesma janela, mesmos `404`/`422`.
   *
   * **Só escreve quando há `nao_houve` gravado** (INV-076c): lido sob a raiz,
   * no portão. Sem ele, devolve o estado atual e não toca em nada — o retry
   * depois de um refechamento não apaga a chamada nova (AC-012).
   *
   * - **nasceu sobre chamada automática** (há `fechada_automaticamente_em`):
   *   a aula é **refechada na hora**, pela mesma função do worker, com **o
   *   mesmo instante de fechamento** — se desfazer deixasse o worker refechar,
   *   o instante seria novo e os sete dias recomeçariam (INV-076f). `M ∪ V`
   *   vazio → o cabeçalho sai e a aula vira `sem_participantes`;
   * - **nasceu humano**: o cabeçalho sai. Pós-corte, o worker a fecha no
   *   próximo tick (o primeiro fechamento dela); anterior ao corte, vira
   *   `sem_registro`.
   */
  async desfazerNaoHouve(
    companyId: string,
    ocupacaoId: string,
    usuarioId: string,
    comoProfessor: boolean,
    turmaIdDaRota?: string,
  ): Promise<NaoHouveDesfeitoResponseDto> {
    const professorIdScope = comoProfessor
      ? (await this.professorDoUsuario(companyId, usuarioId)).id
      : undefined;

    const turmaId = await this.prisma.$transaction(async (tx) => {
      const { origemTurmaId, cabecalho } = await this.travarEValidarOcorrencia(
        tx,
        companyId,
        ocupacaoId,
        professorIdScope,
        turmaIdDaRota,
      );
      if (cabecalho?.completude !== 'nao_houve') return origemTurmaId;

      if (cabecalho.fechadaAutomaticamenteEm) {
        const participantes = await participantesDaOcorrencia(
          tx,
          companyId,
          origemTurmaId,
          ocupacaoId,
        );
        if (participantes.length === 0) {
          await tx.chamada.delete({ where: { ocupacaoId } });
          return origemTurmaId;
        }
        // Um UPDATE só: `completa` e `automatica` andam juntos, e o gatilho da
        // D10 recusaria `completa` com origem humana. O instante NÃO é
        // escrito — `chamadas_fechamento_imutavel` recusaria trocá-lo.
        await tx.$executeRaw`
          UPDATE chamadas
             SET completude = 'completa'::completude_chamada,
                 origem = 'automatica',
                 registrada_por = NULL,
                 esperados = ${participantes.length}::int,
                 updated_at = timezone('UTC', clock_timestamp())
           WHERE ocupacao_id = ${ocupacaoId}::uuid
        `;
        await gravarPresencasDoFechamento(
          tx,
          companyId,
          ocupacaoId,
          participantes,
        );
        return origemTurmaId;
      }

      await tx.chamada.delete({ where: { ocupacaoId } });
      return origemTurmaId;
    });

    return {
      ocupacaoId,
      estado: await this.estadoAtual(companyId, turmaId, ocupacaoId),
    };
  }

  /** O estado de UMA ocorrência, pelo resolvedor, depois de escrever. */
  private async estadoAtual(
    companyId: string,
    turmaId: string,
    ocupacaoId: string,
  ): Promise<EstadoDaChamada> {
    const o = await this.prisma.ocupacaoQuadra.findFirstOrThrow({
      where: { id: ocupacaoId, companyId },
      select: {
        id: true,
        data: true,
        horaInicio: true,
        horaFim: true,
        statusPagamento: true,
        chamadas: { select: { completude: true } },
      },
    });
    const agora = await this.relogio.agora(this.prisma);
    const paraEstado = {
      cancelada: o.statusPagamento === 'cancelado',
      completude: o.chamadas[0]?.completude,
      data: o.data,
      horaInicio: o.horaInicio,
      horaFim: o.horaFim,
    };
    const corte = await this.corteDaPresenca.ler();
    const participantes = await participantesDasCandidatas(
      this.prisma,
      companyId,
      corte,
      [{ ...paraEstado, id: o.id, turmaId }],
      agora,
    );
    return resolverEstadoDaChamada(
      { ...paraEstado, corte, participantes: participantes.get(o.id) },
      agora,
    );
  }

  /**
   * SPEC-014/AC-009 e LIM-002 — o histórico do gestor. **Só leitura.**
   *
   * O gestor não corrige chamada nesta spec, e o custo está declarado: se o
   * professor sair do clube, uma chamada errada dele não tem quem conserte.
   * Preferi isso a expor um contrato de escrita sem tela que o use.
   */
  async historicoDaTurma(
    companyId: string,
    turmaId: string,
    dias: number,
  ): Promise<OcorrenciaNoHistoricoResponseDto[]> {
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: { id: true },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    const desde = new Date(this.hoje());
    desde.setUTCDate(desde.getUTCDate() - dias);

    const ocorrencias = await this.prisma.ocupacaoQuadra.findMany({
      where: {
        companyId,
        origemTipo: 'TURMA',
        origemTurmaId: turmaId,
        data: { gte: desde },
      },
      include: {
        presencas: {
          include: {
            aluno: { include: { usuario: { select: { nome: true } } } },
            registrante: { select: { nome: true } },
          },
        },
        // SPEC-030 — o cabeçalho entrou aqui por duas razões.
        //
        // 1. O estado: esta lista decidia "chamada feita" por
        //    `presencas.length > 0`, a **terceira** regra diferente para a
        //    mesma pergunta. Agora vem do resolvedor, que precisa da
        //    `completude`.
        // 2. `registradoPor`: com `nao_houve` não há nenhuma presença, então
        //    `presencas[0].registrante` seria nulo e o gestor não veria quem
        //    fechou a aula — que é justamente o caso que motivou a SPEC-030
        //    (professor saiu do clube, gestor fechou).
        chamadas: {
          select: {
            completude: true,
            origem: true,
            origemInicial: true,
            // SPEC-076/D3 — o limite do "Desfazer" depende de como nasceu.
            fechadaAutomaticamenteEm: true,
            registrante: { select: { nome: true } },
          },
        },
        // DEF-035 — quem estava ali REPONDO. Sem isso o histórico do gestor
        // marca o visitante como "saiu da turma", que é uma acusação falsa
        // sobre alguém que nunca esteve nela.
        reposicoes: { select: { alunoId: true } },
      },
      orderBy: [{ data: 'desc' }],
    });
    // SPEC-076/D11 — o relógio do portão, para o `desfazerNaoHouveAte` e o
    // estado saírem do mesmo instante.
    const agora = await this.relogio.agora(this.prisma);
    const paraEstado = (o: (typeof ocorrencias)[number]) => ({
      cancelada: o.statusPagamento === 'cancelado',
      completude: o.chamadas[0]?.completude,
      data: o.data,
      horaInicio: o.horaInicio,
      horaFim: o.horaFim,
    });
    // SPEC-057/TASK-001/D4 — o mesmo estado que o professor vê.
    const corte = await this.corteDaPresenca.ler();
    const participantes = await participantesDasCandidatas(
      this.prisma,
      companyId,
      corte,
      ocorrencias.map((o) => ({ ...paraEstado(o), id: o.id, turmaId })),
      agora,
    );

    const matriculados = await this.prisma.turmaAluno.findMany({
      where: { turmaId },
      select: { alunoId: true },
    });
    const naTurma = new Set(matriculados.map((m) => m.alunoId));

    return ocorrencias.map((o) => {
      const cabecalho = o.chamadas[0];
      const estado = resolverEstadoDaChamada(
        { ...paraEstado(o), corte, participantes: participantes.get(o.id) },
        agora,
      );
      const repondo = new Set(o.reposicoes.map((r) => r.alunoId));
      return {
        ocupacaoId: o.id,
        data: formatDateOnly(o.data),
        horaInicio: formatTimeOnly(o.horaInicio),
        horaFim: formatTimeOnly(o.horaFim),
        // AC-012: aula cancelada depois não desfaz quem esteve lá — por isso
        // a chamada continua aqui, com a aula marcada como cancelada.
        cancelada: o.statusPagamento === 'cancelado',
        // SPEC-030: era `o.presencas.length > 0`.
        chamadaFeita: chamadaJaRegistrada(estado),
        estado,
        // O cabeçalho primeiro: ele existe em toda chamada, inclusive na
        // `nao_houve`, que não tem nenhuma presença. As presenças ficam como
        // segunda fonte para as chamadas antigas — as de antes da SPEC-015
        // (`legada`) podem ter presença sem cabeçalho registrado por ninguém.
        //
        // SPEC-057/TASK-001/D1 — na automática não há autor em lugar nenhum,
        // e `null` é a verdade: `origem` ao lado diz por quê.
        registradoPor:
          cabecalho?.registrante?.nome ??
          o.presencas[0]?.registrante?.nome ??
          null,
        origem: cabecalho?.origem ?? null,
        origemInicial: cabecalho?.origemInicial ?? null,
        desfazerNaoHouveAte: limiteDoDesfazerNaoHouve(
          cabecalho ?? null,
          o.data,
          agora,
        ),
        alunos: o.presencas
          .map((p) => ({
            alunoId: p.alunoId,
            nome: p.aluno.usuario.nome,
            status: p.status,
            // Sinalizadores em vez de bloqueio: a spec decidiu que alocação é
            // o único requisito para marcar presença, e que o gestor vê quem
            // já não está ativo ou já não está na turma.
            naTurmaHoje: naTurma.has(p.alunoId),
            // DEF-035 — a marca que separa "veio repor" de "saiu da turma".
            reposicao: repondo.has(p.alunoId),
            alunoAtivo: p.aluno.status === 'ativo',
          }))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
      };
    });
  }
}

/**
 * SPEC-076/D3 — **até quando o `nao_houve` desta aula pode ser desfeito**, o
 * mesmo limite do portão: `fechada_automaticamente_em + 7 dias` se a chamada
 * nasceu automática; o fim da janela retroativa da data da aula se não — o
 * portão aceita enquanto o dia do clube de `agora` for até `data + 7`, então o
 * limite é a meia-noite do dia `data + 8` no fuso do clube.
 *
 * Não nulo **só** quando há `nao_houve` gravado e `agora` está dentro dele. A
 * tela mostra "Desfazer (até …)" com esta data; sem ela, não mostra — é assim
 * que o frontend novo fica certo com o Back antigo, que não manda o campo
 * (D12). Nunca "7 dias a partir do último gesto".
 */
export function limiteDoDesfazerNaoHouve(
  cabecalho: {
    completude: CompletudeChamada;
    fechadaAutomaticamenteEm: Date | null;
  } | null,
  dataDaAula: Date,
  agora: Date,
): string | null {
  if (cabecalho?.completude !== 'nao_houve') return null;
  let limite: Date;
  if (cabecalho.fechadaAutomaticamenteEm) {
    limite = prazoDaAutomatica(cabecalho.fechadaAutomaticamenteEm);
  } else {
    const diaSeguinteAoPrazo = new Date(dataDaAula);
    diaSeguinteAoPrazo.setUTCDate(
      diaSeguinteAoPrazo.getUTCDate() + JANELA_RETROATIVA_DIAS + 1,
    );
    limite = instanteNoFusoDoClube(diaSeguinteAoPrazo, new Date(0));
  }
  return limite.getTime() > agora.getTime() ? limite.toISOString() : null;
}

/** SPEC-057/TASK-001/D5 — fechamento automático + janela, para exibição. */
function prazoDaAutomatica(fechadaEm: Date): Date {
  const prazo = new Date(fechadaEm);
  prazo.setUTCDate(prazo.getUTCDate() + JANELA_DA_AUTOMATICA_DIAS);
  return prazo;
}
