/**
 * SPEC-072/TASK-001 — **o crédito diz de qual ocorrência nasceu** — e, desde a
 * SPEC-075, **o servidor olha o nível**.
 *
 * Duas provas, pelo app real e pela rede, porque nenhuma das duas sobrevive a
 * um dublê:
 *
 *   (a) **AC-002 — `ocupacaoId` é a ocorrência de ORIGEM**, a que ele perdeu,
 *       antes e **depois** de marcada a reposição. Sem a metade de depois,
 *       trocar origem por destino passaria; sem a de antes, publicar o
 *       `faltaId` dentro do campo passaria na AC-001, que só olha o contrato.
 *   (b) **INV-075a (SPEC-075) — aluno de nível A marca em turma de nível B, e
 *       o servidor RECUSA.** Até a SPEC-075 este caso afirmava o contrário — o
 *       servidor ACEITAVA, era a `INV-072a` ("nível é recorte de tela, nunca
 *       autoridade"). A ADR-026 derrubou a INV-072a, e a D11 da SPEC-075 manda
 *       **inverter, nunca silenciar**: a fixture que cruza nível FICA (o caso
 *       que a afirma continua aqui embaixo), e mudam o nome, o status e o
 *       estado final esperados. A metade AC-002(b) da SPEC-072 — "depois de
 *       marcada, a origem não se move" — precisava de uma reposição marcada de
 *       verdade, e mudou para um caso próprio, com destino do nível dele.
 *
 * **A premissa da fixture é afirmada, não suposta.** Um cenário em que o
 * aluno e a turma ficassem os dois sem nível deixaria (b) verde provando
 * coisa nenhuma — a mesma família do teste que passa porque a sabotagem não
 * rodou. Por isso o primeiro caso lê os dois ids do banco e exige que sejam
 * diferentes.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import {
  login,
  montarCenario,
  type IdsDoCenario,
  type Sessao,
} from './cenario';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';

jest.setTimeout(600_000);
exigirBancoLocal();

// **Ids próprios, e não `idsDoCenario(n)`.** Aquele helper cabe num dígito
// hexadecimal só (`f043000<suite>`), e as suítes 1 a 9 já estão tomadas —
// reaproveitar uma faria o `afterAll` de uma apagar a fixture da outra quando
// os jobs rodam em paralelo, que é exatamente o acidente que o comentário do
// `cenario.ts` documenta.
const BASE = 'f0720000-0000-4000-8000-0000000000';
const C: IdsDoCenario = {
  EMPRESA: `${BASE}01`,
  QUADRA: `${BASE}02`,
  QUADRA_TURMAS: `${BASE}03`,
  ADMIN_USUARIO: `${BASE}10`,
  ALUNO1_USUARIO: `${BASE}11`,
  ALUNO2_USUARIO: `${BASE}12`,
  ALUNO1: `${BASE}21`,
  ALUNO2: `${BASE}22`,
  ADMIN_EMAIL: 'spec072-admin@teste.local',
  ALUNO1_EMAIL: 'spec072-aluno1@teste.local',
  ALUNO2_EMAIL: 'spec072-aluno2@teste.local',
};

const NIVEL_A = `${BASE}31`;
const NIVEL_B = `${BASE}32`;
const TURMA_A = `${BASE}33`;
const TURMA_B = `${BASE}34`;
const OC_ORIGEM = `${BASE}35`;
const OC_DESTINO = `${BASE}36`;
const FALTA = `${BASE}37`;
/** SPEC-075 — o destino DO NÍVEL DELE, para a AC-002(b) continuar tendo uma
 *  reposição marcada de verdade depois que o destino de outro nível passou a
 *  ser recusado. */
const TURMA_A2 = `${BASE}38`;
const OC_DESTINO_MESMO_NIVEL = `${BASE}39`;

const ROTA = '/api/v1/me/reposicoes';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
let app: INestApplication<App>;
let aluno: Sessao;

interface FaltaNaResposta {
  faltaId: string;
  ocupacaoId: string;
  turmaNome: string | null;
  reposicao: { id: string } | null;
}
interface CorpoDoCredito {
  creditos: number;
  faltas: FaltaNaResposta[];
}
interface CorpoDaReposicao {
  id: string;
  faltaId: string;
  ocupacaoId: string;
}

/** `AAAA-MM-DD` no fuso do clube, `dias` à frente (negativo = atrás). */
function emDias(dias: number): string {
  // `hojeNoFusoDoClube()` e não `new Date()`: às 22h locais o relógio UTC já
  // está no dia seguinte, e o teste passaria a comparar dias diferentes dos
  // que o serviço calcula. A lição é do CI, e está no `spec-046`.
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function ocorrencia(
  id: string,
  turmaId: string,
  data: string,
  hora: string,
): Promise<void> {
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${C.EMPRESA}','${C.QUADRA_TURMAS}','${data}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
}

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);

  for (const [id, nome, ordem] of [
    [NIVEL_A, 'Iniciante', 0],
    [NIVEL_B, 'Avancado', 1],
  ] as const) {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem,created_at) VALUES ('${id}','${C.EMPRESA}','${nome}',${ordem},now())`,
    );
  }

  for (const [id, nome, nivel] of [
    [TURMA_A, 'Turma do nivel dele', NIVEL_A],
    [TURMA_B, 'Turma de OUTRO nivel', NIVEL_B],
    [TURMA_A2, 'Outra turma do nivel dele', NIVEL_A],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,nivel_id,quadra_id,capacidade,status) VALUES ('${id}','${C.EMPRESA}','${nome}','${nivel}','${C.QUADRA_TURMAS}',10,'ativa')`,
    );
  }

  // Ele é do nível A e está matriculado só na turma A. **Fora da B de
  // propósito:** matriculado lá, a recusa seria `JA_MATRICULADO_NA_TURMA` e o
  // caso (b) ficaria vermelho pelo motivo errado.
  await q(
    `UPDATE alunos SET nivel_id='${NIVEL_A}' WHERE id='${C.ALUNO1}' AND company_id='${C.EMPRESA}'`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA_A}','${C.ALUNO1}',now())`,
  );

  // A aula que ele perdeu (origem) e a que ele quer frequentar (destino).
  await ocorrencia(OC_ORIGEM, TURMA_A, emDias(-3), '19:00');
  await ocorrencia(OC_DESTINO, TURMA_B, emDias(5), '20:00');
  await ocorrencia(OC_DESTINO_MESMO_NIVEL, TURMA_A2, emDias(6), '20:00');
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${FALTA}','${C.EMPRESA}','${OC_ORIGEM}','${C.ALUNO1}',now())`,
  );

  app = await subirAppReal();
  aluno = await login(app, C.ALUNO1_EMAIL);
});

afterAll(async () => {
  if (app) await app.close();
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

const comToken = () => ({ Authorization: `Bearer ${aluno.accessToken}` });

const credito = async (): Promise<CorpoDoCredito> => {
  const res = await request(app.getHttpServer())
    .get(ROTA)
    .set(comToken())
    .expect(200);
  return res.body as CorpoDoCredito;
};

describe('SPEC-072/TASK-001 — a ocupação do crédito, e o nível', () => {
  it('a FIXTURE é o que ela diz ser: aluno de um nível, turma de outro', async () => {
    // Sem este caso, um cenário que perdesse os níveis deixaria o caso do
    // `POST` verde sem ter nível nenhum em jogo.
    const [linha] = await db.$queryRawUnsafe<
      { aluno: string | null; turma: string | null }[]
    >(
      `SELECT a.nivel_id::text AS aluno, t.nivel_id::text AS turma
         FROM alunos a, turmas t
        WHERE a.id='${C.ALUNO1}' AND t.id='${TURMA_B}'`,
    );

    expect(linha.aluno).toBe(NIVEL_A);
    expect(linha.turma).toBe(NIVEL_B);
    expect(linha.aluno).not.toBe(linha.turma);
  });

  it('AC-002(a): o crédito traz a ocorrência que GEROU a falta', async () => {
    const corpo = await credito();

    expect(corpo.creditos).toBe(1);
    expect(corpo.faltas).toHaveLength(1);

    const falta = corpo.faltas[0];
    expect(falta.faltaId).toBe(FALTA);
    // **O campo é a OCORRÊNCIA, não a falta.** Publicar `faltaId` aqui
    // passaria na AC-001, que só confere que o contrato tem o campo.
    expect(falta.ocupacaoId).toBe(OC_ORIGEM);
    expect(falta.ocupacaoId).not.toBe(falta.faltaId);
  });

  it('INV-075a (SPEC-075, invertido da INV-072a): o POST fora do nível é RECUSADO, e o crédito fica intacto', async () => {
    const res = await request(app.getHttpServer())
      .post(ROTA)
      .set(comToken())
      .send({ faltaId: FALTA, ocupacaoId: OC_DESTINO });

    // **Recusado.** Até a SPEC-075 este caso esperava `201` — a INV-072a dizia
    // que o servidor não olhava o nível. A mesma fixture cruzada, o resultado
    // invertido (D11 da SPEC-075).
    expect(res.status).toBe(422);
    expect((res.body as { code?: string }).code).toBe('NIVEL_INCOMPATIVEL');

    // E nada foi gasto: o crédito continua disponível, apontando para a origem.
    const depois = await credito();
    expect(depois.creditos).toBe(1);
    expect(depois.faltas[0].reposicao).toBeNull();
    expect(depois.faltas[0].ocupacaoId).toBe(OC_ORIGEM);
  });

  it('AC-002(b): marcada a reposição (num destino do nível dele), o crédito continua apontando para a ORIGEM', async () => {
    const res = await request(app.getHttpServer())
      .post(ROTA)
      .set(comToken())
      .send({ faltaId: FALTA, ocupacaoId: OC_DESTINO_MESMO_NIVEL });

    expect(res.status).toBe(201);
    const criada = res.body as CorpoDaReposicao;
    expect(criada.faltaId).toBe(FALTA);
    expect(criada.ocupacaoId).toBe(OC_DESTINO_MESMO_NIVEL);

    const depois = await credito();
    const falta = depois.faltas[0];

    // **A origem não se move.** O destino agora existe, e está em
    // `reposicao` — trocar um pelo outro é o que este caso pega.
    expect(falta.reposicao).not.toBeNull();
    expect(falta.ocupacaoId).toBe(OC_ORIGEM);
    expect(falta.ocupacaoId).not.toBe(OC_DESTINO_MESMO_NIVEL);
    // O crédito foi consumido: a falta deixou de contar como saldo.
    expect(depois.creditos).toBe(0);
  });
});
