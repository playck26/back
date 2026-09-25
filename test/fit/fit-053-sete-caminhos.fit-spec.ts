/**
 * SPEC-064/TASK-006 — **FIT-053: são SETE, e nenhum termina sem motivo.**
 *
 * ## O que este arquivo prova que os db-specs não provam
 *
 * `spec-064-encerramentos` e `spec-064-varredor` já exercitam os caminhos **um
 * a um**: cada caso mostra que aquele gesto encerra aquela fila. Nenhum deles
 * responde a pergunta da D6, que é outra: **o conjunto está completo?**
 *
 * Este arquivo roda os sete e compara o conjunto de `motivo_fim` alcançados com
 * o conjunto **declarado** em `MOTIVO`. Ele fica vermelho em duas situações que
 * nenhum outro teste vê:
 *
 * - alguém acrescenta um `MOTIVO` e esquece de ligar o caminho — motivo morto;
 * - alguém acrescenta um caminho novo com um motivo fora da lista — motivo
 *   solto, que o operador vai encontrar em produção sem saber de onde veio.
 *
 * E prova a propriedade que a D6 implica sem dizer: **linha terminal nunca tem
 * `motivo_fim` nulo.** Fila que termina sem motivo é fila que ninguém consegue
 * auditar depois, e é o tipo de buraco que só aparece meses adiante.
 *
 * **A SPEC-061/v4 esquecera a retirada da falta.** Um teste que conta o
 * conjunto é o que impede o sétimo de sumir de novo.
 */
import { PrismaClient } from '@prisma/client';
import { VarredorDaFilaService } from '../../src/fila-de-espera/varredor-da-fila.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { MOTIVO } from '../../src/fila-de-espera/encerramento-da-fila';
import { FaltaAvisadaService } from '../../src/classes/falta-avisada.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { StudentsService } from '../../src/people/students.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = 'f0530000-0000-4000-8000-000000000001';
const QUADRA = 'f0530000-0000-4000-8000-000000000002';
const TURMA_ORIGEM = 'f0530000-0000-4000-8000-00000000000a';
const ADMIN = 'f0530000-0000-4000-8000-00000000000c';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const operacao = () => new ConfigOperacaoService(p);
const varredor = () =>
  new VarredorDaFilaService(p, new ConfigOperacaoService(p));
const faltas = () => new FaltaAvisadaService(p, operacao());
const reposicoes = () => new ReposicaoService(p, operacao());
const matriculas = () => new MatriculaDoAlunoService(p, operacao());
const filaDeEspera = () =>
  new FilaDeEsperaService(p, operacao(), matriculas(), reposicoes());

function classes(): ClassesService {
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    operacao(),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(p, courts, new StudentsService(p), operacao());
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const usuarioId = `f0530000-0000-4000-8000-100000000${s}`;
  const alunoId = `f0530000-0000-4000-8000-200000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit053.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function ocorrencia(turmaId: string, data: string, hora: string) {
  ocSeq += 1;
  const id = `f0530000-0000-4000-8000-300000000${String(ocSeq).padStart(3, '0')}`;
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
  const id = `f0530000-0000-4000-8000-400000000${String(faltaSeq).padStart(3, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

let turmaSeq = 0;
async function turma(): Promise<string> {
  turmaSeq += 1;
  const id = `f0530000-0000-4000-8000-500000000${String(turmaSeq).padStart(3, '0')}`;
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${id}','${EMPRESA}','T${turmaSeq}','${QUADRA}',40,'ativa')`,
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
  prazoHoras?: number;
}) {
  filaSeq += 1;
  const id = `f0530000-0000-4000-8000-600000000${String(filaSeq).padStart(3, '0')}`;
  const estado = opcoes.chamado
    ? `'chamado', now(), now() + interval '${opcoes.prazoHoras ?? 6} hours'`
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

const motivoDe = async (id: string) =>
  (
    await db.listaDeEspera.findUniqueOrThrow({
      where: { id },
      select: { motivoFim: true },
    })
  ).motivoFim;

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-053','fit-053-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q','${esporte.id}',80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.fit053@x.com','h','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_ORIGEM}','${EMPRESA}','Origem','${QUADRA}',40,'ativa')`,
  );
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-053 — os sete caminhos, e o conjunto fecha', () => {
  it('cada um dos sete encerra, e o conjunto de motivos é EXATAMENTE o declarado', async () => {
    const alcancados = new Set<string>();

    // --- 1. prazo vencido (varredor) ---------------------------------------
    {
      const t = await turma();
      const a = await aluno('Prazo vencido');
      const f = await naFila({
        alunoId: a.alunoId,
        turmaId: t,
        chamado: true,
        prazoHoras: -1,
      });
      await varredor().executarCiclo();
      const m = await motivoDe(f);
      expect(m).toBe('prazo vencido');
      alcancados.add(m as string);
    }

    // --- 2. aula cancelada (inativar a turma cancela as ocorrências) --------
    {
      const t = await turma();
      const a = await aluno('Aula cancelada');
      await matricular(TURMA_ORIGEM, a.alunoId);
      const perdida = await ocorrencia(TURMA_ORIGEM, emDias(-3), '06:00');
      const credito = await falta(a.alunoId, perdida);
      const alvo = await ocorrencia(t, emDias(5), '07:00');
      const f = await naFila({
        alunoId: a.alunoId,
        ocupacaoId: alvo,
        faltaId: credito,
      });
      await classes().update(EMPRESA, t, { status: 'inativa' } as never, ADMIN);
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.AULA_CANCELADA);
      alcancados.add(m as string);
    }

    // --- 3. turma inativada -------------------------------------------------
    {
      const t = await turma();
      const a = await aluno('Turma inativada');
      const f = await naFila({ alunoId: a.alunoId, turmaId: t });
      await classes().update(EMPRESA, t, { status: 'inativa' } as never, ADMIN);
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.TURMA_INATIVADA);
      alcancados.add(m as string);
    }

    // --- 4. o aluno sai da turma (por conta própria) ------------------------
    {
      const t = await turma();
      const a = await aluno('Saiu sozinho');
      await matricular(t, a.alunoId);
      const f = await naFila({ alunoId: a.alunoId, turmaId: t });
      await matriculas().sair(EMPRESA, a.usuarioId, t);
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.SAIU_DA_TURMA);
      alcancados.add(m as string);
    }

    // --- 5. o aluno sai da turma (removido pelo gestor) ---------------------
    {
      const t = await turma();
      const a = await aluno('Removido');
      await matricular(t, a.alunoId);
      const f = await naFila({ alunoId: a.alunoId, turmaId: t });
      await classes().removeStudent(
        EMPRESA,
        t,
        a.alunoId,
        ADMIN,
        'company_admin',
      );
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.SAIU_DA_TURMA);
      alcancados.add(m as string);
    }

    // --- 6. o aluno perde o vínculo ----------------------------------------
    {
      const t = await turma();
      const a = await aluno('Desligado');
      const f = await naFila({ alunoId: a.alunoId, turmaId: t });
      await new StudentsService(p).update(EMPRESA, a.alunoId, {
        status: 'inativo',
      } as never);
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.SEM_VINCULO);
      alcancados.add(m as string);
    }

    // --- 7. a falta retirada (a ordem normativa) ---------------------------
    {
      const a = await aluno('Retirou a falta');
      await matricular(TURMA_ORIGEM, a.alunoId);
      const perdida = await ocorrencia(TURMA_ORIGEM, emDias(2), '08:00');
      const credito = await falta(a.alunoId, perdida);
      const t = await turma();
      const alvo = await ocorrencia(t, emDias(6), '09:00');
      const f = await naFila({
        alunoId: a.alunoId,
        ocupacaoId: alvo,
        faltaId: credito,
      });
      await faltas().retirar(EMPRESA, a.usuarioId, TURMA_ORIGEM, perdida);
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.FALTA_RETIRADA);
      alcancados.add(m as string);
    }

    // --- 8. o crédito consumido por outro caminho --------------------------
    {
      const a = await aluno('Repos direto');
      await matricular(TURMA_ORIGEM, a.alunoId);
      const perdida = await ocorrencia(TURMA_ORIGEM, emDias(-4), '10:00');
      const credito = await falta(a.alunoId, perdida);
      const t = await turma();
      const naFilaDe = await ocorrencia(t, emDias(7), '11:00');
      const escolhida = await ocorrencia(t, emDias(8), '12:00');
      const f = await naFila({
        alunoId: a.alunoId,
        ocupacaoId: naFilaDe,
        faltaId: credito,
      });
      await reposicoes().marcar(EMPRESA, a.usuarioId, credito, escolhida);
      const m = await motivoDe(f);
      expect(m).toBe(MOTIVO.CREDITO_CONSUMIDO);
      alcancados.add(m as string);
    }

    // =====================================================================
    // **O conjunto fecha.**
    //
    // Sete eventos terminais da D6, e `saiu da turma` cobre dois deles (o
    // aluno sozinho e o gestor removendo) — por isso são SEIS motivos vindos
    // de `MOTIVO`, mais `prazo vencido`, que é do varredor.
    //
    // Se alguém acrescentar um `MOTIVO` sem ligar o caminho, ele fica de fora
    // deste conjunto e o teste grita. Se acrescentar um caminho com motivo
    // fora da lista, idem.
    // =====================================================================
    const declarados = new Set<string>([
      ...Object.values(MOTIVO),
      'prazo vencido',
    ]);
    expect([...alcancados].sort()).toEqual([...declarados].sort());
  });

  /**
   * **Linha terminal nunca tem `motivo_fim` nulo.**
   *
   * A D6 implica isso sem dizer, e nenhum caso individual o verifica: cada um
   * olha a própria linha. Esta asserção olha a tabela inteira da empresa,
   * depois de todos os caminhos terem rodado.
   *
   * Fila que termina sem motivo é fila que ninguém consegue auditar depois —
   * e o operador descobre meses adiante, olhando uma linha `encerrada` que não
   * diz por quê.
   */
  it('nenhuma linha terminal ficou sem motivo', async () => {
    const orfas = await db.listaDeEspera.count({
      where: {
        companyId: EMPRESA,
        estado: { in: ['expirada', 'encerrada', 'desistiu', 'atendida'] },
        motivoFim: null,
      },
    });
    expect(orfas).toBe(0);
  });

  /** E o espelho: linha ativa nunca tem `concluida_em`. */
  it('nenhuma linha ativa ficou com data de conclusão', async () => {
    const confusas = await db.listaDeEspera.count({
      where: {
        companyId: EMPRESA,
        estado: { in: ['aguardando', 'chamado'] },
        concluidaEm: { not: null },
      },
    });
    expect(confusas).toBe(0);
  });

  /** A fila também termina por gesto do próprio aluno — e isso não é da D6. */
  it('desistir e confirmar também escrevem motivo', async () => {
    const t = await turma();
    const a = await aluno('Desistiu');
    const f = await naFila({ alunoId: a.alunoId, turmaId: t });
    await filaDeEspera().sair(EMPRESA, a.usuarioId, f);
    expect(await motivoDe(f)).toBe('saiu da fila');

    const b = await aluno('Confirmou');
    const g = await naFila({ alunoId: b.alunoId, turmaId: t, chamado: true });
    const r = await filaDeEspera().confirmar(EMPRESA, b.usuarioId, g);
    expect(r.ok).toBe(true);
    expect(await motivoDe(g)).toBe('confirmou');
  });
});
