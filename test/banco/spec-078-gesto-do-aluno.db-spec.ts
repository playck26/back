/**
 * SPEC-078/REQ-001 — **as seis ações do aluno avisam o gestor**, contra o banco.
 *
 * Avisar e retirar falta, marcar e desmarcar reposição, entrar e sair de turma.
 * Cada caso lê a tabela `notificacoes` depois do gesto: o aviso é o efeito, e
 * a resposta do serviço não diz nada sobre ele.
 *
 * A pela-rota (AC-007) e a fila de espera (AC-016) moram no FIT
 * `test/fit/spec-078-avisos.fit-spec.ts`.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { diaNoFuturo } from './datas-relativas';
import { FaltaAvisadaService } from '../../src/classes/falta-avisada.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { momentoDaAula } from '../../src/push/avisos-de-gesto';
import { instanteNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { comNivelDaFixture, primeiroNivelSql } from './nivel-da-fixture';

jest.setTimeout(180_000);
exigirBancoLocal();

const id = (n: number) =>
  '07800000-0000-4000-8000-' + String(n).padStart(12, '0');
const EMPRESA = id(1);
const OUTRA = id(2);
const QUADRA = id(3);
const TURMA_A = id(4);
const TURMA_B = id(5);
/** Dois gestores ativos: os que DEVEM receber. */
const G1 = id(10);
const G2 = id(11);
/** Gestor inativo, gestor de outra empresa, professor: os que NÃO. */
const G_INATIVO = id(12);
const G_OUTRA = id(13);
const U_PROF = id(14);
const PROF = id(15);
const U_ALUNO = id(16);
const ALUNO = id(17);

/**
 * AC-004 — **nomes únicos**, procurados depois em toda coluna de texto dos
 * avisos. Palavras que nenhum texto do sistema usaria por acaso.
 */
const NOMES = {
  aluno: 'Zefiro Quintanilha',
  turmaA: 'Turma Xilofone',
  turmaB: 'Turma Ornitorrinco',
  quadra: 'Quadra Wombat',
  professor: 'Yakov Pestalozzi',
};

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const p = db as unknown as PrismaService;
const operacao = new ConfigOperacaoService(p);
const faltas = new FaltaAvisadaService(p, operacao);
const reposicoes = new ReposicaoService(p, operacao);
const matriculas = new MatriculaDoAlunoService(p, operacao);

let seq = 100;
async function ocorrencia(
  turmaId: string,
  data: string,
  hora: string,
  status: 'pendente_pagamento' | 'cancelado' = 'pendente_pagamento',
): Promise<string> {
  const oc = id(++seq);
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(`INSERT INTO ocupacoes_quadra
             (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
           VALUES ('${oc}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','${status}',now())`);
  return oc;
}

async function falta(ocupacaoId: string): Promise<string> {
  const f = id(++seq);
  await q(`INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
           VALUES ('${f}','${EMPRESA}','${ocupacaoId}','${ALUNO}',now())`);
  return f;
}

interface Aviso {
  destinatario_id: string;
  titulo: string;
  corpo: string;
  destino_url: string;
  expira_em: Date | null;
  origem_id: string;
}

async function avisos(): Promise<Aviso[]> {
  return db.$queryRawUnsafe<Aviso[]>(
    `SELECT destinatario_id::text, titulo, corpo, destino_url, expira_em, origem_id::text
       FROM notificacoes
      WHERE tipo = 'gesto_do_aluno' AND company_id IN ('${EMPRESA}','${OUTRA}')
      ORDER BY criada_em, destinatario_id`,
  );
}

/** A aula como a coluna a guarda, para o texto e o prazo esperados. */
function aulaDe(data: string, hora: string) {
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  return {
    data: new Date(`${data}T00:00:00.000Z`),
    horaInicio: new Date(`1970-01-01T${hora}:00.000Z`),
    horaFim: new Date(`1970-01-01T${fim}:00.000Z`),
  };
}

/** O que os dois gestores ativos devem ter recebido de UM gesto. */
function doisAvisos(
  titulo: string,
  corpo: string,
  turmaId: string,
  expira: Date | null,
): unknown[] {
  return [G1, G2].map((g): unknown =>
    expect.objectContaining({
      destinatario_id: g,
      titulo,
      corpo,
      destino_url: `/turmas/${turmaId}`,
      expira_em: expira,
    }),
  );
}

async function contagens() {
  const [r] = await db.$queryRawUnsafe<
    { acoes: number; ev_oc: number; ev_mat: number }[]
  >(
    `SELECT (SELECT count(*)::int FROM acoes_administrativas WHERE company_id = '${EMPRESA}') AS acoes,
            (SELECT count(*)::int FROM eventos_de_ocupacao WHERE company_id = '${EMPRESA}') AS ev_oc,
            (SELECT count(*)::int FROM eventos_de_matricula WHERE company_id = '${EMPRESA}') AS ev_mat`,
  );
  return r;
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA);
  for (const [e, slug] of [
    [EMPRESA, 'spec-078'],
    [OUTRA, 'spec-078-outra'],
  ]) {
    await q(
      comNivelDaFixture(
        `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${e}','SPEC-078 ${slug}','${slug}',now())`,
      ),
    );
  }
  await q(`INSERT INTO usuarios (id,email,senha_hash,nome,role,status,company_id,updated_at) VALUES
    ('${G1}','g1@s078.test','h','Gestor Um','company_admin','ativo','${EMPRESA}',now()),
    ('${G2}','g2@s078.test','h','Gestor Dois','company_admin','ativo','${EMPRESA}',now()),
    ('${G_INATIVO}','g3@s078.test','h','Gestor Inativo','company_admin','inativo','${EMPRESA}',now()),
    ('${G_OUTRA}','g4@s078.test','h','Gestor Outra','company_admin','ativo','${OUTRA}',now()),
    ('${U_PROF}','prof@s078.test','h','${NOMES.professor}','professor','ativo','${EMPRESA}',now()),
    ('${U_ALUNO}','aluno@s078.test','h','${NOMES.aluno}','aluno','ativo','${EMPRESA}',now())`);
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','${NOMES.professor}','${U_PROF}')`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${U_ALUNO}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','${NOMES.quadra}','${esporte.id}',80,'ativa')`,
  );
  await q(`INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status,nivel_id) VALUES
    ('${TURMA_A}','${EMPRESA}','${NOMES.turmaA}','${QUADRA}','${PROF}',10,'ativa',${primeiroNivelSql(`'${EMPRESA}'`)}),
    ('${TURMA_B}','${EMPRESA}','${NOMES.turmaB}','${QUADRA}','${PROF}',10,'ativa',${primeiroNivelSql(`'${EMPRESA}'`)})`);
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA_A}','${ALUNO}',now())`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA);
  await db.$disconnect();
});

describe('SPEC-078/REQ-001 — falta avisada e retirada', () => {
  it('AC-001 + AC-006: avisar falta avisa os DOIS gestores ativos, e ninguém mais', async () => {
    const dia = diaNoFuturo(10);
    const oc = await ocorrencia(TURMA_A, dia, '19:00');
    const aula = aulaDe(dia, '19:00');

    await faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc);

    const lidos = await avisos();
    expect(lidos).toHaveLength(2);
    expect(lidos).toEqual(
      doisAvisos(
        'Faltas',
        `Um aluno avisou que vai faltar na aula de ${momentoDaAula(aula.data, aula.horaInicio)}`,
        TURMA_A,
        instanteNoFusoDoClube(aula.data, aula.horaFim),
      ),
    );
    // Um gesto, uma origem: os dois avisos são do MESMO fato.
    expect(new Set(lidos.map((a) => a.origem_id)).size).toBe(1);
  });

  it('AC-005: avisar, retirar e avisar de novo são TRÊS fatos — três pares de avisos', async () => {
    const dia = diaNoFuturo(11);
    const oc = await ocorrencia(TURMA_A, dia, '19:00');

    await faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc);
    await faltas.retirar(EMPRESA, U_ALUNO, TURMA_A, oc);
    await faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc);

    const lidos = await avisos();
    expect(lidos).toHaveLength(6);
    expect(
      lidos.map((a) => a.corpo.split(' na aula')[0].split(' da aula')[0]),
    ).toEqual([
      'Um aluno avisou que vai faltar',
      'Um aluno avisou que vai faltar',
      'Um aluno retirou o aviso de falta',
      'Um aluno retirou o aviso de falta',
      'Um aluno avisou que vai faltar',
      'Um aluno avisou que vai faltar',
    ]);
    expect(new Set(lidos.map((a) => a.origem_id)).size).toBe(3);
  });

  it('AC-002: o que não aconteceu não avisa — avisar de novo, retirar sem aviso, aula cancelada', async () => {
    const dia = diaNoFuturo(12);
    const oc = await ocorrencia(TURMA_A, dia, '19:00');
    const cancelada = await ocorrencia(
      TURMA_A,
      diaNoFuturo(13),
      '19:00',
      'cancelado',
    );

    await faltas.retirar(EMPRESA, U_ALUNO, TURMA_A, oc); // não havia aviso
    expect(await avisos()).toHaveLength(0);

    await faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc);
    await faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc); // já avisada
    expect(await avisos()).toHaveLength(2);

    await expect(
      faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, cancelada),
    ).rejects.toMatchObject({ response: { code: 'OCUPACAO_CANCELADA' } });
    expect(await avisos()).toHaveLength(2);
  });

  it('AC-003: a ação que volta atrás não deixa aviso — um erro no COMMIT desfaz os dois', async () => {
    const oc = await ocorrencia(TURMA_A, diaNoFuturo(14), '19:00');
    // A sabotagem, no próprio teste: um gatilho DIFERIDO que recusa a falta no
    // commit — depois de o aviso já ter sido gravado na mesma transação.
    await q(`CREATE FUNCTION spec078_recusa() RETURNS trigger AS $$
             BEGIN RAISE EXCEPTION 'SPEC078_VOLTA'; END $$ LANGUAGE plpgsql`);
    await q(`CREATE CONSTRAINT TRIGGER spec078_recusa AFTER INSERT ON faltas_avisadas
             DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION spec078_recusa()`);
    try {
      await expect(
        faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc),
      ).rejects.toThrow(/SPEC078_VOLTA/);
    } finally {
      await q(`DROP TRIGGER spec078_recusa ON faltas_avisadas`);
      await q(`DROP FUNCTION spec078_recusa()`);
    }
    expect(await avisos()).toHaveLength(0);
    const [{ n }] = await db.$queryRawUnsafe<{ n: number }[]>(
      `SELECT count(*)::int AS n FROM faltas_avisadas WHERE ocupacao_id = '${oc}'`,
    );
    expect(n).toBe(0);
  });
});

describe('SPEC-078/REQ-001 — reposição marcada e desmarcada', () => {
  it('AC-001: marcar e desmarcar avisam, com a turma e a aula de DESTINO', async () => {
    const perdida = await ocorrencia(TURMA_A, diaNoFuturo(-3), '19:00');
    const faltaId = await falta(perdida);
    const diaDestino = diaNoFuturo(5);
    const destino = await ocorrencia(TURMA_B, diaDestino, '20:00');
    const aula = aulaDe(diaDestino, '20:00');
    const momento = momentoDaAula(aula.data, aula.horaInicio);
    const expira = instanteNoFusoDoClube(aula.data, aula.horaFim);

    const r = await reposicoes.marcar(EMPRESA, U_ALUNO, faltaId, destino);
    expect(await avisos()).toEqual(
      doisAvisos(
        'Reposições',
        `Uma reposição foi marcada para ${momento}`,
        TURMA_B,
        expira,
      ),
    );

    await reposicoes.desmarcar(EMPRESA, U_ALUNO, r.id);
    const lidos = await avisos();
    expect(lidos).toHaveLength(4);
    expect(lidos.slice(2)).toEqual(
      doisAvisos(
        'Reposições',
        `Uma reposição de ${momento} foi desmarcada`,
        TURMA_B,
        expira,
      ),
    );
  });

  it('AC-002: marcar recusado (aula cancelada) não avisa', async () => {
    const perdida = await ocorrencia(TURMA_A, diaNoFuturo(-3), '19:00');
    const faltaId = await falta(perdida);
    const destino = await ocorrencia(
      TURMA_B,
      diaNoFuturo(6),
      '20:00',
      'cancelado',
    );

    await expect(
      reposicoes.marcar(EMPRESA, U_ALUNO, faltaId, destino),
    ).rejects.toBeDefined();
    expect(await avisos()).toHaveLength(0);
  });
});

describe('SPEC-078/REQ-001 — entrar e sair de turma', () => {
  it('AC-001 + AC-002: entrar avisa; entrar de novo não; sair avisa; sair de novo não', async () => {
    await matriculas.entrar(EMPRESA, U_ALUNO, TURMA_B);
    expect(await avisos()).toEqual(
      doisAvisos('Turmas', 'Um aluno entrou em uma das turmas', TURMA_B, null),
    );

    await matriculas.entrar(EMPRESA, U_ALUNO, TURMA_B); // já matriculado
    expect(await avisos()).toHaveLength(2);

    await matriculas.sair(EMPRESA, U_ALUNO, TURMA_B);
    const lidos = await avisos();
    expect(lidos).toHaveLength(4);
    expect(lidos.slice(2)).toEqual(
      doisAvisos('Turmas', 'Um aluno saiu de uma das turmas', TURMA_B, null),
    );

    await expect(
      matriculas.sair(EMPRESA, U_ALUNO, TURMA_B),
    ).rejects.toBeDefined();
    expect(await avisos()).toHaveLength(4);
  });
});

describe('SPEC-078 — o que vale para as seis', () => {
  it('AC-004 + AC-017: nenhum nome em aviso nenhum, e nenhuma ação nem evento de auditoria', async () => {
    const antes = await contagens();

    const oc = await ocorrencia(TURMA_A, diaNoFuturo(15), '19:00');
    await faltas.avisar(EMPRESA, U_ALUNO, TURMA_A, oc);
    await faltas.retirar(EMPRESA, U_ALUNO, TURMA_A, oc);
    const perdida = await ocorrencia(TURMA_A, diaNoFuturo(-4), '19:00');
    const faltaId = await falta(perdida);
    const destino = await ocorrencia(TURMA_B, diaNoFuturo(7), '20:00');
    const r = await reposicoes.marcar(EMPRESA, U_ALUNO, faltaId, destino);
    await reposicoes.desmarcar(EMPRESA, U_ALUNO, r.id);
    await matriculas.entrar(EMPRESA, U_ALUNO, TURMA_B);
    await matriculas.sair(EMPRESA, U_ALUNO, TURMA_B);

    const lidos = await avisos();
    // As seis ações, dois gestores cada.
    expect(lidos).toHaveLength(12);
    const texto = JSON.stringify(lidos);
    for (const nome of Object.values(NOMES)) {
      expect(texto).not.toContain(nome);
    }
    // I5 — só o aviso: o histórico de auditoria não ganha linha nenhuma.
    expect(await contagens()).toEqual(antes);
  });
});
