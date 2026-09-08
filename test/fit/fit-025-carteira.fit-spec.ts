/**
 * SPEC-033/FIT-025 — **a carteira contra a Neon, por HTTP, com duas pools.**
 *
 * ## Por que este arquivo existe, e por que ele é o que faltava
 *
 * Sete validações cruzadas da SPEC-033 fecharam com a mesma frase na lista do
 * que segue sem prova: **"carga e concorrência na Neon"**. Tudo o que a spec
 * mediu rodou em PostgreSQL local — inclusive as provas de concorrência.
 *
 * Local e Neon não são o mesmo alvo. A Neon tem latência de rede entre as duas
 * conexões, e latência muda o intercalamento: uma janela que o loopback fecha
 * em microssegundos fica aberta o suficiente para outra transação entrar. **Já
 * mordeu este projeto**, com `P1002` e advisory lock preso.
 *
 * ## O que ele prova, e o que continua sem prova
 *
 * Prova: **dinheiro não sai duas vezes sob corrida real**. Dois pedidos
 * simultâneos, saldo para um, cada um por uma pool própria — exatamente um
 * passa, o outro recebe `422 SALDO_INSUFICIENTE`, e o saldo nunca fica
 * negativo.
 *
 * **Não** prova carga: são dois pedidos por iteração, não cem. Carga continua
 * na lista, e escrever que "a Neon está coberta" seria trocar uma lacuna por
 * uma frase.
 *
 * ## Duas pools, e não é detalhe
 *
 * Um app só, com uma pool só, poderia serializar por acidente e provar nada —
 * mesma razão pela qual o FIT-001 sobe dois apps e o FIT-010 abre dois
 * `PrismaClient`.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import {
  ADMIN_USUARIO,
  ALUNO1,
  ALUNO1_EMAIL,
  EMPRESA,
  QUADRA,
  dataFutura,
  login,
  montarCenario,
} from './cenario';

jest.setTimeout(180_000);

exigirBancoLocal();

const db = new PrismaClient();
let appA: INestApplication<App>;
let appB: INestApplication<App>;

const PRECO_HORA = 80;
const UMA_HORA_EM_CENTAVOS = PRECO_HORA * 100;

const saldo = async (): Promise<number> => {
  const [l] = await db.$queryRawUnsafe<{ saldo_creditos: number }[]>(
    `SELECT saldo_creditos FROM alunos WHERE id = '${ALUNO1}'`,
  );
  return l.saldo_creditos;
};

const consumos = async (): Promise<number> => {
  const [l] = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM movimentos_de_credito
      WHERE company_id='${EMPRESA}' AND aluno_id='${ALUNO1}' AND tipo='consumo'`,
  );
  return Number(l.n);
};

/**
 * Credita pela porta do ledger — a única que existe (D1/INV-071).
 *
 * `UPDATE alunos SET saldo_creditos` seria recusado com `23514`, e é isso que
 * torna este caminho o único: a trigger é a escritora do saldo.
 */
async function creditar(centavos: number): Promise<void> {
  const [acao] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','credito_lancado','${ADMIN_USUARIO}')
     RETURNING id`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO movimentos_de_credito (id,company_id,aluno_id,tipo,valor_centavos,motivo,autor_id,acao_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO1}','entrada',${centavos},'aporte do canario','${ADMIN_USUARIO}','${acao.id}')`,
  );
}

function reservar(
  app: INestApplication<App>,
  token: string,
  data: string,
  hora: string,
) {
  return request(app.getHttpServer())
    .post('/api/v1/bookings')
    .set('Authorization', `Bearer ${token}`)
    .send({
      quadraId: QUADRA,
      data,
      slots: [{ horaInicio: hora, horaFim: proximaHora(hora) }],
      alunoId: ALUNO1,
    });
}

const proximaHora = (h: string) =>
  `${String(Number(h.slice(0, 2)) + 1).padStart(2, '0')}:00`;

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await montarCenario(db);
  [appA, appB] = await Promise.all([subirAppReal(), subirAppReal()]);
});

afterAll(async () => {
  await Promise.all([appA?.close(), appB?.close()]);
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-025 na Neon — dois pedidos, saldo para um', () => {
  // Poucas iterações de propósito: o canário roda no `db-migrate.yml`, que é
  // manual, e o objetivo é a JANELA, não o volume. Repetir importa porque uma
  // corrida que não acontece uma vez não prova ausência de janela — foi a
  // repetição que achou o comportamento das triggers diferidas no Prisma.
  const ITERACOES = 5;

  it.each(Array.from({ length: ITERACOES }, (_, i) => i + 1))(
    'iteração %i: exatamente um passa, o outro recebe SALDO_INSUFICIENTE',
    async (i) => {
      // Cada iteração com data própria: uma não pode herdar o estado da outra
      // e passar (ou cair) por ele.
      const data = dataFutura(30 + i);
      const consumosAntes = await consumos();

      // Saldo para UMA hora. As duas reservas são em horários diferentes, para
      // a disputa ser pela CARTEIRA e não pela `EXCLUDE` — brigando pelo mesmo
      // slot, o teste passaria pelo mecanismo errado e ficaria verde sem nunca
      // tocar no saldo.
      const atual = await saldo();
      if (atual < UMA_HORA_EM_CENTAVOS) {
        await creditar(UMA_HORA_EM_CENTAVOS - atual);
      }
      expect(await saldo()).toBe(UMA_HORA_EM_CENTAVOS);

      const { accessToken } = await login(appA, ALUNO1_EMAIL);

      const [rA, rB] = await Promise.all([
        reservar(appA, accessToken, data, '10:00'),
        reservar(appB, accessToken, data, '14:00'),
      ]);

      const criadas = [rA, rB].filter((r) => r.status === 201);
      const recusadas = [rA, rB].filter((r) => r.status !== 201);

      expect(criadas).toHaveLength(1);
      expect(recusadas).toHaveLength(1);
      expect(recusadas[0].status).toBe(422);
      expect((recusadas[0].body as { code?: string }).code).toBe(
        'SALDO_INSUFICIENTE',
      );

      // **As duas invariantes que importam:** o saldo nunca fica negativo (o
      // `CHECK` garante, mas ele garantindo por `500` seria falha) e nasceu
      // exatamente UM consumo.
      expect(await saldo()).toBe(0);
      expect(await consumos()).toBe(consumosAntes + 1);
    },
  );

  it('e a reserva que consumiu nasce `pago` — a carteira paga, o clube não cobra de novo', async () => {
    const data = dataFutura(90);
    await creditar(UMA_HORA_EM_CENTAVOS);
    const { accessToken } = await login(appA, ALUNO1_EMAIL);

    const res = await reservar(appA, accessToken, data, '10:00');
    expect(res.status).toBe(201);

    const [linha] = await db.$queryRawUnsafe<{ status_pagamento: string }[]>(
      `SELECT status_pagamento FROM ocupacoes_quadra
        WHERE company_id='${EMPRESA}' AND data='${data}'`,
    );
    expect(linha.status_pagamento).toBe('pago');
  });
});
