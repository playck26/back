/**
 * SPEC-057/TASK-005/D17 — **a ocupação da aula é a mesma nos três lugares
 * que a leem**: a agenda do gestor, as oportunidades de reposição do aluno e
 * a recusa do `POST` de reposição (INV-145, AC-028).
 *
 * ## Por que banco, e por que os três juntos
 *
 * A regra mora num lugar só (`ocupacao-da-ocorrencia.ts`), e o unitário dela
 * cobre a álgebra. O que o unitário não prova é que **os três leitores a
 * usam**: a SPEC-046 escreveu a conta duas vezes (oportunidades e POST), com
 * contagens, e a agenda nem a tinha. Se um dos três voltar a contar por conta
 * própria, é aqui que os números divergem.
 *
 * ## Os cinco casos
 *
 * São os que o veredito v4 reproduziu em banco (`B1_SET_RESULTS`). Dois deles
 * a fórmula antiga erra, e por isso são o vermelho desta suíte antes da task:
 *
 * - **ex-matriculado com falta retida** — a falta sobrevive à saída da turma e
 *   subtraía de uma matrícula inexistente: capacidade 2 aparecia com 3 vagas;
 * - **membro que também é visitante** — contado duas vezes, fechava a aula com
 *   uma vaga livre.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { AgendaService } from '../../src/courts/agenda.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '05780000-0000-4000-8000-000000000001';
const QUADRA = '05780000-0000-4000-8000-000000000002';
const TURMA_ORIGEM = '05780000-0000-4000-8000-00000000000a';
const TURMA_ALVO = '05780000-0000-4000-8000-00000000000b';
const AULA = '05780000-0000-4000-8000-0000000000c1';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const p = db as unknown as PrismaService;

const agenda = () => new AgendaService(p, new HorarioFuncionamentoService(p));
const reposicao = () => new ReposicaoService(p, new ConfigOperacaoService(p));

function emDias(dias: number): string {
  // Base no fuso do clube, e não no relógio UTC (lição do FIT-035).
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const DIA_DA_AULA = emDias(5);

let seq = 0;
async function aluno(
  nome: string,
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `05780000-0000-4000-8000-1000000000${s}`;
  const alunoId = `05780000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s057oc.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );
const desmatricular = (turmaId: string, alunoId: string) =>
  q(
    `DELETE FROM turma_alunos WHERE turma_id='${turmaId}' AND aluno_id='${alunoId}'`,
  );

let ocSeq = 0;
async function ocorrencia(turmaId: string, data: string): Promise<string> {
  ocSeq += 1;
  const id = `05780000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  const hora = String(6 + ocSeq).padStart(2, '0');
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}:00','${hora}:30','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

let faltaSeq = 0;
async function falta(alunoId: string, ocupacaoId: string): Promise<string> {
  faltaSeq += 1;
  const id = `05780000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

/** Uma reposição já marcada na aula-alvo, sem passar pelo serviço. */
async function visita(alunoId: string): Promise<void> {
  const perdida = await ocorrencia(TURMA_ORIGEM, emDias(-2));
  const f = await falta(alunoId, perdida);
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES (gen_random_uuid(),'${EMPRESA}','${alunoId}','${f}','${AULA}')`,
  );
}

/** Um aluno de fora com crédito, pronto para tentar o POST. */
async function candidato(): Promise<{ usuarioId: string; faltaId: string }> {
  const c = await aluno('Candidato');
  await matricular(TURMA_ORIGEM, c.alunoId);
  const perdida = await ocorrencia(TURMA_ORIGEM, emDias(-3));
  const faltaId = await falta(c.alunoId, perdida);
  return { usuarioId: c.usuarioId, faltaId };
}

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-057 ocupacao','spec-057-oc-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_ORIGEM}','${EMPRESA}','Origem','${QUADRA}',50,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_ALVO}','${EMPRESA}','Alvo','${QUADRA}',2,'ativa')`,
  );
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${AULA}','${EMPRESA}','${QUADRA}','${DIA_DA_AULA}','20:00','21:00','TURMA','${TURMA_ALVO}','pendente_pagamento',now())`,
  );
}

/** O que cada um dos três leitores diz sobre a aula-alvo, lido na mesma hora. */
async function leituras(usuarioDoCandidato: string) {
  const dia = await agenda().detalheDoDia(EMPRESA, DIA_DA_AULA);
  const item = dia.find((i) => i.id === AULA);
  const ops = await reposicao().oportunidades(EMPRESA, usuarioDoCandidato);
  const op = ops.find((o) => o.ocupacaoId === AULA);
  return { item, vagasNaOportunidade: op?.vagas ?? 0 };
}

async function post(c: { usuarioId: string; faltaId: string }) {
  try {
    await reposicao().marcar(EMPRESA, c.usuarioId, c.faltaId, AULA);
    return 'marcou';
  } catch (e) {
    const r = (e as { response?: { code?: string } }).response;
    return r?.code ?? String(e);
  }
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

describe('SPEC-057/D17 — a mesma ocupação na agenda, nas oportunidades e no POST', () => {
  it('ex-matriculado com falta retida: 0 ocupados, 2 vagas — e não 3', async () => {
    const saiu = await aluno('Saiu');
    await matricular(TURMA_ALVO, saiu.alunoId);
    await falta(saiu.alunoId, AULA);
    await desmatricular(TURMA_ALVO, saiu.alunoId);
    const c = await candidato();

    const { item, vagasNaOportunidade } = await leituras(c.usuarioId);

    expect(item).toMatchObject({
      capacidade: 2,
      matriculados: 0,
      faltasAvisadas: 0,
      reposicoesMarcadas: 0,
      reposicoesNaOcupacao: 0,
      ocupados: 0,
      vagasNaOcorrencia: 2,
    });
    expect(vagasNaOportunidade).toBe(2);
    expect(await post(c)).toBe('marcou');
  });

  it('M∩V sem falta: conta UMA vez, sobra vaga, e o POST aceita', async () => {
    const duplo = await aluno('Membro e Visitante');
    await visita(duplo.alunoId);
    await matricular(TURMA_ALVO, duplo.alunoId);
    const c = await candidato();

    const { item, vagasNaOportunidade } = await leituras(c.usuarioId);

    expect(item).toMatchObject({
      matriculados: 1,
      faltasAvisadas: 0,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 0,
      ocupados: 1,
      vagasNaOcorrencia: 1,
    });
    expect(vagasNaOportunidade).toBe(1);
    expect(await post(c)).toBe('marcou');
  });

  it('M∩F∩V: ocupa uma vaga, como visitante', async () => {
    const triplo = await aluno('Membro, Faltou e Visitante');
    await visita(triplo.alunoId);
    await matricular(TURMA_ALVO, triplo.alunoId);
    await falta(triplo.alunoId, AULA);
    const c = await candidato();

    const { item, vagasNaOportunidade } = await leituras(c.usuarioId);

    expect(item).toMatchObject({
      matriculados: 1,
      faltasAvisadas: 1,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 1,
      ocupados: 1,
      vagasNaOcorrencia: 1,
    });
    expect(vagasNaOportunidade).toBe(1);
    expect(await post(c)).toBe('marcou');
  });

  it('visitante externo completa a aula: 0 vagas nos três leitores', async () => {
    const membro = await aluno('Membro');
    await matricular(TURMA_ALVO, membro.alunoId);
    const externo = await aluno('Externo');
    await visita(externo.alunoId);
    const c = await candidato();

    const { item, vagasNaOportunidade } = await leituras(c.usuarioId);

    expect(item).toMatchObject({
      matriculados: 1,
      reposicoesMarcadas: 1,
      reposicoesNaOcupacao: 1,
      ocupados: 2,
      vagasNaOcorrencia: 0,
    });
    expect(vagasNaOportunidade).toBe(0);
    expect(await post(c)).toBe('TURMA_SEM_VAGA');
  });

  it('lotação excedida: `ocupados` mostra o excedente, vagas param em zero', async () => {
    for (const nome of ['Um', 'Dois']) {
      const m = await aluno(nome);
      await matricular(TURMA_ALVO, m.alunoId);
    }
    const externo = await aluno('Externo');
    await visita(externo.alunoId);
    const c = await candidato();

    const { item, vagasNaOportunidade } = await leituras(c.usuarioId);

    expect(item).toMatchObject({
      matriculados: 2,
      reposicoesNaOcupacao: 1,
      ocupados: 3,
      vagasNaOcorrencia: 0,
    });
    expect(vagasNaOportunidade).toBe(0);
    expect(await post(c)).toBe('TURMA_SEM_VAGA');
  });

  it('a semana devolve os mesmos números do dia para a mesma aula', async () => {
    const membro = await aluno('Membro');
    await matricular(TURMA_ALVO, membro.alunoId);
    const externo = await aluno('Externo');
    await visita(externo.alunoId);

    const dia = (await agenda().detalheDoDia(EMPRESA, DIA_DA_AULA)).find(
      (i) => i.id === AULA,
    );
    const semana = (await agenda().semanaDe(EMPRESA, DIA_DA_AULA))
      .flatMap((d) => d.itens)
      .find((i) => i.id === AULA);

    expect(semana).toEqual(dia);
  });

  it('visitantes da aula: nome e nível do visitante, e só dele', async () => {
    const membro = await aluno('Membro Fixo');
    await matricular(TURMA_ALVO, membro.alunoId);
    const externo = await aluno('Visitante Externo');
    await visita(externo.alunoId);

    const visitantes = await agenda().visitantesDaOcorrencia(EMPRESA, AULA);

    expect(visitantes).toEqual([
      {
        alunoId: externo.alunoId,
        nome: 'Visitante Externo',
        nivelId: null,
        nivelNome: null,
        tipo: 'reposicao',
      },
    ]);
  });
});
