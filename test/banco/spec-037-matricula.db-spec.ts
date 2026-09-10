/**
 * SPEC-037 — plano e matrícula, contra o banco de verdade.
 *
 * ## O caso que dá nome à spec: a INV-114
 *
 * *Não há matrícula sem o contrato aceito por aquele usuário naquela versão*,
 * e quem garante é o **banco** — FK composta apontando para uma coluna
 * `GENERATED ALWAYS … STORED` que vale `'contrato'` só na linha de contrato.
 *
 * **O caso decisivo é o do TERMO.** Sem a coluna gerada, uma `UNIQUE
 * (usuario_id, versao)` casaria também o aceite do termo de mesma versão, e a
 * matrícula passaria apontando para o aceite errado — o aluno teria "aceitado
 * o contrato" tendo aceitado outra coisa. Um teste que só verificasse
 * "matrícula sem aceite nenhum é recusada" ficaria verde com o mecanismo
 * errado.
 *
 * ## E o `fim`, que o JavaScript erraria
 *
 * `2026-01-31 + 1 mês` é **28 de fevereiro**, não 3 de março. O Postgres sabe;
 * o `Date` do JavaScript transborda em silêncio.
 */
import { PrismaClient, Prisma } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { MatriculasService } from '../../src/matriculas/matriculas.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'e0370000-0000-4000-8000-000000000001';
const ADMIN = 'e0370000-0000-4000-8000-000000000002';
const USUARIO = 'e0370000-0000-4000-8000-000000000003';
const ALUNO = 'e0370000-0000-4000-8000-000000000004';
const PLANO = 'e0370000-0000-4000-8000-000000000005';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): MatriculasService {
  return new MatriculasService(db as unknown as PrismaService);
}

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,contrato_versao_vigente,updated_at) VALUES ('${EMPRESA}','SPEC-037','spec-037-${EMPRESA}',1,now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin037@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno037@teste.local','x','Ana','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado')`,
  );
  await q(
    `INSERT INTO planos (id,company_id,nome,valor_centavos,prazo_meses,updated_at) VALUES ('${PLANO}','${EMPRESA}','Mensal',30000,1,now())`,
  );
}

/** O SQLSTATE da recusa, ou falha se a escrita passar. */
async function recusadoCom(sql: string): Promise<string> {
  try {
    await q(sql);
  } catch (erro) {
    const e = erro as Prisma.PrismaClientKnownRequestError;
    // **O SQLSTATE vem em `meta.code`, nao no texto da mensagem.** A primeira
    // versao deste helper o procurava por regex em `message` e devolvia `?`
    // em todos os casos -- os testes ficavam vermelhos dizendo a coisa certa
    // sobre a constraint e a coisa errada sobre o codigo.
    const codigo = (e.meta?.code as string) ?? '?';
    const msg = String((e.meta?.message as string) ?? e.message);
    const constraint = /constraint "([a-z_]+)"/.exec(msg)?.[1];
    return `${codigo}/${constraint ?? '?'}`;
  }
  throw new Error('a escrita PASSOU, e deveria ter sido recusada');
}

function matriculaSql(extra: Record<string, string | number> = {}): string {
  const campos: Record<string, string | number> = {
    id: `'${crypto.randomUUID()}'`,
    company_id: `'${EMPRESA}'`,
    aluno_id: `'${ALUNO}'`,
    usuario_id: `'${USUARIO}'`,
    plano_id: `'${PLANO}'`,
    valor_centavos: 30000,
    valor_de_tabela_centavos: 30000,
    prazo_meses: 1,
    inicio: `'2026-09-10'`,
    fim: `'2026-10-10'`,
    contrato_versao: 1,
    criado_por_id: `'${ADMIN}'`,
    ...extra,
  };
  return `INSERT INTO matriculas (${Object.keys(campos).join(',')}) VALUES (${Object.values(campos).join(',')})`;
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-037/INV-114 — não há matrícula sem o contrato aceito', () => {
  it('sem aceite nenhum: recusado com `23503`', async () => {
    expect(await recusadoCom(matriculaSql())).toBe(
      '23503/matriculas_contrato_aceito_fkey',
    );
  });

  it('**com o aceite do TERMO de mesma versão: TAMBÉM recusado**', async () => {
    // É o caso decisivo. Sem a coluna gerada, uma `UNIQUE (usuario_id,
    // versao)` casaria este aceite — e o aluno teria "aceitado o contrato"
    // tendo aceitado outra coisa. Um teste que só checasse "sem aceite
    // nenhum" ficaria verde com o mecanismo errado.
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','termo',1,now())`,
    );
    expect(await recusadoCom(matriculaSql())).toBe(
      '23503/matriculas_contrato_aceito_fkey',
    );
  });

  it('com o aceite do CONTRATO: aceito', async () => {
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','contrato',1,now())`,
    );
    await q(matriculaSql());
    expect(await db.matricula.count({ where: { companyId: EMPRESA } })).toBe(1);
  });

  it('aceite de OUTRA versão não serve', async () => {
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','contrato',2,now())`,
    );
    expect(await recusadoCom(matriculaSql({ contrato_versao: 1 }))).toBe(
      '23503/matriculas_contrato_aceito_fkey',
    );
  });

  it('a coluna gerada vale `contrato` na linha de contrato e NULO na de termo', async () => {
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','termo',1,now())`,
    );
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','contrato',1,now())`,
    );
    const linhas = await db.$queryRawUnsafe<
      { tipo: string; tipo_contrato: string | null }[]
    >(
      `SELECT tipo, tipo_contrato FROM aceites WHERE usuario_id='${USUARIO}' ORDER BY tipo`,
    );
    // É o discriminante inteiro, à vista: sem o NULO na linha do termo, a
    // UNIQUE alvo teria duas linhas iguais e a FK escolheria qualquer uma.
    //
    // **`termo` vem primeiro, e não é ordem alfabética:** o Postgres ordena
    // `enum` pela ordem de DECLARAÇÃO, e `TipoDeAceite` declara `termo` antes
    // de `contrato`. Escrevi a expectativa em ordem alfabética e o teste me
    // corrigiu — a mesma ordem de declaração que este projeto trata como
    // regra dura quando acrescenta valor no fim de um enum.
    expect(linhas).toEqual([
      { tipo: 'termo', tipo_contrato: null },
      { tipo: 'contrato', tipo_contrato: 'contrato' },
    ]);
  });
});

describe('SPEC-037 — os CHECKs e o RESTRICT', () => {
  beforeEach(async () => {
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','contrato',1,now())`,
    );
  });

  it('`fim` antes do início é recusado (INV-113)', async () => {
    expect(
      await recusadoCom(
        matriculaSql({ inicio: `'2026-10-10'`, fim: `'2026-09-10'` }),
      ),
    ).toBe('23514/matriculas_fim_depois_do_inicio');
  });

  it('valor negativo é recusado', async () => {
    expect(await recusadoCom(matriculaSql({ valor_centavos: -1 }))).toBe(
      '23514/matriculas_valor_nao_negativo',
    );
  });

  it('prazo de 61 meses é recusado — plano de cinco anos é digitação errada', async () => {
    expect(await recusadoCom(matriculaSql({ prazo_meses: 61 }))).toBe(
      '23514/matriculas_prazo_positivo',
    );
  });

  it('INV-115: plano CONTRATADO não é apagado', async () => {
    await q(matriculaSql());
    // **`23001`, e não `23503`.** `ON DELETE RESTRICT` levanta
    // `restrict_violation`; `NO ACTION` é que levanta `foreign_key_violation`.
    // A diferença importa para quem for traduzir o erro numa rota: os dois
    // dizem "há filho apontando", e só um deles aparece neste caminho.
    expect(await recusadoCom(`DELETE FROM planos WHERE id='${PLANO}'`)).toBe(
      '23001/matriculas_plano_fkey',
    );
  });

  it('plano de outra empresa não vira matrícula (DEF-024)', async () => {
    const outra = 'e0370000-0000-4000-8000-0000000000ff';
    // **Limpa ANTES, e nao so depois.** A primeira versao limpava no fim do
    // caso — e um caso que falha no meio nunca chega la, deixando a empresa
    // para a proxima rodada e trocando o defeito real por um `23505` que nao
    // diz nada. `limparEmpresa` do `beforeEach` so alcanca `EMPRESA`.
    await limparEmpresa(db, outra);
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${outra}','Outra','outra-037',now())`,
    );
    await q(
      `INSERT INTO planos (id,company_id,nome,valor_centavos,prazo_meses,updated_at) VALUES ('${outra}','${outra}','Alheio',1,1,now())`,
    );
    // A FK é COMPOSTA: `(company_id, plano_id)`. Com FK simples o banco
    // aceitaria matrícula da empresa A apontando para plano da B — que é
    // exatamente o que a DEF-024 existe para impedir.
    expect(await recusadoCom(matriculaSql({ plano_id: `'${outra}'` }))).toBe(
      '23503/matriculas_plano_fkey',
    );
    await limparEmpresa(db, outra);
  });

  it('CHECK do plano: prazo 0 é recusado', async () => {
    expect(
      await recusadoCom(
        `INSERT INTO planos (id,company_id,nome,valor_centavos,prazo_meses,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','Zero',100,0,now())`,
      ),
    ).toBe('23514/planos_prazo_positivo');
  });
});

describe('SPEC-037/D9 — o `fim` que o JavaScript erraria', () => {
  it('31/01 + 1 mês é 28/02, e não 3 de março', async () => {
    // O `Date` do JavaScript transborda em silêncio: `Date.UTC(2026,0,31)`
    // mais um mês vira 3 de março, porque 31 de fevereiro não existe. Uma
    // matrícula terminando "dia 3" ninguém olha duas vezes.
    const fim = await MatriculasService.calcularFim(
      db,
      new Date('2026-01-31T00:00:00.000Z'),
      1,
    );
    expect(fim.toISOString().slice(0, 10)).toBe('2026-02-28');
  });

  it('29/02 de ano bissexto + 12 meses é 28/02', async () => {
    const fim = await MatriculasService.calcularFim(
      db,
      new Date('2024-02-29T00:00:00.000Z'),
      12,
    );
    expect(fim.toISOString().slice(0, 10)).toBe('2025-02-28');
  });

  it('dia que existe nos dois meses passa direto', async () => {
    const fim = await MatriculasService.calcularFim(
      db,
      new Date('2026-01-15T00:00:00.000Z'),
      3,
    );
    expect(fim.toISOString().slice(0, 10)).toBe('2026-04-15');
  });
});

describe('SPEC-037/AC-011 — a matrícula vigente', () => {
  beforeEach(async () => {
    await q(
      `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','contrato',1,now())`,
    );
  });

  it('sem matrícula devolve `null`, e não erro', async () => {
    // Não ter plano é um estado NORMAL — a tabela nasceu vazia, e a maioria
    // dos alunos de hoje está assim. `404` faria a tela tratar o normal como
    // erro, que é o defeito que a carteira levou para produção na SPEC-033.
    expect(await servico().minhaMatricula(EMPRESA, USUARIO)).toBeNull();
  });

  it('matrícula VENCIDA não é vigente', async () => {
    await q(matriculaSql({ inicio: `'2020-01-01'`, fim: `'2020-02-01'` }));
    expect(await servico().minhaMatricula(EMPRESA, USUARIO)).toBeNull();
  });

  it('a vigente vem, com o desconto CALCULADO', async () => {
    await q(
      matriculaSql({
        inicio: `'2020-01-01'`,
        fim: `'2099-01-01'`,
        valor_centavos: 25000,
        valor_de_tabela_centavos: 30000,
      }),
    );
    const m = await servico().minhaMatricula(EMPRESA, USUARIO);
    expect(m?.valorCentavos).toBe(25000);
    expect(m?.valorDeTabelaCentavos).toBe(30000);
    // Nunca gravado: uma coluna seria uma terceira verdade sobre os mesmos
    // dois números, e a primeira a divergir.
    expect(m?.descontoCentavos).toBe(5000);
  });

  it('o link vem do PLANO quando ele tem, e da EMPRESA quando não tem (D6)', async () => {
    await q(
      `INSERT INTO config_pagamento_empresa (id,company_id,link_pagamento_url,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','https://clube.example/pagar',now())`,
    );
    await q(matriculaSql({ inicio: `'2020-01-01'`, fim: `'2099-01-01'` }));

    // Sem link próprio: herda.
    expect(
      (await servico().minhaMatricula(EMPRESA, USUARIO))?.linkPagamentoUrl,
    ).toBe('https://clube.example/pagar');

    await q(
      `UPDATE planos SET link_pagamento_url='https://plano.example/mensal' WHERE id='${PLANO}'`,
    );
    // Com link próprio: o do plano vence. A herança é ausência de linha, não
    // cópia de valor — mesma forma de `horarios_funcionamento`.
    expect(
      (await servico().minhaMatricula(EMPRESA, USUARIO))?.linkPagamentoUrl,
    ).toBe('https://plano.example/mensal');
  });
});
