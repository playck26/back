import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { formatDateOnly, hojeNoFusoDoClube } from '../../courts/date-time.util';
import { PrismaService } from '../../prisma/prisma.service';
import {
  montarPlanilhaDeAlunos,
  nomeDoArquivoDaPlanilha,
  statusNaPlanilha,
  type AlunoDaPlanilha,
} from './planilha-de-alunos';

/** Uma linha da consulta, antes de virar `AlunoDaPlanilha`. */
interface LinhaDoBanco {
  nome: string;
  email: string;
  telefone: string | null;
  nivel: string | null;
  aluno_inativo: boolean;
  conta_inativa: boolean;
  senha_temporaria: boolean;
  turmas: string[];
}

/**
 * SPEC-092 — **o clube inteiro numa consulta só.**
 *
 * Uma consulta por aluno para buscar as turmas seria o N+1 que o DEF-013 baniu
 * — e um clube de 300 alunos é exatamente o que este botão vai exportar. As
 * turmas vêm agregadas por `array_agg`, já na ordem da D4.
 *
 * ## O clube sai de UM lugar
 *
 * `a.company_id = $1`, e os `JOIN`s também casam pelo clube. A FK composta de
 * `alunos -> usuarios` já impede a conta de outro clube, e o `JOIN` de turma
 * pelo clube é o que impede a matrícula numa turma de outro clube — que o
 * banco não proíbe por FK em `turma_alunos` — de vazar o nome dela.
 */
@Injectable()
export class ExportacaoDeAlunosService {
  constructor(private readonly prisma: PrismaService) {}

  async alunosDoClube(companyId: string): Promise<AlunoDaPlanilha[]> {
    const linhas = await this.prisma.$queryRaw<LinhaDoBanco[]>(Prisma.sql`
      SELECT u.nome,
             u.email,
             u.telefone,
             n.nome                       AS nivel,
             (a.status = 'inativo')       AS aluno_inativo,
             (u.status = 'inativo')       AS conta_inativa,
             u.senha_temporaria,
             COALESCE(
               array_agg(t.nome ORDER BY t.nome, t.id)
                 FILTER (WHERE t.id IS NOT NULL),
               '{}'
             )                            AS turmas
        FROM alunos a
        JOIN usuarios u
          ON u.id = a.usuario_id AND u.company_id = a.company_id
        LEFT JOIN niveis n
          ON n.id = a.nivel_id AND n.company_id = a.company_id
        LEFT JOIN turma_alunos ta
          ON ta.aluno_id = a.id
        LEFT JOIN turmas t
          ON t.id = ta.turma_id
         AND t.company_id = a.company_id
         AND t.status = 'ativa'
       WHERE a.company_id = ${companyId}::uuid
       GROUP BY a.id, u.id, n.nome
       ORDER BY u.nome, a.id
    `);

    return linhas.map((l) => ({
      nome: l.nome,
      email: l.email,
      telefone: l.telefone,
      nivel: l.nivel,
      turmas: l.turmas,
      status: statusNaPlanilha({
        alunoInativo: l.aluno_inativo,
        contaInativa: l.conta_inativa,
        senhaTemporaria: l.senha_temporaria,
      }),
    }));
  }

  /** O arquivo e o nome dele (D6), com a data de hoje no fuso do clube. */
  async exportar(
    companyId: string,
    agora: Date = new Date(),
  ): Promise<{ nomeDoArquivo: string; conteudo: string }> {
    const alunos = await this.alunosDoClube(companyId);
    return {
      nomeDoArquivo: nomeDoArquivoDaPlanilha(
        formatDateOnly(hojeNoFusoDoClube(agora)),
      ),
      conteudo: montarPlanilhaDeAlunos(alunos),
    };
  }
}
