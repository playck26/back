/**
 * SPEC-069/AC-016 — **a compensatória é EXECUTADA, não lida.**
 *
 * ## Por que esta prova existe com esta forma
 *
 * A v5 da spec conferia FORMA: o arquivo existe, contém
 * `DROP TRIGGER acao_exige_alvo`, nada além, fora de `prisma/migrations`. A 5ª
 * rodada de validação mostrou a sabotagem que passa em tudo isso e falha no
 * incidente:
 *
 * ```sql
 * DROP TRIGGER acao_exige_alvo ON tabela_errada;
 * ```
 *
 * Arquivo existe, o comando está lá, nada além, fora do diretório. **E no
 * incidente ele estoura.** *"É válida" não se confere lendo.*
 *
 * ## Os quatro passos, e o que cada um mata
 *
 * | | |
 * |---|---|
 * | 1 | o artefato está em `prisma/rollback/`, e **nenhum** diretório sob `prisma/migrations/` o contém — migration pendente é aplicada |
 * | 2 | executado num banco migrado até o Deploy 2, ele **aplica com sucesso** — é aqui que o `ON tabela_errada` morre |
 * | 3 | depois dele, `pg_trigger` não tem mais o `acao_exige_alvo`, **e uma ação nua volta a commitar** — o mecanismo saiu de verdade |
 * | 4 | **promovido** a migration (cópia byte a byte), o `migrate deploy` o aplica e o `_prisma_migrations` fica consistente |
 *
 * O passo 4 roda contra um **segundo banco**, limpo e migrado até o Deploy 2:
 * no primeiro o trigger já foi derrubado à mão, e aplicar o `DROP` de novo
 * falharia por um motivo que não é o que se quer medir.
 *
 * E ele usa uma árvore de migrations **temporária**, fora do repositório: criar
 * diretório em `prisma/migrations` para testar seria deixar, por acidente de
 * script interrompido, exatamente a migration pendente que o passo 1 proíbe.
 *
 * uso: URL_A=postgresql://... URL_B=postgresql://... node test/prova-ac016-rollback.cjs
 *      (os dois bancos migrados até o Deploy 2)
 */
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PrismaClient } = require('@prisma/client');

const RAIZ = path.resolve(__dirname, '..');
const ARTEFATO = path.join(RAIZ, 'prisma', 'rollback', '069-remove-acao-exige-alvo.sql');
const MIGRATIONS = path.join(RAIZ, 'prisma', 'migrations');

const URL_A = process.env.URL_A;
const URL_B = process.env.URL_B;
if (!URL_A || !URL_B) {
  console.error('uso: URL_A=... URL_B=... node test/prova-ac016-rollback.cjs');
  process.exit(2);
}

const cliente = (url) => new PrismaClient({ datasources: { db: { url } } });
const falhas = [];
const ok = (cond, texto) => {
  console.log((cond ? 'OK    ' : 'FALHA ') + texto);
  if (!cond) falhas.push(texto);
};

async function temTrigger(db) {
  const [{ n }] = await db.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'acao_exige_alvo'`,
  );
  return n === 1;
}

/** Uma ação NUA, numa transação. Devolve `true` se commitou. */
async function acaoNuaCommita(db) {
  const E = 'a0690000-0000-4000-8000-00000000f001';
  const U = 'a0690000-0000-4000-8000-00000000f002';
  await db.$executeRawUnsafe(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${E}','AC-016','ac-016-rollback',now()) ON CONFLICT DO NOTHING`,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${U}','ac016@x.test','x','Admin','company_admin','${E}',now()) ON CONFLICT DO NOTHING`,
  );
  try {
    await db.$transaction((tx) =>
      tx.$executeRawUnsafe(
        `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
         VALUES (gen_random_uuid(),'${E}','reserva_criada','${U}')`,
      ),
    );
    return true;
  } catch {
    return false;
  }
}

/**
 * O CLI do Prisma chamado **pelo Node, sem shell**.
 *
 * `execFileSync('pnpm.cmd', ...)` falha com `EINVAL` no Windows: desde o
 * conserto de seguranca do Node (CVE-2024-27980), `.cmd` e `.bat` so sobem com
 * `shell: true` — e afrouxar isso para rodar um comando e a mesma tentacao que
 * o `CLAUDE.md` ja registra sobre a `ExecutionPolicy` do PowerShell. Resolver o
 * binario e executa-lo com `process.execPath` nao precisa de shell nenhum.
 */
function prisma(args, url) {
  const pkg = require.resolve('prisma/package.json');
  const manifesto = JSON.parse(fs.readFileSync(pkg, 'utf8'));
  const bin = path.join(
    path.dirname(pkg),
    typeof manifesto.bin === 'string' ? manifesto.bin : manifesto.bin.prisma,
  );
  return execFileSync(process.execPath, [bin, ...args], {
    cwd: RAIZ,
    env: { ...process.env, DATABASE_URL: url },
    encoding: 'utf8',
  });
}

async function main() {
  // ---- PASSO 1 — onde ele mora, e onde ele NÃO mora --------------------
  ok(fs.existsSync(ARTEFATO), 'passo 1: o artefato existe em prisma/rollback/');
  const bytes = fs.readFileSync(ARTEFATO);
  ok(bytes.length > 0, `passo 1: o artefato tem conteudo (${bytes.length} bytes)`);

  const dentroDeMigrations = fs
    .readdirSync(MIGRATIONS)
    .filter((d) => fs.statSync(path.join(MIGRATIONS, d)).isDirectory())
    .filter((d) => {
      const f = path.join(MIGRATIONS, d, 'migration.sql');
      return fs.existsSync(f) && /DROP\s+TRIGGER\s+"?acao_exige_alvo"?/i.test(fs.readFileSync(f, 'utf8'));
    });
  ok(
    dentroDeMigrations.length === 0,
    `passo 1: nenhuma migration derruba o trigger (achadas: ${dentroDeMigrations.join(', ') || 'nenhuma'})`,
  );

  // ---- PASSO 2 — ele APLICA ------------------------------------------
  const a = cliente(URL_A);
  ok(await temTrigger(a), 'passo 2: o banco A comeca COM o trigger (pre-condicao)');
  let aplicou = true;
  let erroDaAplicacao = '';
  try {
    prisma(['db', 'execute', '--url', URL_A, '--file', ARTEFATO], URL_A);
  } catch (e) {
    aplicou = false;
    erroDaAplicacao = String(e.stderr || e.message).replace(/\s+/g, ' ').slice(0, 200);
  }
  ok(aplicou, `passo 2: o artefato aplica com sucesso ${erroDaAplicacao && '-> ' + erroDaAplicacao}`);

  // ---- PASSO 3 — o mecanismo saiu de VERDADE ---------------------------
  ok(!(await temTrigger(a)), 'passo 3: pg_trigger nao tem mais o acao_exige_alvo');
  ok(await acaoNuaCommita(a), 'passo 3: uma acao NUA volta a commitar');
  await a.$disconnect();

  // ---- PASSO 4 — promovido, o migrate deploy o aplica ------------------
  const b = cliente(URL_B);
  ok(await temTrigger(b), 'passo 4: o banco B comeca COM o trigger (pre-condicao)');

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'ac016-'));
  const tempMig = path.join(temp, 'migrations');
  fs.cpSync(MIGRATIONS, tempMig, { recursive: true });
  const promovida = path.join(tempMig, '20260924000000_remove_acao_exige_alvo');
  fs.mkdirSync(promovida);
  fs.copyFileSync(ARTEFATO, path.join(promovida, 'migration.sql'));

  const copiados = fs.readFileSync(path.join(promovida, 'migration.sql'));
  ok(
    Buffer.compare(bytes, copiados) === 0,
    'passo 4: a promocao e copia BYTE A BYTE, nao SQL reescrito',
  );

  fs.writeFileSync(
    path.join(temp, 'schema.prisma'),
    'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
  );

  let deployOk = true;
  let saida = '';
  try {
    saida = prisma(['migrate', 'deploy', '--schema', path.join(temp, 'schema.prisma')], URL_B);
  } catch (e) {
    deployOk = false;
    saida = String(e.stdout || '') + String(e.stderr || '');
  }
  ok(deployOk, 'passo 4: `migrate deploy` aplica a promovida');
  ok(
    /remove_acao_exige_alvo/.test(saida),
    'passo 4: a saida do deploy NOMEIA a migration promovida',
  );

  const [registro] = await b.$queryRawUnsafe(
    `SELECT migration_name, finished_at IS NOT NULL AS terminou, rolled_back_at IS NULL AS sem_rollback
       FROM _prisma_migrations WHERE migration_name = '20260924000000_remove_acao_exige_alvo'`,
  );
  ok(!!registro, 'passo 4: a migration esta no _prisma_migrations');
  ok(!!registro && registro.terminou && registro.sem_rollback, 'passo 4: o historico do Prisma esta consistente');
  ok(!(await temTrigger(b)), 'passo 4: e o trigger saiu tambem por esse caminho');

  const [{ n }] = await b.$queryRawUnsafe(
    `SELECT count(*)::int AS n FROM _prisma_migrations WHERE finished_at IS NULL OR rolled_back_at IS NOT NULL`,
  );
  ok(n === 0, `passo 4: nenhuma migration falha ou pendente no historico (${n})`);
  await b.$disconnect();

  fs.rmSync(temp, { recursive: true, force: true });
  ok(!fs.existsSync(temp), 'limpeza: a arvore temporaria de migrations saiu');
  ok(
    !fs.existsSync(path.join(MIGRATIONS, '20260924000000_remove_acao_exige_alvo')),
    'limpeza: NADA foi criado dentro de prisma/migrations do repositorio',
  );

  console.log(`\nVEREDITO (AC-016): ${falhas.length === 0 ? 'APROVADO' : 'REPROVADO'}`);
  process.exitCode = falhas.length === 0 ? 0 : 1;
}

main().catch((e) => {
  console.error('FALHOU:', e.message);
  process.exitCode = 1;
});
