import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  formatDateOnly,
  formatTimeOnly,
  hojeNoFusoDoClube,
} from '../courts/date-time.util';

/**
 * SPEC-025 — **a avaliação das aulas.**
 *
 * Decisão do Israel (ADR-017, item 4): nota de 1 a 5; o painel Admin é o
 * único que vê **quem avaliou** e **os comentários**; o público vê só a
 * **média em estrelas**.
 *
 * **A nota é de UMA AULA; a aula não tem média própria; as notas das aulas
 * alimentam a média da TURMA.** O objetivo, nas palavras dele, é
 * *"identificar com facilidade os detratores"* — e é isso que decide o
 * desenho. Média por aula quase nunca teria volume (cada aula tem poucos
 * alunos), mas a **nota por aula** aponta para a terça-feira concreta em que
 * a pessoa se decepcionou. É a diferença entre "esta turma está em 3,8" e
 * "no dia 12 três alunos deram 2".
 */
@Injectable()
export class AvaliacaoDeAulaService {
  /**
   * **Quantas notas antes de mostrar a média da turma.**
   *
   * Duas razões, e a segunda é a que decide. A primeira é estatística: média
   * de uma nota é ruído. **A segunda é de privacidade** — a avaliação não é
   * anônima para o gestor, e com uma ou duas notas na turma ele infere quem
   * disse o quê mesmo olhando só a média. Três dá alguma diluição, e continua
   * sendo pouca (LIM-025a).
   */
  /**
   * **REMOVIDO em 2026-08-30, por decisão do Israel.** O valor era `3`.
   *
   * Ele viu a tela e disse: *"o que seria 2 de 3 aval? Precisa apresentar a
   * média de nota e não essa quantidade atual"*. A média passa a ser
   * publicada **desde a primeira avaliação**.
   *
   * **O que se perdeu, para quem ler isto depois:** o mínimo não era
   * estatística, era **privacidade**. A avaliação é anônima para o professor
   * e para os outros alunos — mas com UMA nota, a média *é* aquela nota. Numa
   * turma de dois alunos (existe uma assim em produção: "Nova turma", 2 de 6),
   * o professor sabe exatamente quem disse o quê.
   *
   * Foi sinalizado a ele antes de implementar, e ele decidiu assim mesmo. A
   * LIM-025a — que já dizia que três dá "pouca diluição" — passa a valer sem
   * diluição nenhuma. Restaurar é reintroduzir a comparação aqui e o campo
   * `minimoParaMedia` no DTO.
   */
  static readonly MINIMO_PARA_MEDIA_REMOVIDO = 3;

  /**
   * **Detrator é quem deu 1 ou 2.**
   *
   * Escala de 1 a 5, na leitura clássica: 1–2 detrator, 3 neutro, 4–5
   * promotor. **Decisão minha, sinalizada ao Israel**, e ela mora aqui num
   * lugar só porque é a mais provável de ele querer mexer.
   */
  static readonly NOTA_MAXIMA_DE_DETRATOR = 2;

  /** Quanto tempo para trás a lista de aulas anteriores olha. */
  static readonly DIAS_DE_HISTORICO = 90;

  constructor(private readonly prisma: PrismaService) {}

  private async alunoDoUsuario(companyId: string, usuarioId: string) {
    const aluno = await this.prisma.aluno.findFirst({
      where: { usuarioId, companyId },
    });
    if (!aluno) {
      throw new ForbiddenException();
    }
    return aluno;
  }

  /**
   * **As aulas que já aconteceram, para poder avaliá-las.**
   *
   * `GET /me/classes` devolve só o futuro (`data >= hoje`), então sem esta
   * rota não haveria como chegar até a aula. Cada item já vem com a nota que
   * a pessoa deu — a tela precisa distinguir "ainda não avaliei" de "dei 4",
   * e uma segunda requisição por aula seria uma por linha da lista.
   */
  /**
   * SPEC-027 — **paginada**, a pedido do Israel ("vamos precisar de paginacao
   * nas paginas necessarias").
   *
   * Esta era a lista do aluno que mais crescia: a janela de 90 dias de um
   * aluno com tres aulas por semana ja passa de 35 cartoes, e cada cartao
   * carrega um formulario de avaliacao. O `pageSize` continua opcional e o
   * padrao mantem o comportamento antigo para quem nao passar nada.
   */
  async aulasAnteriores(
    companyId: string,
    usuarioId: string,
    page = 1,
    pageSize = 20,
  ) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const alocacoes = await this.prisma.turmaAluno.findMany({
      where: { alunoId: aluno.id },
      select: { turmaId: true },
    });
    const turmaIds = alocacoes.map((a) => a.turmaId);
    if (turmaIds.length === 0) {
      return { data: [], page, pageSize, total: 0 };
    }

    const hoje = hojeNoFusoDoClube();
    const inicio = new Date(hoje);
    inicio.setUTCDate(
      inicio.getUTCDate() - AvaliacaoDeAulaService.DIAS_DE_HISTORICO,
    );

    // O MESMO `where` para a pagina e para a contagem — duplicar o filtro
    // e como o total passa a mentir sobre a lista.
    const onde = {
      companyId,
      origemTipo: 'TURMA' as const,
      origemTurmaId: { in: turmaIds },
      statusPagamento: { not: 'cancelado' as const },
      // `lt: hoje` e não `lte`: a regra de "já terminou" é a mesma do
      // `exigirAulaTerminada`, e as duas precisam concordar — lista que
      // oferece o que o servidor recusa é a armadilha do DEF-011.
      data: { gte: inicio, lt: hoje },
    };

    const total = await this.prisma.ocupacaoQuadra.count({ where: onde });
    const ocupacoes = await this.prisma.ocupacaoQuadra.findMany({
      where: onde,
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: {
        origemTurma: { select: { id: true, nome: true } },
        quadra: { select: { nome: true } },
        avaliacoes: {
          where: { alunoId: aluno.id },
          select: { nota: true, comentario: true },
        },
      },
      // SPEC-027 — **`id` como desempate, e sem ele a paginação erra.**
      //
      // `data` + `horaInicio` NÃO é ordem total: duas ocupações no mesmo dia
      // e hora ficam em ordem indefinida, e o Postgres não promete a mesma
      // entre duas consultas. Com `skip`/`take` isso faz uma linha aparecer
      // em duas páginas e outra em nenhuma — o defeito clássico de
      // paginação, e o mais difícil de notar, porque a lista parece certa.
      orderBy: [{ data: 'desc' }, { horaInicio: 'desc' }, { id: 'desc' }],
    });

    return {
      data: ocupacoes.map((o) => ({
        ocupacaoId: o.id,
        turmaId: o.origemTurmaId,
        turmaNome: o.origemTurma?.nome ?? null,
        quadraNome: o.quadra.nome,
        data: formatDateOnly(o.data),
        horaInicio: formatTimeOnly(o.horaInicio),
        horaFim: formatTimeOnly(o.horaFim),
        minhaNota: o.avaliacoes[0]?.nota ?? null,
        meuComentario: o.avaliacoes[0]?.comentario ?? null,
      })),
      page,
      pageSize,
      total,
    };
  }

  /**
   * As duas regras de quem pode avaliar, e são só duas de propósito.
   *
   * **1. Estar matriculado na turma da aula.** A alternativa considerada
   * exigia presença registrada, e ela amarra a funcionalidade à chamada:
   * turma cujo professor não preenche chamada teria avaliação morta.
   *
   * **2. A aula já ter acontecido.** "Já aconteceu" é *a data dela ser
   * anterior a hoje no fuso do clube* — e não uma comparação com a hora de
   * término. A comparação por hora exigiria montar o instante do fim no fuso
   * certo, que é exatamente a armadilha documentada em `date-time.util.ts`.
   * O custo é que a aula de hoje só pode ser avaliada amanhã (LIM-025d); o
   * ganho é uma regra que não erra por três horas à noite.
   */
  private async exigirDireitoDeAvaliar(
    companyId: string,
    usuarioId: string,
    ocupacaoId: string,
  ) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const ocupacao = await this.prisma.ocupacaoQuadra.findFirst({
      where: { id: ocupacaoId, companyId, origemTipo: 'TURMA' },
      select: { id: true, data: true, origemTurmaId: true },
    });
    // 404 também para reserva avulsa e para ocupação de outra empresa: as
    // três são "esta aula não existe para você", e distinguir entregaria
    // informação sobre o outro clube (mesma regra da SPEC-023, INV-023b).
    if (!ocupacao || !ocupacao.origemTurmaId) {
      throw new NotFoundException();
    }

    if (ocupacao.data.getTime() >= hojeNoFusoDoClube().getTime()) {
      throw new ConflictException({
        statusCode: 409,
        code: 'AULA_NAO_TERMINOU',
        message: 'Você pode avaliar esta aula a partir do dia seguinte.',
      });
    }

    const matricula = await this.prisma.turmaAluno.findFirst({
      where: { turmaId: ocupacao.origemTurmaId, alunoId: aluno.id },
      select: { id: true },
    });
    if (!matricula) {
      throw new ForbiddenException({
        statusCode: 403,
        code: 'NAO_MATRICULADO',
        message:
          'Você só pode avaliar aulas de turmas em que está matriculado.',
      });
    }

    return aluno;
  }

  /**
   * Grava ou corrige a nota.
   *
   * `upsert` sobre a UNIQUE `(ocupacao_id, aluno_id)`: avaliar de novo é
   * **correção**, não uma segunda linha. Diferente dos `aceites` da SPEC-024,
   * que são append-only porque são registro legal — impedir a correção de um
   * toque errado aqui só produziria dado pior.
   */
  async avaliar(
    companyId: string,
    usuarioId: string,
    ocupacaoId: string,
    dados: { nota: number; comentario?: string | null },
  ) {
    const aluno = await this.exigirDireitoDeAvaliar(
      companyId,
      usuarioId,
      ocupacaoId,
    );

    // Comentário em branco é ausência de comentário, não uma string vazia
    // guardada — o painel do gestor não deve ter linhas com aspas vazias.
    const comentario = dados.comentario?.trim() || null;

    return this.prisma.avaliacaoDeAula.upsert({
      where: { ocupacaoId_alunoId: { ocupacaoId, alunoId: aluno.id } },
      create: {
        companyId,
        ocupacaoId,
        alunoId: aluno.id,
        nota: dados.nota,
        comentario,
      },
      update: { nota: dados.nota, comentario },
      select: { nota: true, comentario: true, updatedAt: true },
    });
  }

  /**
   * **A média da TURMA, agregada das notas das aulas dela.**
   *
   * INV-025a: nada de autoria nem de comentário sai por aqui, e a prova disso
   * olha o JSON serializado — não os campos que eu lembrei de conferir.
   *
   * `media: null` abaixo do mínimo, com a `quantidade` visível: esconder
   * também a contagem faria a tela não conseguir dizer "ainda faltam
   * avaliações", que é informação útil e não identifica ninguém.
   */
  async mediaDaTurma(companyId: string, turmaId: string) {
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: { id: true },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    const agregado = await this.prisma.avaliacaoDeAula.aggregate({
      // `companyId` explícito aqui, e não só a relação — achado 1 da
      // validação cruzada. A FK composta passou a impedir que uma ocupação
      // de outra empresa aponte para esta turma; este filtro é a segunda
      // tranca, no caminho de leitura. Isolamento entre empresas é caro
      // demais para depender de uma camada só.
      where: { companyId, ocupacao: { companyId, origemTurmaId: turmaId } },
      _avg: { nota: true },
      _count: { _all: true },
    });

    const quantidade = agregado._count._all;

    return {
      quantidade,
      // Uma casa decimal: a tela desenha estrelas, e precisão maior seria
      // falsa — cinco notas não distinguem 4,26 de 4,3.
      media:
        agregado._avg.nota !== null
          ? Math.round(agregado._avg.nota * 10) / 10
          : null,
    };
  }

  /**
   * **A lista do gestor, ordenada por PIOR NOTA primeiro.**
   *
   * A ordem é a funcionalidade, não um detalhe: o pedido era *"identificar
   * com facilidade os detratores"*. Ordenar por data mais recente — o
   * reflexo — enterraria o 1 da semana passada embaixo dos 5 de ontem.
   *
   * Nome e comentário saem por aqui e por lugar nenhum mais.
   */
  async listarParaOGestor(companyId: string, turmaId: string) {
    const turma = await this.prisma.turma.findFirst({
      where: { id: turmaId, companyId },
      select: { id: true },
    });
    if (!turma) {
      throw new NotFoundException();
    }

    const avaliacoes = await this.prisma.avaliacaoDeAula.findMany({
      // Ver a nota gêmea em `mediaDaTurma`. Aqui o custo de um vazamento é
      // maior: esta é a única resposta do produto que carrega NOME e
      // COMENTÁRIO.
      where: { companyId, ocupacao: { companyId, origemTurmaId: turmaId } },
      orderBy: [{ nota: 'asc' }, { updatedAt: 'desc' }],
      select: {
        nota: true,
        comentario: true,
        updatedAt: true,
        ocupacao: { select: { data: true, horaInicio: true } },
        aluno: { select: { usuario: { select: { nome: true } } } },
      },
    });

    const itens = avaliacoes.map((a) => ({
      alunoNome: a.aluno.usuario.nome,
      nota: a.nota,
      comentario: a.comentario,
      // A data da AULA, não a do registro: é ela que diz ao gestor qual
      // terça-feira investigar.
      dataDaAula: formatDateOnly(a.ocupacao.data),
      horaInicio: formatTimeOnly(a.ocupacao.horaInicio),
      avaliadaEm: a.updatedAt,
      detrator: a.nota <= AvaliacaoDeAulaService.NOTA_MAXIMA_DE_DETRATOR,
    }));

    return {
      itens,
      // Contado no servidor, e não na tela, pela mesma razão da média: se a
      // tela contasse, a régua de detrator viraria uma segunda cópia da
      // regra — e é sempre a cópia que fica velha.
      detratores: itens.filter((i) => i.detrator).length,
      notaMaximaDeDetrator: AvaliacaoDeAulaService.NOTA_MAXIMA_DE_DETRATOR,
    };
  }
}
