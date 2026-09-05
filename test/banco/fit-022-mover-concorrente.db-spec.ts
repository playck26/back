/**
 * SPEC-034/REQ-007 — **FIT-022: mover sob concorrência.**
 *
 * Três versões da spec erraram o cenário antes de acertar, e o registro fica
 * aqui porque a próxima pessoa vai ter a mesma intuição errada:
 *
 * - a **troca A↔B** (T1 move A para o slot de B, T2 move B para o de A) **não
 *   produz deadlock**. A pré-checagem de conflito responde `409` antes de
 *   qualquer `UPDATE`, e mesmo suprimindo-a o `UPDATE` de T1 encontra a linha
 *   de B apenas travada — o desfecho é `23P01`, não espera circular;
 * - o cenário que produz é **duas reservas para o MESMO slot livre**. As duas
 *   pré-checagens passam (o destino está vazio quando cada uma olha) e os dois
 *   `UPDATE` se esperam na `EXCLUDE`.
 *
 * **Duas conexões, não duas chamadas** — a lição do FIT-010. Com um cliente
 * só, as transações podem sair da mesma conexão e serializar por acidente,
 * provando nada.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';

jest.setTimeout(180_000);

exigirBancoLocal();

const EMPRESA = 'f0220000-0000-4000-8000-000000000001';
const QUADRA = 'f0220000-0000-4000-8000-000000000002';
const USUARIO = 'f0220000-0000-4000-8000-000000000003';
const ALUNO = 'f0220000-0000-4000-8000-000000000004';
const ADMIN = 'f0220000-0000-4000-8000-000000000005';
const A = 'f0220000-0000-4000-8000-00000000000a';
const B = 'f0220000-0000-4000-8000-00000000000b';
const DATA = '2026-10-05';

const dbA = new PrismaClient();
const dbB = new PrismaClient();
const semear = new PrismaClient();

function servico(db: PrismaClient): CourtsService {
  const horarios = new HorarioFuncionamentoService(
    db as unknown as PrismaService,
  );
  return new CourtsService(
    db as unknown as PrismaService,
    // `moveBooking` não toca em MOD-003: o aluno da reserva não muda
    // (LIM-034a). Os dublês aqui são declaradamente inertes — se algum
    // caminho passar a usá-los, o teste quebra em vez de mentir.
    {
      exigirVinculoAprovado: () => {
        throw new Error('moveBooking nao deve consultar vinculo de aluno');
      },
    } as unknown as StudentsService,
    horarios,
    {
      resolver: () => {
        throw new Error('moveBooking nao deve resolver imagem de quadra');
      },
    } as unknown as ImagemDaQuadraService,
  );
}

const servicoA = servico(dbA);
const servicoB = servico(dbB);

async function semearFixture() {
  await limparEmpresa(semear, EMPRESA);
  await semear.$executeRawUnsafe(`
    INSERT INTO empresas (id, nome, created_at, updated_at)
    VALUES ('${EMPRESA}', 'Empresa FIT-022', now(), now());

    INSERT INTO quadras (id, company_id, nome, preco_hora, status, created_at, updated_at)
    VALUES ('${QUADRA}', '${EMPRESA}', 'Quadra FIT-022', 100, 'ativa', now(), now());

    -- Expediente largo: o teste julga concorrência, não INV-011. Um dia
    -- fechado faria as duas transações morrerem em 422 antes do UPDATE.
    INSERT INTO horarios_funcionamento
      (id, company_id, quadra_id, dia_semana, fechado, hora_inicio, hora_fim, created_at, updated_at)
    SELECT gen_random_uuid(), '${EMPRESA}', '${QUADRA}', d, false, '06:00', '23:00', now(), now()
      FROM generate_series(0, 6) AS d;

    INSERT INTO usuarios (id, company_id, nome, email, senha_hash, role, status, created_at, updated_at)
    VALUES ('${USUARIO}', '${EMPRESA}', 'Aluno FIT-022', 'aluno-fit022@x.test', 'x', 'aluno', 'ativo', now(), now()),
           ('${ADMIN}', '${EMPRESA}', 'Admin FIT-022', 'admin-fit022@x.test', 'x', 'company_admin', 'ativo', now(), now());

    INSERT INTO alunos (id, company_id, usuario_id, status, vinculo, created_at, updated_at)
    VALUES ('${ALUNO}', '${EMPRESA}', '${USUARIO}', 'ativo', 'aprovado', now(), now());
  `);
}

/** Duas reservas AVULSAS, em horas diferentes, na mesma quadra. */
async function semearDuasReservas(horaA: string, horaB: string) {
  await semear.$executeRawUnsafe(`
    DELETE FROM eventos_de_ocupacao WHERE company_id = '${EMPRESA}';
    DELETE FROM acoes_administrativas WHERE company_id = '${EMPRESA}';
    DELETE FROM ocupacoes_quadra WHERE company_id = '${EMPRESA}';

    INSERT INTO ocupacoes_quadra
      (id, company_id, quadra_id, data, hora_inicio, hora_fim, origem_tipo,
       aluno_id, status_pagamento, valor, created_at, updated_at)
    VALUES
      ('${A}', '${EMPRESA}', '${QUADRA}', '${DATA}', '${horaA}', '${horaA.slice(0, 2)}:59:59', 'AVULSO',
       '${ALUNO}', 'pendente_pagamento', 100, now(), now()),
      ('${B}', '${EMPRESA}', '${QUADRA}', '${DATA}', '${horaB}', '${horaB.slice(0, 2)}:59:59', 'AVULSO',
       '${ALUNO}', 'pendente_pagamento', 100, now(), now());
  `);
}

beforeAll(semearFixture);

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    dbA.$disconnect(),
    dbB.$disconnect(),
    semear.$disconnect(),
  ]);
});

describe('FIT-022 — mover sob concorrência (SPEC-034/REQ-007)', () => {
  /**
   * AC-019 — N transações movendo reservas distintas para o **mesmo slot
   * livre**: exatamente uma vence, as demais recebem 409, nenhuma 500.
   */
  it('AC-019: duas para o mesmo slot livre — uma vence, a outra recebe 409', async () => {
    await semearDuasReservas('09:00', '10:00');

    const destino = { horaInicio: '15:00', horaFim: '16:00' };
    const [rA, rB] = await Promise.allSettled([
      servicoA.moveBooking(EMPRESA, A, destino, ADMIN),
      servicoB.moveBooking(EMPRESA, B, destino, ADMIN),
    ]);

    const ganhou = [rA, rB].filter((r) => r.status === 'fulfilled');
    const perdeu = [rA, rB].filter((r) => r.status === 'rejected');
    expect(ganhou).toHaveLength(1);
    expect(perdeu).toHaveLength(1);

    // 409, e **não** 500: a corrida perdida é conflito, não defeito.
    const erro = perdeu[0].reason as {
      status?: number;
    };
    expect(erro.status).toBe(409);

    // E o estado final não tem sobreposição — quem perdeu ficou onde estava.
    const noDestino = await semear.ocupacaoQuadra.count({
      where: {
        companyId: EMPRESA,
        data: new Date(`${DATA}T00:00:00.000Z`),
        horaInicio: new Date('1970-01-01T15:00:00.000Z'),
        statusPagamento: { not: 'cancelado' },
      },
    });
    expect(noDestino).toBe(1);
  });

  /**
   * AC-020 — o mesmo cenário, **com o `40P01` observado**.
   *
   * O deadlock depende de escalonamento: as duas transações precisam tomar a
   * própria linha antes de qualquer uma tentar o `UPDATE`. Isso não acontece
   * em toda execução — na validação cruzada apareceu no sexto par —, então o
   * teste **repete com teto declarado** e afirma o que vale sempre:
   * nenhuma transação recebe `40P01` cru, e quando o retry roda ele roda
   * **uma vez**.
   */
  it('AC-020: o retry aparece, e nunca vaza 40P01 cru', async () => {
    const TETO = 12;
    let viuRetry = false;

    for (let i = 0; i < TETO && !viuRetry; i += 1) {
      await semearDuasReservas('09:00', '10:00');
      const antes = servicoA.retentativasDeMover + servicoB.retentativasDeMover;

      const destino = { horaInicio: '15:00', horaFim: '16:00' };
      const r = await Promise.allSettled([
        servicoA.moveBooking(EMPRESA, A, destino, ADMIN),
        servicoB.moveBooking(EMPRESA, B, destino, ADMIN),
      ]);

      for (const item of r) {
        if (item.status === 'rejected') {
          const e = item.reason as { status?: number; message?: string };
          // O que vale SEMPRE: recusa é 409, e `40P01` nunca chega cru.
          expect(e.status).toBe(409);
          expect(String(e.message ?? '')).not.toContain('40P01');
        }
      }

      const depois =
        servicoA.retentativasDeMover + servicoB.retentativasDeMover;
      if (depois > antes) {
        viuRetry = true;
        // **Exatamente uma**, e é isto que o contador prova: um laço de N
        // tentativas passaria em todo o resto deste teste.
        expect(depois - antes).toBe(1);
      }
    }

    // Se em 12 pares o escalonador nunca produziu o ciclo, o teste NÃO falha
    // — ele registra. Falhar aqui transformaria um teste de concorrência em
    // sorteio, que é o defeito que a SPEC-030 catalogou (`LEARNINGS.md`,
    // 2026-08-29). O que ele já provou é o invariante: nenhuma 500, nenhum
    // 40P01 cru, nenhuma sobreposição.
    if (!viuRetry) {
      console.warn(
        `FIT-022/AC-020: ${TETO} pares sem produzir 40P01 nesta execução. ` +
          'O invariante foi verificado; o ciclo não apareceu.',
      );
    }
  });

  /**
   * AC-020b — a rede de segurança determinística.
   *
   * Injeta `40P01` na primeira tentativa e afere que a segunda completa. É o
   * que garante que o laço existe mesmo quando o escalonador não coopera.
   */
  it('AC-020b: 40P01 injetado na 1a tentativa — a 2a completa', async () => {
    await semearDuasReservas('09:00', '10:00');

    const servicoInjetado = servico(dbA);
    const original = dbA.$transaction.bind(dbA) as (
      ...a: unknown[]
    ) => Promise<unknown>;
    let primeira = true;
    const espiao = jest
      .spyOn(dbA, '$transaction')
      .mockImplementation((...args: unknown[]) => {
        if (primeira) {
          primeira = false;
          const e = new Error('deadlock detected') as Error & { code?: string };
          e.code = 'P2034';
          return Promise.reject(e);
        }
        return original(...args);
      });

    try {
      const antes = servicoInjetado.retentativasDeMover;
      const movida = await servicoInjetado.moveBooking(
        EMPRESA,
        A,
        { horaInicio: '15:00', horaFim: '16:00' },
        ADMIN,
      );
      expect(movida.horaInicio).toBe('15:00');
      expect(servicoInjetado.retentativasDeMover - antes).toBe(1);
    } finally {
      espiao.mockRestore();
    }
  });
});
