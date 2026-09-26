/**
 * SPEC-075/TASK-003 — **empresa nova nasce com níveis, na transação dela**
 * (D7, AC-013, INV-075f), pelo `CompaniesService.create` de verdade.
 *
 * A transação é provada por **sonda** — o molde da `spec-038-importacao`: um
 * gatilho criado pelo próprio teste, **afirmado existente antes**, que levanta
 * exceção num ponto escolhido, e que sai no `finally`. Duas direções:
 *
 *   (a) **a falha NA semeadura** desfaz a empresa — ela nunca fica sem nível;
 *   (b) **a falha DEPOIS da semeadura** (no admin inicial) desfaz empresa e
 *       níveis — e a sonda confere a precondição: ela só levanta a falha
 *       "planejada" se os três níveis da empresa JÁ existirem quando o admin
 *       nasce. Criar o admin antes dos níveis faz chegar a outra mensagem, e o
 *       caso fica vermelho (2ª rodada, B-02) — sem isso, as duas ordens
 *       deixariam o mesmo banco vazio depois do rollback, e passariam as duas.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CompaniesService } from '../../src/companies/companies.service';
import type { CreateCompanyDto } from '../../src/companies/dto/create-company.dto';
import { LevelsService } from '../../src/people/levels.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

/** Uma empresa que já existia antes da SPEC-075, sem nível (decisão 8). */
const EMPRESA_VELHA = '07530000-0000-4000-8000-000000000001';
const PREFIXO = 'SPEC-075 empresa nova';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): CompaniesService {
  return new CompaniesService(
    p,
    // `create` não usa o AuthService (gera o hash com bcrypt direto).
    {} as ConstructorParameters<typeof CompaniesService>[1],
    {
      resolver: (e: { logoUrl: string | null }) => ({ logoUrl: e.logoUrl }),
    } as unknown as ConstructorParameters<typeof CompaniesService>[2],
    new LevelsService(p),
  );
}

let seq = 0;
function dto(): CreateCompanyDto {
  seq += 1;
  return {
    nome: `${PREFIXO} ${seq}`,
    esportes: ['Tênis'],
    adminInicial: {
      nome: 'Admin',
      email: `spec075.empresa${seq}@teste.local`,
      senha: 'senha-de-teste-075',
    },
  };
}

async function empresasCriadas(): Promise<{ id: string }[]> {
  return db.empresa.findMany({
    where: { nome: { startsWith: PREFIXO } },
    select: { id: true },
  });
}

async function limpar(): Promise<void> {
  for (const e of await empresasCriadas()) await limparEmpresa(db, e.id);
  await limparEmpresa(db, EMPRESA_VELHA);
}

async function gatilhoExiste(nome: string): Promise<boolean> {
  const r = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM pg_trigger WHERE tgname = '${nome}'`,
  );
  return Number(r[0].n) === 1;
}

async function mensagemDaFalha(promessa: Promise<unknown>): Promise<string> {
  try {
    await promessa;
    return 'NAO_FALHOU';
  } catch (erro) {
    const e = erro as { message?: string; meta?: unknown };
    return `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`;
  }
}

beforeEach(async () => {
  await limpar();
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA_VELHA}','SPEC-075 velha','spec-075-velha-${EMPRESA_VELHA}',now())`,
  );
});

afterAll(async () => {
  await limpar();
  await db.$disconnect();
});

describe('SPEC-075/TASK-003 — empresa nova nasce com níveis (AC-013)', () => {
  it('nascem Iniciante (1), Intermediário (2) e Avançado (3) DELA — e a empresa que já existia não ganha nada', async () => {
    const d = dto();
    const r = await servico().create(d);

    const niveis = await db.nivel.findMany({
      where: { companyId: r.empresa.id },
      orderBy: { ordem: 'asc' },
      select: { nome: true, ordem: true },
    });
    expect(niveis).toEqual([
      { nome: 'Iniciante', ordem: 1 },
      { nome: 'Intermediário', ordem: 2 },
      { nome: 'Avançado', ordem: 3 },
    ]);
    // decisão 8: a que já existia continua sem nível
    expect(await db.nivel.count({ where: { companyId: EMPRESA_VELHA } })).toBe(
      0,
    );
  });

  it('(a) a falha NA semeadura desfaz a empresa: nunca empresa sem nível', async () => {
    const d = dto();
    await q(
      `CREATE OR REPLACE FUNCTION sonda_075a() RETURNS trigger AS $BODY$ BEGIN RAISE EXCEPTION 'sonda-075a: a semeadura falhou' USING ERRCODE = '23514'; END $BODY$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER sonda_075a BEFORE INSERT ON niveis FOR EACH ROW EXECUTE FUNCTION sonda_075a()`,
    );
    try {
      expect(await gatilhoExiste('sonda_075a')).toBe(true);

      const msg = await mensagemDaFalha(servico().create(d));
      expect(msg).toContain('sonda-075a: a semeadura falhou');

      // Semear DEPOIS da transação deixaria a empresa comitada e sem nível.
      expect(await db.empresa.count({ where: { nome: d.nome } })).toBe(0);
      expect(
        await db.usuario.count({ where: { email: d.adminInicial.email } }),
      ).toBe(0);
    } finally {
      await q('DROP TRIGGER IF EXISTS sonda_075a ON niveis');
      await q('DROP FUNCTION IF EXISTS sonda_075a()');
    }
  });

  it('(b) a falha DEPOIS da semeadura desfaz empresa E níveis — e a sonda prova que os níveis vieram ANTES do admin', async () => {
    const d = dto();
    const niveisAntes = await db.nivel.count();
    await q(
      `CREATE OR REPLACE FUNCTION sonda_075b() RETURNS trigger AS $BODY$ BEGIN IF (SELECT count(*) FROM niveis WHERE company_id = NEW.company_id) <> 3 THEN RAISE EXCEPTION 'sonda-075b: admin antes dos niveis' USING ERRCODE = '23514'; END IF; RAISE EXCEPTION 'sonda-075b: falha planejada' USING ERRCODE = '23514'; END $BODY$ LANGUAGE plpgsql`,
    );
    await q(
      `CREATE TRIGGER sonda_075b BEFORE INSERT ON usuarios FOR EACH ROW WHEN (NEW.email = '${d.adminInicial.email}') EXECUTE FUNCTION sonda_075b()`,
    );
    try {
      expect(await gatilhoExiste('sonda_075b')).toBe(true);

      const msg = await mensagemDaFalha(servico().create(d));
      // A outra mensagem ("admin antes dos niveis") é a sabotagem da ordem.
      expect(msg).toContain('sonda-075b: falha planejada');

      expect(await db.empresa.count({ where: { nome: d.nome } })).toBe(0);
      expect(await db.nivel.count()).toBe(niveisAntes);
    } finally {
      await q('DROP TRIGGER IF EXISTS sonda_075b ON usuarios');
      await q('DROP FUNCTION IF EXISTS sonda_075b()');
    }
  });
});
