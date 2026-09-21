import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { buildUsuarioAtivo, loginAndGetTokens } from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/** O corpo que a AC-001 exige, tipado — `res.body` é `any`, e o lint recusa
 *  navegar em `any`. Tipar aqui também faz o teste falhar na COMPILAÇÃO se o
 *  contrato mudar de forma, e não só na asserção. */
type Pagina = {
  data: { ocupacaoId: string }[];
  page: number;
  pageSize: number;
  total: number;
};

/** O pedido que chegou ao Prisma. É o que as INV-066a/b observam. */
type PedidoAoPrisma = { take?: number; skip?: number; orderBy?: unknown };

/**
 * **SPEC-066/TASK-001 — `GET /me/classes/proximas`.**
 *
 * ## O que este arquivo prova, e o que ele NÃO prova
 *
 * Prova a **AC-001** (a rota existe e devolve `{data, page, pageSize, total}`),
 * a **AC-002** (o teto recusa com `400`) e os dois mecanismos que as
 * invariantes nomeiam: que o corte é `take`/`skip` **no banco** (INV-066a) e
 * que a ordem leva o `id` como desempate (INV-066b).
 *
 * **Não** prova a AC-004 — que percorrer todas as páginas devolve cada
 * `ocupacaoId` uma vez, com duas aulas na mesma data e hora. Isso exige banco
 * de verdade e é da TASK-005. Aqui o Prisma é dublê: ele confirma **o pedido
 * que foi feito**, não o resultado que o Postgres devolveria.
 *
 * ## A AC-001 é o mecanismo da INV-066g
 *
 * `proximas` é rota literal e está declarada acima do `@Get(':id')`. Se
 * alguém a mover para baixo, o Express casa o `:id` primeiro, o pipe de UUID
 * recebe a palavra `"proximas"` e responde `400` — **e o primeiro caso deste
 * arquivo fica vermelho**. Foi exatamente assim que o DEF-039 matou a tela de
 * aulas anteriores, em silêncio, porque lá não havia teste da rota.
 */
const ROTA = '/api/v1/me/classes/proximas';

describe('SPEC-066/TASK-001 — a página das próximas aulas', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function comoAluno() {
    const aluno = await buildUsuarioAtivo({
      id: 'u-aluno',
      email: 'aluno@empresa.demo',
      role: 'aluno',
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, aluno);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    prisma.aluno.findFirst.mockResolvedValue({ id: 'a-1' });
    prisma.turmaAluno.findMany.mockResolvedValue([{ turmaId: 't-1' }]);
    // O service usa a forma em ARRAY do `$transaction` — a contagem e a
    // página saem da mesma leitura. O dublê padrão só entende a forma de
    // callback, então aqui ele aprende as duas.
    prisma.$transaction.mockImplementation((arg: unknown) =>
      Array.isArray(arg)
        ? Promise.all(arg)
        : (arg as (tx: unknown) => unknown)(prisma),
    );
    return accessToken;
  }

  /** O primeiro pedido que chegou ao `findMany`. Num so lugar porque
   *  `mock.calls` e `any` e navegar nele espalha `as` pelo arquivo. */
  function pedidoAoPrisma(): PedidoAoPrisma {
    const chamadas = prisma.ocupacaoQuadra.findMany.mock
      .calls as unknown as PedidoAoPrisma[][];
    return chamadas[0][0];
  }

  function aula(id: string, data = '2026-10-01') {
    return {
      id,
      origemTurmaId: 't-1',
      quadraId: 'q-1',
      data: new Date(`${data}T00:00:00.000Z`),
      horaInicio: new Date('1970-01-01T18:00:00.000Z'),
      horaFim: new Date('1970-01-01T19:00:00.000Z'),
      origemTurma: { nome: 'Turma A' },
      quadra: { nome: 'Quadra 1' },
      chamadas: [],
      faltas: [],
    };
  }

  it('AC-001 — sem `page`, devolve a primeira página de 10 e o total', async () => {
    const token = await comoAluno();
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([
      aula('o-1'),
      aula('o-2'),
    ]);
    prisma.ocupacaoQuadra.count.mockResolvedValue(43);

    const res = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`);

    // **O 400 aqui significaria que o `:id` engoliu a rota** — ver a nota do
    // arquivo. É a INV-066g falseada.
    expect(res.status).toBe(200);
    const corpo = res.body as Pagina;
    expect(corpo).toMatchObject({ page: 1, pageSize: 10, total: 43 });
    expect(corpo.data).toHaveLength(2);
    expect(corpo.data[0].ocupacaoId).toBe('o-1');
  });

  it('INV-066a — o corte é `take`/`skip` no banco, derivado do `pageSize`', async () => {
    const token = await comoAluno();
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([]);
    prisma.ocupacaoQuadra.count.mockResolvedValue(0);

    await request(app.getHttpServer())
      .get(`${ROTA}?page=3&pageSize=10`)
      .set('Authorization', `Bearer ${token}`);

    const pedido = pedidoAoPrisma();
    expect(pedido.take).toBe(10);
    expect(pedido.skip).toBe(20);
  });

  it('INV-066b — a ordem é total: `data`, `horaInicio` e o `id` de desempate', async () => {
    const token = await comoAluno();
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([]);
    prisma.ocupacaoQuadra.count.mockResolvedValue(0);

    await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${token}`);

    const pedido = pedidoAoPrisma();
    // Sem o terceiro campo, duas aulas na mesma data e hora ficam em ordem
    // indefinida e o `OFFSET` repete e pula linhas — a 1ª rodada da validação
    // mediu as páginas 1 e 2 devolvendo as mesmas dez.
    expect(pedido.orderBy).toEqual([
      { data: 'asc' },
      { horaInicio: 'asc' },
      { id: 'asc' },
    ]);
  });

  it('AC-002 — `pageSize=100000` é recusado com 400', async () => {
    const token = await comoAluno();

    const res = await request(app.getHttpServer())
      .get(`${ROTA}?pageSize=100000`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
    // A recusa é ANTES do banco: é isso que torna a INV-066c mecânica.
    expect(prisma.ocupacaoQuadra.findMany).not.toHaveBeenCalled();
  });

  it('AC-002 — `pageSize=50` é o maior aceito', async () => {
    const token = await comoAluno();
    prisma.ocupacaoQuadra.findMany.mockResolvedValue([]);
    prisma.ocupacaoQuadra.count.mockResolvedValue(0);

    const res = await request(app.getHttpServer())
      .get(`${ROTA}?pageSize=50`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(200);
    const pedido = pedidoAoPrisma();
    expect(pedido.take).toBe(50);
  });

  it('`page=0` é recusado — não existe página zero', async () => {
    const token = await comoAluno();

    const res = await request(app.getHttpServer())
      .get(`${ROTA}?page=0`)
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(400);
  });
});
