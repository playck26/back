/**
 * SPEC-076/TASK-003 — **o rollback dos gatilhos é EXECUTADO, não lido**
 * (AC-034; 3ª rodada, R7).
 *
 * A compensatória (`prisma/rollback/076-presenca-sem-autor-humano.sql`) tira
 * os dois gatilhos da D10, e é ela que tem de rodar ANTES de o binário antigo
 * voltar: o binário antigo tem o `PUT` da chamada, e com os gatilhos no banco
 * cada gravação dele vira `23514`. A prova: o que ele gravava é recusado com
 * os gatilhos, e passa com a compensatória aplicada — dentro de uma transação
 * que desfaz, para o banco sair como entrou (DDL do Postgres é transacional).
 */
import { PrismaClient } from '@prisma/client';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import {
  EMPRESA,
  TURMA_A,
  UPROF,
  aluno,
  aula,
  matricular,
  montarEmpresa,
  reiniciarSequencias,
} from './presenca-automatica-fixture';

jest.setTimeout(120_000);
exigirBancoLocal();

const db = new PrismaClient();
const RAIZ = join(__dirname, '..', '..');
const ARQUIVO = join(
  RAIZ,
  'prisma',
  'rollback',
  '076-presenca-sem-autor-humano.sql',
);

function instrucoes(): string[] {
  return readFileSync(ARQUIVO, 'utf8')
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** O que o binário antigo gravava: o cabeçalho humano `completa` e a linha com autor. */
const gravacoesDoBinarioAntigo = (oc: string, alunoId: string) => [
  `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,updated_at,completude,esperados,origem,origem_inicial)
   VALUES ('${oc}','TURMA','${EMPRESA}','${UPROF}',now(),'completa',1,'professor','professor')`,
  `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at)
   VALUES (gen_random_uuid(),'${EMPRESA}','${oc}','TURMA','${alunoId}','presente','${UPROF}',now())`,
];

async function gatilhos(): Promise<string[]> {
  const r = await db.$queryRawUnsafe<{ tgname: string }[]>(
    `SELECT tgname FROM pg_trigger
      WHERE tgname IN ('presencas_sem_autor_humano','chamadas_completa_so_automatica')
      ORDER BY tgname`,
  );
  return r.map((x) => x.tgname);
}

class Desfazer extends Error {}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  reiniciarSequencias();
  await montarEmpresa();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('AC-034 — a compensatória dos gatilhos da D10', () => {
  it('(i) mora em prisma/rollback, e NENHUMA migration a contém', () => {
    const conteudo = readFileSync(ARQUIVO, 'utf8');
    const migrations = join(RAIZ, 'prisma', 'migrations');
    for (const dir of readdirSync(migrations, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const sql = readFileSync(
        join(migrations, dir.name, 'migration.sql'),
        'utf8',
      );
      expect(sql).not.toBe(conteudo);
      expect(sql).not.toContain('DROP TRIGGER "presencas_sem_autor_humano"');
    }
  });

  it('(ii) com os gatilhos, o que o binário antigo gravava é recusado com 23514', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    const [cab] = gravacoesDoBinarioAntigo(oc, a.alunoId);
    await expect(db.$executeRawUnsafe(cab)).rejects.toThrow(/23514/);
  });

  it('(iii) aplicada, os dois gravam — e a transação desfaz tudo, com os gatilhos de volta', async () => {
    const a = await aluno('Ana');
    await matricular(TURMA_A, a.alunoId);
    const oc = await aula(TURMA_A, -1);
    let gravadas = -1;

    await expect(
      db.$transaction(async (tx) => {
        for (const sql of instrucoes()) await tx.$executeRawUnsafe(sql);
        for (const sql of gravacoesDoBinarioAntigo(oc, a.alunoId)) {
          await tx.$executeRawUnsafe(sql);
        }
        const [n] = await tx.$queryRawUnsafe<{ n: bigint }[]>(
          `SELECT count(*) AS n FROM presencas WHERE ocupacao_id = $1::uuid`,
          oc,
        );
        gravadas = Number(n.n);
        throw new Desfazer();
      }),
    ).rejects.toBeInstanceOf(Desfazer);

    expect(gravadas).toBe(1);
    expect(await gatilhos()).toEqual([
      'chamadas_completa_so_automatica',
      'presencas_sem_autor_humano',
    ]);
  });
});
