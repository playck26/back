/**
 * SPEC-057/TASK-001 (card 5361) — **o que o BANCO garante na presença
 * automática**, sem nenhum serviço no meio.
 *
 * Três famílias, cada uma com o mecanismo que a spec declara:
 *
 * - **D1/INV-137 — proveniência do cabeçalho**: CHECKs de domínio e de autor;
 *   INSERT antigo continua válido pelos DEFAULTs.
 * - **D5/INV-143 — o instante do fechamento automático**: CHECK de presença e
 *   trigger de imutabilidade.
 * - **D3/INV-146 — autoridade da ativação**: GRANT/REVOKE, função
 *   `SECURITY DEFINER` de owner dedicado, trigger da flag. O runtime da
 *   aplicação só lê; o operador só muda a flag pela função; o owner sem DDL
 *   não muda a flag direto; o owner COM DDL contorna, e isso é bypass
 *   declarado (LIM-057o), demonstrado aqui.
 *
 * Os papéis são exercitados como o produto os usará: logins de teste que
 * HERDAM dos grupos da migration, via `SET LOCAL ROLE` numa transação. A
 * sessão do teste é superusuário — é o que torna o `SET ROLE` possível, e é
 * também por isso que nenhuma asserção aqui confia no superusuário para provar
 * recusa de privilégio.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import {
  LOGIN_OPERADOR_DE_TESTE,
  LOGIN_RUNTIME_DE_TESTE,
  garantirLoginsDeTeste,
  redefinirConfigDePresenca,
} from './config-de-presenca';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '05710000-0000-4000-8000-000000000001';
const QUADRA = '05710000-0000-4000-8000-000000000002';
const TURMA = '05710000-0000-4000-8000-00000000000a';
const PROFESSOR_USUARIO = '05710000-0000-4000-8000-00000000000b';
const ALUNO_USUARIO = '05710000-0000-4000-8000-00000000000c';
const ALUNO = '05710000-0000-4000-8000-00000000000d';

const db = new PrismaClient();
const outra = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

class Desfaz extends Error {}

/** Roda os comandos numa transação como `papel` e devolve o SQLSTATE do primeiro que falhar, ou `ok`. */
async function comoPapel(papel: string, ...sqls: string[]): Promise<string> {
  let resultado = 'ok';
  await db
    .$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(`SET LOCAL ROLE ${papel}`);
        for (const sql of sqls) {
          try {
            await tx.$queryRawUnsafe(sql);
          } catch (erro) {
            resultado = sqlstateDoErro(erro) ?? `sem SQLSTATE: ${String(erro)}`;
            throw new Desfaz();
          }
        }
        throw new Desfaz();
      },
      { timeout: 30_000 },
    )
    .catch((e: unknown) => {
      if (!(e instanceof Desfaz)) throw e;
    });
  return resultado;
}

async function sqlstate(sql: string): Promise<string> {
  try {
    await q(sql);
  } catch (erro) {
    return sqlstateDoErro(erro) ?? `sem SQLSTATE: ${String(erro)}`;
  }
  return 'ok';
}

async function config() {
  const [c] = await db.$queryRawUnsafe<
    {
      instancia_id: string;
      ambiente: string | null;
      ativada_em: Date | null;
      habilitada: boolean;
    }[]
  >(
    'SELECT instancia_id::text, ambiente, ativada_em, habilitada FROM public.config_presenca_automatica',
  );
  return c;
}

const alterar = (instancia: string, ambiente: string, habilitar: boolean) =>
  `SELECT * FROM public.presenca_auto_alterar('${instancia}'::uuid, '${ambiente}', ${habilitar})`;

let ocSeq = 0;
async function ocorrencia(): Promise<string> {
  ocSeq += 1;
  const id = `05710000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}',CURRENT_DATE - 2,TIME '0${ocSeq}:00',TIME '0${ocSeq}:30','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
  return id;
}

beforeAll(async () => {
  await garantirLoginsDeTeste(db);
});

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  ocSeq = 0;
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-057 presenca','spec-057-pres-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${PROFESSOR_USUARIO}','prof.s057p@x.com','h','Prof','professor','${EMPRESA}',now()), ('${ALUNO_USUARIO}','aluno.s057p@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${ALUNO_USUARIO}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma','${QUADRA}',10,'ativa')`,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await redefinirConfigDePresenca(db);
  await Promise.all([db.$disconnect(), outra.$disconnect()]);
});

describe('SPEC-057/D1/INV-137 — proveniência do cabeçalho (CHECK)', () => {
  it('INSERT antigo, sem origem, nasce legada_humana e continua válido', async () => {
    const oc = await ocorrencia();
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_por,completude,esperados,updated_at) VALUES ('${oc}','TURMA','${EMPRESA}','${PROFESSOR_USUARIO}','completa',1,now())`,
    );
    const [c] = await db.$queryRawUnsafe<
      {
        origem: string;
        origem_inicial: string;
        fechada_automaticamente_em: Date | null;
      }[]
    >(
      `SELECT origem, origem_inicial, fechada_automaticamente_em FROM chamadas WHERE ocupacao_id='${oc}'`,
    );
    expect(c).toEqual({
      origem: 'legada_humana',
      origem_inicial: 'legada_humana',
      fechada_automaticamente_em: null,
    });
  });

  it.each([
    [
      'automática COM autor',
      `'automatica','automatica','${PROFESSOR_USUARIO}',clock_timestamp()`,
    ],
    ['humana SEM autor', `'professor','professor',NULL,NULL`],
    ['origem fora do domínio', `'sistema','sistema',NULL,NULL`],
    ['automática sem instante', `'automatica','automatica',NULL,NULL`],
    [
      'humana com instante',
      `'professor','professor','${PROFESSOR_USUARIO}',clock_timestamp()`,
    ],
  ])('%s → 23514', async (_caso, valores) => {
    const oc = await ocorrencia();
    expect(
      await sqlstate(
        `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,origem,origem_inicial,registrada_por,fechada_automaticamente_em,completude,esperados,updated_at) VALUES ('${oc}','TURMA','${EMPRESA}',${valores},'completa',1,now())`,
      ),
    ).toBe('23514');
  });

  it('presença com autor nulo é aceita pelo banco (a consistência com o cabeçalho é de aplicação, LIM-057j)', async () => {
    const oc = await ocorrencia();
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,origem,origem_inicial,registrada_por,fechada_automaticamente_em,completude,esperados,updated_at) VALUES ('${oc}','TURMA','${EMPRESA}','automatica','automatica',NULL,clock_timestamp(),'completa',1,now())`,
    );
    expect(
      await sqlstate(
        `INSERT INTO presencas (id,company_id,ocupacao_id,origem_tipo,aluno_id,status,registrado_por,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${oc}','TURMA','${ALUNO}','presente',NULL,now())`,
      ),
    ).toBe('ok');
  });
});

describe('SPEC-057/D5/INV-143 — o instante do fechamento automático', () => {
  async function automatica(): Promise<string> {
    const oc = await ocorrencia();
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,origem,origem_inicial,registrada_por,fechada_automaticamente_em,completude,esperados,updated_at) VALUES ('${oc}','TURMA','${EMPRESA}','automatica','automatica',NULL,clock_timestamp(),'completa',1,now())`,
    );
    return oc;
  }

  it('alterar o instante → 23514', async () => {
    const oc = await automatica();
    expect(
      await sqlstate(
        `UPDATE chamadas SET fechada_automaticamente_em = fechada_automaticamente_em - interval '1 day' WHERE ocupacao_id='${oc}'`,
      ),
    ).toBe('23514');
  });

  it('limpar o instante → 23514', async () => {
    const oc = await automatica();
    expect(
      await sqlstate(
        `UPDATE chamadas SET fechada_automaticamente_em = NULL, origem_inicial='professor', origem='professor', registrada_por='${PROFESSOR_USUARIO}' WHERE ocupacao_id='${oc}'`,
      ),
    ).toBe('23514');
  });

  it('ratificar (origem → professor, com autor) PRESERVA o instante', async () => {
    const oc = await automatica();
    const [antes] = await db.$queryRawUnsafe<{ f: Date }[]>(
      `SELECT fechada_automaticamente_em AS f FROM chamadas WHERE ocupacao_id='${oc}'`,
    );
    await q(
      `UPDATE chamadas SET origem='professor', registrada_por='${PROFESSOR_USUARIO}' WHERE ocupacao_id='${oc}'`,
    );
    const [depois] = await db.$queryRawUnsafe<
      { f: Date; origem_inicial: string }[]
    >(
      `SELECT fechada_automaticamente_em AS f, origem_inicial FROM chamadas WHERE ocupacao_id='${oc}'`,
    );
    expect(depois.f.getTime()).toBe(antes.f.getTime());
    expect(depois.origem_inicial).toBe('automatica');
  });

  it('raw SQL CONSEGUE trocar a origem inicial de uma humana — proteção de aplicação, LIM-057j', async () => {
    const oc = await ocorrencia();
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,origem,origem_inicial,registrada_por,completude,esperados,updated_at) VALUES ('${oc}','TURMA','${EMPRESA}','professor','professor','${PROFESSOR_USUARIO}','completa',1,now())`,
    );
    expect(
      await sqlstate(
        `UPDATE chamadas SET origem_inicial='gestor' WHERE ocupacao_id='${oc}'`,
      ),
    ).toBe('ok');
  });
});

describe('SPEC-057/D3/INV-146/AC-004 — autoridade da ativação', () => {
  it('nasce desligada, com UUID e sem ambiente nem corte', async () => {
    const c = await config();
    expect(c.habilitada).toBe(false);
    expect(c.ambiente).toBeNull();
    expect(c.ativada_em).toBeNull();
    expect(c.instancia_id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('RUNTIME da aplicação: ativar, pausar, INSERT, DELETE, TRUNCATE, FOR UPDATE e EXECUTE → 42501; SELECT ok; nada muda', async () => {
    const c = await config();
    const antes = JSON.stringify(c);
    const casos = {
      ativar: 'UPDATE public.config_presenca_automatica SET habilitada = true',
      pausar: 'UPDATE public.config_presenca_automatica SET habilitada = false',
      insert: 'INSERT INTO public.config_presenca_automatica DEFAULT VALUES',
      delete: 'DELETE FROM public.config_presenca_automatica',
      truncate: 'TRUNCATE public.config_presenca_automatica',
      forUpdate: 'SELECT 1 FROM public.config_presenca_automatica FOR UPDATE',
      execute: alterar(c.instancia_id, 'dev', true),
    };
    for (const [nome, sql] of Object.entries(casos)) {
      expect([nome, await comoPapel(LOGIN_RUNTIME_DE_TESTE, sql)]).toEqual([
        nome,
        '42501',
      ]);
    }
    expect(
      await comoPapel(
        LOGIN_RUNTIME_DE_TESTE,
        'SELECT habilitada FROM public.config_presenca_automatica',
      ),
    ).toBe('ok');
    expect(JSON.stringify(await config())).toBe(antes);
  });

  it('RUNTIME continua com DML nas tabelas do produto', async () => {
    expect(
      await comoPapel(
        LOGIN_RUNTIME_DE_TESTE,
        `UPDATE empresas SET nome = nome WHERE id='${EMPRESA}'`,
        `SELECT 1 FROM turmas WHERE id='${TURMA}'`,
      ),
    ).toBe('ok');
  });

  it('OPERADOR: UPDATE direto, INSERT, DELETE, TRUNCATE → 42501', async () => {
    for (const sql of [
      'UPDATE public.config_presenca_automatica SET habilitada = true',
      "UPDATE public.config_presenca_automatica SET ambiente = 'dev'",
      'INSERT INTO public.config_presenca_automatica DEFAULT VALUES',
      'DELETE FROM public.config_presenca_automatica',
      'TRUNCATE public.config_presenca_automatica',
    ]) {
      expect([sql, await comoPapel(LOGIN_OPERADOR_DE_TESTE, sql)]).toEqual([
        sql,
        '42501',
      ]);
    }
  });

  it('OPERADOR pela função: ambiente não declarado PA004; UUID errado PA001; ambiente errado PA002; nulo PA005 — sem mutação', async () => {
    const c = await config();
    expect(
      await comoPapel(
        LOGIN_OPERADOR_DE_TESTE,
        alterar(c.instancia_id, 'dev', true),
      ),
    ).toBe('PA004');

    await q("UPDATE public.config_presenca_automatica SET ambiente = 'dev'");
    const declarada = JSON.stringify(await config());

    expect(
      await comoPapel(
        LOGIN_OPERADOR_DE_TESTE,
        alterar('00000000-0000-4000-8000-000000000000', 'dev', true),
      ),
    ).toBe('PA001');
    expect(
      await comoPapel(
        LOGIN_OPERADOR_DE_TESTE,
        alterar(c.instancia_id, 'producao', true),
      ),
    ).toBe('PA002');
    expect(
      await comoPapel(
        LOGIN_OPERADOR_DE_TESTE,
        `SELECT * FROM public.presenca_auto_alterar(NULL, 'dev', true)`,
      ),
    ).toBe('PA005');
    expect(JSON.stringify(await config())).toBe(declarada);
  });

  it('duas ativações concorrentes pela função fixam o MESMO corte; pausa e retomada o preservam', async () => {
    await q("UPDATE public.config_presenca_automatica SET ambiente = 'dev'");
    const { instancia_id } = await config();

    const ativar = (cliente: PrismaClient) =>
      cliente.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SET LOCAL ROLE ${LOGIN_OPERADOR_DE_TESTE}`,
          );
          const [r] = await tx.$queryRawUnsafe<
            { o_ativada_em: Date; o_mudou: boolean }[]
          >(alterar(instancia_id, 'dev', true));
          await tx.$executeRawUnsafe('SELECT pg_sleep(0.3)');
          return r;
        },
        { timeout: 30_000 },
      );
    const [a, b] = await Promise.all([ativar(db), ativar(outra)]);

    expect(a.o_ativada_em.getTime()).toBe(b.o_ativada_em.getTime());
    expect([a.o_mudou, b.o_mudou].sort()).toEqual([false, true]);
    const corte = (await config()).ativada_em as Date;

    for (const habilitar of [false, true, false, true]) {
      await comoPapelComResultado(alterar(instancia_id, 'dev', habilitar));
    }
    const depois = await config();
    expect(depois.habilitada).toBe(true);
    expect((depois.ativada_em as Date).getTime()).toBe(corte.getTime());
  });

  it('OWNER sem DDL: mudar a flag direto → 42501; pré-atribuir ou trocar corte, trocar UUID, redeclarar ambiente, DELETE, TRUNCATE e INSERT ativo → 23514', async () => {
    await q("UPDATE public.config_presenca_automatica SET ambiente = 'dev'");
    expect(
      await sqlstate(
        'UPDATE public.config_presenca_automatica SET habilitada = true',
      ),
    ).toBe('42501');
    expect(
      await sqlstate(
        'UPDATE public.config_presenca_automatica SET ativada_em = now()',
      ),
    ).toBe('23514');
    expect(
      await sqlstate(
        'UPDATE public.config_presenca_automatica SET instancia_id = gen_random_uuid()',
      ),
    ).toBe('23514');
    expect(
      await sqlstate(
        "UPDATE public.config_presenca_automatica SET ambiente = 'producao'",
      ),
    ).toBe('23514');
    expect(
      await sqlstate('DELETE FROM public.config_presenca_automatica'),
    ).toBe('23514');
    expect(await sqlstate('TRUNCATE public.config_presenca_automatica')).toBe(
      '23514',
    );
    expect(
      await sqlstate(
        'INSERT INTO public.config_presenca_automatica (id, habilitada, ativada_em) VALUES (2, true, now())',
      ),
    ).toBe('23514');
  });

  it('linha ausente: a função responde PA003 e NÃO recria a linha', async () => {
    await q(
      'ALTER TABLE public.config_presenca_automatica DISABLE TRIGGER USER',
    );
    await q('DELETE FROM public.config_presenca_automatica');
    await q(
      'ALTER TABLE public.config_presenca_automatica ENABLE TRIGGER USER',
    );

    expect(
      await comoPapel(
        LOGIN_OPERADOR_DE_TESTE,
        alterar('00000000-0000-4000-8000-000000000000', 'dev', true),
      ),
    ).toBe('PA003');
    const [n] = await db.$queryRawUnsafe<{ n: number }[]>(
      'SELECT count(*)::int AS n FROM public.config_presenca_automatica',
    );
    expect(n.n).toBe(0);
  });

  it('catálogo: grants, owner sem login, SECURITY DEFINER, search_path fixo e EXECUTE só do operador', async () => {
    const privs = await db.$queryRawUnsafe<
      { grantee: string; privs: string }[]
    >(
      `SELECT grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
         FROM information_schema.table_privileges
        WHERE table_schema='public' AND table_name='config_presenca_automatica'
          AND grantee IN ('playck_app_runtime','presenca_auto_operador','presenca_auto_guardiao')
        GROUP BY grantee ORDER BY grantee`,
    );
    expect(privs).toEqual([
      { grantee: 'playck_app_runtime', privs: 'SELECT' },
      { grantee: 'presenca_auto_guardiao', privs: 'SELECT' },
      { grantee: 'presenca_auto_operador', privs: 'SELECT' },
    ]);
    const colunas = await db.$queryRawUnsafe<
      { grantee: string; column_name: string }[]
    >(
      `SELECT grantee, column_name FROM information_schema.column_privileges
        WHERE table_schema='public' AND table_name='config_presenca_automatica' AND privilege_type='UPDATE'
          AND grantee IN ('playck_app_runtime','presenca_auto_operador','presenca_auto_guardiao')`,
    );
    expect(colunas).toEqual([
      { grantee: 'presenca_auto_guardiao', column_name: 'habilitada' },
    ]);

    const [fn] = await db.$queryRawUnsafe<
      {
        owner: string;
        prosecdef: boolean;
        proconfig: string[];
        rolcanlogin: boolean;
        rolsuper: boolean;
        rolcreatedb: boolean;
        rolcreaterole: boolean;
      }[]
    >(
      `SELECT r.rolname AS owner, p.prosecdef, p.proconfig, r.rolcanlogin, r.rolsuper, r.rolcreatedb, r.rolcreaterole
         FROM pg_proc p JOIN pg_roles r ON r.oid = p.proowner
        WHERE p.proname = 'presenca_auto_alterar'`,
    );
    expect(fn).toEqual({
      owner: 'presenca_auto_guardiao',
      prosecdef: true,
      proconfig: ['search_path=pg_catalog, pg_temp'],
      rolcanlogin: false,
      rolsuper: false,
      rolcreatedb: false,
      rolcreaterole: false,
    });
    const execucao = await db.$queryRawUnsafe<{ r: string; pode: boolean }[]>(
      `SELECT r, has_function_privilege(r, 'public.presenca_auto_alterar(uuid,text,boolean)', 'EXECUTE') AS pode
         FROM unnest(ARRAY['public','playck_app_runtime','presenca_auto_operador']) AS r`,
    );
    expect(execucao).toEqual([
      { r: 'public', pode: false },
      { r: 'playck_app_runtime', pode: false },
      { r: 'presenca_auto_operador', pode: true },
    ]);
  });

  /**
   * **O gate contra o regrant.** Uma migration futura com
   * `GRANT ... ON ALL TABLES` devolveria escrita na configuração ao runtime;
   * este caso quebra no CI (`test:banco` roda no job `build`) antes do merge.
   */
  it('GATE: o runtime não tem NENHUMA escrita na configuração', async () => {
    const [r] = await db.$queryRawUnsafe<{ escreve: boolean }[]>(
      `SELECT has_table_privilege('playck_app_runtime','public.config_presenca_automatica','INSERT,UPDATE,DELETE,TRUNCATE')
           OR has_column_privilege('playck_app_runtime','public.config_presenca_automatica','habilitada','UPDATE') AS escreve`,
    );
    expect(r.escreve).toBe(false);
  });

  it('rollback: sem EXECUTE o operador recebe 42501, e o runtime continua LENDO a flag', async () => {
    await q("UPDATE public.config_presenca_automatica SET ambiente = 'dev'");
    const { instancia_id } = await config();
    await q(
      'REVOKE EXECUTE ON FUNCTION public.presenca_auto_alterar(uuid,text,boolean) FROM presenca_auto_operador',
    );
    try {
      expect(
        await comoPapel(
          LOGIN_OPERADOR_DE_TESTE,
          alterar(instancia_id, 'dev', true),
        ),
      ).toBe('42501');
      expect(
        await comoPapel(
          LOGIN_RUNTIME_DE_TESTE,
          'SELECT habilitada FROM public.config_presenca_automatica',
        ),
      ).toBe('ok');
    } finally {
      await q(
        'GRANT EXECUTE ON FUNCTION public.presenca_auto_alterar(uuid,text,boolean) TO presenca_auto_operador',
      );
    }
  });

  it('BYPASS DECLARADO (LIM-057o): quem tem DDL desliga o trigger e muda a flag', async () => {
    await q(
      'ALTER TABLE public.config_presenca_automatica DISABLE TRIGGER config_presenca_corte_guard',
    );
    try {
      expect(
        await sqlstate(
          "UPDATE public.config_presenca_automatica SET ambiente='dev', habilitada = true, ativada_em = now()",
        ),
      ).toBe('ok');
    } finally {
      await q(
        'ALTER TABLE public.config_presenca_automatica ENABLE TRIGGER config_presenca_corte_guard',
      );
    }
  });
});

async function comoPapelComResultado(sql: string) {
  return db.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SET LOCAL ROLE ${LOGIN_OPERADOR_DE_TESTE}`);
    return tx.$queryRawUnsafe(sql);
  });
}
