/**
 * SPEC-064/TASK-003b — **confirmar a vez, contra o banco de verdade.**
 *
 * ## O que está em julgamento
 *
 * - **AC-007 — os dois comitam juntos.** A reposição nasce e a linha vira
 *   `atendida` na mesma transação. Separá-los deixaria alguém com reposição
 *   marcada e fila ainda `chamado`, ou o contrário;
 * - **AC-006 — a recusa devolve `409` E a linha fica `encerrada`.** Este é o
 *   achado v2-03, **reaberto em v4-06**: a v3 ainda lançava exceção de dentro
 *   do callback, o que reverteria o próprio encerramento e deixaria o chamado
 *   morto aparecendo para a pessoa.
 *
 * O segundo só é observável contra o banco: precisa que a transação **comite**
 * com o encerramento dentro e a recusa fora. Um mock não comita nada.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '06440000-0000-4000-8000-000000000001';
const QUADRA = '06440000-0000-4000-8000-000000000002';
const TURMA = '06440000-0000-4000-8000-00000000000a';
const TURMA_ALVO = '06440000-0000-4000-8000-00000000000b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): FilaDeEsperaService {
  const p = db as unknown as PrismaService;
  const operacao = new ConfigOperacaoService(p);
  return new FilaDeEsperaService(
    p,
    operacao,
    new MatriculaDoAlunoService(p, operacao),
    new ReposicaoService(p, operacao),
  );
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `06440000-0000-4000-8000-1000000000${s}`;
  const alunoId = `06440000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','c064.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function ocorrencia(turmaId: string, data: string, hora = '09:00') {
  ocSeq += 1;
  const id = `06440000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
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
  const id = `06440000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

let repSeq = 0;
async function reposicao(faltaId: string, alunoId: string, ocupacaoId: string) {
  repSeq += 1;
  const id = `06440000-0000-4000-8000-5000000000${String(repSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,falta_id,aluno_id,ocupacao_id,origem_tipo)
     VALUES ('${id}','${EMPRESA}','${faltaId}','${alunoId}','${ocupacaoId}','TURMA')`,
  );
  return id;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

let filaSeq = 0;
/** Uma linha já **chamada**, com prazo vivo — o estado em que se confirma. */
async function chamada(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
  prazoHoras?: number;
}): Promise<string> {
  filaSeq += 1;
  const id = `06440000-0000-4000-8000-6000000000${String(filaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}',
             ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
             ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
             ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
             'chamado', now(), now() + interval '${opcoes.prazoHoras ?? 6} hours')`,
  );
  return id;
}

const linha = (id: string) =>
  db.listaDeEspera.findUniqueOrThrow({ where: { id } });

async function montar(capacidade = 2): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-064 confirmar','spec-064-c-${EMPRESA}',now())`,
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
  for (const t of [TURMA, TURMA_ALVO]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${t}','${EMPRESA}','T','${QUADRA}',${capacidade},'ativa')`,
    );
  }
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  ocSeq = 0;
  faltaSeq = 0;
  repSeq = 0;
  filaSeq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-064/TASK-003b — confirmar dá certo (AC-007)', () => {
  it('fila de TURMA: vira matrícula E `atendida`, juntas', async () => {
    const a = await aluno('Vai entrar');
    const fila = await chamada({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    const r = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(r).toMatchObject({ ok: true, fila: 'turma', reposicaoId: null });
    expect(
      await db.turmaAluno.count({
        where: { turmaId: TURMA_ALVO, alunoId: a.alunoId },
      }),
    ).toBe(1);
    const depois = await linha(fila);
    expect(depois.estado).toBe('atendida');
    expect(depois.concluidaEm).not.toBeNull();
  });

  it('fila de AULA: cria a reposição E `atendida`, na MESMA transação', async () => {
    const a = await aluno('Vai repor');
    const m1 = await aluno('Matriculado');
    await matricular(TURMA_ALVO, m1.alunoId);

    const alvo = await ocorrencia(TURMA_ALVO, emDias(3));
    await matricular(TURMA, a.alunoId);
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    const credito = await falta(a.alunoId, perdida);
    const fila = await chamada({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    const r = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(r.ok).toBe(true);
    const reposicoes = await db.reposicaoDeAula.findMany({
      where: { companyId: EMPRESA, alunoId: a.alunoId },
      select: { id: true, faltaId: true, ocupacaoId: true },
    });
    expect(reposicoes).toHaveLength(1);
    expect(reposicoes[0].faltaId).toBe(credito);
    expect(reposicoes[0].ocupacaoId).toBe(alvo);
    // O mesmo id que a rota devolve — a tela não precisa procurar.
    expect(r.ok && r.reposicaoId).toBe(reposicoes[0].id);
    expect((await linha(fila)).estado).toBe('atendida');
  });
});

describe('SPEC-064/TASK-003b — a recusa, e o encerramento que COMITA (AC-006)', () => {
  /**
   * **O achado v2-03, reaberto em v4-06.** A v3 lançava exceção de dentro do
   * callback: o `409` chegava à pessoa, mas o `UPDATE` de encerramento voltava
   * atrás junto — e o chamado morto continuava aparecendo na tela dela,
   * insistindo num convite que o servidor já tinha recusado.
   */
  it('turma cheia: devolve o código E a linha fica `encerrada`', async () => {
    const a = await aluno('Chegou tarde');
    const m1 = await aluno('Matriculado 1');
    const m2 = await aluno('Matriculado 2');
    // A turma encheu entre o chamado e a confirmação — LIM-064f, e é o caso
    // que a fila existe para tratar com honestidade.
    await matricular(TURMA_ALVO, m1.alunoId);
    await matricular(TURMA_ALVO, m2.alunoId);
    const fila = await chamada({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    const r = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('TURMA_CHEIA');
    // **E o encerramento sobreviveu à recusa.**
    const depois = await linha(fila);
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('TURMA_CHEIA');
    // Nada foi criado pela metade.
    expect(
      await db.turmaAluno.count({
        where: { turmaId: TURMA_ALVO, alunoId: a.alunoId },
      }),
    ).toBe(0);
  });

  it('crédito consumido entre o chamado e a confirmação: recusa e encerra, sem reposição órfã', async () => {
    const a = await aluno('Usou o crédito');
    const m1 = await aluno('Matriculado');
    await matricular(TURMA_ALVO, m1.alunoId);

    const alvo = await ocorrencia(TURMA_ALVO, emDias(3));
    await matricular(TURMA, a.alunoId);
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    const credito = await falta(a.alunoId, perdida);
    const fila = await chamada({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    // Ele repôs em outra aula pela tela normal, depois de ser chamado.
    const outra = await ocorrencia(TURMA_ALVO, emDias(4), '10:00');
    await reposicao(credito, a.alunoId, outra);

    const r = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(r.ok).toBe(false);
    expect(!r.ok && r.code).toBe('FALTA_JA_REPOSTA');
    expect((await linha(fila)).estado).toBe('encerrada');
    // **Atomicidade**: a reposição do alvo não existe — só a que ele fez pela
    // tela.
    expect(
      await db.reposicaoDeAula.count({
        where: { companyId: EMPRESA, ocupacaoId: alvo },
      }),
    ).toBe(0);
  });

  it('prazo vencido: `VEZ_EXPIRADA`, e a linha encerra', async () => {
    const a = await aluno('Perdeu a vez');
    const fila = await chamada({
      alunoId: a.alunoId,
      turmaId: TURMA_ALVO,
      prazoHoras: -1,
    });

    const r = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(!r.ok && r.code).toBe('VEZ_EXPIRADA');
    const depois = await linha(fila);
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('prazo vencido');
    // A tela NÃO depende do varredor para isto: ele podia estar desligado.
    expect(
      await db.turmaAluno.count({
        where: { turmaId: TURMA_ALVO, alunoId: a.alunoId },
      }),
    ).toBe(0);
  });

  it('confirmar quem ainda só AGUARDA: `NAO_E_SUA_VEZ`, e a linha NÃO é encerrada', async () => {
    const a = await aluno('Ansioso');
    await q(
      `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id)
       VALUES ('06440000-0000-4000-8000-6000000000ff','${EMPRESA}','${a.alunoId}','${TURMA_ALVO}')`,
    );
    const fila = '06440000-0000-4000-8000-6000000000ff';

    const r = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(!r.ok && r.code).toBe('NAO_E_SUA_VEZ');
    // **Não encerra**: ele não fez nada de errado, e matar a posição dele por
    // um toque fora de hora seria punição sem regra.
    expect((await linha(fila)).estado).toBe('aguardando');
  });

  it('confirmar a linha de OUTRA PESSOA é 404, e não mexe nela', async () => {
    const a = await aluno('Dono');
    const b = await aluno('Intruso');
    const fila = await chamada({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    await expect(
      servico().confirmar(EMPRESA, b.usuarioId, fila),
    ).rejects.toMatchObject({ status: 404 });
    expect((await linha(fila)).estado).toBe('chamado');
  });

  it('confirmar duas vezes: a segunda é `NAO_E_SUA_VEZ`, sem matricular de novo', async () => {
    const a = await aluno('Toque duplo');
    const fila = await chamada({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    await servico().confirmar(EMPRESA, a.usuarioId, fila);
    const segunda = await servico().confirmar(EMPRESA, a.usuarioId, fila);

    expect(!segunda.ok && segunda.code).toBe('NAO_E_SUA_VEZ');
    expect(
      await db.turmaAluno.count({
        where: { turmaId: TURMA_ALVO, alunoId: a.alunoId },
      }),
    ).toBe(1);
    expect((await linha(fila)).estado).toBe('atendida');
  });
});
