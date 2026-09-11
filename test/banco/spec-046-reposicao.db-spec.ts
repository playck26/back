/**
 * SPEC-046 — **a reposição de aula, que fecha o GAP-008.**
 *
 * ## O que este arquivo existe para provar
 *
 * O crédito é **derivado** (D1) — não há coluna de saldo —, e isso só é seguro
 * por causa da INV-118. Os casos que carregam a spec:
 *
 * - **a vaga que só existe porque alguém avisou falta** (D2). Turma cheia com
 *   uma falta avisada tem uma vaga; sem subtrair as faltas, a reposição
 *   nasceria morta justamente na turma onde ela importa.
 * - **o crédito VOLTA** ao desmarcar e ao o clube cancelar a aula de destino
 *   (D7) — sem estado, sem job, porque é derivado.
 * - **o teto conta pelo mês da FALTA**, não da reposição (D6).
 *
 * A sabotagem registrada na spec é trocar o cálculo da vaga por
 * `matriculados + reposições` (sem subtrair as faltas): o caso da turma cheia
 * precisa ficar vermelho, e os outros verdes.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04600000-0000-4000-8000-000000000001';
const QUADRA = '04600000-0000-4000-8000-000000000002';
const TURMA_A = '04600000-0000-4000-8000-00000000000a';
const TURMA_B = '04600000-0000-4000-8000-00000000000b';
const ADMIN = '04600000-0000-4000-8000-00000000000c';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): ReposicaoService {
  const p = db as unknown as PrismaService;
  return new ReposicaoService(p, new ConfigOperacaoService(p));
}

function emDias(dias: number): string {
  // **A base é `hojeNoFusoDoClube()`, e não `new Date()`.**
  //
  // A primeira versão usava o relógio UTC, e o CI a derrubou às 22h locais:
  // 01h UTC do dia seguinte faz `emDias(-5)` cair num dia a mais do que o
  // serviço calcula, e `diasRestantes` vem `-4` onde o teste espera `-5`.
  // **O defeito era latente**, invisível antes das 21h — que é exatamente a
  // classe de erro que o gate `fuso-do-clube` existe para impedir no `src/`,
  // e que o `test/` precisa respeitar por disciplina.
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
/** Um aluno ativo com conta. Devolve `{ alunoId, usuarioId }`. */
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `04600000-0000-4000-8000-1000000000${s}`;
  const alunoId = `04600000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s046.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
/** Uma ocorrência de turma no dia pedido. Devolve o `ocupacaoId`. */
async function ocorrencia(
  turmaId: string,
  data: string,
  hora: string,
  statusPagamento: 'pendente_pagamento' | 'cancelado' = 'pendente_pagamento',
): Promise<string> {
  ocSeq += 1;
  const id = `04600000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','${statusPagamento}',now())`,
  );
  return id;
}

/** Uma falta avisada daquele aluno naquela ocorrência. Devolve o `faltaId`. */
let faltaSeq = 0;
async function falta(alunoId: string, ocupacaoId: string): Promise<string> {
  faltaSeq += 1;
  const id = `04600000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

async function montar(capacidadeB = 10): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-046','spec-046-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.s046@x.com','h','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra','${(await db.esporteDeQuadra.findFirstOrThrow({ where: { companyId: EMPRESA }, select: { id: true } })).id}',80,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_A}','${EMPRESA}','Turma A','${QUADRA}',10,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_B}','${EMPRESA}','Turma B','${QUADRA}',${capacidadeB},'ativa')`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  ocSeq = 0;
  faltaSeq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-046 — reposição de aula', () => {
  // =====================================================================
  // O crédito derivado (D1)
  // =====================================================================

  it('falta avisada VIRA crédito, sem coluna de saldo', async () => {
    const a = await aluno('Faltou');
    await matricular(TURMA_A, a.alunoId);
    const oc = await ocorrencia(TURMA_A, emDias(-3), '19:00');
    await falta(a.alunoId, oc);

    const r = await servico().meuCredito(EMPRESA, a.usuarioId);

    expect(r.creditos).toBe(1);
    expect(r.faltas).toHaveLength(1);
    expect(r.faltas[0].expirada).toBe(false);
  });

  it('AC-002: falta fora da VALIDADE não gera crédito — e continua na lista', async () => {
    const a = await aluno('Faltou Ha Muito');
    await matricular(TURMA_A, a.alunoId);
    // Padrão de validade são 30 dias (D6).
    const oc = await ocorrencia(TURMA_A, emDias(-45), '19:00');
    await falta(a.alunoId, oc);

    const r = await servico().meuCredito(EMPRESA, a.usuarioId);

    expect(r.creditos).toBe(0);
    // **Continua listada, marcada.** Sumir com ela faria o aluno achar que
    // nunca avisou — é a mesma decisão da SPEC-031/D14 do outro lado.
    expect(r.faltas).toHaveLength(1);
    expect(r.faltas[0].expirada).toBe(true);
  });

  it('AC-003: falta de aula que o CLUBE cancelou não gera crédito', async () => {
    const a = await aluno('Clube Cancelou');
    await matricular(TURMA_A, a.alunoId);
    const oc = await ocorrencia(TURMA_A, emDias(-3), '19:00', 'cancelado');
    await falta(a.alunoId, oc);

    const r = await servico().meuCredito(EMPRESA, a.usuarioId);

    // Ele não perdeu nada: não houve aula para ninguém.
    expect(r.creditos).toBe(0);
    expect(r.faltas[0].aulaCancelada).toBe(true);
  });

  // =====================================================================
  // A vaga que a falta liberou (D2) — o caso que define a spec
  // =====================================================================

  it('**D2: turma CHEIA tem vaga porque alguém avisou falta**', async () => {
    await limparEmpresa(db, EMPRESA);
    await montar(2); // Turma B com capacidade 2

    const visitante = await aluno('Quer Repor');
    await matricular(TURMA_A, visitante.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-3), '19:00');
    await falta(visitante.alunoId, perdida);

    // A turma B está CHEIA: dois matriculados para capacidade 2.
    const b1 = await aluno('B Um');
    const b2 = await aluno('B Dois');
    await matricular(TURMA_B, b1.alunoId);
    await matricular(TURMA_B, b2.alunoId);
    const destino = await ocorrencia(TURMA_B, emDias(5), '20:00');

    // Sem falta nenhuma na B, não há vaga.
    expect(
      (await servico().oportunidades(EMPRESA, visitante.usuarioId)).filter(
        (o) => o.ocupacaoId === destino,
      ),
    ).toEqual([]);

    // Um dos dois avisa que não vai — e a vaga aparece.
    await falta(b1.alunoId, destino);

    const comVaga = (
      await servico().oportunidades(EMPRESA, visitante.usuarioId)
    ).filter((o) => o.ocupacaoId === destino);
    expect(comVaga).toHaveLength(1);
    expect(comVaga[0].vagas).toBe(1);
  });

  it('AC-005: turma em que ele JÁ está não aparece', async () => {
    const a = await aluno('Ja Esta Nas Duas');
    await matricular(TURMA_A, a.alunoId);
    await matricular(TURMA_B, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-3), '19:00');
    await falta(a.alunoId, perdida);
    const daB = await ocorrencia(TURMA_B, emDias(5), '20:00');

    const oportunidades = await servico().oportunidades(EMPRESA, a.usuarioId);

    // Ele já é esperado lá. A chamada o mostraria duas vezes (D5).
    expect(oportunidades.map((o) => o.ocupacaoId)).not.toContain(daB);
  });

  it('AC-006: ocorrência CANCELADA e turma INATIVA não aparecem', async () => {
    const a = await aluno('Procurando');
    await matricular(TURMA_A, a.alunoId);
    await falta(a.alunoId, await ocorrencia(TURMA_A, emDias(-3), '19:00'));

    const cancelada = await ocorrencia(
      TURMA_B,
      emDias(5),
      '20:00',
      'cancelado',
    );
    const viva = await ocorrencia(TURMA_B, emDias(6), '20:00');

    const antes = await servico().oportunidades(EMPRESA, a.usuarioId);
    expect(antes.map((o) => o.ocupacaoId)).toContain(viva);
    expect(antes.map((o) => o.ocupacaoId)).not.toContain(cancelada);

    await q(`UPDATE turmas SET status='inativa' WHERE id='${TURMA_B}'`);
    const depois = await servico().oportunidades(EMPRESA, a.usuarioId);
    expect(depois.map((o) => o.ocupacaoId)).not.toContain(viva);
  });

  // =====================================================================
  // Marcar
  // =====================================================================

  async function cenarioSimples() {
    const a = await aluno('Repositor');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-3), '19:00');
    const f = await falta(a.alunoId, perdida);
    const destino = await ocorrencia(TURMA_B, emDias(5), '20:00');
    return { ...a, faltaId: f, destino };
  }

  it('AC-007: marca, e o crédito ZERA', async () => {
    const c = await cenarioSimples();

    const r = await servico().marcar(
      EMPRESA,
      c.usuarioId,
      c.faltaId,
      c.destino,
    );
    expect(r.ocupacaoId).toBe(c.destino);

    const depois = await servico().meuCredito(EMPRESA, c.usuarioId);
    expect(depois.creditos).toBe(0);
    expect(depois.faltas[0].reposicao?.id).toBe(r.id);
  });

  it('AC-009: a mesma falta duas vezes é `FALTA_JA_REPOSTA`', async () => {
    const c = await cenarioSimples();
    const outro = await ocorrencia(TURMA_B, emDias(6), '20:00');
    await servico().marcar(EMPRESA, c.usuarioId, c.faltaId, c.destino);

    await expect(
      servico().marcar(EMPRESA, c.usuarioId, c.faltaId, outro),
    ).rejects.toMatchObject({
      response: { statusCode: 409, code: 'FALTA_JA_REPOSTA' },
    });
  });

  it('**INV-118: e o BANCO recusa, não só o serviço**', async () => {
    const c = await cenarioSimples();
    const outro = await ocorrencia(TURMA_B, emDias(6), '20:00');
    await servico().marcar(EMPRESA, c.usuarioId, c.faltaId, c.destino);

    // A pré-checagem existe para a MENSAGEM; a garantia é a `UNIQUE`. Este
    // caso pula o serviço de propósito — é o único arranjo que prova qual das
    // duas está segurando, e sob corrida só a segunda está.
    // `$executeRawUnsafe` embrulha o erro do Postgres como **`P2010`** (raw
    // query failed), não como o `P2002` que o Prisma usa quando a violação
    // vem pelo delegate. A asserção é sobre a MENSAGEM, que carrega o nome da
    // constraint — é ela que prova QUAL regra segurou.
    const erro = await q(
      `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES (gen_random_uuid(),'${EMPRESA}','${c.alunoId}','${c.faltaId}','${outro}')`,
    ).catch((e: unknown) => e as Error);

    // `23505` é o SQLSTATE de violação de UNIQUE, e `(falta_id)` diz QUAL das
    // duas uniques desta tabela segurou — a outra é `(ocupacao_id, aluno_id)`.
    // Só o par distingue.
    expect(erro).toBeInstanceOf(Error);
    expect((erro as Error).message).toMatch(/23505[\s\S]*falta_id/);
  });

  it('AC-011: turma em que ele já está é `JA_MATRICULADO_NA_TURMA`', async () => {
    const c = await cenarioSimples();
    await matricular(TURMA_B, c.alunoId);

    await expect(
      servico().marcar(EMPRESA, c.usuarioId, c.faltaId, c.destino),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'JA_MATRICULADO_NA_TURMA' },
    });
  });

  it('AC-010: aula cheia é `TURMA_SEM_VAGA`', async () => {
    await limparEmpresa(db, EMPRESA);
    await montar(1);
    const c = await cenarioSimples();
    const ocupante = await aluno('Ja Enche');
    await matricular(TURMA_B, ocupante.alunoId);

    await expect(
      servico().marcar(EMPRESA, c.usuarioId, c.faltaId, c.destino),
    ).rejects.toMatchObject({
      response: { statusCode: 409, code: 'TURMA_SEM_VAGA' },
    });
  });

  it('AC-008: falta EXPIRADA é `SEM_CREDITO_DE_REPOSICAO`', async () => {
    const a = await aluno('Tarde Demais');
    await matricular(TURMA_A, a.alunoId);
    const f = await falta(
      a.alunoId,
      await ocorrencia(TURMA_A, emDias(-45), '19:00'),
    );
    const destino = await ocorrencia(TURMA_B, emDias(5), '20:00');

    await expect(
      servico().marcar(EMPRESA, a.usuarioId, f, destino),
    ).rejects.toMatchObject({
      response: { statusCode: 409, code: 'SEM_CREDITO_DE_REPOSICAO' },
    });
  });

  it('AC-012: o teto do mês é `TETO_DE_REPOSICAO`', async () => {
    const a = await aluno('Falta Muito');
    await matricular(TURMA_A, a.alunoId);
    // Três faltas no mês corrente, teto padrão de 2.
    const f1 = await falta(
      a.alunoId,
      await ocorrencia(TURMA_A, emDias(-1), '19:00'),
    );
    const f2 = await falta(
      a.alunoId,
      await ocorrencia(TURMA_A, emDias(-2), '19:00'),
    );
    const f3 = await falta(
      a.alunoId,
      await ocorrencia(TURMA_A, emDias(-3), '19:00'),
    );
    const d1 = await ocorrencia(TURMA_B, emDias(5), '20:00');
    const d2 = await ocorrencia(TURMA_B, emDias(6), '20:00');
    const d3 = await ocorrencia(TURMA_B, emDias(7), '20:00');

    await servico().marcar(EMPRESA, a.usuarioId, f1, d1);
    await servico().marcar(EMPRESA, a.usuarioId, f2, d2);

    await expect(
      servico().marcar(EMPRESA, a.usuarioId, f3, d3),
    ).rejects.toMatchObject({
      response: { statusCode: 409, code: 'TETO_DE_REPOSICAO', teto: 2 },
    });
  });

  it('o teto é do CLUBE, e mudá-lo muda a recusa', async () => {
    await q(
      `INSERT INTO config_operacao_empresa (id,company_id,reposicoes_por_mes,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}',1,now())`,
    );
    const a = await aluno('Teto Um');
    await matricular(TURMA_A, a.alunoId);
    const f1 = await falta(
      a.alunoId,
      await ocorrencia(TURMA_A, emDias(-1), '19:00'),
    );
    const f2 = await falta(
      a.alunoId,
      await ocorrencia(TURMA_A, emDias(-2), '19:00'),
    );

    await servico().marcar(
      EMPRESA,
      a.usuarioId,
      f1,
      await ocorrencia(TURMA_B, emDias(5), '20:00'),
    );
    // Sem este caso, o padrão de 2 poderia estar fixo no código e ninguém veria.
    await expect(
      servico().marcar(
        EMPRESA,
        a.usuarioId,
        f2,
        await ocorrencia(TURMA_B, emDias(6), '20:00'),
      ),
    ).rejects.toMatchObject({
      response: { code: 'TETO_DE_REPOSICAO', teto: 1 },
    });
  });

  // =====================================================================
  // O crédito VOLTA (D7 e AC-013)
  // =====================================================================

  it('AC-013: desmarcar DEVOLVE o crédito', async () => {
    const c = await cenarioSimples();
    const r = await servico().marcar(
      EMPRESA,
      c.usuarioId,
      c.faltaId,
      c.destino,
    );
    expect((await servico().meuCredito(EMPRESA, c.usuarioId)).creditos).toBe(0);

    await servico().desmarcar(EMPRESA, c.usuarioId, r.id);

    expect((await servico().meuCredito(EMPRESA, c.usuarioId)).creditos).toBe(1);
  });

  it('**D7: o clube cancelar a aula de destino devolve o crédito SOZINHO**', async () => {
    const c = await cenarioSimples();
    await servico().marcar(EMPRESA, c.usuarioId, c.faltaId, c.destino);
    expect((await servico().meuCredito(EMPRESA, c.usuarioId)).creditos).toBe(0);

    // **A INV-064 recusou o `UPDATE` cru** com `23514 — ocupacao cancelada sem
    // transicao_id`. O helper existe justamente para isto: um lugar que sabe
    // cancelar certo, em vez de trinta fixtures que podem errar. **Nona vez
    // neste trabalho que o banco corrige uma fixture minha.**
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: c.destino,
      autorId: ADMIN,
    });

    // Nenhum gesto, nenhum job: o crédito é derivado, então parar de contar a
    // reposição já o devolve. **A linha continua lá** de propósito — apagá-la
    // destruiria o histórico de que ele tinha marcado (SPEC-031/D14).
    expect((await servico().meuCredito(EMPRESA, c.usuarioId)).creditos).toBe(1);
    expect(
      await db.reposicaoDeAula.count({ where: { alunoId: c.alunoId } }),
    ).toBe(1);
  });

  // =====================================================================
  // Tenant
  // =====================================================================

  it('a empresa vizinha não vê oportunidade nenhuma', async () => {
    const a = await aluno('Da Casa');
    await matricular(TURMA_A, a.alunoId);
    await falta(a.alunoId, await ocorrencia(TURMA_A, emDias(-3), '19:00'));
    await ocorrencia(TURMA_B, emDias(5), '20:00');

    // A trava vive no `where`, e um `where` sem `companyId` passaria em todos
    // os outros casos deste arquivo.
    await expect(
      servico().oportunidades(
        '04600000-0000-4000-8000-0000000000ff',
        a.usuarioId,
      ),
    ).rejects.toBeDefined();
  });
});
