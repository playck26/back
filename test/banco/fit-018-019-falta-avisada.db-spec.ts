/**
 * SPEC-031/REQ-006 — **FIT-018 e FIT-019: a falta avisada, contra Postgres
 * real.** A corrida com o cancelamento é o FIT-020, em arquivo próprio.
 *
 * Metade destes casos depende de **constraint**, não de código: a FK composta
 * com `origem_tipo` que recusa falta em reserva avulsa, e o índice
 * `faltas_unica` que faz dois `POST` simultâneos produzirem uma linha. Mock
 * não tem constraint nenhuma — provar isso com Prisma dublado provaria só que
 * o meu código concorda comigo.
 *
 * **Duas conexões, não duas chamadas** (a lição do FIT-010): com um cliente
 * só, as transações podem sair da mesma conexão e serializar por acidente.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import { FaltaAvisadaService } from '../../src/classes/falta-avisada.service';
import { PresencaService } from '../../src/classes/presenca.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);

exigirBancoLocal();

const EMPRESA = 'f0180000-0000-4000-8000-000000000001';
const QUADRA = 'f0180000-0000-4000-8000-000000000002';
const ESPORTE = 'f0180000-0000-4000-8000-000000000003';
const TURMA = 'f0180000-0000-4000-8000-000000000004';
const OUTRA_TURMA = 'f0180000-0000-4000-8000-000000000005';
const UPROF = 'f0180000-0000-4000-8000-000000000006';
const PROF = 'f0180000-0000-4000-8000-000000000007';
const UALUNO = 'f0180000-0000-4000-8000-000000000008';
const ALUNO = 'f0180000-0000-4000-8000-000000000009';
const UFORA = 'f0180000-0000-4000-8000-00000000000e';
const AFORA = 'f0180000-0000-4000-8000-00000000000f';

const dbA = new PrismaClient();
const dbB = new PrismaClient();
const semear = new PrismaClient();

const q = (sql: string) => semear.$executeRawUnsafe(sql);
const svc = (c: PrismaClient) =>
  new FaltaAvisadaService(
    c as unknown as PrismaService,
    new ConfigOperacaoService(c as unknown as PrismaService),
  );
const faltasA = svc(dbA);
const faltasB = svc(dbB);
const presencas = new PresencaService(semear as unknown as PrismaService);

/** `HH:MM` no fuso do clube, deslocado de `n` minutos a partir de agora. */
async function minutoDoClube(n: number): Promise<string> {
  const [r] = await semear.$queryRawUnsafe<{ hhmm: string }[]>(
    `SELECT to_char((now() AT TIME ZONE 'America/Sao_Paulo') + INTERVAL '${n} minutes','HH24:MI') AS hhmm`,
  );
  return r.hhmm;
}

async function semearFixture() {
  await limparEmpresa(semear, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-018','fit-018',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,company_id,nome,email,senha_hash,role,status,updated_at) VALUES
       ('${UPROF}','${EMPRESA}','P','prof-f018@x.test','x','professor','ativo',now()),
       ('${UALUNO}','${EMPRESA}','A','aluno-f018@x.test','x','aluno','ativo',now()),
       ('${UFORA}','${EMPRESA}','F','fora-f018@x.test','x','aluno','ativo',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','P','${UPROF}')`,
  );
  await q(
    `INSERT INTO alunos (id,company_id,usuario_id,status,vinculo) VALUES
       ('${ALUNO}','${EMPRESA}','${UALUNO}','ativo','aprovado'),
       ('${AFORA}','${EMPRESA}','${UFORA}','ativo','aprovado')`,
  );
  for (const [id, nome] of [
    [TURMA, 'Turma FIT-018'],
    [OUTRA_TURMA, 'Outra'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}','${PROF}',20,'ativa')`,
    );
  }
  // Só o ALUNO é matriculado; o `AFORA` existe para provar o AC-016.
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}')`,
  );
}

/** Uma ocorrência de TURMA, hoje, começando em `hhmm`. */
async function ocorrencia(
  hhmm: string,
  turmaId = TURMA,
  status = 'pendente_pagamento',
): Promise<string> {
  const [r] = await semear.$queryRawUnsafe<{ id: string }[]>(`
    INSERT INTO ocupacoes_quadra
      (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
    VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',
            (now() AT TIME ZONE 'America/Sao_Paulo')::date,
            TIME '${hhmm}', TIME '${hhmm}' + INTERVAL '50 minutes',
            'TURMA','${turmaId}','${status}',now())
    RETURNING id`);
  return r.id;
}

const contaFaltas = (ocupacaoId: string) =>
  semear.faltaAvisada.count({ where: { ocupacaoId } });

const codigoDe = async (fn: () => Promise<unknown>) => {
  try {
    await fn();
    return 'aceito';
  } catch (e) {
    const r = (e as { getResponse?: () => { code?: string } }).getResponse?.();
    return r?.code ?? (e as { name?: string }).name ?? 'erro';
  }
};

beforeEach(semearFixture);

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbA.$disconnect(),
    dbB.$disconnect(),
    semear.$disconnect(),
  ]);
});

describe('FIT-018/FIT-019 — a falta avisada (SPEC-031/REQ-006)', () => {
  /**
   * AC-017 — **a idempotência é do BANCO.** Dois `POST` de duas conexões, e o
   * que garante a linha única é o índice `faltas_unica`, não o lock.
   */
  it('AC-017: dois POST SIMULTANEOS, duas conexoes, UMA linha', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));

    const r = await Promise.allSettled([
      faltasA.avisar(EMPRESA, UALUNO, TURMA, aula),
      faltasB.avisar(EMPRESA, UALUNO, TURMA, aula),
    ]);

    // Os DOIS devolvem sucesso: repetir não é engano do usuário.
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(2);
    expect(await contaFaltas(aula)).toBe(1);
  });

  it('AC-017b: DELETE repetido devolve o mesmo sucesso, mesmo sem linha', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));

    // Sem nunca ter avisado.
    await faltasA.retirar(EMPRESA, UALUNO, TURMA, aula);
    await faltasA.avisar(EMPRESA, UALUNO, TURMA, aula);
    await faltasA.retirar(EMPRESA, UALUNO, TURMA, aula);
    await faltasA.retirar(EMPRESA, UALUNO, TURMA, aula);

    expect(await contaFaltas(aula)).toBe(0);
  });

  /**
   * AC-017c — **o banco recusa**, não o código. A FK composta com
   * `origem_tipo` e o CHECK `faltas_origem_turma` são as duas metades.
   */
  it('AC-017c: falta em reserva AVULSA e recusada pelo banco', async () => {
    const [r] = await semear.$queryRawUnsafe<{ id: string }[]>(`
      INSERT INTO ocupacoes_quadra
        (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,status_pagamento,valor,updated_at)
      VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','2026-12-20','09:00','10:00','AVULSO','${ALUNO}','pendente_pagamento',100,now())
      RETURNING id`);

    await expect(
      q(
        `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}','${r.id}','${ALUNO}',now())`,
      ),
    ).rejects.toThrow();
  });

  /**
   * FIT-018, o tenant do D18 — `company_id` de A com ocupação de B devolve
   * `23503`. **É a FK composta `(company_id, ocupacao_id)` que faz isso**, e
   * ela existe separada da FK de `origem_tipo` porque `ocupacoes_quadra` não
   * tem `UNIQUE (company_id, id, origem_tipo)`: juntar as duas
   * responsabilidades numa constraint só enfraqueceria uma delas.
   */
  it('FIT-018: company_id de A com ocupacao de B devolve 23503', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));
    const outraEmpresa = 'f0180000-0000-4000-8000-0000000000bb';
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${outraEmpresa}','Outra','outra-f018',now())`,
    );

    // A ocupação é da EMPRESA; a falta se diz de `outraEmpresa`.
    await expect(
      q(
        `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at)
         VALUES (gen_random_uuid(),'${outraEmpresa}','${aula}','${ALUNO}',now())`,
      ),
    ).rejects.toThrow(/23503/);

    await q(`DELETE FROM empresas WHERE id = '${outraEmpresa}'`);
  });

  /**
   * AC-016 — **só matriculado.** É a consulta de matrícula que faz isto, não a
   * derivação do `alunoId`: o `AFORA` é da empresa certa, e as quatro FKs
   * passariam.
   */
  it('AC-016: aluno NAO matriculado leva 404, e nenhuma linha nasce', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));

    expect(
      await codigoDe(() => faltasA.avisar(EMPRESA, UFORA, TURMA, aula)),
    ).toBe('NotFoundException');
    expect(await contaFaltas(aula)).toBe(0);
  });

  /**
   * O `:turmaId` da rota entra nos quatro predicados: sem `origem_turma_id`, a
   * URL da turma A alcançaria a ocorrência da turma B.
   */
  it('AC-016: a ocorrencia de OUTRA turma nao e alcancavel pela URL desta', async () => {
    const aulaDaOutra = await ocorrencia(await minutoDoClube(240), OUTRA_TURMA);

    expect(
      await codigoDe(() => faltasA.avisar(EMPRESA, UALUNO, TURMA, aulaDaOutra)),
    ).toBe('NotFoundException');
    expect(await contaFaltas(aulaDaOutra)).toBe(0);
  });

  /**
   * AC-016b e AC-016c (D23) — **os dois verbos, o mesmo código.** Retirar o
   * aviso dentro do prazo é proibido igual a criá-lo: com o `DELETE` livre, o
   * aluno avisaria cedo e retiraria em cima da hora, terminando exatamente no
   * estado que o prazo existe para negar.
   */
  describe('a politica de prazo, nos DOIS verbos (D23)', () => {
    beforeEach(async () => {
      await q(
        `INSERT INTO config_operacao_empresa (id,company_id,prazo_cancelamento_aula_horas,prazo_cancelamento_reserva_horas,updated_at)
         VALUES (gen_random_uuid(),'${EMPRESA}',2,NULL,now())`,
      );
    });

    it('AC-016b: POST dentro do prazo recusa com PRAZO_DE_CANCELAMENTO', async () => {
      const aula = await ocorrencia(await minutoDoClube(60)); // 1h < 2h

      expect(
        await codigoDe(() => faltasA.avisar(EMPRESA, UALUNO, TURMA, aula)),
      ).toBe('PRAZO_DE_CANCELAMENTO');
      expect(await contaFaltas(aula)).toBe(0);
    });

    it('AC-016b: fora do prazo, aceita', async () => {
      const aula = await ocorrencia(await minutoDoClube(180)); // 3h > 2h
      await faltasA.avisar(EMPRESA, UALUNO, TURMA, aula);
      expect(await contaFaltas(aula)).toBe(1);
    });

    it('AC-016c: DELETE dentro do prazo recusa com o MESMO codigo', async () => {
      // Avisa com folga...
      const aula = await ocorrencia(await minutoDoClube(180));
      await faltasA.avisar(EMPRESA, UALUNO, TURMA, aula);

      // ...e a aula "chega perto": move o início para daqui a 1h.
      await q(
        `UPDATE ocupacoes_quadra SET hora_inicio = TIME '${await minutoDoClube(60)}' WHERE id = '${aula}'`,
      );

      expect(
        await codigoDe(() => faltasA.retirar(EMPRESA, UALUNO, TURMA, aula)),
      ).toBe('PRAZO_DE_CANCELAMENTO');
      // **A linha continua lá** — é o ponto do D23.
      expect(await contaFaltas(aula)).toBe(1);
    });
  });

  /**
   * AC-018b e AC-018c (D14) — não se avisa falta do que não vai acontecer, e o
   * aviso que já existe **sobrevive** ao cancelamento e **aparece** no
   * histórico. Preservar em vez de apagar é a mesma escolha da SPEC-032: o que
   * aconteceu, aconteceu.
   */
  it('AC-018b/c: cancelada recusa os dois verbos, e o aviso SOBREVIVE', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));
    await faltasA.avisar(EMPRESA, UALUNO, TURMA, aula);

    // **Cancelar por `UPDATE` cru não passa** — a trigger da INV-064 recusa, e
    // recusou este teste na primeira execução. A fixture faz o que o produto
    // faz: ação, transição e evento, na mesma transação.
    await cancelarOcupacaoNaFixture(semear, {
      companyId: EMPRESA,
      ocupacaoId: aula,
      autorId: UPROF,
    });

    expect(
      await codigoDe(() => faltasA.avisar(EMPRESA, UALUNO, TURMA, aula)),
    ).toBe('OCUPACAO_CANCELADA');
    expect(
      await codigoDe(() => faltasA.retirar(EMPRESA, UALUNO, TURMA, aula)),
    ).toBe('OCUPACAO_CANCELADA');

    // A falta continua registrada — é a resposta para "eu avisei".
    expect(await contaFaltas(aula)).toBe(1);

    // AC-019 + AC-018c: e ela APARECE na chamada, com a aula cancelada.
    const chamada = await presencas.chamada(EMPRESA, UPROF, aula);
    expect(chamada.cancelada).toBe(true);
    expect(chamada.alunos.find((a) => a.alunoId === ALUNO)?.faltaAvisada).toBe(
      true,
    );
  });

  it('AC-019: sem aviso, a chamada marca false', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));
    const chamada = await presencas.chamada(EMPRESA, UPROF, aula);
    expect(chamada.alunos.find((a) => a.alunoId === ALUNO)?.faltaAvisada).toBe(
      false,
    );
  });

  /**
   * Papel `aluno` no token e **sem linha em `alunos`** é sessão inconsistente,
   * não recurso ausente — `403`, não `404`. Mesma leitura do
   * `MatriculaDoAlunoService`; um `404` aqui mandaria o front tratar como
   * "aula não existe", e o aluno veria a tela errada para o problema errado.
   */
  it('usuario com papel aluno e SEM linha em alunos leva 403', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));
    const orfao = 'f0180000-0000-4000-8000-0000000000aa';
    await q(
      `INSERT INTO usuarios (id,company_id,nome,email,senha_hash,role,status,updated_at) VALUES ('${orfao}','${EMPRESA}','Orfao','orfao-f018@x.test','x','aluno','ativo',now())`,
    );

    expect(
      await codigoDe(() => faltasA.avisar(EMPRESA, orfao, TURMA, aula)),
    ).toBe('ForbiddenException');
    expect(await contaFaltas(aula)).toBe(0);
  });

  it('AC-018: avisar NAO desmatricula', async () => {
    const aula = await ocorrencia(await minutoDoClube(240));
    await faltasA.avisar(EMPRESA, UALUNO, TURMA, aula);

    expect(
      await semear.turmaAluno.count({
        where: { turmaId: TURMA, alunoId: ALUNO },
      }),
    ).toBe(1);
  });
});
