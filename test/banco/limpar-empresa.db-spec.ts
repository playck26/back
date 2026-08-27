/**
 * DEF-009 (2026-08-24) — a guarda permanente contra o acidente.
 *
 * Em 2026-08-24 uma suíte de banco rodou contra o Neon de produção e apagou
 * os dados. Ela começava com `DELETE FROM <tabela>` sem `WHERE`, dez tabelas,
 * porque foi escrita supondo um Postgres descartável — e a suposição não
 * estava escrita nem imposta.
 *
 * Este arquivo existe para que a limpeza **não possa voltar a ser total**:
 * monta duas empresas com dado, limpa uma, e exige que a outra saia intacta.
 * Uma suíte que apaga a empresa do vizinho reprova aqui.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(60_000);

exigirBancoLocal();

const db = new PrismaClient();

const ALVO = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const VIZINHA = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

async function montarEmpresa(id: string, nome: string): Promise<void> {
  const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ($1::uuid,$2,$2,now())`,
    id,
    nome,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES (gen_random_uuid(),$1,'x','Gestor','company_admin',$2::uuid,now())`,
    `gestor@${nome}.local`,
    id,
  );
  // SPEC-020/TASK-004 — quadra sem esporte deixou de existir. A opcao vem
  // antes, e precisa ser da MESMA empresa (a FK e composta).
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),$1::uuid,'Tenis',0,now())`,
    id,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES (gen_random_uuid(),$1::uuid,'Quadra 1',
             (SELECT id FROM esportes_de_quadra WHERE company_id=$1::uuid AND nome='Tenis'),
             80)`,
    id,
  );
  await q(
    `INSERT INTO niveis (id,company_id,nome,ordem)
     VALUES (gen_random_uuid(),$1::uuid,'Iniciante',1)`,
    id,
  );
}

async function contar(id: string): Promise<number> {
  const r = await db.$queryRawUnsafe<{ total: bigint }[]>(
    `SELECT (SELECT count(*) FROM empresas WHERE id = $1::uuid)
          + (SELECT count(*) FROM usuarios WHERE company_id = $1::uuid)
          + (SELECT count(*) FROM quadras WHERE company_id = $1::uuid)
          + (SELECT count(*) FROM niveis WHERE company_id = $1::uuid) AS total`,
    id,
  );
  return Number(r[0].total);
}

describe('limparEmpresa', () => {
  beforeEach(async () => {
    for (const id of [ALVO, VIZINHA]) {
      await limparEmpresa(db, id);
    }
    await montarEmpresa(ALVO, 'alvo');
    await montarEmpresa(VIZINHA, 'vizinha');
  });

  afterAll(async () => {
    for (const id of [ALVO, VIZINHA]) {
      await limparEmpresa(db, id);
    }
    await db.$disconnect();
  });

  it('apaga a empresa pedida por inteiro', async () => {
    expect(await contar(ALVO)).toBe(4);
    await limparEmpresa(db, ALVO);
    expect(await contar(ALVO)).toBe(0);
  });

  it('NÃO encosta na empresa vizinha — é o defeito que causou o incidente', async () => {
    await limparEmpresa(db, ALVO);
    expect(await contar(VIZINHA)).toBe(4);
  });

  it('limpar duas vezes não quebra', async () => {
    // A limpeza roda no `beforeAll` das suítes, e uma empresa que não existe
    // é o estado normal na primeira execução.
    await limparEmpresa(db, ALVO);
    await expect(limparEmpresa(db, ALVO)).resolves.toBeUndefined();
  });

  it('empresa que nunca existiu não causa erro', async () => {
    await expect(
      limparEmpresa(db, '99999999-9999-4999-8999-999999999999'),
    ).resolves.toBeUndefined();
  });
});
