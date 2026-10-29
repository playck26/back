/**
 * DEF-040 — **quem espera a importação na trava do clube**, contra o Postgres
 * de verdade.
 *
 * A importação segura a trava do clube COMPARTILHADA da instrução da trava
 * até o `COMMIT`, e o prazo dela passou de 2 s para 6,69 s
 * (`PRAZO_DA_IMPORTACAO_MS`). As edições de nível — o catálogo
 * (`LevelsService`), a turma e o aluno com `nivelId` — tomam a mesma trava
 * EXCLUSIVA, sem `lock_timeout`: esperam a importação inteira. Com o `timeout`
 * padrão do Prisma (5 s), a espera passava dele e a edição caía em `P2028`,
 * que nenhum desses serviços traduz — **500 ao gestor**, e o backend
 * continuava na fila da trava até a importação soltar (achado da revisão do
 * 512025f). Antes, a importação desistia em ~2 s e a espera cabia nos 5 s.
 *
 * O cenário é o pior que o prazo admite: a importação **gasta o prazo
 * inteiro** esperando uma turma que outra transação segura em `FOR UPDATE`, e
 * desiste com `409`. As quatro edições entram na fila da trava do clube
 * DEPOIS de a importação a tomar (vistas esperando em `pg_stat_activity`,
 * nunca por tempo), e o teste exige que a importação tenha segurado a trava
 * por mais que os 5 s do padrão — sem isso, ele não distinguiria nada.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  type Clube,
  type Resposta,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  limparClube,
  linhaEmForUpdate,
  montarClube,
  resposta,
  segurar,
  servicos,
  urlDoCaminho,
  vistoEsperando,
} from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { ImportacaoDeAlunosService } from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import { PRAZO_DA_IMPORTACAO_MS } from '../../src/people/importacao/prazo-da-importacao';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(120_000);
exigirBancoLocal();

const MODELOS = {
  remetente: 'convites@def040e.teste.local',
  responderPara: 'suporte@def040e.teste.local',
  urlCliente: 'https://cliente.def040e.teste.local',
  urlAdmin: 'https://admin.def040e.teste.local',
};

/** O `timeout` padrão de `$transaction` no Prisma 6. */
const TIMEOUT_PADRAO_DO_PRISMA_MS = 5_000;

const db = new PrismaClient();
let clube: Clube | null = null;

afterEach(async () => {
  await desconectarTodos();
  await limparClube(db, clube);
  clube = null;
});
afterAll(async () => {
  await db.$disconnect();
});

async function criarNivel(c: Clube, nome: string, ordem: number) {
  const id = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${id}','${c.id}','${nome}',${ordem})`,
  );
  return id;
}

describe('DEF-040 — a edição de nível atrás de uma importação que gasta o prazo inteiro', () => {
  it('as quatro edições (nível, apagar nível, turma e aluno com `nivelId`) terminam, e nenhuma cai no `timeout` da transação', async () => {
    clube = await montarClube(db);
    const c = clube;
    const turmaPresa = await criarTurma(db, c);
    const outraTurma = await criarTurma(db, c);
    const aluno = await criarAluno(db, c);
    const nivelParaRenomear = await criarNivel(c, 'Avançado', 2);
    const nivelParaApagar = await criarNivel(c, 'Sem uso', 3);
    const { nome } = await db.turma.findUniqueOrThrow({
      where: { id: turmaPresa },
      select: { nome: true },
    });
    const csv = [
      'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
      `Ana;def040e-${c.id.slice(0, 8)}@teste.local;;Intermediário;${nome};;`,
    ].join('\r\n');

    // As quatro edições, cada uma num cliente com nome próprio.
    const EDICOES = {
      'def040e-nivel': (s: ReturnType<typeof servicos>) =>
        s.niveis.update(c.id, nivelParaRenomear, { nome: 'Avançado II' }),
      'def040e-apagar': (s: ReturnType<typeof servicos>) =>
        s.niveis.remove(c.id, nivelParaApagar),
      'def040e-turma': (s: ReturnType<typeof servicos>) =>
        s.turmas.update(c.id, outraTurma, { nivelId: c.nivel }, c.gestores[0]),
      'def040e-aluno': (s: ReturnType<typeof servicos>) =>
        s.alunos.update(c.id, aluno.alunoId, { nivelId: c.nivel }),
    } as const;
    const apps = Object.keys(EDICOES) as (keyof typeof EDICOES)[];
    const servicosDe = Object.fromEntries(
      apps.map((app) => [app, servicos(cliente(urlDoCaminho(app)))]),
    ) as Record<keyof typeof EDICOES, ReturnType<typeof servicos>>;

    // Quem segura a turma da importação: ela vai gastar o prazo inteiro ali.
    const soltarTurma = await segurar(
      db,
      linhaEmForUpdate('turmas', turmaPresa),
    );

    const edicoes: Record<
      string,
      Promise<{ status: number; erro?: unknown }>
    > = {};
    const fimDasEdicoes: Record<string, number> = {};
    let travouEm = 0;
    const gestor = {
      sub: c.gestores[0],
      email: 'gestor@def040e.teste.local',
      nome: 'Gestora',
      role: 'company_admin',
      companyId: c.id,
    } as unknown as AccessTokenPayload;
    const memoria = new MemoriaProvedorDeEmail();
    const p = db as unknown as PrismaService;
    const controller = new ImportacaoController(
      new ImportacaoDeAlunosService(
        p,
        new AcessoService(p, memoria, MODELOS),
        memoria,
        MODELOS,
        {
          // A importação já tem a trava do clube: as edições entram na fila
          // dela agora, e o teste só segue quando VÊ as quatro esperando.
          aoTravar: async () => {
            travouEm = Date.now();
            for (const app of apps) {
              edicoes[app] = resposta(EDICOES[app](servicosDe[app])).then(
                (r) => {
                  fimDasEdicoes[app] = Date.now();
                  return r;
                },
              );
            }
            for (const app of apps) await vistoEsperando(db, app, 'advisory');
          },
        },
      ),
    );

    let importacao: Resposta;
    try {
      importacao = await resposta(
        controller.importar(
          gestor,
          undefined,
          { buffer: Buffer.from(csv, 'utf8') } as Express.Multer.File,
          undefined,
        ),
      );
    } finally {
      await soltarTurma();
    }
    const soltouEm = Date.now();
    const resultados = Object.fromEntries(
      await Promise.all(apps.map(async (app) => [app, await edicoes[app]])),
    ) as Record<string, { status: number; erro?: unknown }>;

    const segurou = soltouEm - travouEm;
    console.log(
      `DEF040_ESPERA importacao=${importacao.status} segurou_a_trava_ms=${segurou} ` +
        apps
          .map(
            (app) =>
              `${app}=${resultados[app].status}` +
              `${resultados[app].erro ? `(${(resultados[app].erro as { code?: string }).code ?? (resultados[app].erro as Error).name})` : ''}` +
              `@${fimDasEdicoes[app] - travouEm}ms`,
          )
          .join(' '),
    );

    // A importação desistiu da turma com o prazo dela inteiro gasto, e
    // segurou a trava do clube por mais que o `timeout` padrão do Prisma: é
    // isso que torna a prova capaz de distinguir.
    expect(importacao.status).toBe(409);
    expect(segurou).toBeGreaterThan(TIMEOUT_PADRAO_DO_PRISMA_MS);
    expect(segurou).toBeGreaterThanOrEqual(PRAZO_DA_IMPORTACAO_MS - 500);

    // As quatro edições terminaram — nenhuma em `P2028`.
    expect(
      Object.fromEntries(apps.map((app) => [app, resultados[app].status])),
    ).toEqual(Object.fromEntries(apps.map((app) => [app, 200])));
    expect(
      await db.nivel.findUniqueOrThrow({
        where: { id: nivelParaRenomear },
        select: { nome: true },
      }),
    ).toEqual({ nome: 'Avançado II' });
    expect(await db.nivel.count({ where: { id: nivelParaApagar } })).toBe(0);
  });
});
