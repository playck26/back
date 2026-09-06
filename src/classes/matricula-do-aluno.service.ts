import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { avaliarSaidaDeTurma } from '../company-settings/prazo-de-cancelamento';
import { ocorrenciaRelevante } from './ocorrencia-relevante';

/**
 * SPEC-023 — **o aluno entra e sai de turma sozinho.**
 *
 * Mora fora de `ClassesService` de propósito: lá é o CRUD do gestor, e as
 * regras daqui são de outro ator. Misturar deixaria as regras do aluno
 * valendo, sem querer, para o caminho do gestor — que é o oposto do que a
 * SPEC-023 decide (o gestor continua podendo tudo o que já podia, REQ-006).
 *
 * **O que este serviço NÃO reinventa:** a trava de capacidade. `INV-003` é
 * `SELECT ... FOR UPDATE` na linha da turma, e existe desde a SPEC-003. O
 * caminho do aluno usa a mesma trava na mesma linha — dois caminhos de
 * matrícula com travas diferentes seriam duas verdades sobre a mesma vaga.
 */
@Injectable()
export class MatriculaDoAlunoService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operacao: ConfigOperacaoService,
  ) {}

  /**
   * Resolve o aluno a partir do usuário do token.
   *
   * `ForbiddenException` e não `NotFound`: quem chega aqui tem papel
   * `aluno` no token mas não tem linha em `alunos` — é sessão inconsistente,
   * não recurso ausente.
   */
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
   * REQ-001 — as turmas do clube, com a ocupação à vista.
   *
   * **Turma cheia aparece, marcada como cheia.** Some com ela e a pessoa vai
   * perguntar no WhatsApp por que a turma das 18h sumiu.
   *
   * `podeEntrar` vem calculado do servidor junto com o `motivo`, em vez de a
   * tela deduzir: se a tela deduzir, ela vira uma segunda cópia das regras,
   * e é a cópia que fica velha.
   */
  async disponiveis(companyId: string, usuarioId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    const [empresa, turmas, minhas] = await Promise.all([
      this.prisma.empresa.findUniqueOrThrow({
        where: { id: companyId },
        select: { limiteTurmasPorAluno: true },
      }),
      this.prisma.turma.findMany({
        where: { companyId },
        select: {
          id: true,
          nome: true,
          status: true,
          capacidade: true,
          encontros: {
            select: { diaSemana: true, horaInicio: true, horaFim: true },
          },
          _count: { select: { alunos: true } },
        },
        orderBy: { nome: 'asc' },
      }),
      this.prisma.turmaAluno.findMany({
        where: { alunoId: aluno.id },
        select: { turmaId: true },
      }),
    ]);

    const minhasIds = new Set(minhas.map((alocacao) => alocacao.turmaId));
    const noLimite =
      empresa.limiteTurmasPorAluno !== null &&
      minhasIds.size >= empresa.limiteTurmasPorAluno;

    return turmas.map((turma) => {
      const matriculados = turma._count.alunos;
      const jaEstouNela = minhasIds.has(turma.id);
      const motivo = this.motivoDeBloqueio({
        jaEstouNela,
        status: turma.status,
        matriculados,
        capacidade: turma.capacidade,
        vinculo: aluno.vinculo,
        noLimite,
      });

      return {
        id: turma.id,
        nome: turma.nome,
        status: turma.status,
        capacidade: turma.capacidade,
        matriculados,
        jaEstouNela,
        podeEntrar: motivo === null && !jaEstouNela,
        motivo,
        encontros: turma.encontros.map((encontro) => ({
          diaSemana: encontro.diaSemana,
          horaInicio: encontro.horaInicio.toISOString().slice(11, 16),
          horaFim: encontro.horaFim.toISOString().slice(11, 16),
        })),
      };
    });
  }

  /**
   * A ordem das checagens **é a mensagem**: quem já está na turma não precisa
   * ouvir que ela está cheia, e aluno não aprovado ouve isso antes de
   * qualquer coisa sobre vaga — o problema dele não é a vaga.
   */
  private motivoDeBloqueio(dados: {
    jaEstouNela: boolean;
    status: string;
    matriculados: number;
    capacidade: number;
    vinculo: string;
    noLimite: boolean;
  }): string | null {
    if (dados.jaEstouNela) return null;
    if (dados.vinculo !== 'aprovado') return 'ALUNO_NAO_APROVADO';
    if (dados.status !== 'ativa') return 'TURMA_INATIVA';
    if (dados.noLimite) return 'LIMITE_DE_TURMAS';
    if (dados.matriculados >= dados.capacidade) return 'TURMA_CHEIA';
    return null;
  }

  /**
   * REQ-002/REQ-003 — entrar.
   *
   * Tudo dentro da transação que trava a linha da turma. Checar antes de
   * abrir a transação deixaria janela entre a checagem e a escrita — é a
   * mesma razão pela qual `allocateStudent` já fazia assim.
   */
  async entrar(companyId: string, usuarioId: string, turmaId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);

    return this.prisma.$transaction(async (tx) => {
      const turmaRows = await tx.$queryRaw<
        { id: string; capacidade: number; status: string }[]
      >`
        SELECT id, capacidade, status::text AS status FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;
      const turma = turmaRows[0];
      // 404 e não 403: dizer "existe mas não é sua" já entrega informação
      // sobre a outra empresa (INV-023b).
      if (!turma) {
        throw new NotFoundException();
      }

      // Idempotente por decisão de desenho: toque duplo em conexão ruim é o
      // caso real, e entrar duas vezes é o mesmo estado.
      const jaAlocado = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId: aluno.id },
      });
      if (jaAlocado) {
        return jaAlocado;
      }

      if (aluno.vinculo !== 'aprovado') {
        throw new ForbiddenException({
          statusCode: 403,
          code: 'ALUNO_NAO_APROVADO',
          message:
            'Seu cadastro ainda está aguardando a aprovação do clube. Assim que for aprovado, você poderá entrar nas turmas.',
        });
      }

      if (turma.status !== 'ativa') {
        throw new ConflictException({
          statusCode: 409,
          code: 'TURMA_INATIVA',
          message: 'Esta turma não está ativa.',
        });
      }

      const empresa = await tx.empresa.findUniqueOrThrow({
        where: { id: companyId },
        select: { limiteTurmasPorAluno: true },
      });
      if (empresa.limiteTurmasPorAluno !== null) {
        const minhas = await tx.turmaAluno.count({
          where: { alunoId: aluno.id },
        });
        if (minhas >= empresa.limiteTurmasPorAluno) {
          throw new ConflictException({
            statusCode: 409,
            code: 'LIMITE_DE_TURMAS',
            message: `Você já está em ${minhas} turma(s), que é o limite deste clube.`,
          });
        }
      }

      // Por último, e sob a trava: é a checagem que a concorrência ataca.
      const alocados = await tx.turmaAluno.count({ where: { turmaId } });
      if (alocados >= turma.capacidade) {
        throw new ConflictException({
          statusCode: 409,
          code: 'TURMA_CHEIA',
          message: 'Esta turma já está com todas as vagas ocupadas.',
        });
      }

      return tx.turmaAluno.create({ data: { turmaId, alunoId: aluno.id } });
    });
  }

  /**
   * SPEC-031/REQ-003 — sair da turma, com o prazo que o clube configurou.
   *
   * **Substitui a regra `AULA_HOJE` da SPEC-023.** O `FOR UPDATE` continua
   * sendo o par do lock que `PresencaService.salvarChamada` pega: sem este
   * lado, o de lá não trava nada — quem não pede lock não respeita lock.
   *
   * ## A sequência do D16, e ela é dentro da MESMA transação
   *
   * | # | Passo |
   * |---|---|
   * | 1 | `turmas … FOR UPDATE` |
   * | 2 | conferir matrícula — 404 antes de qualquer regra |
   * | 3 | `ocorrenciaRelevante(tx, …)`, **depois** do lock |
   * | 4 | ler a configuração pelo mesmo `tx`, **sem `FOR UPDATE`** |
   * | 5 | `avaliarSaidaDeTurma(…)` |
   * | 7 | `DELETE turma_alunos` |
   *
   * *(O passo 6 — registrar a ação administrativa — é do caminho do GESTOR,
   * TASK-005. O aluno saindo por conta própria não gera ação administrativa.)*
   *
   * **Ler a ocorrência FORA do bloco seria decidir sobre a grade antiga:** o
   * gestor edita o horário da turma, `cancelFutureClassOccupancies` cancela as
   * futuras em massa, e a política já leu.
   *
   * **O passo 4 não leva `FOR UPDATE` de propósito.** O `SELECT` dentro da
   * transação já dá a garantia que importa — vale o prazo commitado antes
   * desta leitura; um `PUT /operacao` que commite depois vale para a próxima
   * operação. Travar a configuração faria toda saída de turma serializar
   * contra toda outra saída da mesma empresa.
   */
  async sair(companyId: string, usuarioId: string, turmaId: string) {
    const aluno = await this.alunoDoUsuario(companyId, usuarioId);
    // Injetado uma vez e usado nos passos 3 e 5: duas leituras de relógio na
    // mesma decisão poderiam cair em minutos diferentes.
    const agora = new Date();

    await this.prisma.$transaction(async (tx) => {
      const turmaRows = await tx.$queryRaw<{ id: string }[]>`
        SELECT id FROM turmas
        WHERE id = ${turmaId}::uuid AND company_id = ${companyId}::uuid
        FOR UPDATE
      `;
      if (!turmaRows[0]) {
        throw new NotFoundException();
      }

      const alocacao = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId: aluno.id },
      });
      // Sair de onde não se está é engano, e merece 404 — silenciar
      // esconderia bug de tela.
      if (!alocacao) {
        throw new NotFoundException();
      }

      const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);

      /**
       * **Rollout passo 1 (D11): empresa SEM prazo configurado continua na
       * regra de hoje, e com o código de hoje.**
       *
       * O passo 1 manda "emitir os dois códigos conforme a configuração", e
       * esta é a leitura que mantém o cliente antigo funcionando: quem nunca
       * configurou nada não vê mudança nenhuma de comportamento nem de
       * código. Quem configurou entra na regra nova.
       *
       * O passo 3 apaga este bloco inteiro, e aí a AC-003 passa a valer para
       * todos — empresa sem configuração deixa de exigir antecedência, e só o
       * corte de `minutos <= 0` (D5b) permanece.
       *
       * **Isto deixou de ser leitura e virou regra.** A v13 da spec dizia
       * "os dois códigos conforme a configuração" sem dizer qual em qual
       * caso; a validação cruzada de 2026-09-05 apontou que interpretação de
       * rollout tem de ser norma, não comentário. A **v14** tem a tabela, na
       * seção *"Rollout do `AULA_HOJE`"* — e diz explicitamente que este ramo
       * **não** equivale à AC-003 final: enquanto ele existir, a empresa sem
       * configuração é barrada por "tem aula hoje", que é mais restritivo.
       */
      if (prazos.aula.regra === 'SEM_PRAZO') {
        const aulaHoje = await tx.ocupacaoQuadra.findFirst({
          where: {
            companyId,
            origemTipo: 'TURMA',
            origemTurmaId: turmaId,
            statusPagamento: { not: 'cancelado' },
            data: hojeNoFusoDoClube(agora),
          },
          select: { id: true },
        });
        if (aulaHoje) {
          throw new ConflictException({
            statusCode: 409,
            code: 'AULA_HOJE',
            message:
              'Esta turma tem aula hoje. Você pode sair a partir de amanhã, ou falar com o clube.',
          });
        }
      } else {
        const veredicto = avaliarSaidaDeTurma({
          papelDoAutor: 'aluno',
          agora,
          ocorrenciaRelevante: await ocorrenciaRelevante(
            tx,
            companyId,
            turmaId,
            agora,
          ),
          prazo: prazos.aula,
        });
        if (!veredicto.permitido) {
          throw new ConflictException({
            statusCode: 409,
            code: veredicto.code,
            // AC-006: dizer QUANTAS horas o clube exige. "Fora do prazo" sem
            // o número obriga o aluno a descobrir por tentativa.
            message: `Esta turma exige ${prazos.aula.horas}h de antecedência para sair.`,
            horasExigidas: prazos.aula.horas,
          });
        }
      }

      await tx.turmaAluno.delete({ where: { id: alocacao.id } });
    });
  }
}
