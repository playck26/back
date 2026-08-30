import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { OcupacaoQuadra, Prisma, StatusPresenca } from '@prisma/client';
import {
  ChamadaResponseDto,
  ChamadaSalvaResponseDto,
  OcorrenciaDaTurmaResponseDto,
} from './dto/me-response.dto';
import { OcorrenciaNoHistoricoResponseDto } from './dto/presenca-historico-response.dto';
import {
  chamadaJaRegistrada,
  resolverEstadoDaChamada,
} from './estado-da-chamada';
import {
  aulaJaComecou,
  formatDateOnly,
  formatTimeOnly,
  hojeNoFusoDoClube,
} from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';

/** SPEC-014/INV-017: janela em que a chamada pode ser lançada. */
export const JANELA_RETROATIVA_DIAS = 7;

/** Uma linha da tela de chamada: o aluno e o que está marcado para ele. */
export interface LinhaDaChamada {
  alunoId: string;
  nome: string;
  status: StatusPresenca | null;
  naTurmaHoje: boolean;
}

export interface ItemChamada {
  alunoId: string;
  status: StatusPresenca;
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
  constructor(private readonly prisma: PrismaService) {}

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
    matriculados: { alunoId: string }[],
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
    const ids = matriculados.map((m) => m.alunoId).sort();
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
   * chamada. Era o começo de `salvarChamada`; virou método próprio quando
   * `registrarNaoHouve` passou a precisar exatamente das mesmas guardas.
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
  ): Promise<{
    origemTurmaId: string;
    data: Date;
    horaInicio: Date;
    statusPagamento: string;
    professorId: string | null;
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

    // INV-016 (a metade que o banco não impõe): é regra de escrita.
    if (ocupacao.statusPagamento === 'cancelado') {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_CANCELADA',
        message: 'Esta aula foi cancelada e não recebe chamada.',
      });
    }

    // INV-017. O limite futuro impede a chamada de virar previsão — o caso
    // real é banal: o professor abre a grade da semana e toca na linha
    // errada. O limite passado existe porque a turma de hoje deixa de ser um
    // retrato confiável do que era há muito tempo (LIM-003).
    const hoje = this.hoje().getTime();
    const dia = ocupacao.data.getTime();
    // SPEC-027 — **o portão passou a olhar a HORA, não só o dia.**
    //
    // Era `dia > hoje`, e por isso a aula das 18h de hoje aceitava chamada às
    // 8h da manhã. **Isto é o portão de verdade, e a tela não substitui:**
    // esconder o botão resolve o engano honesto; só o servidor resolve o
    // pedido montado à mão.
    if (!aulaJaComecou(ocupacao.data, ocupacao.horaInicio)) {
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
    if (dia < hoje - JANELA_RETROATIVA_DIAS * 24 * 60 * 60 * 1000) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'AULA_ANTIGA',
        message: `A chamada pode ser lançada em até ${JANELA_RETROATIVA_DIAS} dias após a aula.`,
      });
    }

    return ocupacao;
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
        chamadas: { select: { completude: true } },
      },
      // SPEC-027 — `id` como desempate: `data` + `horaInicio` não é ordem
      // total, e com `skip`/`take` isso faz linha aparecer em duas páginas e
      // sumir de outra.
      orderBy: [{ data: 'desc' }, { horaInicio: 'desc' }, { id: 'desc' }],
    });

    const hoje = this.hoje();
    const data = ocorrencias.map((o) => {
      const estado = resolverEstadoDaChamada({
        cancelada: o.statusPagamento === 'cancelado',
        completude: o.chamadas[0]?.completude,
        data: o.data,
        horaInicio: o.horaInicio,
        horaFim: o.horaFim,
      });
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
        podeLancar:
          o.statusPagamento !== 'cancelado' &&
          aulaJaComecou(o.data, o.horaInicio) &&
          o.data.getTime() >=
            hoje.getTime() - JANELA_RETROATIVA_DIAS * 24 * 60 * 60 * 1000,
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

    const [presencas, matriculados, cabecalho] = await Promise.all([
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
    ]);

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
    const completa = cabecalho?.completude === 'completa';
    const semRegistro = presencas.length === 0 && !cabecalho;
    const completude: 'completa' | 'desconhecida' | null = semRegistro
      ? null
      : completa
        ? 'completa'
        : 'desconhecida';

    const doSnapshot: LinhaDaChamada[] = presencas.map((p) => ({
      alunoId: p.alunoId,
      nome: p.aluno.usuario.nome,
      status: p.status,
      naTurmaHoje: matriculados.some((m) => m.alunoId === p.alunoId),
    }));

    // INV-020, agora estrita: chamada **completa** não ganha aluno novo ao
    // ser reaberta.
    const alunos = completa
      ? doSnapshot
      : [
          ...doSnapshot,
          ...matriculados
            .filter((m) => !presencas.some((p) => p.alunoId === m.alunoId))
            .map((m): LinhaDaChamada => ({
              alunoId: m.alunoId,
              nome: m.aluno.usuario.nome,
              status: null,
              naTurmaHoje: true,
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
      versao: this.versaoDe(presencas, cabecalho, matriculados),
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
      // As mesmas guardas de `salvarChamada`, e é de propósito: aula
      // cancelada (`AULA_CANCELADA`), aula futura (`AULA_FUTURA`) e janela
      // retroativa (`AULA_ANTIGA`) valem igual. Quem não pode lançar chamada
      // também não pode declarar que não houve aula.
      await this.travarEValidarOcorrencia(
        tx,
        companyId,
        ocupacaoId,
        professorIdScope,
      );

      // LIM-030d — **não sobrescreve chamada com presença.** O AC-012 já
      // decidiu que cancelar depois não desfaz quem esteve lá; apagar
      // presenças aqui contradiria isso, e em silêncio.
      //
      // Não é o caminho de ninguém por acidente: se há presença, o dia já
      // saiu do vermelho, então não há motivo para vir aqui. Quem vier
      // mesmo assim está corrigindo um engano, e o caminho é apagar a
      // chamada primeiro — explicitamente.
      const comPresenca = await tx.presenca.count({ where: { ocupacaoId } });
      if (comPresenca > 0) {
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
          completude: 'nao_houve',
          esperados: null,
        },
        // REQ-004a/D1b — `registradaPor` é reescrito também no update: quem
        // registrou por ÚLTIMO é a resposta útil quando o gestor fecha a
        // aula de um professor que saiu do clube.
        update: {
          registradaPor: usuarioId,
          completude: 'nao_houve',
          esperados: null,
        },
        select: { ocupacaoId: true, completude: true },
      });

      return cabecalho;
    });
  }

  async salvarChamada(
    companyId: string,
    usuarioId: string,
    ocupacaoId: string,
    versao: string,
    itens: ItemChamada[],
  ): Promise<ChamadaSalvaResponseDto> {
    // SPEC-015/AC-000i (v10, BLOQUEADOR da 8ª rodada) — só isto fica fora
    // da transação, e fica porque é de OUTRO agregado: "este usuário é
    // professor desta empresa?" se resolve em `professores`, que o lock da
    // turma não cobre e não deveria cobrir.
    //
    // Tudo o que depende da TURMA — quem é o dono dela e qual é o estado da
    // ocorrência — mudou de lugar na v10: desceu para dentro da transação,
    // depois do lock. A v9 lia isso aqui em cima e chamava o `FOR UPDATE`
    // de "passo 0" sem ser: entre autorizar e travar cabia um
    // `ClassesService.update` trocando o professor, e o `PUT` gravava sem
    // revalidar. Provado em `bloq8-autorizacao.ts`.
    const professor = await this.professorDoUsuario(companyId, usuarioId);

    const idsRecebidos = itens.map((i) => i.alunoId);
    if (new Set(idsRecebidos).size !== idsRecebidos.length) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'ALUNO_REPETIDO',
        message: 'O mesmo aluno apareceu duas vezes na chamada.',
      });
    }

    // AC-006 — alocação é o **único** requisito. `alunos.status` e
    // `vinculo` não bloqueiam, e isso é decisão registrada na spec:
    // presença registra o que aconteceu, e quem assistiu segunda e foi
    // desligado terça esteve lá na segunda.
    //
    // SPEC-015/INV-026 — os **esperados** são a união de "matriculados
    // hoje" com "já registrados nesta ocorrência". A união, e não só os
    // matriculados, porque corrigir a chamada de quem saiu da turma depois
    // precisa continuar possível (AC-004 da SPEC-014) — antes disso ele
    // caía no 422 abaixo e a correção era recusada.
    // SPEC-015/INV-028 (BLOQ-2 da 6ª validação cruzada) — nada de regra de
    // domínio sobre estado compartilhado ANTES da checagem de versão. Ler
    // fora da transação e validar antes do controle otimista faz uma aba
    // desatualizada levar 422 acusando um aluno invisível, quando a resposta
    // certa é 409 "recarregue". Daqui para baixo tudo é lido dentro da
    // transação, e a versão é a primeira coisa conferida.

    // SPEC-015/DEF-002/INV-026 — chamada salva é completa.
    //
    // A mensagem é deliberadamente **acionável para cliente antigo**
    // (AC-000e): na janela entre a publicação da tela nova e este deploy,
    // um professor com o bundle velho manda só os alunos que tocou e cai
    // aqui. Ele não tem como saber que existe uma janela; o texto precisa
    // dizer o que fazer.
    return this.prisma.$transaction(async (tx) => {
      // SPEC-015/AC-000i (v9, BLOQ-1 da 7ª rodada) — o passo 0, e ele é o
      // que torna a ordem dos passos 1..5 uma garantia em vez de uma
      // promessa. Ler dentro da transação NÃO congela o que foi lido:
      // em READ COMMITTED cada statement pega um snapshot novo, então
      // `turma_alunos` pode mudar e commitar entre o passo 1 e o passo 5,
      // e a versão — conferida no passo 2 — já passou. O resultado é
      // gravar sobre domínio velho sem 409 nenhum. Provado por execução
      // em `bloq7-concorrencia.ts`, cenário 1.
      //
      // Isolamento não resolve, e a razão não é a que a v9 dava aqui.
      // Dizia-se que SERIALIZABLE só garante entre transações que estejam
      // todas em SERIALIZABLE, e que bastaria pôr todo mundo lá. Medido:
      // com os DOIS lados em SERIALIZABLE o `PUT` continua sendo aceito
      // (cenários 7 e 8 de `bloq7-concorrencia.ts`).
      //
      // A razão verdadeira: ao banco basta existir ALGUMA ordem serial
      // válida, e "PUT antes da matrícula" é uma delas — serializável, e
      // ainda assim o que a regra de produto proíbe. SSI detecta anomalia,
      // não impõe a ordem que o domínio quer. O lock pessimista impõe.
      //
      // O lock na linha da turma resolve, e não é disciplina nova: é a
      // MESMA de REQ-004/INV-003 que `ClassesService.allocateStudent` já
      // usa em produção. Raw query porque `FOR UPDATE` não é expressável
      // no query builder do Prisma.
      //
      // Só vale acompanhado do par em `removeStudent` (v9, peça 2): lock
      // de um lado só não trava nada. A entrada está protegida de graça
      // pela FK `turma_alunos -> turmas`, que obriga o INSERT a pegar
      // `FOR KEY SHARE` na turma; a SAÍDA não, porque DELETE de filho não
      // checa FK no pai. Cenários 4 e 5.
      // O passo 0 são DOIS statements, e a ordem entre eles é o contrato:
      // **travar primeiro, ler depois**.
      //
      // A v10 fazia num ato só — um JOIN com `FOR UPDATE OF t` — e isso
      // parecia bastar. Não basta, e o BLOQUEADOR da 9ª rodada mostrou por
      // quê: em READ COMMITTED o snapshot é do STATEMENT. Quando esse
      // statement esbarra no lock de `turmas` e espera, o Postgres, ao ser
      // liberado, reavalia só a linha travada (EvalPlanQual) — as outras
      // relações do JOIN continuam com o snapshot de antes da espera.
      //
      // É por isso que a v10 acertava a troca de professor (`professor_id`
      // vem de `t`, a relação travada, e é reavaliada) e errava o
      // cancelamento (`status_pagamento` vem de `o`, que não é). Medido em
      // `bloq9-snapshot.ts`: o JOIN devolveu `pendente_pagamento` com o
      // banco já em `cancelado`; uma releitura em statement novo, com o
      // lock na mão, devolveu `cancelado`.
      //
      // Continua travando SÓ `turmas`: raiz única é o que garante ordem de
      // aquisição única (INV-029) e, portanto, ausência de deadlock. E não
      // faz falta travar a ocorrência — o único caminho que cancela
      // ocorrência de TURMA é `cancelFutureClassOccupancies`, chamado de
      // dentro do `ClassesService.update`, que trava esta mesma linha
      // antes. Os outros dois (`cancelBooking`, `updatePaymentStatus`)
      // recusam ocorrência de turma com `OCUPACAO_DE_TURMA`.

      const ocupacao = await this.travarEValidarOcorrencia(
        tx,
        companyId,
        ocupacaoId,
        professor.id,
      );

      const [atuais, cabecalhoAtual, matriculados] = await Promise.all([
        tx.presenca.findMany({
          where: { ocupacaoId },
          select: { alunoId: true, updatedAt: true },
        }),
        tx.chamada.findUnique({ where: { ocupacaoId } }),
        tx.turmaAluno.findMany({
          where: { turmaId: ocupacao.origemTurmaId },
          select: { alunoId: true },
        }),
      ]);

      // INV-019 — controle otimista, e é a PRIMEIRA regra a rodar. Qualquer
      // recusa de domínio antes dela poderia estar julgando uma tela velha
      // com o estado novo.
      if (this.versaoDe(atuais, cabecalhoAtual, matriculados) !== versao) {
        throw new ConflictException({
          statusCode: 409,
          code: 'CHAMADA_DESATUALIZADA',
          message:
            'Esta chamada mudou desde que você abriu. Recarregue para ver o estado atual.',
        });
      }

      // SPEC-015/DEF-006 — teto e piso são conjuntos DIFERENTES. Usar um só
      // para os dois papéis era o defeito: com cabeçalho `completa` o `GET`
      // devolve o snapshot, e a escrita exigia a união — então salvar de
      // volta o que a tela mostrou virava 422.
      const permitidos = new Set([
        ...matriculados.map((m) => m.alunoId),
        ...atuais.map((p) => p.alunoId),
      ]);
      const forasteiros = idsRecebidos.filter((id) => !permitidos.has(id));
      if (forasteiros.length > 0) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'ALUNO_FORA_DA_TURMA',
          message: 'Há aluno que não está nesta turma.',
          alunoIds: forasteiros,
        });
      }

      // AC-000h — o piso é, por construção, a lista que o `GET` devolveu.
      const exigidos =
        cabecalhoAtual?.completude === 'completa'
          ? new Set(atuais.map((p) => p.alunoId))
          : permitidos;
      const recebidos = new Set(idsRecebidos);
      const faltando = [...exigidos].filter((id) => !recebidos.has(id));
      if (faltando.length > 0) {
        throw new UnprocessableEntityException({
          statusCode: 422,
          code: 'CHAMADA_INCOMPLETA',
          message:
            'A chamada precisa incluir todos os alunos da turma. Atualize o app e marque quem faltou antes de salvar.',
          alunoIds: faltando,
        });
      }

      // INV-027 — o cabeçalho primeiro, e na mesma transação. A ordem
      // importa a partir do `contract`: a FK de `presencas` para `chamadas`
      // recusa linha sem cabeçalho. Escrever nesta ordem desde agora evita
      // que a fase seguinte precise mexer neste código de novo.
      await tx.chamada.upsert({
        where: { ocupacaoId },
        create: {
          ocupacaoId,
          origemTipo: 'TURMA',
          companyId,
          registradaPor: usuarioId,
          completude: 'completa',
          esperados: itens.length,
        },
        // Promoção de `desconhecida` para `completa` num **único** UPDATE:
        // os dois campos andam juntos, e o CHECK do banco recusa o estado
        // intermediário (achado da 4ª validação cruzada).
        update: {
          registradaPor: usuarioId,
          completude: 'completa',
          esperados: itens.length,
        },
      });

      for (const item of itens) {
        await tx.presenca.upsert({
          where: {
            ocupacaoId_alunoId: { ocupacaoId, alunoId: item.alunoId },
          },
          create: {
            companyId,
            ocupacaoId,
            origemTipo: 'TURMA',
            alunoId: item.alunoId,
            status: item.status,
            registradoPor: usuarioId,
          },
          update: { status: item.status, registradoPor: usuarioId },
        });
      }

      const [depois, cabecalhoDepois] = await Promise.all([
        tx.presenca.findMany({
          where: { ocupacaoId },
          select: { updatedAt: true },
        }),
        tx.chamada.findUnique({ where: { ocupacaoId } }),
      ]);
      return {
        ocupacaoId,
        versao: this.versaoDe(depois, cabecalhoDepois, matriculados),
        total: itens.length,
      };
    });
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
            registrante: { select: { nome: true } },
          },
        },
      },
      orderBy: [{ data: 'desc' }],
    });

    const matriculados = await this.prisma.turmaAluno.findMany({
      where: { turmaId },
      select: { alunoId: true },
    });
    const naTurma = new Set(matriculados.map((m) => m.alunoId));

    return ocorrencias.map((o) => {
      const cabecalho = o.chamadas[0];
      const estado = resolverEstadoDaChamada({
        cancelada: o.statusPagamento === 'cancelado',
        completude: cabecalho?.completude,
        data: o.data,
        horaInicio: o.horaInicio,
        horaFim: o.horaFim,
      });
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
        registradoPor:
          cabecalho?.registrante.nome ??
          o.presencas[0]?.registrante.nome ??
          null,
        alunos: o.presencas
          .map((p) => ({
            alunoId: p.alunoId,
            nome: p.aluno.usuario.nome,
            status: p.status,
            // Sinalizadores em vez de bloqueio: a spec decidiu que alocação é
            // o único requisito para marcar presença, e que o gestor vê quem
            // já não está ativo ou já não está na turma.
            naTurmaHoje: naTurma.has(p.alunoId),
            alunoAtivo: p.aluno.status === 'ativo',
          }))
          .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')),
      };
    });
  }
}
