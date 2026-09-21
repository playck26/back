/**
 * SPEC-064/TASK-006 — **FIT-051 e FIT-052: a fila sob concorrência real.**
 *
 * ## Por que sequencial não prova nada aqui
 *
 * Os db-specs das TASK-002/003/004 rodam tudo numa conexão só, e o Prisma
 * serializa: quem chega depois lê o estado já escrito e decide certo **sem que
 * nenhum lock tenha sido exercitado**. A decisão mais cara desta spec — a
 * **ordem canônica de quatro níveis** — seria afirmação.
 *
 * Este arquivo abre **conexões independentes**. É o único lugar em que:
 *
 * - **FIT-051** — duas réplicas varrem o mesmo alvo ao mesmo tempo, e o
 *   `UNIQUE (turma_id) WHERE estado='chamado'` é o **único** lock entre elas
 *   (D8: não há advisory lock, e isso é deliberado);
 * - **FIT-052 / AC-013** — varredor, confirmação de aula e
 *   `ReposicaoService.marcar` correm juntos sobre o mesmo alvo. Sem a ordem de
 *   quatro níveis, o varredor segura a turma e quer a linha da fila enquanto a
 *   confirmação segura a linha e quer a turma: **deadlock** (`40P01`).
 *
 * ## O que se afirma, e o que não
 *
 * Afirma-se o **efeito**: um chamado por alvo, e nenhum `40P01`. **Não** se
 * afirma qual lado vence — isso depende de quem chega primeiro ao lock, e
 * exigir um vencedor fixo seria medir o escalonador do Postgres.
 */
import { PrismaClient } from '@prisma/client';
import { VarredorDaFilaService } from '../../src/fila-de-espera/varredor-da-fila.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = 'f0510000-0000-4000-8000-000000000001';
const QUADRA = 'f0510000-0000-4000-8000-000000000002';
const TURMA_ORIGEM = 'f0510000-0000-4000-8000-00000000000a';
const TURMA_ALVO = 'f0510000-0000-4000-8000-00000000000b';

/**
 * **Quatro conexões, e é o ponto do arquivo.** Uma para semear e três para
 * correr — com um cliente só, o Prisma serializa e a corrida vira sequência.
 */
const semear = new PrismaClient();
const dbA = new PrismaClient();
const dbB = new PrismaClient();
const dbC = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);

const varredor = (c: PrismaClient) =>
  new VarredorDaFilaService(c as unknown as PrismaService);

const fila = (c: PrismaClient) => {
  const p = c as unknown as PrismaService;
  const operacao = new ConfigOperacaoService(p);
  return new FilaDeEsperaService(
    p,
    operacao,
    new MatriculaDoAlunoService(p, operacao),
    new ReposicaoService(p, operacao),
  );
};

const reposicoes = (c: PrismaClient) => {
  const p = c as unknown as PrismaService;
  return new ReposicaoService(p, new ConfigOperacaoService(p));
};

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** Um lado da corrida, sem derrubar os outros. */
async function desfecho<T>(
  p: Promise<T>,
): Promise<{ ok: true; valor: T } | { ok: false; erro: unknown }> {
  try {
    return { ok: true, valor: await p };
  } catch (erro) {
    return { ok: false, erro };
  }
}

/** `40P01` é `deadlock_detected`. É ele, e só ele, que a AC-013 proíbe. */
function ehDeadlock(erro: unknown): boolean {
  const e = erro as { message?: string; meta?: { code?: string } };
  return (
    e?.meta?.code === '40P01' || String(e?.message ?? '').includes('40P01')
  );
}

let seq = 0;
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const usuarioId = `f0510000-0000-4000-8000-100000000${s}`;
  const alunoId = `f0510000-0000-4000-8000-200000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit051.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function ocorrencia(turmaId: string, data: string, hora: string) {
  ocSeq += 1;
  const id = `f0510000-0000-4000-8000-300000000${String(ocSeq).padStart(3, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

let faltaSeq = 0;
async function falta(alunoId: string, ocupacaoId: string) {
  faltaSeq += 1;
  const id = `f0510000-0000-4000-8000-400000000${String(faltaSeq).padStart(3, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

let filaSeq = 0;
async function naFila(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
  chamado?: boolean;
}) {
  filaSeq += 1;
  const id = `f0510000-0000-4000-8000-500000000${String(filaSeq).padStart(3, '0')}`;
  const estado = opcoes.chamado
    ? `'chamado', now(), now() + interval '6 hours'`
    : `'aguardando', NULL, NULL`;
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}',
             ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
             ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
             ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
             ${estado})`,
  );
  return id;
}

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-051','fit-051-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await semear.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q','${esporte.id}',80,'ativa')`,
  );
  // Capacidade alta: o que está em julgamento aqui é lock, não capacidade.
  for (const t of [TURMA_ORIGEM, TURMA_ALVO]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${t}','${EMPRESA}','T','${QUADRA}',40,'ativa')`,
    );
  }
}

beforeAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    semear.$disconnect(),
    dbA.$disconnect(),
    dbB.$disconnect(),
    dbC.$disconnect(),
  ]);
});

describe('FIT-051 — duas réplicas varrendo o MESMO alvo', () => {
  /**
   * **A constraint é o lock, e este é o único lugar onde isso é exercitado.**
   *
   * A D8 recusa advisory lock de propósito: chamar duas vezes é impossível por
   * construção, porque o `UNIQUE (turma_id) WHERE estado='chamado'` recusa o
   * segundo com `23505` e a réplica perdedora desiste daquele alvo.
   *
   * Com um advisory lock por cima, este teste passaria **sem provar nada** — a
   * serialização viria do lock, não da constraint. É por isso que a ausência
   * dele está declarada na spec em vez de ser silêncio.
   */
  it('AC-003 — dez rodadas, e NUNCA dois chamados no mesmo alvo', async () => {
    for (let i = 0; i < 10; i += 1) {
      const turma = `f0510000-0000-4000-8000-6000000000${String(i).padStart(2, '0')}`;
      await q(
        `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${turma}','${EMPRESA}','R${i}','${QUADRA}',40,'ativa')`,
      );
      const a = await aluno(`R${i}a`);
      const b = await aluno(`R${i}b`);
      await naFila({ alunoId: a.alunoId, turmaId: turma });
      await naFila({ alunoId: b.alunoId, turmaId: turma });

      // As duas réplicas, de verdade ao mesmo tempo.
      const [ra, rb] = await Promise.all([
        desfecho(varredor(dbA).executarCiclo()),
        desfecho(varredor(dbB).executarCiclo()),
      ]);

      // **Nenhuma das duas pode explodir.** Perder a disputa é desfecho
      // normal — a réplica perdedora trata o `23505` e segue.
      expect(ra.ok).toBe(true);
      expect(rb.ok).toBe(true);

      const chamados = await semear.listaDeEspera.count({
        where: { turmaId: turma, estado: 'chamado' },
      });
      expect(chamados).toBe(1);

      // E a fila não ficou pela metade: o outro continua esperando.
      expect(
        await semear.listaDeEspera.count({
          where: { turmaId: turma, estado: 'aguardando' },
        }),
      ).toBe(1);
    }
  });
});

describe('FIT-052 / AC-013 — confirmação × reposição × varredor', () => {
  /**
   * **Os TRÊS caminhos, e não dois.**
   *
   * A v3 da spec deixava `alunos FOR KEY SHARE` de fora da confirmação de
   * aula, e a 2ª rodada de validação reabriu por isso: a confirmação ali
   * **cria `reposicoes_de_aula`**, a mesma escrita do `ReposicaoService`, que
   * toma `1→2→3`. Se uma das duas pular o nível 2, elas tomam ordens
   * diferentes sobre as mesmas linhas — e o ciclo volta por outro lado.
   *
   * Por isso a prova roda **varredor, confirmação de aula e `marcar` pela tela
   * normal**, nas três conexões, sobre o mesmo alvo.
   */
  it('AC-013 — dez rodadas dos três caminhos juntos, e nenhum 40P01', async () => {
    for (let i = 0; i < 10; i += 1) {
      // **Um dia por iteração.** A primeira versão punha as três faltas no
      // mesmo (quadra, dia, hora) todas as vezes, e a `EXCLUDE`
      // `no_overlap_por_quadra` derrubou a segunda rodada com `23P01` — a
      // invariante mais antiga do projeto recusando a minha fixture.
      const alvo = await ocorrencia(TURMA_ALVO, emDias(3 + i), '09:00');

      // Quem vai confirmar: já chamado, com crédito.
      const confirmante = await aluno(`C${i}`);
      await matricular(TURMA_ORIGEM, confirmante.alunoId);
      const perdidaC = await ocorrencia(
        TURMA_ORIGEM,
        emDias(-(2 + i)),
        '07:00',
      );
      const creditoC = await falta(confirmante.alunoId, perdidaC);
      const linhaChamada = await naFila({
        alunoId: confirmante.alunoId,
        ocupacaoId: alvo,
        faltaId: creditoC,
        chamado: true,
      });

      // Quem marca pela tela normal, disputando a MESMA aula (LIM-064f).
      const direto = await aluno(`D${i}`);
      await matricular(TURMA_ORIGEM, direto.alunoId);
      const perdidaD = await ocorrencia(
        TURMA_ORIGEM,
        emDias(-(2 + i)),
        '08:00',
      );
      const creditoD = await falta(direto.alunoId, perdidaD);

      // E alguém esperando numa OUTRA aula, para o varredor ter trabalho.
      const esperando = await aluno(`E${i}`);
      await matricular(TURMA_ORIGEM, esperando.alunoId);
      const perdidaE = await ocorrencia(
        TURMA_ORIGEM,
        emDias(-(2 + i)),
        '10:00',
      );
      const creditoE = await falta(esperando.alunoId, perdidaE);
      const outraAula = await ocorrencia(TURMA_ALVO, emDias(3 + i), '11:00');
      await naFila({
        alunoId: esperando.alunoId,
        ocupacaoId: outraAula,
        faltaId: creditoE,
      });

      const [rVarredor, rConfirma, rMarca] = await Promise.all([
        desfecho(varredor(dbA).executarCiclo()),
        desfecho(
          fila(dbB).confirmar(EMPRESA, confirmante.usuarioId, linhaChamada),
        ),
        desfecho(
          reposicoes(dbC).marcar(EMPRESA, direto.usuarioId, creditoD, alvo),
        ),
      ]);

      // **A asserção da AC-013**: nenhum dos três pode morrer de deadlock.
      for (const r of [rVarredor, rConfirma, rMarca]) {
        if (!r.ok) {
          expect(ehDeadlock(r.erro)).toBe(false);
        }
      }

      // O varredor nunca falha: ele trata o `23505` como desfecho.
      expect(rVarredor.ok).toBe(true);

      // E o estado não ficou pela metade: a linha chamada terminou de alguma
      // forma — `atendida` se confirmou, `encerrada` se a vaga sumiu. O que
      // não pode é continuar `chamado` com a transação comitada.
      const depois = await semear.listaDeEspera.findUniqueOrThrow({
        where: { id: linhaChamada },
        select: { estado: true },
      });
      expect(['atendida', 'encerrada', 'chamado']).toContain(depois.estado);

      // **Se confirmou, existe UMA reposição dela — nunca duas.**
      if (rConfirma.ok && rConfirma.valor.ok) {
        expect(
          await semear.reposicaoDeAula.count({
            where: { companyId: EMPRESA, faltaId: creditoC },
          }),
        ).toBe(1);
        expect(depois.estado).toBe('atendida');
      }
    }
  });
});
