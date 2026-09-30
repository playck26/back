import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { instanteNoFusoDoClube } from '../courts/date-time.util';
import { momentoDaAula } from './avisos-de-gesto';
import { RESTO_DO_PRAZO } from '../common/lock/prazo-de-espera';

/**
 * SPEC-078/REQ-001 — **o gestor sabe o que o aluno fez.**
 *
 * Os avisos da SPEC-063 nascem da AÇÃO ADMINISTRATIVA que o gesto do gestor
 * grava; as ações do aluno não gravam ação nenhuma (decisão I5 do Israel: elas
 * **não** entram no histórico). Por isso esta é uma família própria, no molde
 * da pré-reserva (SPEC-074): `tipo = 'gesto_do_aluno'`, um montador puro e um
 * enfileirador, com o índice parcial e o CHECK de origem da migration
 * `…_spec078_gesto_do_aluno`.
 *
 * **Quem chama é quem ESCREVE** (D1): `marcarNaTransacao` e
 * `entrarNaTransacao` — e por isso a confirmação da fila de espera, que compõe
 * os dois, avisa igual (I12) —, `avisar`, `retirar`, `desmarcar` e `sair`. E
 * só depois de a escrita acontecer: ação que não aconteceu não avisa (AC-002).
 */
export const TIPO_GESTO_DO_ALUNO = 'gesto_do_aluno';

/** O vocabulário fechado de títulos desta família (I9). */
export const TITULOS_DO_GESTO_DO_ALUNO = [
  'Reposições',
  'Faltas',
  'Turmas',
] as const;

export type TituloDoGestoDoAluno = (typeof TITULOS_DO_GESTO_DO_ALUNO)[number];

export type AcaoDoAluno =
  | 'reposicao_marcada'
  | 'reposicao_desmarcada'
  | 'falta_avisada'
  | 'falta_retirada'
  | 'entrou_na_turma'
  | 'saiu_da_turma';

/**
 * **Só dia, hora e a turma — e a turma só como ID, na URL** (INV-078a, I3).
 * Não há campo de nome aqui, e é isso que fecha o "sem nome" por construção:
 * o montador não tem como escrever o que não recebe.
 */
export interface FatosDaAcaoDoAluno {
  readonly turmaId: string;
  /** A aula, para as ações que têm uma (falta e reposição); `null` nas de turma. */
  readonly aula: {
    readonly data: Date;
    readonly horaInicio: Date;
    readonly horaFim: Date;
  } | null;
}

export interface AvisoDaAcaoDoAluno {
  readonly titulo: TituloDoGestoDoAluno;
  readonly corpo: string;
  readonly destinoUrl: string;
  /** O fim da aula; `null` = sem prazo (o TTL de 24 h da SPEC-062). */
  readonly expiraEm: Date | null;
}

/** O montador puro: sem I/O, e o `switch` é exaustivo sobre as seis ações. */
export function montarAvisoDoGestoDoAluno(
  acao: AcaoDoAluno,
  fatos: FatosDaAcaoDoAluno,
): AvisoDaAcaoDoAluno {
  const destinoUrl = `/turmas/${fatos.turmaId}`;
  const momento = fatos.aula
    ? momentoDaAula(fatos.aula.data, fatos.aula.horaInicio)
    : null;
  const expiraEm = fatos.aula
    ? instanteNoFusoDoClube(fatos.aula.data, fatos.aula.horaFim)
    : null;

  const daAula = (
    corpo: (m: string) => string,
    titulo: TituloDoGestoDoAluno,
  ) => {
    if (!momento) {
      throw new Error(`SPEC-078: ${acao} precisa da aula`);
    }
    return { titulo, corpo: corpo(momento), destinoUrl, expiraEm };
  };

  switch (acao) {
    case 'reposicao_marcada':
      return daAula((m) => `Uma reposição foi marcada para ${m}`, 'Reposições');
    case 'reposicao_desmarcada':
      return daAula(
        (m) => `Uma reposição de ${m} foi desmarcada`,
        'Reposições',
      );
    case 'falta_avisada':
      return daAula(
        (m) => `Um aluno avisou que vai faltar na aula de ${m}`,
        'Faltas',
      );
    case 'falta_retirada':
      return daAula(
        (m) => `Um aluno retirou o aviso de falta da aula de ${m}`,
        'Faltas',
      );
    case 'entrou_na_turma':
      return {
        titulo: 'Turmas',
        corpo: 'Um aluno entrou em uma das turmas',
        destinoUrl,
        expiraEm: null,
      };
    case 'saiu_da_turma':
      return {
        titulo: 'Turmas',
        corpo: 'Um aluno saiu de uma das turmas',
        destinoUrl,
        expiraEm: null,
      };
  }
}

/**
 * Grava o aviso da ação para cada gestor ativo da empresa, **na transação da
 * ação** — duas idas ao banco, qualquer que seja o número de gestores
 * (NFR-001): ler os gestores, gravar as linhas.
 *
 * `origem_id` é um uuid novo por ação: cada fato é um aviso (I6 — avisar e
 * retirar são dois). O índice parcial da migration só impede que a MESMA
 * ação seja gravada duas vezes para o mesmo gestor.
 */
export class AvisosDoGestoDoAluno {
  constructor(
    private readonly tx: Prisma.TransactionClient,
    private readonly companyId: string,
    /** O usuário do aluno, que nunca é gestor — mas o autor sai por regra. */
    private readonly autorUsuarioId: string | null,
  ) {}

  async despachar(
    acao: AcaoDoAluno,
    fatos: FatosDaAcaoDoAluno,
  ): Promise<number> {
    const aviso = montarAvisoDoGestoDoAluno(acao, fatos);
    const gestores = await this.tx.$queryRaw<{ usuario_id: string }[]>`
      SELECT id AS usuario_id FROM usuarios
       WHERE company_id = ${this.companyId}::uuid
         AND role = 'company_admin'
         AND status = 'ativo'
         AND id IS DISTINCT FROM ${this.autorUsuarioId}::uuid`;
    if (gestores.length === 0) {
      return 0;
    }
    const origemId = randomUUID();
    const linhas = gestores.map(
      (g) =>
        Prisma.sql`(${randomUUID()}::uuid, ${this.companyId}::uuid,
                    ${g.usuario_id}::uuid, ${origemId}::uuid,
                    ${TIPO_GESTO_DO_ALUNO}::text, ${aviso.titulo}::text,
                    ${aviso.corpo}::text, ${aviso.destinoUrl}::text,
                    ${aviso.expiraEm}::timestamptz)`,
    );
    const destinatarios = gestores.map((g) => g.usuario_id);
    // SPEC-082/D2b (achado 082-V4-01) — cada linha grava uma FK para
    // `usuarios`, e cada checagem é uma AQUISIÇÃO: um `lock_timeout` único para
    // a instrução deixaria a soma passar do prazo. As linhas dos gestores são
    // travadas ANTES, em `FOR KEY SHARE`, uma a uma, com o prazo recalculado
    // imediatamente antes de CADA uma — e o recálculo DEPENDE da linha
    // (`WHERE d.id IS NOT NULL`): sem a dependência o Postgres o avalia uma vez
    // só (a pré-prova da spec: 3.513 ms contra 2.030 ms). A checagem de FK
    // encontra a linha já travada pela própria transação e não espera.
    //
    // Fora de matrícula (sair da turma, falta), a transação não tem prazo e o
    // recálculo devolve o `lock_timeout` vigente: nada muda para eles.
    return this.tx.$executeRaw`
      WITH alvo AS MATERIALIZED (
        SELECT u.id
          FROM unnest(${destinatarios}::uuid[]) WITH ORDINALITY AS d(id, ord),
               LATERAL (SELECT set_config('lock_timeout', ${RESTO_DO_PRAZO}, true) AS cfg
                         WHERE d.id IS NOT NULL) r,
               LATERAL (SELECT us.id FROM usuarios us
                         WHERE us.company_id = ${this.companyId}::uuid
                           AND us.id = d.id AND r.cfg IS NOT NULL
                         FOR KEY SHARE) u
         ORDER BY d.ord)
      INSERT INTO notificacoes (id, company_id, destinatario_id, origem_id,
                                tipo, titulo, corpo, destino_url, expira_em)
      SELECT v.id, v.company_id, v.destinatario_id, v.origem_id, v.tipo,
             v.titulo, v.corpo, v.destino_url, v.expira_em
        FROM (VALUES ${Prisma.join(linhas)})
             AS v(id, company_id, destinatario_id, origem_id, tipo, titulo,
                  corpo, destino_url, expira_em)
       WHERE v.destinatario_id IN (SELECT id FROM alvo)
      ON CONFLICT (origem_id, destinatario_id) WHERE tipo = 'gesto_do_aluno'
      DO NOTHING`;
  }
}
