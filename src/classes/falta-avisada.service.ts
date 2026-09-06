import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { avaliarSaidaDeTurma } from '../company-settings/prazo-de-cancelamento';
import { antecedenciaEmMinutos } from './ocorrencia-relevante';

/**
 * SPEC-031/REQ-006 — **o aluno avisa que vai faltar, sem sair da turma.**
 *
 * ## A ordem dos locks é o D19, e ela é normativa
 *
 * `alunos FOR KEY SHARE` → `ocupacoes_quadra FOR UPDATE` → escrita. Dois locks
 * explícitos, na ordem do INV-029 — a v6 da spec dizia que esta rota "não pode
 * segurar dois locks", e deixou de ser verdade na v7. **O que a Matriz depende
 * de não existir não é "dois locks": é lock fora de ordem.**
 *
 * Travar a TURMA aqui seria o conserto errado: faria a rota pegar `turmas`
 * (nível 1) **além** de `alunos` (2) e `ocupacoes_quadra` (3), alargando o
 * alcance do lock para evitar uma inconsistência inócua (LIM-031j).
 *
 * ## `alunoId` é derivado, e isso prova IDENTIDADE — não matrícula
 *
 * **É o erro mais perigoso que esta spec catalogou.** A v5 dizia que derivar
 * `alunoId` de `(companyId, user.sub)` "é o que faz o AC-016 (só
 * matriculado)". Falso: um aluno da empresa certa, **não matriculado** na
 * turma B, chamaria a rota com uma ocorrência de B; a ocupação existe, é de
 * turma, é da empresa dele, e as quatro FKs do D18 passam —
 * `faltas_avisadas` **não tem FK para `turma_alunos`**. A falta nasceria.
 *
 * Por isso a matrícula é **consulta própria e obrigatória**, e o `:turmaId` da
 * rota entra nos quatro predicados da ocupação: sem `origem_turma_id`, a URL
 * da turma A alcança a ocorrência da turma B.
 *
 * ## A corrida com `removeStudent` é ACEITA, e o ponto de linearização é dito
 *
 * A consulta de matrícula roda na mesma transação e **não trava a turma**.
 * Entre ela e o `INSERT`, um `removeStudent` concorrente pode tirar o aluno
 * (ele segura `turmas FOR UPDATE`, que esta transação não pede).
 *
 * **A elegibilidade é linearizada na consulta de matrícula**, sob READ
 * COMMITTED. Se a remoção acontece depois dela, o aviso precede logicamente a
 * saída, e o par (aviso, saída) é uma história consistente. Se acontece antes,
 * a consulta não encontra a matrícula e a rota devolve `404`. Não há terceiro
 * desfecho — e é isso, não a intuição de "inofensivo", que sustenta a decisão.
 */
@Injectable()
export class FaltaAvisadaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly operacao: ConfigOperacaoService,
  ) {}

  /**
   * O tronco comum dos dois verbos.
   *
   * `POST` e `DELETE` compartilham **tudo** até a escrita: identidade,
   * matrícula, a ordem de locks, o corte de ocorrência cancelada e a política
   * de prazo. O D23 é simétrico de propósito — *"uma ação barrada com a
   * inversa livre não é regra, é rodeio"* —, e escrever a regra duas vezes
   * seria o convite para as duas divergirem.
   */
  private async comAOcorrenciaTravada<T>(
    companyId: string,
    usuarioId: string,
    turmaId: string,
    ocupacaoId: string,
    escrever: (tx: Prisma.TransactionClient, alunoId: string) => Promise<T>,
  ): Promise<T> {
    const agora = new Date();

    return this.prisma.$transaction(async (tx) => {
      // (1) IDENTIDADE — `alunoId` nunca vem do corpo nem da URL.
      //
      // `FOR KEY SHARE` e não `FOR UPDATE`: esta rota **lê** o aluno, e o que
      // ela precisa é que ele não suma nem mude de chave enquanto a falta
      // nasce. Nível 2 do INV-029, tomado antes do nível 3.
      const alunos = await tx.$queryRaw<{ id: string }[]>`
        SELECT a.id
          FROM alunos a
         WHERE a.company_id = ${companyId}::uuid
           AND a.usuario_id = ${usuarioId}::uuid
         FOR KEY SHARE
      `;
      const aluno = alunos[0];
      // Papel `aluno` no token e sem linha em `alunos` é sessão inconsistente,
      // não recurso ausente — mesma leitura de `MatriculaDoAlunoService`.
      if (!aluno) throw new ForbiddenException();

      // (2) MATRÍCULA — consulta própria, e é ela que faz o AC-016.
      const matricula = await tx.turmaAluno.findFirst({
        where: { turmaId, alunoId: aluno.id },
        select: { id: true },
      });
      if (!matricula) throw new NotFoundException();

      // (3) A OCORRÊNCIA, travada, com os QUATRO predicados. A rota não vale
      // como prova de nenhum deles.
      const ocorrencias = await tx.$queryRaw<
        {
          id: string;
          status_pagamento: string;
          data: Date;
          hora_inicio: Date;
        }[]
      >`
        SELECT id, status_pagamento, data, hora_inicio
          FROM ocupacoes_quadra
         WHERE id              = ${ocupacaoId}::uuid
           AND company_id      = ${companyId}::uuid
           AND origem_tipo     = 'TURMA'
           AND origem_turma_id = ${turmaId}::uuid
         FOR UPDATE
      `;
      const ocorrencia = ocorrencias[0];
      if (!ocorrencia) throw new NotFoundException();

      // (4) D14 — não se avisa falta do que não vai acontecer. A leitura do
      // status vem DEPOIS do lock: sem ele, o `DELETE` leria a aula ativa,
      // outra conexão cancelaria, e a falta sumiria de uma aula cancelada —
      // destruindo o histórico que o D14 manda preservar.
      if (ocorrencia.status_pagamento === 'cancelado') {
        throw new ConflictException({
          statusCode: 409,
          code: 'OCUPACAO_CANCELADA',
          message: 'Esta aula foi cancelada pelo clube.',
        });
      }

      // (5) D23 — a política, nos DOIS verbos e com o mesmo código.
      const prazos = await this.operacao.prazosDaEmpresa(companyId, tx);
      const veredicto = avaliarSaidaDeTurma({
        papelDoAutor: 'aluno',
        agora,
        ocorrenciaRelevante: {
          tipo: 'MINUTOS',
          minutos: antecedenciaEmMinutos(
            ocorrencia.data,
            ocorrencia.hora_inicio,
          ),
        },
        prazo: prazos.aula,
      });
      if (!veredicto.permitido) {
        throw new ConflictException({
          statusCode: 409,
          code: veredicto.code,
          message:
            prazos.aula.regra === 'HORAS'
              ? `Avisar ou retirar o aviso exige ${prazos.aula.horas}h de antecedência.`
              : 'Esta aula já começou.',
        });
      }

      return escrever(tx, aluno.id);
    });
  }

  /**
   * AC-015/AC-017 — avisar. **A idempotência é do BANCO.**
   *
   * `createMany({ skipDuplicates })` porque é o que o Prisma compila para
   * `INSERT … ON CONFLICT DO NOTHING` **sempre**, sem condição a conferir.
   * Nem `upsert` nem a sequência find/create: o `upsert` só delega ao banco
   * quando os critérios do Prisma são atendidos, e depender dessa condição
   * para uma garantia de concorrência é frágil. Mesmo idioma de
   * `aceites.service.ts:150`.
   *
   * Dois `POST` simultâneos, de duas conexões, produzem **uma** linha — quem
   * garante é o índice `faltas_unica (ocupacao_id, aluno_id)`, não o lock.
   */
  async avisar(
    companyId: string,
    usuarioId: string,
    turmaId: string,
    ocupacaoId: string,
  ): Promise<void> {
    await this.comAOcorrenciaTravada(
      companyId,
      usuarioId,
      turmaId,
      ocupacaoId,
      async (tx, alunoId) => {
        await tx.faltaAvisada.createMany({
          data: [{ companyId, ocupacaoId, alunoId }],
          skipDuplicates: true,
        });
      },
    );
  }

  /**
   * AC-015/AC-017b — retirar o aviso.
   *
   * `deleteMany` e não `delete`: repetir devolve o mesmo sucesso, inclusive
   * quando a linha já não existe. `delete` levantaria `P2025` na segunda
   * chamada, e retentativa de rede não é engano do usuário.
   */
  async retirar(
    companyId: string,
    usuarioId: string,
    turmaId: string,
    ocupacaoId: string,
  ): Promise<void> {
    await this.comAOcorrenciaTravada(
      companyId,
      usuarioId,
      turmaId,
      ocupacaoId,
      async (tx, alunoId) => {
        await tx.faltaAvisada.deleteMany({
          where: { companyId, ocupacaoId, alunoId },
        });
      },
    );
  }
}
