import {
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { StudentsService } from '../people/students.service';
import { formatDateOnly, hojeNoFusoDoClube } from '../courts/date-time.util';
import type { CriarMatriculaDto } from './dto/matricula.dto';
import type { MatriculaResponseDto } from './dto/matricula-response.dto';
import type {
  VencimentoResponseDto,
  VencimentosResponseDto,
} from './dto/vencimentos-response.dto';

/**
 * SPEC-037 — a matrícula: **esta pessoa contratou este plano, por este prazo,
 * por este valor, tendo aceito este contrato.**
 *
 * ## O `fim` é calculado aqui, e gravado (D9)
 *
 * `inicio + prazoMeses`. Derivar na leitura pareceria mais limpo e não é:
 * *"quem está com matrícula vencendo"* viraria varredura com aritmética de
 * data, e a primeira tela que precisasse repetiria a regra. Gravado, é índice
 * (`matriculas_fim_idx`).
 *
 * ## As três recusas acontecem ANTES do banco, e é o ponto delas
 *
 * A INV-114 (FK causal) é a garantia; sem as checagens daqui, ela responderia
 * `23503`, que vaza como `500`. **O gestor precisa saber que o aluno não
 * aceitou o contrato** — não que "houve um erro no servidor".
 */
/**
 * **Os `code` sao LITERAIS, e nao constantes exportadas.**
 *
 * Parece pior e nao e: o gate `Docs/contrato-spec-x-codigo.py` casa o campo
 * `code` seguido de uma string literal, e confronta com o que a spec PROMETE.
 * Atras de uma constante, o codigo existe e o gate nao o ve -- e ele reprova a
 * spec dizendo "ramo morto no frontend" sobre algo que funciona.
 *
 * Foi assim que esta spec reprovou na primeira execucao do gate. E a SEGUNDA
 * reprovacao foi do comentario que explicava a primeira: ele trazia o padrao
 * escrito por extenso, e o gate o leu como um codigo chamado `X`. Escrever a
 * regra sem escrever a forma dela e o conserto.
 */
/**
 * SPEC-045 — o quanto de histórico a lista de vencimentos varre.
 *
 * Quem venceu há dois anos não é pendência de renovação, é ex-aluno. Sem o
 * corte, a consulta arrastaria a tabela inteira para desenhar uma tela.
 * Declarado como constante e não enterrado na consulta, porque é um **recorte**
 * — e recorte silencioso vira "a lista não mostra tudo" na boca de quem usa.
 */
const DIAS_DE_HISTORICO = 365;

@Injectable()
export class MatriculasService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly students: StudentsService,
  ) {}

  /**
   * `inicio + meses`, **calculado pelo Postgres**.
   *
   * ## Por que não em JavaScript
   *
   * `new Date(Date.UTC(2026,0,31))` mais um mês vira **3 de março**: 31 de
   * fevereiro não existe e o `Date` transborda em silêncio. Uma matrícula de
   * 31/01 com prazo 1 terminaria dia 3, não dia 28 — e ninguém olharia duas
   * vezes para uma data que "existe". Medido:
   *
   * ```
   *   Postgres: 2026-01-31 + 1 mes = 2026-02-28
   *   JS:       2026-01-31 + 1 mes = 2026-03-03
   * ```
   *
   * Dá para corrigir à mão (detectar o transbordo e recuar), e a primeira
   * versão deste método fazia isso. **Duas coisas a derrubaram:** o gate
   * `fuso-do-clube.spec.ts` recusa `getUTCFullYear()` em `src/` — a premissa
   * dele é que quem chama esse método está montando "agora" —, e o Postgres
   * já implementa a semântica certa, testada por décadas.
   *
   * ## E uma coluna GERADA não resolve
   *
   * Ensaiado: `GENERATED ALWAYS AS ((inicio + (prazo_meses || ' months')
   * ::interval)::date) STORED` é recusado com **`42P17` — "generation
   * expression is not immutable"**, porque a saída de `interval` depende de
   * `IntervalStyle`. Por isso o cálculo é uma consulta, e não uma coluna.
   *
   * Custa uma ida ao banco, **dentro da transação de quem chama**.
   */
  static async calcularFim(
    tx: Prisma.TransactionClient | PrismaService,
    inicio: Date,
    meses: number,
  ): Promise<Date> {
    // `::int` explicito: o Prisma manda `number` como **bigint**, e
    // `make_interval(months => bigint)` nao existe -- `42883`. Custou uma
    // rodada vermelha da suite inteira.
    const [linha] = await tx.$queryRaw<{ fim: Date }[]>`
      SELECT (${formatDateOnly(inicio)}::date
              + make_interval(months => ${meses}::int))::date AS fim
    `;
    return linha.fim;
  }

  private paraResposta(
    m: {
      id: string;
      alunoId: string;
      planoId: string;
      valorCentavos: number;
      valorDeTabelaCentavos: number;
      prazoMeses: number;
      inicio: Date;
      fim: Date;
      contratoVersao: number;
      plano?: { nome: string; linkPagamentoUrl: string | null } | null;
    },
    linkDaEmpresa: string | null,
  ): MatriculaResponseDto {
    return {
      id: m.id,
      alunoId: m.alunoId,
      planoId: m.planoId,
      planoNome: m.plano?.nome ?? null,
      valorCentavos: m.valorCentavos,
      valorDeTabelaCentavos: m.valorDeTabelaCentavos,
      // **Calculado, nunca gravado** (AC-006). Uma coluna `desconto` seria uma
      // terceira verdade sobre os mesmos dois números, e a primeira a
      // divergir.
      descontoCentavos: m.valorDeTabelaCentavos - m.valorCentavos,
      prazoMeses: m.prazoMeses,
      inicio: formatDateOnly(m.inicio),
      fim: formatDateOnly(m.fim),
      contratoVersao: m.contratoVersao,
      // SPEC-045/AC-009 — **a data sozinha não cria urgência.** "até 12 de
      // outubro" e "vence em 5 dias" são a mesma informação, e só a segunda
      // faz alguém agir. Mesma lição do `70%` da SPEC-036 e da contagem de
      // conflitos da SPEC-035: o número bruto não diz o que fazer.
      //
      // Calculado aqui e não na tela, porque "hoje" da tela é o relógio do
      // navegador — que está no fuso de quem viaja, e não no do clube.
      diasRestantes: Math.round(
        (m.fim.getTime() - hojeNoFusoDoClube().getTime()) / 86_400_000,
      ),
      linkPagamentoUrl: m.plano?.linkPagamentoUrl ?? linkDaEmpresa ?? null,
    };
  }

  private async linkDaEmpresa(companyId: string): Promise<string | null> {
    const config = await this.prisma.configPagamentoEmpresa.findUnique({
      where: { companyId },
      select: { linkPagamentoUrl: true },
    });
    return config?.linkPagamentoUrl ?? null;
  }

  async criar(
    companyId: string,
    alunoId: string,
    dto: CriarMatriculaDto,
    autorId: string,
  ): Promise<MatriculaResponseDto> {
    const aluno = await this.prisma.aluno.findFirst({
      where: { id: alunoId, companyId },
      select: { id: true, usuarioId: true, vinculo: true, status: true },
    });
    if (!aluno) throw new NotFoundException();
    /**
     * **DEF-027 — e este era o pior dos tres, porque tem preco.**
     *
     * Medido: um aluno desligado, que recebe `401` no login e `403
     * CONTA_INATIVA` em toda rota, era matriculado num plano de R$ 100,00 sem
     * uma palavra. A conferencia do contrato logo abaixo ate passava — o
     * aceite dele continua valido, ele so nao pode mais entrar para usar nada
     * do que estaria pagando.
     */
    this.students.garantirAlunoOperante(aluno);

    const plano = await this.prisma.plano.findFirst({
      where: { id: dto.planoId, companyId },
    });
    if (!plano) throw new NotFoundException('Plano não encontrado');
    if (!plano.ativo) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'PLANO_INATIVO',
        message:
          'Este plano está inativo. Reative-o ou escolha outro antes de matricular.',
      });
    }

    const empresa = await this.prisma.empresa.findUniqueOrThrow({
      where: { id: companyId },
      select: { contratoVersaoVigente: true },
    });
    if (empresa.contratoVersaoVigente == null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'CONTRATO_NAO_PUBLICADO',
        message:
          'O clube ainda não publicou um contrato. Publique em Configurações antes de matricular.',
      });
    }

    /**
     * **A conferência que evita o `500`.**
     *
     * A FK causal (INV-114) é quem garante — e ela responderia `23503`. Aqui
     * a resposta diz o que fazer: o aluno precisa entrar no app e aceitar. É
     * a mesma divisão de trabalho da `EXCLUDE` e da pré-checagem na INV-001.
     */
    const aceite = await this.prisma.aceite.findFirst({
      where: {
        usuarioId: aluno.usuarioId,
        tipo: 'contrato',
        versao: empresa.contratoVersaoVigente,
      },
      select: { id: true },
    });
    if (!aceite) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'CONTRATO_NAO_ACEITO',
        message:
          'Este aluno ainda não aceitou a versão vigente do contrato. Ele precisa entrar no app e aceitar antes da matrícula.',
      });
    }

    const inicio = dto.inicio
      ? new Date(`${dto.inicio}T00:00:00.000Z`)
      : hojeNoFusoDoClube();
    const fim = await MatriculasService.calcularFim(
      this.prisma,
      inicio,
      plano.prazoMeses,
    );

    const criada = await this.prisma.matricula.create({
      data: {
        companyId,
        alunoId: aluno.id,
        usuarioId: aluno.usuarioId,
        planoId: plano.id,
        // `?? plano.valorCentavos`: ausente significa "o preço de tabela".
        // **Zero é um valor legítimo** e por isso o teste é contra
        // `undefined`, não contra falsy — `dto.valorCentavos || plano...`
        // transformaria uma bolsa integral em preço cheio.
        valorCentavos: dto.valorCentavos ?? plano.valorCentavos,
        valorDeTabelaCentavos: plano.valorCentavos,
        prazoMeses: plano.prazoMeses,
        inicio,
        fim,
        contratoVersao: empresa.contratoVersaoVigente,
        criadoPorId: autorId,
      },
      include: { plano: { select: { nome: true, linkPagamentoUrl: true } } },
    });

    return this.paraResposta(criada, await this.linkDaEmpresa(companyId));
  }

  async listarDoAluno(
    companyId: string,
    alunoId: string,
  ): Promise<MatriculaResponseDto[]> {
    const [linhas, link] = await Promise.all([
      this.prisma.matricula.findMany({
        where: { companyId, alunoId },
        orderBy: { inicio: 'desc' },
        include: { plano: { select: { nome: true, linkPagamentoUrl: true } } },
      }),
      this.linkDaEmpresa(companyId),
    ]);
    return linhas.map((m) => this.paraResposta(m, link));
  }

  /**
   * SPEC-045/REQ-001 — **quem vence, e quem já venceu.**
   *
   * ## A unidade é o ALUNO, e a resposta ingênua está errada (D2)
   *
   * A LIM-037c aceita sobreposição de propósito — *"upgrade de plano no meio
   * do mês é o caso normal"*. Uma consulta por `fim BETWEEN hoje AND hoje+N`
   * devolveria como **vencida** a matrícula antiga de quem acabou de fazer
   * upgrade, e o gestor ligaria cobrando renovação de quem já renovou.
   *
   * Então a pergunta é a mesma de `minhaMatricula`: **este aluno tem matrícula
   * vigente hoje?** E, para quem tem, **existe alguma que continue depois
   * dela?**
   *
   * ## Uma consulta, não uma por aluno
   *
   * Carrega as matrículas relevantes da empresa de uma vez e agrupa em
   * memória. O N+1 é o erro que este projeto já baniu três vezes, e aqui ele
   * seria pior que o de sempre: uma consulta por aluno numa tela que o gestor
   * abre para ver o clube inteiro.
   *
   * O filtro `fim >= hoje - 1 ano` existe para não arrastar histórico antigo:
   * quem venceu há dois anos não é pendência de renovação, é ex-aluno. Está
   * declarado aqui porque é um recorte, e recorte silencioso vira "a lista não
   * mostra tudo" na boca de quem usa.
   */
  async vencimentos(
    companyId: string,
    dias: number,
  ): Promise<VencimentosResponseDto> {
    const hoje = hojeNoFusoDoClube();
    const limite = new Date(hoje);
    limite.setUTCDate(limite.getUTCDate() + dias);
    // **O chão é em DIAS, e não em anos, porque o gate me reprovou.**
    // `fuso-do-clube.spec.ts` bane `getUTCFullYear()` — *"só aparece quando
    // alguém está montando a data de agora"* —, e a primeira versão fazia
    // `setUTCFullYear(getUTCFullYear() - 1)`. Podia ter trocado por
    // `getUTCDate() - 365` só para escapar do teste; a diferença é que **os
    // dois deslocamentos agora são a mesma aritmética**, e "um ano" era
    // arbitrário de qualquer forma.
    const chao = new Date(hoje);
    chao.setUTCDate(chao.getUTCDate() - DIAS_DE_HISTORICO);

    const linhas = await this.prisma.matricula.findMany({
      where: {
        companyId,
        fim: { gte: chao },
        // AC-006 — desligado não é pendência de renovação. O DEF-027 fechou as
        // portas de escrita para ele; cobrar renovação seria a mesma
        // incoerência do outro lado.
        aluno: { status: 'ativo' },
      },
      select: {
        alunoId: true,
        inicio: true,
        fim: true,
        plano: { select: { nome: true } },
        aluno: { select: { usuario: { select: { nome: true } } } },
      },
      orderBy: { fim: 'asc' },
    });

    const porAluno = new Map<string, typeof linhas>();
    for (const m of linhas) {
      const atuais = porAluno.get(m.alunoId) ?? [];
      atuais.push(m);
      porAluno.set(m.alunoId, atuais);
    }

    const vencidas: VencimentoResponseDto[] = [];
    const vencendo: VencimentoResponseDto[] = [];

    for (const [, doAluno] of porAluno) {
      const vigentes = doAluno.filter((m) => m.inicio <= hoje && m.fim >= hoje);

      if (vigentes.length === 0) {
        // Venceu e ninguém renovou. `doAluno` está ordenado por `fim`, então a
        // última é a que terminou por último — a que o gestor precisa citar.
        // **Matrícula que ainda não COMEÇOU não é vencida**: quem comprou o
        // plano do mês que vem está resolvido, não pendente.
        const futuras = doAluno.filter((m) => m.inicio > hoje);
        if (futuras.length > 0) continue;
        vencidas.push(this.paraVencimento(doAluno[doAluno.length - 1], hoje));
        continue;
      }

      // A que vale é a que começou por último (mesma regra de
      // `minhaMatricula`), e o `fim` dela é o que interessa.
      const vigente = vigentes.reduce((a, b) => (a.inicio >= b.inicio ? a : b));
      if (vigente.fim > limite) continue;

      // AC-005 — **já comprou o próximo.** Alguma matrícula que termine depois
      // desta tira o aluno da lista: ele não vai ficar sem plano.
      const cobreDepois = doAluno.some((m) => m.fim > vigente.fim);
      if (cobreDepois) continue;

      vencendo.push(this.paraVencimento(vigente, hoje));
    }

    const porFim = (a: VencimentoResponseDto, b: VencimentoResponseDto) =>
      a.fim.localeCompare(b.fim);
    return {
      dias,
      // AC-008 — o que venceu há mais tempo primeiro, nos dois grupos.
      vencidas: vencidas.sort(porFim),
      vencendo: vencendo.sort(porFim),
    };
  }

  /** Uma linha da lista: o bastante para agir sem abrir a ficha (AC-002). */
  private paraVencimento(
    m: {
      alunoId: string;
      fim: Date;
      plano: { nome: string };
      aluno: { usuario: { nome: string } };
    },
    hoje: Date,
  ): VencimentoResponseDto {
    return {
      alunoId: m.alunoId,
      alunoNome: m.aluno.usuario.nome,
      planoNome: m.plano.nome,
      fim: formatDateOnly(m.fim),
      // Negativo para vencida. **`Math.round` e não `floor`:** as duas datas
      // são `DATE` à meia-noite UTC, então a divisão é exata — o `round` é
      // contra o dia de 23h ou 25h do horário de verão, que o Brasil não tem
      // hoje e já teve.
      diasRestantes: Math.round(
        (m.fim.getTime() - hoje.getTime()) / 86_400_000,
      ),
    };
  }

  /**
   * SPEC-037/AC-011 — a matrícula **vigente** do aluno logado, ou `null`.
   *
   * **`null` e não `404`.** Não ter plano é um estado normal — a maioria dos
   * alunos de hoje está assim, porque a tabela nasceu vazia. `404` faria a
   * tela do Cliente tratar o normal como erro, que é exatamente o defeito que
   * a carteira levou para produção na SPEC-033.
   *
   * "Vigente" é `inicio <= hoje <= fim`, com `hoje` **no fuso do clube**. Em
   * UTC, uma matrícula que termina hoje já teria vencido às 21h de ontem.
   */
  async minhaMatricula(
    companyId: string,
    usuarioId: string,
  ): Promise<MatriculaResponseDto | null> {
    const hoje = hojeNoFusoDoClube();
    const [m, link] = await Promise.all([
      this.prisma.matricula.findFirst({
        where: {
          companyId,
          usuarioId,
          inicio: { lte: hoje },
          fim: { gte: hoje },
        },
        // A mais recente vence: a LIM-037c aceita sobreposição de propósito
        // (upgrade de plano no meio do mês é o caso normal), então "vigente"
        // pode ser mais de uma. A que começou por último é a que vale.
        orderBy: { inicio: 'desc' },
        include: { plano: { select: { nome: true, linkPagamentoUrl: true } } },
      }),
      this.linkDaEmpresa(companyId),
    ]);
    return m ? this.paraResposta(m, link) : null;
  }

  /**
   * SPEC-037/AC-015 — a matrícula que nasce **dentro** da transação do aceite
   * do convite.
   *
   * Recebe o `tx` porque falhar aqui tem de desfazer a conta e o aceite: uma
   * conta sem matrícula é recuperável, mas uma matrícula sem contrato aceito
   * é o buraco que a INV-114 existe para impedir.
   *
   * **Devolve `null` quando o plano foi desativado** entre convidar e aceitar
   * (AC-016), em vez de recusar o aceite inteiro. *Recusar puniria o aluno por
   * uma mudança do clube* — ele fez tudo certo e não tem como saber.
   */
  async criarNoAceite(
    tx: Prisma.TransactionClient,
    dados: {
      companyId: string;
      alunoId: string;
      usuarioId: string;
      planoId: string;
      contratoVersao: number;
      autorId: string;
    },
  ): Promise<{ id: string } | null> {
    const plano = await tx.plano.findFirst({
      where: { id: dados.planoId, companyId: dados.companyId },
    });
    if (!plano || !plano.ativo) return null;

    const inicio = hojeNoFusoDoClube();
    return tx.matricula.create({
      data: {
        companyId: dados.companyId,
        alunoId: dados.alunoId,
        usuarioId: dados.usuarioId,
        planoId: plano.id,
        valorCentavos: plano.valorCentavos,
        valorDeTabelaCentavos: plano.valorCentavos,
        prazoMeses: plano.prazoMeses,
        inicio,
        fim: await MatriculasService.calcularFim(tx, inicio, plano.prazoMeses),
        contratoVersao: dados.contratoVersao,
        criadoPorId: dados.autorId,
      },
      select: { id: true },
    });
  }
}
