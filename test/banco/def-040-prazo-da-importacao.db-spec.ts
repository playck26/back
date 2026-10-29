/**
 * DEF-040 — **dois prazos, cada um no seu caminho**, contra o Postgres de
 * verdade.
 *
 * A importação ganhou prazo próprio (`PRAZO_DA_IMPORTACAO_MS`, 6,69 s; decisão
 * do Israel em 2026-10-28), e a matrícula continua com os 2 s
 * (`PRAZO_DA_MATRICULA_MS`). As duas gravam `playck.prazo` numa instrução que
 * toma a trava do clube; o que este arquivo prova é **qual número cada uma
 * grava**, por dois lados:
 *
 * 1. **o parâmetro da instrução**, pelo evento `query` de um cliente próprio:
 *    o número que o Back mandou ao `set_config('playck.prazo', …)` — exato;
 * 2. **o valor gravado na sessão**, lido nela mesma: `playck.prazo − now()`.
 *    O `now()` é o início da transação, e o prazo é contado do relógio da
 *    instrução da trava, um pouco depois — então o valor fica entre o prazo e
 *    o prazo + o que a transação levou até a trava (aqui, banco local, menos de
 *    1 s). A diferença entre 2 s e 6,69 s não cabe nessa folga.
 *
 * A matrícula vai pela rota de verdade (`allocateStudent`, o `POST
 * /classes/:id/students/:aluno`), e a importação pelo controller.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  type Clube,
  criarAluno,
  criarTurma,
  limparClube,
  montarClube,
  resposta,
  rotas,
} from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import { PRAZO_DA_MATRICULA_MS } from '../../src/common/lock/prazo-de-espera';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import {
  ImportacaoDeAlunosService,
  type GanchosDaImportacao,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import { PRAZO_DA_IMPORTACAO_MS } from '../../src/people/importacao/prazo-da-importacao';
import { travarNivelDaEmpresa } from '../../src/people/nivel-efetivo';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(120_000);
exigirBancoLocal();

const MODELOS = {
  remetente: 'convites@def040p.teste.local',
  responderPara: 'suporte@def040p.teste.local',
  urlCliente: 'https://cliente.def040p.teste.local',
  urlAdmin: 'https://admin.def040p.teste.local',
};

/** A folga do valor gravado: o que a transação leva até a trava, no local. */
const FOLGA_DA_SESSAO_MS = 1_000;

const db = new PrismaClient();
let clube: Clube | null = null;

afterEach(async () => {
  await limparClube(db, clube);
  clube = null;
});
afterAll(async () => {
  await db.$disconnect();
});

interface Ida {
  query: string;
  params: string;
}

/** Um cliente que registra cada instrução, com os parâmetros. */
async function comClienteQueRegistra<T>(
  corpo: (c: PrismaClient, idas: Ida[]) => Promise<T>,
): Promise<T> {
  const c = new PrismaClient({ log: [{ emit: 'event', level: 'query' }] });
  const idas: Ida[] = [];
  c.$on('query', (e) => idas.push({ query: e.query, params: e.params }));
  try {
    return await corpo(c, idas);
  } finally {
    await c.$disconnect();
  }
}

/**
 * Os parâmetros, como texto, das instruções que gravam `playck.prazo`. O
 * Prisma registra os parâmetros como um arranjo JSON; o número do prazo é um
 * deles.
 */
function prazosGravados(idas: readonly Ida[]): string[][] {
  return idas
    .filter((i) => i.query.includes("set_config('playck.prazo'"))
    .map((i) => (JSON.parse(i.params) as unknown[]).map((v) => String(v)));
}

/** `playck.prazo − now()` na sessão de quem chama, em ms. */
async function restoDesdeOInicio(
  tx: Pick<PrismaClient, '$queryRaw'>,
): Promise<number> {
  const [r] = await tx.$queryRaw<{ ms: number }[]>`
    SELECT (extract(epoch FROM (current_setting('playck.prazo')::timestamptz
                                - now())) * 1000)::float8 AS ms`;
  return r.ms;
}

describe('DEF-040 — a matrícula continua gravando 2 s em `playck.prazo`', () => {
  it('pela rota (`allocateStudent`): o parâmetro do prazo é o da matrícula, e não o da importação', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const aluno = await criarAluno(db, clube);

    await comClienteQueRegistra(async (c, idas) => {
      const r = await resposta(rotas(c).alocar(clube!, aluno, turma));
      expect(r.status).toBe(200);
      const gravados = prazosGravados(idas);
      console.log(`DEF040_PRAZO matricula params=${JSON.stringify(gravados)}`);
      expect(gravados).toHaveLength(1);
      expect(gravados[0]).toContain(String(PRAZO_DA_MATRICULA_MS));
      expect(gravados[0]).not.toContain(String(PRAZO_DA_IMPORTACAO_MS));
    });
    expect(
      await db.turmaAluno.count({
        where: { turmaId: turma, alunoId: aluno.alunoId },
      }),
    ).toBe(1);
  });

  it('o valor gravado na sessão pela trava do modo `leitura` (a da matrícula) é 2 s', async () => {
    clube = await montarClube(db);
    const aluno = await criarAluno(db, clube);
    const resto = await db.$transaction(async (tx) => {
      await travarNivelDaEmpresa(tx, clube!.id, 'leitura', aluno.alunoId);
      return restoDesdeOInicio(tx);
    });
    console.log(`DEF040_PRAZO matricula resto_desde_o_inicio_ms=${resto}`);
    expect(resto).toBeGreaterThanOrEqual(PRAZO_DA_MATRICULA_MS);
    expect(resto).toBeLessThan(PRAZO_DA_MATRICULA_MS + FOLGA_DA_SESSAO_MS);
  });
});

describe('DEF-040 — a importação grava o prazo dela em `playck.prazo`', () => {
  it(`pelo controller: o parâmetro é ${PRAZO_DA_IMPORTACAO_MS} ms, e a sessão da importação vê esse prazo`, async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const { nome } = await db.turma.findUniqueOrThrow({
      where: { id: turma },
      select: { nome: true },
    });
    const csv = [
      'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
      `Ana;def040p-${clube.id.slice(0, 8)}@teste.local;;Intermediário;${nome};;`,
    ].join('\r\n');

    let resto: number | null = null;
    const ganchos: GanchosDaImportacao = {
      aoTravar: async ({ tx }) => {
        resto = await restoDesdeOInicio(tx);
      },
    };
    const gestor = {
      sub: clube.gestores[0],
      email: 'gestor@def040p.teste.local',
      nome: 'Gestora',
      role: 'company_admin',
      companyId: clube.id,
    } as unknown as AccessTokenPayload;

    await comClienteQueRegistra(async (c, idas) => {
      const p = c as unknown as PrismaService;
      const memoria = new MemoriaProvedorDeEmail();
      const controller = new ImportacaoController(
        new ImportacaoDeAlunosService(
          p,
          new AcessoService(p, memoria, MODELOS),
          memoria,
          MODELOS,
          ganchos,
        ),
      );
      const r = await resposta(
        controller.importar(
          gestor,
          undefined,
          { buffer: Buffer.from(csv, 'utf8') } as Express.Multer.File,
          undefined,
        ),
      );
      expect(r.status).toBe(200);
      const gravados = prazosGravados(idas);
      console.log(
        `DEF040_PRAZO importacao params=${JSON.stringify(gravados)} resto_desde_o_inicio_ms=${resto}`,
      );
      expect(gravados).toHaveLength(1);
      expect(gravados[0]).toContain(String(PRAZO_DA_IMPORTACAO_MS));
      expect(gravados[0]).not.toContain(String(PRAZO_DA_MATRICULA_MS));
    });
    expect(resto).not.toBeNull();
    expect(resto!).toBeGreaterThanOrEqual(PRAZO_DA_IMPORTACAO_MS);
    expect(resto!).toBeLessThan(PRAZO_DA_IMPORTACAO_MS + FOLGA_DA_SESSAO_MS);
    expect(await db.turmaAluno.count({ where: { turmaId: turma } })).toBe(1);
  });
});
