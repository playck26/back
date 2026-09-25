/**
 * SPEC-064/TASK-003 — **o varredor, contra o banco de verdade.**
 *
 * ## O que só o banco decide, e está aqui por isso
 *
 * - **a ordem de chegada** sob `FOR UPDATE`, com desempate por `id`: duas
 *   entradas no mesmo instante existem, porque a fila de turma nasce de um
 *   gesto que remove alguém e o aviso é gravado em lote;
 * - **o `UNIQUE (turma_id) WHERE estado='chamado'`** como único lock entre
 *   réplicas (D8) — não há advisory lock, e é deliberado;
 * - **as duas contas de capacidade**, que trabalham sobre três tabelas
 *   (`turma_alunos`, `faltas_avisadas`, `reposicoes_de_aula`). Um dublê aqui
 *   reescreveria a SPEC-057 dentro do teste.
 *
 * O relógio entra por `agora()`, injetado: o varredor é provável **sem
 * esperar**, que é o que torna o agendador dispensável na suíte.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { VarredorDaFilaService } from '../../src/fila-de-espera/varredor-da-fila.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { TIPO_LISTA_ESPERA } from '../../src/fila-de-espera/aviso-do-chamado';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '06430000-0000-4000-8000-000000000001';
const QUADRA = '06430000-0000-4000-8000-000000000002';
const TURMA = '06430000-0000-4000-8000-00000000000a';
const TURMA_ALVO = '06430000-0000-4000-8000-00000000000b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const varredor = () =>
  new VarredorDaFilaService(
    db as unknown as PrismaService,
    new ConfigOperacaoService(db as unknown as PrismaService),
  );

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `06430000-0000-4000-8000-1000000000${s}`;
  const alunoId = `06430000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','v064.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function ocorrencia(
  turmaId: string,
  data: string,
  hora = '09:00',
  statusPagamento: 'pendente_pagamento' | 'cancelado' = 'pendente_pagamento',
): Promise<string> {
  ocSeq += 1;
  const id = `06430000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','${statusPagamento}',now())`,
  );
  return id;
}

let faltaSeq = 0;
async function falta(alunoId: string, ocupacaoId: string): Promise<string> {
  faltaSeq += 1;
  const id = `06430000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

let repSeq = 0;
async function reposicao(
  faltaId: string,
  alunoId: string,
  ocupacaoId: string,
): Promise<void> {
  repSeq += 1;
  const id = `06430000-0000-4000-8000-5000000000${String(repSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,falta_id,aluno_id,ocupacao_id,origem_tipo)
     VALUES ('${id}','${EMPRESA}','${faltaId}','${alunoId}','${ocupacaoId}','TURMA')`,
  );
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

let filaSeq = 0;
/** Uma linha `aguardando`. `criadaEm` explícito para provar ordem de chegada. */
async function naFila(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
  segundosAtras?: number;
}): Promise<string> {
  filaSeq += 1;
  const id = `06430000-0000-4000-8000-6000000000${String(filaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,criada_em)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}',
             ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
             ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
             ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
             now() - interval '${opcoes.segundosAtras ?? 0} seconds')`,
  );
  return id;
}

const linha = (id: string) =>
  db.listaDeEspera.findUniqueOrThrow({ where: { id } });

async function montar(capacidade = 2): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-064 varredor','spec-064-v-${EMPRESA}',now())`,
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

describe('SPEC-064/TASK-003 — chamar (AC-003, AC-005)', () => {
  it('AC-003 — chama o PRIMEIRO da fila, e só ele', async () => {
    const a = await aluno('Chegou antes');
    const b = await aluno('Chegou depois');
    const primeira = await naFila({
      alunoId: a.alunoId,
      turmaId: TURMA_ALVO,
      segundosAtras: 60,
    });
    const segunda = await naFila({ alunoId: b.alunoId, turmaId: TURMA_ALVO });

    const r = await varredor().executarCiclo();

    expect(r.chamados).toBe(1);
    expect((await linha(primeira)).estado).toBe('chamado');
    // O segundo continua esperando: o `UNIQUE (turma_id) WHERE
    // estado='chamado'` permite UM chamado por alvo.
    expect((await linha(segunda)).estado).toBe('aguardando');
  });

  it('AC-003 — o segundo só é chamado quando o primeiro encerra', async () => {
    const a = await aluno('Primeiro');
    const b = await aluno('Segundo');
    const primeira = await naFila({
      alunoId: a.alunoId,
      turmaId: TURMA_ALVO,
      segundosAtras: 60,
    });
    const segunda = await naFila({ alunoId: b.alunoId, turmaId: TURMA_ALVO });

    await varredor().executarCiclo();
    // Um segundo ciclo com o chamado vivo não chama ninguém.
    expect((await varredor().executarCiclo()).chamados).toBe(0);

    await q(
      `UPDATE lista_de_espera SET estado='desistiu', concluida_em=now() WHERE id='${primeira}'`,
    );
    expect((await varredor().executarCiclo()).chamados).toBe(1);
    expect((await linha(segunda)).estado).toBe('chamado');
  });

  it('turma CHEIA não chama; abrir vaga faz o ciclo seguinte chamar', async () => {
    const a = await aluno('Na fila');
    const m1 = await aluno('Matriculado 1');
    const m2 = await aluno('Matriculado 2');
    await matricular(TURMA_ALVO, m1.alunoId);
    await matricular(TURMA_ALVO, m2.alunoId);
    const fila = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    // capacidade 2, dois matriculados.
    const cheio = await varredor().executarCiclo();
    expect(cheio.chamados).toBe(0);
    expect(cheio.semVaga).toBe(1);
    expect((await linha(fila)).estado).toBe('aguardando');

    await q(
      `DELETE FROM turma_alunos WHERE turma_id='${TURMA_ALVO}' AND aluno_id='${m2.alunoId}'`,
    );
    expect((await varredor().executarCiclo()).chamados).toBe(1);
  });

  /**
   * **A conta da fila de aula é `calcularOcupacao`, por conjuntos** — e não a
   * fórmula da SPEC-046, que a SPEC-057/D17 abandonou por dar vaga fantasma. A
   * v1 desta spec citava a abandonada, e um varredor com ela chamaria gente
   * para vaga que não existe.
   */
  it('AC-005 — a vaga de reposição consumida entre a abertura e o ciclo não chama', async () => {
    const naFilaAluno = await aluno('Quer repor');
    const m1 = await aluno('Matriculado 1');
    const m2 = await aluno('Matriculado 2');
    const outro = await aluno('Repôs antes');
    await matricular(TURMA_ALVO, m1.alunoId);
    await matricular(TURMA_ALVO, m2.alunoId);

    const alvo = await ocorrencia(TURMA_ALVO, emDias(3));
    // m2 avisou falta: abriu UMA vaga de reposição (2 - 1 presente = 1).
    await falta(m2.alunoId, alvo);

    // O crédito de quem está na fila.
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    await matricular(TURMA, naFilaAluno.alunoId);
    const credito = await falta(naFilaAluno.alunoId, perdida);
    const fila = await naFila({
      alunoId: naFilaAluno.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    // Antes do ciclo, outra pessoa marcou reposição ali pela tela normal
    // (LIM-064f) — a vaga acabou.
    const perdidaOutro = await ocorrencia(TURMA, emDias(-2), '10:00');
    await matricular(TURMA, outro.alunoId);
    const creditoOutro = await falta(outro.alunoId, perdidaOutro);
    await reposicao(creditoOutro, outro.alunoId, alvo);

    const r = await varredor().executarCiclo();
    expect(r.chamados).toBe(0);
    expect(r.semVaga).toBe(1);
    expect((await linha(fila)).estado).toBe('aguardando');
  });

  it('havendo vaga na aula, chama — e grava o aviso na MESMA transação', async () => {
    const a = await aluno('Quer repor');
    const m1 = await aluno('Matriculado 1');
    const m2 = await aluno('Matriculado 2');
    await matricular(TURMA_ALVO, m1.alunoId);
    await matricular(TURMA_ALVO, m2.alunoId);

    const alvo = await ocorrencia(TURMA_ALVO, emDias(3));
    await falta(m2.alunoId, alvo);

    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    await matricular(TURMA, a.alunoId);
    const credito = await falta(a.alunoId, perdida);
    const fila = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    expect((await varredor().executarCiclo()).chamados).toBe(1);

    const depois = await linha(fila);
    expect(depois.estado).toBe('chamado');
    expect(depois.chamadoEm).not.toBeNull();
    expect(depois.chamadoAte).not.toBeNull();

    const aviso = await db.notificacao.findFirstOrThrow({
      where: { companyId: EMPRESA, destinatarioId: a.usuarioId },
    });
    expect(aviso.tipo).toBe(TIPO_LISTA_ESPERA);
    expect(aviso.titulo).toBe('Sua vez');
    // `origem_id` = a linha da fila, por escolha (o CHECK de gesto não morde).
    expect(aviso.origemId).toBe(fila);
    // `expira_em` é do ENVIO: passou a vez, não adianta mais tentar entregar.
    expect(aviso.expiraEm).toEqual(depois.chamadoAte);
    // INV-063a — nada de texto livre de tabela.
    expect(aviso.corpo).not.toContain('T');
  });
});

describe('SPEC-064/TASK-003 — o relógio (AC-004)', () => {
  /**
   * **A primeira versão deste caso não provava nada, e passou perto de ficar
   * verde assim.** Eu escolhi aula às 23h e relógio às 12h UTC: o limite
   * (início − 2h) caía **exatamente** no teto de 12 h, e um `toBeLessThan`
   * contra um empate só ficou vermelho por sorte do `<` em vez de `<=`.
   *
   * Agora os dois números estão a 5 h de distância, e a asserção é de
   * IGUALDADE com o limite — não uma desigualdade que o empate satisfaz.
   */
  it('`chamado_ate` nunca passa de 2h antes da aula', async () => {
    const a = await aluno('Quer repor');
    const m1 = await aluno('Matriculado');
    await matricular(TURMA_ALVO, m1.alunoId);

    // Aula às 18h no fuso do clube (= 21h UTC). Limite: 19h UTC.
    const alvo = await ocorrencia(TURMA_ALVO, emDias(0), '18:00');
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    await matricular(TURMA, a.alunoId);
    const credito = await falta(a.alunoId, perdida);
    const fila = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    // Relógio às 12h UTC: o teto de 12 h cairia à meia-noite UTC, cinco horas
    // DEPOIS do limite. Quem manda é o limite.
    const meioDia = new Date(`${emDias(0)}T12:00:00.000Z`).getTime();
    const r = await varredor().executarCiclo(() => meioDia);

    expect(r.chamados).toBe(1);
    const depois = await linha(fila);
    const inicioUtc = new Date(`${emDias(0)}T21:00:00.000Z`).getTime();
    expect(depois.chamadoAte!.getTime()).toBe(inicioUtc - 2 * 60 * 60 * 1000);
    expect(depois.chamadoAte!.getTime()).toBeLessThan(
      meioDia + 12 * 60 * 60 * 1000,
    );
  });

  it('prazo que JÁ NASCE VENCIDO encerra sem chamar', async () => {
    const a = await aluno('Tarde demais');
    const m1 = await aluno('Matriculado');
    await matricular(TURMA_ALVO, m1.alunoId);

    const alvo = await ocorrencia(TURMA_ALVO, emDias(1), '09:00');
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    await matricular(TURMA, a.alunoId);
    const credito = await falta(a.alunoId, perdida);
    const fila = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    // Relógio a 1h do início: o limite (início − 2h) já passou.
    const umaHoraAntes = new Date(`${emDias(1)}T11:00:00.000Z`).getTime();
    const r = await varredor().executarCiclo(() => umaHoraAntes);

    expect(r.chamados).toBe(0);
    expect(r.prazoImpossivel).toBe(1);
    const depois = await linha(fila);
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('prazo impossivel');
  });

  /**
   * **Interpretação declarada, e não o texto literal da D4.**
   *
   * A D4 escreve `min(chamado_em + 12h, início da aula − 2h)` uma vez, sem
   * distinguir as duas filas. Mas a fila de TURMA não tem "a aula": o alvo é a
   * turma, e entrar nela não é comparecer a uma ocorrência específica.
   *
   * Aplicar a antecedência ali amarraria a vaga de matrícula à próxima
   * ocorrência e — pior — `prazo_impossivel` é **terminal**: uma turma cujo
   * próximo encontro fosse dali a uma hora mataria a posição de quem esperava
   * há uma semana, por acidente de relógio.
   */
  it('fila de TURMA usa só o teto de 12h — a antecedência é da fila de aula', async () => {
    const a = await aluno('Quer a vaga');
    // Uma ocorrência iminente da turma: se a regra da aula valesse aqui, esta
    // linha seria encerrada.
    await ocorrencia(TURMA_ALVO, emDias(0), '10:00');
    const fila = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    const agora = Date.now();
    const r = await varredor().executarCiclo(() => agora);

    expect(r.chamados).toBe(1);
    expect(r.prazoImpossivel).toBe(0);
    const depois = await linha(fila);
    expect(depois.chamadoAte!.getTime()).toBe(agora + 12 * 60 * 60 * 1000);
  });
});

/**
 * SPEC-064/TASK-008 — **a antecedência é do CLUBE** (card 5331, RN3: *"Admin
 * define a antecedência"*).
 *
 * Os três casos usam o MESMO relógio e a MESMA aula do primeiro caso do
 * relógio acima — aula às 18h no fuso do clube (21h UTC), relógio às 12h UTC —,
 * e mudam só a configuração. **É a diferença entre eles que prova**: um teste
 * que só configurasse e visse alguém ser chamado passaria com o `2` fixo de
 * volta no código, porque 2 h também chamaria.
 */
describe('SPEC-064/TASK-008 — a antecedência configurada pelo clube', () => {
  async function comAntecedencia(horas: number) {
    await q(
      `INSERT INTO config_operacao_empresa (id,company_id,antecedencia_fila_aula_horas,created_at,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',${horas},now(),now())
       ON CONFLICT (company_id) DO UPDATE SET antecedencia_fila_aula_horas = ${horas}`,
    );
  }

  async function filaDeAulaAsDezoito() {
    const a = await aluno('Quer repor');
    const m1 = await aluno('Matriculado');
    await matricular(TURMA_ALVO, m1.alunoId);
    const alvo = await ocorrencia(TURMA_ALVO, emDias(0), '18:00');
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    await matricular(TURMA, a.alunoId);
    const credito = await falta(a.alunoId, perdida);
    return naFila({ alunoId: a.alunoId, ocupacaoId: alvo, faltaId: credito });
  }

  const meioDia = () => new Date(`${emDias(0)}T12:00:00.000Z`).getTime();
  const inicioUtc = () => new Date(`${emDias(0)}T21:00:00.000Z`).getTime();
  const HORA = 60 * 60 * 1000;

  it('5 h configuradas: o limite é início − 5h, e não mais − 2h', async () => {
    await comAntecedencia(5);
    const fila = await filaDeAulaAsDezoito();

    const r = await varredor().executarCiclo(meioDia);

    expect(r.chamados).toBe(1);
    const depois = await linha(fila);
    // **Igualdade**, e não desigualdade: com o `2` fixo de volta o prazo seria
    // início − 2h, três horas DEPOIS deste valor.
    expect(depois.chamadoAte!.getTime()).toBe(inicioUtc() - 5 * HORA);
  });

  /**
   * **O caso que separa os dois comportamentos de forma inconfundível.** Com o
   * padrão, esta aula CHAMA (o limite é 19h UTC, depois do meio-dia); com 10 h
   * configuradas o limite é 11h UTC, que já passou — ninguém é chamado.
   */
  it('10 h configuradas: a MESMA aula que o padrão chamaria vira prazo impossível', async () => {
    await comAntecedencia(10);
    const fila = await filaDeAulaAsDezoito();

    const r = await varredor().executarCiclo(meioDia);

    expect(r.chamados).toBe(0);
    expect(r.prazoImpossivel).toBe(1);
    const depois = await linha(fila);
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('prazo impossivel');
  });

  /** A D4 continua valendo: configurar a antecedência não alcança a fila de TURMA. */
  it('a fila de TURMA ignora a antecedência configurada — só o teto de 12h', async () => {
    await comAntecedencia(10);
    const a = await aluno('Quer a vaga');
    await ocorrencia(TURMA_ALVO, emDias(0), '10:00');
    const fila = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });

    const agora = Date.now();
    const r = await varredor().executarCiclo(() => agora);

    expect(r.chamados).toBe(1);
    expect(r.prazoImpossivel).toBe(0);
    const depois = await linha(fila);
    expect(depois.chamadoAte!.getTime()).toBe(agora + 12 * HORA);
  });
});

describe('SPEC-064/TASK-003 — expirar e a rede de alvo morto', () => {
  it('chamado vencido vira `expirada`, com motivo', async () => {
    const a = await aluno('Perdeu a vez');
    const fila = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });
    await q(
      `UPDATE lista_de_espera SET estado='chamado', chamado_em=now() - interval '13 hours',
              chamado_ate=now() - interval '1 hour' WHERE id='${fila}'`,
    );

    const r = await varredor().executarCiclo();

    expect(r.expirados).toBe(1);
    const depois = await linha(fila);
    expect(depois.estado).toBe('expirada');
    expect(depois.motivoFim).toBe('prazo vencido');
  });

  it('expirar ANTES de chamar libera o alvo no MESMO ciclo', async () => {
    const a = await aluno('Perdeu a vez');
    const b = await aluno('Próximo');
    const vencida = await naFila({
      alunoId: a.alunoId,
      turmaId: TURMA_ALVO,
      segundosAtras: 120,
    });
    await q(
      `UPDATE lista_de_espera SET estado='chamado', chamado_ate=now() - interval '1 hour' WHERE id='${vencida}'`,
    );
    const proxima = await naFila({ alunoId: b.alunoId, turmaId: TURMA_ALVO });

    const r = await varredor().executarCiclo();

    // Sem isso, o próximo esperaria mais um minuto por nada.
    expect(r.expirados).toBe(1);
    expect(r.chamados).toBe(1);
    expect((await linha(proxima)).estado).toBe('chamado');
  });

  it('turma inativada encerra a fila dela — a rede pega o que escapar', async () => {
    const a = await aluno('Turma morreu');
    const fila = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });
    await q(`UPDATE turmas SET status='inativa' WHERE id='${TURMA_ALVO}'`);

    const r = await varredor().executarCiclo();

    expect(r.encerradosPorAlvoMorto).toBe(1);
    const depois = await linha(fila);
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('alvo indisponivel');
  });

  it('aula cancelada e aula que já passou encerram a fila delas', async () => {
    const a = await aluno('Aula cancelada');
    const b = await aluno('Aula passou');
    // **Fila de aula SEM crédito não existe** — o `fila_credito_chk` recusa
    // com `23514`, e foi ele que derrubou a primeira versão deste caso. A
    // invariante é da TASK-001 e continua valendo aqui.
    await matricular(TURMA, a.alunoId);
    await matricular(TURMA, b.alunoId);
    const perdidaA = await ocorrencia(TURMA, emDias(-3), '07:00');
    const perdidaB = await ocorrencia(TURMA, emDias(-3), '08:00');
    const creditoA = await falta(a.alunoId, perdidaA);
    const creditoB = await falta(b.alunoId, perdidaB);

    const cancelada = await ocorrencia(
      TURMA_ALVO,
      emDias(2),
      '09:00',
      'cancelado',
    );
    const passada = await ocorrencia(TURMA_ALVO, emDias(-1), '10:00');
    const f1 = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: cancelada,
      faltaId: creditoA,
    });
    const f2 = await naFila({
      alunoId: b.alunoId,
      ocupacaoId: passada,
      faltaId: creditoB,
    });

    const r = await varredor().executarCiclo();

    expect(r.encerradosPorAlvoMorto).toBe(2);
    expect((await linha(f1)).estado).toBe('encerrada');
    expect((await linha(f2)).estado).toBe('encerrada');
  });

  it('um ciclo sem fila nenhuma não faz nada, e não estoura', async () => {
    const r = await varredor().executarCiclo();
    expect(r).toMatchObject({
      alvos: 0,
      chamados: 0,
      expirados: 0,
      encerradosPorAlvoMorto: 0,
    });
  });
});
