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
