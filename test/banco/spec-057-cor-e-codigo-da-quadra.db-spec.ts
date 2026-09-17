/**
 * SPEC-057/TASK-005/D19 — **cor de paleta e código único da quadra.**
 *
 * ## O que este arquivo prova, e por que é banco e não unitário
 *
 * A cor e o código têm DUAS camadas, e cada uma recusa um tipo de erro:
 *
 * - **a API** (`CourtsService`) recusa a entrada humana com
 *   `400 COR_QUADRA_INVALIDA` — formato, fora da paleta, contraste, `null`;
 * - **o banco** recusa o que passar por fora da API: `NOT NULL` (`23502`),
 *   `CHECK` da paleta e do código positivo (`23514`), `UNIQUE` (`23505`) e a
 *   identity `ALWAYS`, que não aceita código escrito (`428C9`).
 *
 * Só banco real diz qual SQLSTATE sai de cada uma — a matriz de falha da spec
 * promete estes cinco, e o veredito v3 reprovou justamente a versão que os
 * dava de memória (V3-R02).
 *
 * ## O que ele NÃO prova
 *
 * O preenchimento das quadras ANTIGAS pela migration: aqui o banco já nasce
 * migrado. Essa prova é o ensaio da migration sobre dados anteriores a ela,
 * registrado no `CLI_AUDIT.md` da SPEC-057.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '05750000-0000-4000-8000-000000000001';
const QUADRA_A = '05750000-0000-4000-8000-00000000000a';
const QUADRA_B = '05750000-0000-4000-8000-00000000000b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function courts(): CourtsService {
  const p = db as unknown as PrismaService;
  return new CourtsService(
    p,
    {} as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {
      resolver: () => ({ imagemUrl: null }),
    } as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(p),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}

let esporteId = '';

/** Uma quadra pelo INSERT de antes desta task: sem `cor`, sem `codigo_agenda`. */
async function quadraAntiga(id: string, nome: string): Promise<void> {
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${id}','${EMPRESA}','${nome}','${esporteId}',80,'ativa')`,
  );
}

async function sqlstate(sql: string): Promise<string> {
  try {
    await q(sql);
  } catch (erro) {
    return sqlstateDoErro(erro) ?? `sem SQLSTATE: ${String(erro)}`;
  }
  throw new Error(`esperava recusa do banco, e passou: ${sql}`);
}

/** Falha se o pedido PASSAR — `promessa.catch(...)` fica verde no silêncio. */
async function recusa(promessa: Promise<unknown>): Promise<{
  status: number;
  corpo: Record<string, unknown>;
}> {
  try {
    await promessa;
  } catch (erro) {
    const e = erro as { status?: number; response?: Record<string, unknown> };
    return { status: e.status ?? 0, corpo: e.response ?? {} };
  }
  throw new Error('o pedido PASSOU, e deveria ter sido recusado');
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-057 cor','spec-057-cor-${EMPRESA}',now())`,
  );
  esporteId = (
    await db.esporteDeQuadra.create({
      data: { companyId: EMPRESA, nome: 'Tenis', ordem: 0 },
      select: { id: true },
    })
  ).id;
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-057/D19 — banco (AC-031/AC-032)', () => {
  it('AC-031: INSERT antigo, sem cor nem código, recebe o default e um código positivo', async () => {
    await quadraAntiga(QUADRA_A, 'Central');

    const [linha] = await db.$queryRawUnsafe<
      { cor: string; codigo_agenda: number }[]
    >(`SELECT cor, codigo_agenda FROM quadras WHERE id = '${QUADRA_A}'`);

    expect(linha.cor).toBe('#00763A');
    expect(linha.codigo_agenda).toBeGreaterThan(0);
  });

  it('AC-031: duas quadras HOMÔNIMAS, com a mesma cor, têm códigos diferentes', async () => {
    await quadraAntiga(QUADRA_A, 'Quadra 1');
    await quadraAntiga(QUADRA_B, 'Quadra 1');

    const linhas = await db.quadra.findMany({
      where: { companyId: EMPRESA },
      select: { nome: true, cor: true, codigoAgenda: true },
    });

    expect(linhas.map((l) => l.nome)).toEqual(['Quadra 1', 'Quadra 1']);
    expect(new Set(linhas.map((l) => l.cor)).size).toBe(1);
    expect(new Set(linhas.map((l) => l.codigoAgenda)).size).toBe(2);
  });

  it('AC-032: cor nula → 23502', async () => {
    await quadraAntiga(QUADRA_A, 'Central');
    expect(
      await sqlstate(`UPDATE quadras SET cor = NULL WHERE id = '${QUADRA_A}'`),
    ).toBe('23502');
  });

  it('AC-032: cor fora da paleta, e a mesma cor em minúsculas → 23514', async () => {
    await quadraAntiga(QUADRA_A, 'Central');
    expect(
      await sqlstate(
        `UPDATE quadras SET cor = '#FF0000' WHERE id = '${QUADRA_A}'`,
      ),
    ).toBe('23514');
    // A forma canônica é maiúscula; o CHECK não normaliza, quem normaliza é a API.
    expect(
      await sqlstate(
        `UPDATE quadras SET cor = '#00763a' WHERE id = '${QUADRA_A}'`,
      ),
    ).toBe('23514');
  });

  it('D19: código escrito num INSERT comum → 428C9 (identity ALWAYS)', async () => {
    expect(
      await sqlstate(
        `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status,codigo_agenda) VALUES ('${QUADRA_A}','${EMPRESA}','X','${esporteId}',80,'ativa',999999)`,
      ),
    ).toBe('428C9');
  });

  it('D19: código repetido, mesmo forçado com OVERRIDING SYSTEM VALUE → 23505', async () => {
    await quadraAntiga(QUADRA_A, 'Central');
    const { codigoAgenda } = await db.quadra.findUniqueOrThrow({
      where: { id: QUADRA_A },
      select: { codigoAgenda: true },
    });
    expect(
      await sqlstate(
        `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status,codigo_agenda) OVERRIDING SYSTEM VALUE VALUES ('${QUADRA_B}','${EMPRESA}','Y','${esporteId}',80,'ativa',${codigoAgenda})`,
      ),
    ).toBe('23505');
  });

  it('D19: código zero ou negativo, forçado → 23514', async () => {
    expect(
      await sqlstate(
        `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status,codigo_agenda) OVERRIDING SYSTEM VALUE VALUES ('${QUADRA_B}','${EMPRESA}','Y','${esporteId}',80,'ativa',0)`,
      ),
    ).toBe('23514');
  });
});

describe('SPEC-057/D19 — API da quadra (AC-031/AC-032)', () => {
  it('create sem cor usa o default do banco, e o código sai como string decimal', async () => {
    const criada = await courts().create(EMPRESA, {
      nome: 'Nova',
      esporteId,
      precoHora: 90,
    });

    expect(criada.cor).toBe('#00763A');
    expect(criada.codigoAgenda).toMatch(/^[1-9]\d*$/);
  });

  it('create com cor válida em minúsculas grava a forma canônica maiúscula', async () => {
    const criada = await courts().create(EMPRESA, {
      nome: 'Nova',
      esporteId,
      precoHora: 90,
      cor: '#a12b65',
    });

    expect(criada.cor).toBe('#A12B65');
  });

  it('update sem cor PRESERVA a cor; update com cor troca', async () => {
    const criada = await courts().create(EMPRESA, {
      nome: 'Nova',
      esporteId,
      precoHora: 90,
      cor: '#31658C',
    });

    const soNome = await courts().update(EMPRESA, criada.id, {
      nome: 'Renomeada',
    });
    expect(soNome.cor).toBe('#31658C');
    expect(soNome.codigoAgenda).toBe(criada.codigoAgenda);

    const trocada = await courts().update(EMPRESA, criada.id, {
      cor: '#8B5E00',
    });
    expect(trocada.cor).toBe('#8B5E00');
  });

  it.each([
    ['null', null],
    ['formato sem #', '00763A'],
    ['formato curto', '#0763A'],
    ['alpha', '#00763AFF'],
    ['fora da paleta', '#FF0000'],
    ['não é texto', 123],
  ])(
    'AC-032: %s → 400 COR_QUADRA_INVALIDA, e nada gravado',
    async (_caso, cor) => {
      const criada = await courts().create(EMPRESA, {
        nome: 'Nova',
        esporteId,
        precoHora: 90,
      });

      const r = await recusa(
        courts().update(EMPRESA, criada.id, { cor } as never),
      );
      expect(r.status).toBe(400);
      expect(r.corpo.code).toBe('COR_QUADRA_INVALIDA');

      const r2 = await recusa(
        courts().create(EMPRESA, {
          nome: 'Outra',
          esporteId,
          precoHora: 90,
          cor,
        } as never),
      );
      expect(r2.status).toBe(400);
      expect(r2.corpo.code).toBe('COR_QUADRA_INVALIDA');

      const linhas = await db.quadra.findMany({
        where: { companyId: EMPRESA },
        select: { cor: true },
      });
      expect(linhas).toEqual([{ cor: '#00763A' }]);
    },
  );

  it('a leitura da lista também carrega cor e código', async () => {
    await quadraAntiga(QUADRA_A, 'Central');

    const pagina = await courts().list(EMPRESA);

    expect(pagina.data[0]).toMatchObject({ nome: 'Central', cor: '#00763A' });
    expect(pagina.data[0].codigoAgenda).toMatch(/^[1-9]\d*$/);
  });
});
