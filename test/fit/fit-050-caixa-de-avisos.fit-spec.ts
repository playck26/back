/**
 * SPEC-065/FIT-050 — **a caixa de entrada, pelo app real e pela rede.**
 *
 * O que só se prova aqui, e não por unitário:
 *
 *   (a) **o escopo vem do token** — nem com `destinatario_id` forjado na query
 *       alguém alcança a caixa de outra pessoa (AC-004, AC-005);
 *   (b) **os cinco campos de fila não vazam** — e o pior deles é `origem_id`,
 *       que na SPEC-063 aponta para a ação administrativa, que tem `autor_id`:
 *       expô-lo permitiria descobrir **quem** cancelou a aula (AC-003);
 *   (c) **a caixa não obedece a `expira_em`** (AC-013). Aquela coluna diz até
 *       quando vale a pena TENTAR enviar; a caixa responde outra pergunta. É
 *       o caso que motivou a spec inteira;
 *   (d) **avisos em qualquer estado aparecem** (AC-002), inclusive
 *       `sem_destino` e `falha_definitiva`. Se a caixa espelhasse só o que o
 *       push entregou, não resolveria a perda da LIM-062b;
 *   (e) **o aviso de teste não entra, e o de gesto entra** (AC-014) — os dois
 *       no mesmo caso, senão o teste passa com a caixa vazia;
 *   (f) **marcar como lido é idempotente** (AC-006) e não apaga, não reordena
 *       e não tira o aviso da lista (AC-007);
 *   (g) **a paginação não repete nem pula** com avisos do mesmo instante — que
 *       é o caso normal, porque um gesto grava todas as linhas num `INSERT`.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import type { App } from 'supertest/types';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import { idsDoCenario, login, montarCenario, type Sessao } from './cenario';

jest.setTimeout(600_000);
exigirBancoLocal();

const C = idsDoCenario(9);
const db = new PrismaClient();
let app: INestApplication<App>;
let aluno1: Sessao;
let aluno2: Sessao;

interface AvisoNaResposta {
  id: string;
  titulo: string;
  corpo: string;
  destinoUrl: string | null;
  criadaEm: string;
  lidaEm: string | null;
}
interface CorpoDaCaixa {
  data: AvisoNaResposta[];
  page: number;
  pageSize: number;
  total: number;
  naoLidos: number;
}
interface CorpoDeContagem {
  naoLidos: number;
}
interface CorpoDeMarcacao {
  marcadas: number;
}

const comToken = (s: Sessao) => ({ Authorization: `Bearer ${s.accessToken}` });

/**
 * Semeia um aviso direto no banco. **Não passa pelo enfileirador de propósito:**
 * o que esta FIT prova é a LEITURA, e depender da SPEC-063 para montar o
 * cenário misturaria as duas provas — um defeito lá deixaria esta vermelha
 * pelo motivo errado.
 */
async function semear(opcoes: {
  usuarioId: string;
  corpo: string;
  tipo?: string;
  estado?: string;
  expiraEm?: Date | null;
  criadaEm?: Date;
  lidaEm?: Date | null;
}): Promise<string> {
  const id = randomUUID();
  const tipo = opcoes.tipo ?? 'gesto';
  const estado = opcoes.estado ?? 'pendente';
  // O `CHECK` da SPEC-062 exige `concluida_em` exatamente nos terminais.
  const terminal = ![`pendente`, `enviando`].includes(estado);
  await db.$executeRawUnsafe(
    `INSERT INTO notificacoes
       (id, company_id, destinatario_id, origem_id, tipo, titulo, corpo,
        destino_url, criada_em, expira_em, estado, concluida_em, lida_em)
     VALUES ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5, $6, $7, $8,
             $9::timestamptz, $10::timestamptz, $11::estado_da_notificacao,
             $12::timestamptz, $13::timestamptz)`,
    id,
    C.EMPRESA,
    opcoes.usuarioId,
    // `gesto` exige origem (SPEC-063); `teste` não pode nem precisa dela.
    tipo === 'gesto' ? randomUUID() : null,
    tipo,
    tipo === 'teste' ? 'Avisos do clube' : 'Sua aula',
    opcoes.corpo,
    '/minhas-aulas',
    opcoes.criadaEm ?? new Date(),
    opcoes.expiraEm ?? null,
    estado,
    terminal ? new Date() : null,
    opcoes.lidaEm ?? null,
  );
  return id;
}

const caixaDe = async (s: Sessao, query = '') => {
  const res = await request(app.getHttpServer())
    .get(`/api/v1/me/avisos${query}`)
    .set(comToken(s));
  expect(res.status).toBe(200);
  return res.body as CorpoDaCaixa;
};

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  app = await subirAppReal();
  aluno1 = await login(app, C.ALUNO1_EMAIL);
  aluno2 = await login(app, C.ALUNO2_EMAIL);
});

afterAll(async () => {
  await app?.close();
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

beforeEach(async () => {
  await db.notificacao.deleteMany({ where: { companyId: C.EMPRESA } });
});

// ===========================================================================

describe('FIT-050 (a) — o escopo vem do token', () => {
  it('AC-004: dois usuários da mesma empresa veem listas DISJUNTAS', async () => {
    await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'do aluno 1' });
    await semear({ usuarioId: C.ALUNO2_USUARIO, corpo: 'do aluno 2' });

    const um = await caixaDe(aluno1);
    const dois = await caixaDe(aluno2);

    expect(um.data.map((a) => a.corpo)).toEqual(['do aluno 1']);
    expect(dois.data.map((a) => a.corpo)).toEqual(['do aluno 2']);
  });

  /**
   * **AC-005 — o escopo não vem do pedido.** A rota não tem parâmetro de
   * destinatário, e é essa ausência o mecanismo: não há conferência que alguém
   * possa esquecer de escrever.
   */
  it('AC-005: query forjada não alcança a caixa do outro', async () => {
    await semear({ usuarioId: C.ALUNO2_USUARIO, corpo: 'do aluno 2' });

    for (const forja of [
      `?destinatarioId=${C.ALUNO2_USUARIO}`,
      `?companyId=${C.EMPRESA}&destinatarioId=${C.ALUNO2_USUARIO}`,
      `?usuarioId=${C.ALUNO2_USUARIO}`,
    ]) {
      const res = await request(app.getHttpServer())
        .get(`/api/v1/me/avisos${forja}`)
        .set(comToken(aluno1));
      // 200 com lista vazia, ou 400 pela validação — **nunca** o aviso alheio.
      if (res.status === 200) {
        expect((res.body as CorpoDaCaixa).data).toHaveLength(0);
      } else {
        expect(res.status).toBe(400);
      }
    }
  });

  it('sem token, 401', async () => {
    const res = await request(app.getHttpServer()).get('/api/v1/me/avisos');
    expect(res.status).toBe(401);
  });
});

describe('FIT-050 (b) — AC-003: os campos de fila não vazam', () => {
  /**
   * **`origem_id` é o mais perigoso dos cinco.** Na SPEC-063 ele é o id da
   * `acoes_administrativas`, que carrega `autor_id` — com ele na mão, dá para
   * descobrir **quem** cancelou a aula.
   */
  const PROIBIDOS = [
    'origemId',
    'origem_id',
    'estado',
    'tentativas',
    'ultimoErro',
    'ultimo_erro',
    'reivindicadaPor',
    'reivindicada_por',
    'reivindicadaAte',
    'proximaTentativaEm',
    'concluidaEm',
    'destinatarioId',
    'companyId',
  ];

  it('nenhum dos campos de fila aparece na resposta', async () => {
    await semear({
      usuarioId: C.ALUNO1_USUARIO,
      corpo: 'um aviso',
      estado: 'falha_definitiva',
    });

    const res = await request(app.getHttpServer())
      .get('/api/v1/me/avisos')
      .set(comToken(aluno1));
    expect(res.status).toBe(200);

    // Varre o JSON CRU: um campo novo no `select` apareceria aqui, mesmo que
    // o DTO não o declare.
    const cru = JSON.stringify(res.body);
    for (const proibido of PROIBIDOS) {
      expect(cru).not.toContain(proibido);
    }
  });

  it('e os seis campos que a caixa PROMETE continuam lá', async () => {
    await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'um aviso' });
    const caixa = await caixaDe(aluno1);
    expect(Object.keys(caixa.data[0]).sort()).toEqual(
      ['corpo', 'criadaEm', 'destinoUrl', 'id', 'lidaEm', 'titulo'].sort(),
    );
  });
});

describe('FIT-050 (c) — AC-013: a caixa NÃO obedece a expira_em', () => {
  /**
   * **É o caso que motivou a spec inteira.**
   *
   * `expira_em` responde *"até quando vale a pena TENTAR enviar"*: um aviso de
   * aula expira no fim da ocorrência porque, depois disso, chegar ao aparelho
   * é pior que não chegar.
   *
   * Quem abre a caixa amanhã está perguntando outra coisa — *"o que
   * aconteceu?"* — e filtrar por `expira_em` esvaziaria justamente os avisos
   * que a pessoa não viu na hora.
   */
  it('aviso de aula JÁ TERMINADA continua na caixa', async () => {
    const ontem = new Date(Date.now() - 24 * 60 * 60 * 1000);
    await semear({
      usuarioId: C.ALUNO1_USUARIO,
      corpo: 'Sua aula de ontem foi cancelada',
      expiraEm: ontem,
      estado: 'expirada',
      criadaEm: ontem,
    });

    const caixa = await caixaDe(aluno1);
    expect(caixa.total).toBe(1);
    expect(caixa.data[0].corpo).toBe('Sua aula de ontem foi cancelada');
  });
});

describe('FIT-050 (d) — AC-002: todos os estados aparecem', () => {
  const ESTADOS = [
    'pendente',
    'aceita_pelo_servico',
    'sem_destino',
    'falha_definitiva',
    'falha_operacional',
    'expirada',
  ];

  it('inclusive sem_destino e falha_definitiva', async () => {
    for (const estado of ESTADOS) {
      await semear({
        usuarioId: C.ALUNO1_USUARIO,
        corpo: `estado ${estado}`,
        estado,
      });
    }

    const caixa = await caixaDe(aluno1);
    expect(caixa.total).toBe(ESTADOS.length);
    expect(caixa.data.map((a) => a.corpo).sort()).toEqual(
      ESTADOS.map((e) => `estado ${e}`).sort(),
    );
  });
});

describe('FIT-050 (e) — AC-014: o aviso de teste fica de fora', () => {
  /**
   * **Os dois lados no MESMO caso.** Provar só que o teste não aparece
   * passaria com a caixa vazia — e uma caixa vazia é o defeito, não a prova.
   */
  it('o de gesto entra, o de teste não — e nem conta em naoLidos', async () => {
    await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'recado do clube' });
    await semear({
      usuarioId: C.ALUNO1_USUARIO,
      corpo: 'Tudo certo — os avisos do clube chegam neste aparelho.',
      tipo: 'teste',
    });

    const caixa = await caixaDe(aluno1);
    expect(caixa.total).toBe(1);
    expect(caixa.data[0].corpo).toBe('recado do clube');
    expect(caixa.naoLidos).toBe(1);

    const res = await request(app.getHttpServer())
      .get('/api/v1/me/avisos/nao-lidos')
      .set(comToken(aluno1));
    expect(res.status).toBe(200);
    expect((res.body as CorpoDeContagem).naoLidos).toBe(1);

    // E a linha do teste CONTINUA no banco: a caixa a esconde, não a apaga.
    const noBanco = await db.notificacao.count({
      where: { companyId: C.EMPRESA, tipo: 'teste' },
    });
    expect(noBanco).toBe(1);
  });
});

describe('FIT-050 (f) — marcar como lido', () => {
  const marcar = async (s: Sessao) => {
    const res = await request(app.getHttpServer())
      .post('/api/v1/me/avisos/lidas')
      .set(comToken(s));
    expect(res.status).toBe(200);
    return (res.body as CorpoDeMarcacao).marcadas;
  };

  it('AC-006: zera naoLidos, e a segunda chamada devolve 0', async () => {
    await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'a' });
    await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'b' });

    expect(await marcar(aluno1)).toBe(2);
    expect((await caixaDe(aluno1)).naoLidos).toBe(0);

    // Idempotente por construção: `WHERE lida_em IS NULL`.
    expect(await marcar(aluno1)).toBe(0);
  });

  it('AC-006: a segunda chamada NÃO reescreve o lida_em já gravado', async () => {
    const id = await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'a' });
    await marcar(aluno1);
    const primeiro = await db.notificacao.findUniqueOrThrow({ where: { id } });

    await new Promise((r) => setTimeout(r, 30));
    await marcar(aluno1);
    const segundo = await db.notificacao.findUniqueOrThrow({ where: { id } });

    expect(segundo.lidaEm?.getTime()).toBe(primeiro.lidaEm?.getTime());
  });

  it('AC-007: não apaga, não reordena e não tira da lista', async () => {
    const base = new Date('2026-09-01T12:00:00Z');
    for (const [i, corpo] of ['velho', 'medio', 'novo'].entries()) {
      await semear({
        usuarioId: C.ALUNO1_USUARIO,
        corpo,
        criadaEm: new Date(base.getTime() + i * 60_000),
      });
    }

    const antes = await caixaDe(aluno1);
    expect(antes.data.map((a) => a.corpo)).toEqual(['novo', 'medio', 'velho']);

    await marcar(aluno1);

    const depois = await caixaDe(aluno1);
    expect(depois.total).toBe(3);
    expect(depois.data.map((a) => a.corpo)).toEqual(['novo', 'medio', 'velho']);
    expect(depois.data.every((a) => a.lidaEm !== null)).toBe(true);
  });

  it('marcar do aluno 1 não mexe na caixa do aluno 2', async () => {
    await semear({ usuarioId: C.ALUNO1_USUARIO, corpo: 'do 1' });
    await semear({ usuarioId: C.ALUNO2_USUARIO, corpo: 'do 2' });

    await marcar(aluno1);

    expect((await caixaDe(aluno2)).naoLidos).toBe(1);
  });
});

describe('FIT-050 (g) — a paginação com avisos do MESMO instante', () => {
  /**
   * **O caso normal, e não o excepcional.** Um gesto da SPEC-063 grava todas
   * as linhas num `INSERT` só — então `criada_em` é idêntico entre elas.
   *
   * Sem o desempate por `id`, a ordem entre páginas fica indefinida: a mesma
   * linha pode aparecer duas vezes, e outra pode sumir. O defeito só aparece
   * quando alguém rola a segunda página.
   */
  it('AC-001: seis avisos do mesmo instante, em três páginas, sem repetir nem pular', async () => {
    const mesmoInstante = new Date('2026-09-15T18:00:00Z');
    for (let i = 0; i < 6; i++) {
      await semear({
        usuarioId: C.ALUNO1_USUARIO,
        corpo: `aviso ${i}`,
        criadaEm: mesmoInstante,
      });
    }

    const vistos: string[] = [];
    for (const pagina of [1, 2, 3]) {
      const caixa = await caixaDe(aluno1, `?page=${pagina}&pageSize=2`);
      expect(caixa.total).toBe(6);
      expect(caixa.page).toBe(pagina);
      expect(caixa.pageSize).toBe(2);
      vistos.push(...caixa.data.map((a) => a.id));
    }

    expect(vistos).toHaveLength(6);
    expect(new Set(vistos).size).toBe(6);
  });

  /**
   * **Aqui havia uma asserção de PLANO, e ela foi retirada por ser instável.**
   *
   * A história vale mais que o teste: sabotei o `orderBy` tirando o
   * `, id DESC`, a FIT ficou verde, e fui medir por quê. O `EXPLAIN` da
   * consulta real mostrou algo que eu não esperava — **o desempate que eu
   * acrescentei por correção estava destruindo o índice**:
   *
   * ```
   *   linhas | índice de 3 colunas | de 4 colunas (com id)
   *      200 |  Sort               |  Sort
   *     1000 |  Sort               |  Index Scan
   *     5000 |  Sort               |  Index Scan
   * ```
   *
   * A correção foi pôr o `id` na definição do índice (TASK-000), e não tirar o
   * desempate. Com ele lá, a garantia fica de graça.
   *
   * **Por que o teste saiu:** o plano depende da estatística da tabela
   * INTEIRA, que outros arquivos de teste enchem e esvaziam. A mesma asserção
   * passava e falhava conforme a ordem de execução — e teste instável é pior
   * que teste nenhum, porque ensina a ignorar vermelho.
   *
   * A medição está no comentário da migration, que é onde alguém olha antes de
   * mexer no índice. **Nem toda decisão medida cabe num teste; algumas cabem
   * num registro que sobrevive.**
   */
  it('pageSize acima do teto é recusado com 400', async () => {
    const res = await request(app.getHttpServer())
      .get('/api/v1/me/avisos?pageSize=500')
      .set(comToken(aluno1));
    expect(res.status).toBe(400);
  });
});
