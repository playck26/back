/**
 * SPEC-054/TASK-003 — **o catálogo de adicionais e os nomes de tipo, por HTTP,
 * contra a aplicação e o banco reais.**
 *
 * ## O que a D10 exige, e como cada metade é provada
 *
 * Cada recusa do catálogo tem código, **pela conferência da aplicação e pela
 * recusa do banco** — e a mesma resposta nas duas. A conferência é o caminho
 * normal: basta pedir. A recusa do banco só acontece numa corrida entre a
 * conferência e a escrita, e **é forçada, não simulada**: um espião no próprio
 * serviço da aplicação grava a linha concorrente EXATAMENTE entre as duas, e o
 * que chega à tradução é o `23001`/`P2002`/`P2003` que o Postgres e o Prisma
 * produziram. Objeto de erro montado à mão está proibido pela spec.
 *
 * ## Por que em `test/fit`
 *
 * `subirAppReal` usa `configurarApp`, a mesma função do `main.ts`: o
 * `ValidationPipe` com `forbidNonWhitelisted` é o de produção. E o arquivo entra
 * no `fit-critical`, o job obrigatório do PR.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AdicionaisService } from '../../src/courts/adicionais.service';
import { TiposDeAdicionalService } from '../../src/courts/tipos-de-adicional.service';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import { dataFutura, idsDoCenario, login, montarCenario } from './cenario';

const C = idsDoCenario(5);
/** A outra empresa do AC-005. */
const OUTRA = idsDoCenario(7);

jest.setTimeout(180_000);

exigirBancoLocal();

const db = new PrismaClient();
let app: INestApplication<App>;
let gestor: string;
let aluno: string;
let gestorDaOutra: string;

const api = () => request(app.getHttpServer());
const DATA = dataFutura(20);

function comGestor<T extends request.Test>(r: T): T {
  return r.set('Authorization', `Bearer ${gestor}`);
}

async function criarTipo(nome: string, token = gestor): Promise<string> {
  const r = await api()
    .post('/api/v1/tipos-de-adicional')
    .set('Authorization', `Bearer ${token}`)
    .send({ nome });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
}

async function criarAdicional(
  campos: { tipoId: string; nome: string; preco?: number; estoque?: number },
  token = gestor,
): Promise<string> {
  const r = await api()
    .post('/api/v1/adicionais')
    .set('Authorization', `Bearer ${token}`)
    .send({ preco: 15, estoque: 2, ...campos });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
}

/** Reserva com item por SQL, numa transação só — o item só nasce assim (D5). */
async function reservaComItem(
  adicionalId: string,
  quantidade: number,
  inicio: string,
  fim: string,
): Promise<string> {
  return db.$transaction(async (tx) => {
    const [{ id }] = await tx.$queryRawUnsafe<{ id: string }[]>(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,updated_at)
       VALUES (gen_random_uuid(),'${C.EMPRESA}','${C.QUADRA}','${DATA}','${inicio}','${fim}','AVULSO','${C.ALUNO1}',500,now())
       RETURNING id::text AS id`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO adicionais_da_ocupacao (id,company_id,ocupacao_id,adicional_id,quantidade,valor_unitario)
       VALUES (gen_random_uuid(),'${C.EMPRESA}','${id}','${adicionalId}',${quantidade},15)`,
    );
    return id;
  });
}

beforeAll(async () => {
  for (const ids of [C, OUTRA]) {
    await limparEmpresa(db, ids.EMPRESA);
    await montarCenario(db, ids);
  }
  app = await subirAppReal();
  gestor = (await login(app, C.ADMIN_EMAIL)).accessToken;
  aluno = (await login(app, C.ALUNO1_EMAIL)).accessToken;
  gestorDaOutra = (await login(app, OUTRA.ADMIN_EMAIL)).accessToken;
});

beforeEach(async () => {
  jest.restoreAllMocks();
  // Cada caso começa sem catálogo e sem configuração — a ordem segue as FKs.
  await db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE playck_test_cleanup`);
    await tx.$executeRawUnsafe(
      `SELECT set_config('playck.limpeza_append_only', 'on', true)`,
    );
    for (const empresa of [C.EMPRESA, OUTRA.EMPRESA]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM adicionais_da_ocupacao WHERE company_id = '${empresa}'`,
      );
    }
    await tx.$executeRawUnsafe(`RESET ROLE`);
    for (const empresa of [C.EMPRESA, OUTRA.EMPRESA]) {
      await tx.$executeRawUnsafe(
        `DELETE FROM ocupacoes_quadra WHERE company_id = '${empresa}'`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM adicionais WHERE company_id = '${empresa}'`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM tipos_de_adicional WHERE company_id = '${empresa}'`,
      );
      await tx.$executeRawUnsafe(
        `DELETE FROM config_operacao_empresa WHERE company_id = '${empresa}'`,
      );
    }
  });
});

afterAll(async () => {
  jest.restoreAllMocks();
  await app?.close();
  for (const ids of [C, OUTRA]) {
    await limparEmpresa(db, ids.EMPRESA);
  }
  await db.$disconnect();
});

describe('SPEC-054/REQ-001 — os nomes de tipo', () => {
  it('AC-001: um nome e o padrão; os dois padrões; um campo só no corpo → 400', async () => {
    await comGestor(api().put('/api/v1/company-settings/nomes-de-tipo'))
      .send({ nomeTipoQuadra: 'Espaço', nomeTipoAula: null })
      .expect(200);
    const lido = await api()
      .get('/api/v1/me/company/operacao')
      .set('Authorization', `Bearer ${aluno}`)
      .expect(200);
    expect(lido.body).toMatchObject({
      nomeTipoQuadra: 'Espaço',
      nomeTipoAula: 'Aula particular',
    });

    await comGestor(api().put('/api/v1/company-settings/nomes-de-tipo'))
      .send({ nomeTipoQuadra: null, nomeTipoAula: null })
      .expect(200);
    const padrao = await comGestor(
      api().get('/api/v1/company-settings/operacao'),
    ).expect(200);
    expect(padrao.body).toMatchObject({
      nomeTipoQuadra: 'Quadra',
      nomeTipoAula: 'Aula particular',
    });

    await comGestor(api().put('/api/v1/company-settings/nomes-de-tipo'))
      .send({ nomeTipoQuadra: 'Espaço' })
      .expect(400);
  });

  it('AC-002: nome com espaço nas pontas, ou com mais de 30 caracteres → 400', async () => {
    for (const nomeTipoQuadra of [' Espaço', 'Espaço ', 'x'.repeat(31)]) {
      await comGestor(api().put('/api/v1/company-settings/nomes-de-tipo'))
        .send({ nomeTipoQuadra, nomeTipoAula: null })
        .expect(400);
    }
    for (const nome of [' Raquetes', 'x'.repeat(31)]) {
      await comGestor(api().post('/api/v1/tipos-de-adicional'))
        .send({ nome })
        .expect(400);
    }
  });

  it('AC-006: o PUT de operação com o corpo do Admin de hoje NÃO apaga os nomes; o PUT de nomes NÃO mexe em prazo nem preço', async () => {
    await comGestor(api().put('/api/v1/company-settings/nomes-de-tipo'))
      .send({ nomeTipoQuadra: 'Espaço', nomeTipoAula: 'Aula com professor' })
      .expect(200);
    // O corpo exato que o Admin em produção manda (três campos).
    await comGestor(api().put('/api/v1/company-settings/operacao'))
      .send({
        prazoCancelamentoAulaHoras: 2,
        prazoCancelamentoReservaHoras: 4,
        precoAulaPadrao: 150,
      })
      .expect(200);
    const depoisDaOperacao = await comGestor(
      api().get('/api/v1/company-settings/operacao'),
    ).expect(200);
    expect(depoisDaOperacao.body).toEqual({
      prazoCancelamentoAulaHoras: 2,
      prazoCancelamentoReservaHoras: 4,
      precoAulaPadrao: 150,
      nomeTipoQuadra: 'Espaço',
      nomeTipoAula: 'Aula com professor',
    });

    await comGestor(api().put('/api/v1/company-settings/nomes-de-tipo'))
      .send({ nomeTipoQuadra: null, nomeTipoAula: null })
      .expect(200);
    const depoisDosNomes = await comGestor(
      api().get('/api/v1/company-settings/operacao'),
    ).expect(200);
    expect(depoisDosNomes.body).toEqual({
      prazoCancelamentoAulaHoras: 2,
      prazoCancelamentoReservaHoras: 4,
      precoAulaPadrao: 150,
      nomeTipoQuadra: 'Quadra',
      nomeTipoAula: 'Aula particular',
    });
  });
});

describe('SPEC-054/REQ-001 — o catálogo: conferência da aplicação', () => {
  it('AC-003: preço zero ou estoque negativo → 400', async () => {
    const tipoId = await criarTipo('Raquetes');
    await comGestor(api().post('/api/v1/adicionais'))
      .send({ tipoId, nome: 'Raquete', preco: 0, estoque: 1 })
      .expect(400);
    await comGestor(api().post('/api/v1/adicionais'))
      .send({ tipoId, nome: 'Raquete', preco: 15, estoque: -1 })
      .expect(400);
  });

  it('AC-004: apagar tipo com adicional → 422 TIPO_EM_USO com a contagem; sem adicional → 204', async () => {
    const usado = await criarTipo('Raquetes');
    await criarAdicional({ tipoId: usado, nome: 'Raquete' });
    const r = await comGestor(
      api().delete(`/api/v1/tipos-de-adicional/${usado}`),
    ).expect(422);
    expect(r.body).toMatchObject({ code: 'TIPO_EM_USO', adicionais: 1 });

    const livre = await criarTipo('Bolas');
    await comGestor(api().delete(`/api/v1/tipos-de-adicional/${livre}`)).expect(
      204,
    );
  });

  it('AC-033: nome repetido de tipo e de adicional → 409 TIPO_JA_EXISTE e ADICIONAL_JA_EXISTE', async () => {
    const tipoId = await criarTipo('Raquetes');
    const t = await comGestor(api().post('/api/v1/tipos-de-adicional'))
      .send({ nome: 'Raquetes' })
      .expect(409);
    expect(t.body).toMatchObject({ code: 'TIPO_JA_EXISTE' });

    await criarAdicional({ tipoId, nome: 'Raquete' });
    const a = await comGestor(api().post('/api/v1/adicionais'))
      .send({ tipoId, nome: 'Raquete', preco: 10, estoque: 1 })
      .expect(409);
    expect(a.body).toMatchObject({ code: 'ADICIONAL_JA_EXISTE' });
  });

  it('AC-005: tipo e adicional de outra empresa em rota :id, e tipoId de outra empresa no POST → 404', async () => {
    const tipoAlheio = await criarTipo('Raquetes', gestorDaOutra);
    const adicionalAlheio = await criarAdicional(
      { tipoId: tipoAlheio, nome: 'Raquete' },
      gestorDaOutra,
    );

    const r1 = await comGestor(
      api().patch(`/api/v1/tipos-de-adicional/${tipoAlheio}`),
    )
      .send({ nome: 'Meu' })
      .expect(404);
    expect(r1.body).toMatchObject({ code: 'TIPO_NAO_ENCONTRADO' });
    await comGestor(
      api().delete(`/api/v1/tipos-de-adicional/${tipoAlheio}`),
    ).expect(404);

    const r2 = await comGestor(
      api().patch(`/api/v1/adicionais/${adicionalAlheio}`),
    )
      .send({ preco: 1 })
      .expect(404);
    expect(r2.body).toMatchObject({ code: 'ADICIONAL_NAO_ENCONTRADO' });

    const r3 = await comGestor(api().post('/api/v1/adicionais'))
      .send({ tipoId: tipoAlheio, nome: 'Raquete', preco: 15, estoque: 1 })
      .expect(404);
    expect(r3.body).toMatchObject({ code: 'TIPO_NAO_ENCONTRADO' });
  });

  it('o aluno lê tipos e disponíveis, e não lê nem escreve o catálogo do gestor', async () => {
    const tipoId = await criarTipo('Raquetes');
    const comAluno = (r: request.Test) =>
      r.set('Authorization', `Bearer ${aluno}`);
    await comAluno(api().get('/api/v1/tipos-de-adicional')).expect(200);
    await comAluno(
      api().get(
        `/api/v1/adicionais/disponiveis?data=${DATA}&slots=09:00-10:00`,
      ),
    ).expect(200);
    await comAluno(api().get('/api/v1/adicionais')).expect(403);
    await comAluno(api().post('/api/v1/adicionais'))
      .send({ tipoId, nome: 'Raquete', preco: 15, estoque: 1 })
      .expect(403);
  });
});

describe('SPEC-054/D10 — a recusa do BANCO, forçada entre a conferência e a escrita, dá a mesma resposta', () => {
  it('AC-004: um adicional entra entre a contagem e o DELETE → 23001 → 422 TIPO_EM_USO com a contagem relida', async () => {
    const tipoId = await criarTipo('Raquetes');
    const tipos = app.get(TiposDeAdicionalService);
    const real = (companyId: string, id: string): Promise<number> =>
      db.adicional.count({ where: { companyId, tipoId: id } });
    jest
      .spyOn(tipos, 'contarAdicionais')
      .mockImplementationOnce(async (companyId: string, id: string) => {
        const antes = await real(companyId, id);
        await db.$executeRawUnsafe(
          `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at)
           VALUES (gen_random_uuid(),'${C.EMPRESA}','${id}','Entrou na corrida',15,1,now())`,
        );
        return antes; // 0: a conferência passou
      });

    const r = await comGestor(
      api().delete(`/api/v1/tipos-de-adicional/${tipoId}`),
    );
    expect({ status: r.status, body: r.body as unknown }).toEqual({
      status: 422,
      body: expect.objectContaining({
        code: 'TIPO_EM_USO',
        adicionais: 1,
      }) as unknown,
    });
  });

  it('AC-033: tipo com nome repetido gravado na corrida → P2002 → 409 TIPO_JA_EXISTE', async () => {
    const tipos = app.get(TiposDeAdicionalService);
    jest
      .spyOn(tipos, 'recusarNomeRepetido')
      .mockImplementationOnce(async (companyId: string, nome: string) => {
        await db.$executeRawUnsafe(
          `INSERT INTO tipos_de_adicional (id,company_id,nome) VALUES (gen_random_uuid(),'${companyId}','${nome}')`,
        );
      });
    const r = await comGestor(api().post('/api/v1/tipos-de-adicional')).send({
      nome: 'Raquetes',
    });
    expect({ status: r.status, body: r.body as unknown }).toEqual({
      status: 409,
      body: expect.objectContaining({ code: 'TIPO_JA_EXISTE' }) as unknown,
    });
  });

  it('AC-033: adicional com nome repetido gravado na corrida → P2002 → 409 ADICIONAL_JA_EXISTE', async () => {
    const tipoId = await criarTipo('Raquetes');
    const adicionais = app.get(AdicionaisService);
    jest
      .spyOn(adicionais, 'recusarNomeRepetido')
      .mockImplementationOnce(async (companyId: string, nome: string) => {
        await db.$executeRawUnsafe(
          `INSERT INTO adicionais (id,company_id,tipo_id,nome,preco,estoque,updated_at)
           VALUES (gen_random_uuid(),'${companyId}','${tipoId}','${nome}',15,1,now())`,
        );
      });
    const r = await comGestor(api().post('/api/v1/adicionais')).send({
      tipoId,
      nome: 'Raquete',
      preco: 15,
      estoque: 1,
    });
    expect({ status: r.status, body: r.body as unknown }).toEqual({
      status: 409,
      body: expect.objectContaining({ code: 'ADICIONAL_JA_EXISTE' }) as unknown,
    });
  });

  it('AC-033: PATCH de tipoId para tipo de outra empresa, com a conferência vencida na corrida → P2003 → 404 TIPO_NAO_ENCONTRADO', async () => {
    const meuTipo = await criarTipo('Raquetes');
    const adicionalId = await criarAdicional({
      tipoId: meuTipo,
      nome: 'Raquete',
    });
    const tipoAlheio = await criarTipo('Bolas', gestorDaOutra);
    const adicionais = app.get(AdicionaisService);
    // A conferência "passa": o tipo existia na empresa quando foi olhado. O que
    // o banco vê na escrita é um tipo de OUTRA empresa — a FK composta recusa.
    jest
      .spyOn(adicionais, 'exigirTipoDaEmpresa')
      .mockImplementationOnce(() => Promise.resolve());

    const r = await comGestor(
      api().patch(`/api/v1/adicionais/${adicionalId}`),
    ).send({
      tipoId: tipoAlheio,
    });
    expect({ status: r.status, body: r.body as unknown }).toEqual({
      status: 404,
      body: expect.objectContaining({ code: 'TIPO_NAO_ENCONTRADO' }) as unknown,
    });
  });
});

describe('SPEC-054/REQ-003 — a leitura do estoque', () => {
  it('AC-018: `disponivel` é o que sobra no horário — o menor saldo entre os blocos —, e o inativo não aparece', async () => {
    const tipoId = await criarTipo('Raquetes');
    const raquete = await criarAdicional({
      tipoId,
      nome: 'Raquete',
      estoque: 3,
    });
    const inativo = await criarAdicional({
      tipoId,
      nome: 'Bola velha',
      estoque: 9,
    });
    await comGestor(api().patch(`/api/v1/adicionais/${inativo}`))
      .send({ ativo: false })
      .expect(200);
    await reservaComItem(raquete, 2, '09:00', '10:00');

    const r = await comGestor(
      api().get(
        `/api/v1/adicionais/disponiveis?data=${DATA}&slots=09:00-10:00,15:00-16:00`,
      ),
    ).expect(200);
    // Dois blocos (9h e 15h): às 9h sobra 1, às 15h sobram 3 → o pedido cabe 1.
    expect(r.body).toEqual([
      expect.objectContaining({
        id: raquete,
        nome: 'Raquete',
        preco: 15,
        disponivel: 1,
        tipoNome: 'Raquetes',
      }),
    ]);
  });

  it('AC-020: baixar o estoque abaixo do reservado → 200 com horariosAcimaDoEstoque, e a reserva fica intacta', async () => {
    const tipoId = await criarTipo('Raquetes');
    const raquete = await criarAdicional({
      tipoId,
      nome: 'Raquete',
      estoque: 3,
    });
    const ocupacao = await reservaComItem(raquete, 2, '09:00', '10:00');

    const r = await comGestor(api().patch(`/api/v1/adicionais/${raquete}`))
      .send({ estoque: 1 })
      .expect(200);
    expect(r.body).toMatchObject({
      estoque: 1,
      horariosAcimaDoEstoque: [
        { data: DATA, horaInicio: '09:00', horaFim: '10:00', reservado: 2 },
      ],
    });
    const [item] = await db.$queryRawUnsafe<{ quantidade: number }[]>(
      `SELECT quantidade FROM adicionais_da_ocupacao WHERE ocupacao_id = '${ocupacao}'`,
    );
    expect(item.quantidade).toBe(2);

    const semNadaAcima = await comGestor(
      api().patch(`/api/v1/adicionais/${raquete}`),
    )
      .send({ estoque: 5 })
      .expect(200);
    expect(
      (semNadaAcima.body as { horariosAcimaDoEstoque: unknown[] })
        .horariosAcimaDoEstoque,
    ).toEqual([]);
  });
});
