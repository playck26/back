/**
 * SPEC-092 — **a exportação contra o Postgres de verdade.**
 *
 * ## Por que banco
 *
 * O formato tem teste próprio sem banco (`planilha-de-alunos.spec.ts`). O que
 * só o Postgres decide é a consulta: que o clube do outro não entra (AC-001),
 * que a turma inativa some e as ativas saem em ordem (D4), e que o `Status`
 * nasce das duas colunas de `status` e da `senha_temporaria` (AC-003). Um
 * dublê do `$queryRaw` devolveria o que o teste mandasse.
 *
 * ## Por que a AC-006 passa pela conferência DE VERDADE
 *
 * "O arquivo exportado volta pela importação" é uma frase que se prova
 * entregando o arquivo ao `ImportacaoDeAlunosService.conferir` — o mesmo que
 * a rota de importar chama — e não comparando cabeçalhos com uma lista.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { AcessoService } from '../../src/acesso/acesso.service';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import { analisarCsv } from '../../src/people/importacao/csv';
import { ExportacaoDeAlunosService } from '../../src/people/importacao/exportacao-de-alunos.service';
import {
  ImportacaoDeAlunosService,
  MENSAGEM_EMAIL_JA_EXISTE,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { celulaDaPlanilha } from '../../src/people/importacao/planilha-de-alunos';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const base = 'c0920000-0000-4000-8000-0000000000';
const EMPRESA = `${base}0a`;
const EMPRESA_B = `${base}0b`;
const INICIANTE = `${base}b1`;
const NIVEL_B = `${base}b9`;
const QUADRA = `${base}d1`;
const QUADRA_B = `${base}d9`;

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);

const exportacao = new ExportacaoDeAlunosService(p);

function importacao(): ImportacaoDeAlunosService {
  const memoria = new MemoriaProvedorDeEmail();
  const modelos = {
    remetente: 'convites@spec092.teste.local',
    responderPara: 'suporte@spec092.teste.local',
    urlCliente: 'https://cliente.spec092.teste.local',
    urlAdmin: 'https://admin.spec092.teste.local',
  };
  return new ImportacaoDeAlunosService(
    p,
    new AcessoService(p, memoria, modelos),
    memoria,
    modelos,
  );
}

async function montarClube(
  empresa: string,
  nivel: string,
  quadra: string,
): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ($1::uuid,$2,$3,now())`,
    empresa,
    `Clube SPEC-092 ${empresa}`,
    `spec-092-${empresa}`,
  );
  await q(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ($1::uuid,$2::uuid,'Iniciante',1)`,
    nivel,
    empresa,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),$1::uuid,'Tenis',0,now())`,
    empresa,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ($1::uuid,$2::uuid,'Q',(SELECT id FROM esportes_de_quadra WHERE company_id=$2::uuid LIMIT 1),80,'ativa')`,
    quadra,
    empresa,
  );
}

async function turma(
  nome: string,
  opcoes: { status?: 'ativa' | 'inativa'; empresa?: string } = {},
): Promise<string> {
  const id = randomUUID();
  const empresa = opcoes.empresa ?? EMPRESA;
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,20,$5::turma_status,$6::uuid)`,
    id,
    empresa,
    nome,
    empresa === EMPRESA ? QUADRA : QUADRA_B,
    opcoes.status ?? 'ativa',
    empresa === EMPRESA ? INICIANTE : NIVEL_B,
  );
  return id;
}

async function aluno(dados: {
  nome: string;
  email: string;
  telefone?: string | null;
  nivel?: string | null;
  alunoStatus?: 'ativo' | 'inativo';
  contaStatus?: 'ativo' | 'inativo';
  senhaTemporaria?: boolean;
  empresa?: string;
}): Promise<string> {
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  const empresa = dados.empresa ?? EMPRESA;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,telefone,role,company_id,status,senha_temporaria,updated_at)
     VALUES ($1::uuid,$2,'h',$3,$4,'aluno',$5::uuid,$6::usuario_status,$7,now())`,
    usuarioId,
    dados.email,
    dados.nome,
    dados.telefone ?? null,
    empresa,
    dados.contaStatus ?? 'ativo',
    dados.senhaTemporaria ?? false,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,nivel_id) VALUES ($1::uuid,$2::uuid,$3::uuid,'aprovado',$4::usuario_status,$5::uuid)`,
    alunoId,
    usuarioId,
    empresa,
    dados.alunoStatus ?? 'ativo',
    dados.nivel === undefined
      ? empresa === EMPRESA
        ? INICIANTE
        : NIVEL_B
      : dados.nivel,
  );
  return alunoId;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,now())`,
    turmaId,
    alunoId,
  );

/** O arquivo, relido pelo leitor da importação (sem o BOM, pelo `csv.ts`). */
async function exportarELer(empresa = EMPRESA): Promise<string[][]> {
  const { conteudo } = await exportacao.exportar(empresa);
  return analisarCsv(conteudo, ';');
}

const CABECALHO_DE_3 = [
  'Nome',
  'E-mail',
  'Telefone',
  'Nível',
  'Turma 1',
  'Turma 2',
  'Turma 3',
  'Status',
];

let turmas: Record<string, string>;
let alunos: Record<string, string>;

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  await montarClube(EMPRESA, INICIANTE, QUADRA);
  await montarClube(EMPRESA_B, NIVEL_B, QUADRA_B);

  // Criadas fora de ordem alfabética: a ordem do arquivo tem de vir da D4, e
  // não da ordem de inserção.
  turmas = {
    c: await turma('Turma C'),
    a: await turma('Turma A'),
    b: await turma('Turma B'),
    inativa: await turma('Turma Inativa', { status: 'inativa' }),
    deB: await turma('Turma do Outro Clube', { empresa: EMPRESA_B }),
  };

  alunos = {
    ana: await aluno({
      nome: 'Ana',
      email: 'ana@spec092.local',
      telefone: '(11) 99999-0000',
    }),
    beto: await aluno({
      nome: 'Beto',
      email: 'beto@spec092.local',
      alunoStatus: 'inativo',
    }),
    caio: await aluno({
      nome: 'Caio',
      email: 'caio@spec092.local',
      contaStatus: 'inativo',
    }),
    duda: await aluno({
      nome: 'Duda',
      email: 'duda@spec092.local',
      senhaTemporaria: true,
    }),
    edu: await aluno({
      nome: 'Edu',
      email: 'edu@spec092.local',
      alunoStatus: 'inativo',
      senhaTemporaria: true,
    }),
    fabi: await aluno({
      nome: 'Fabi',
      email: 'fabi@spec092.local',
      telefone: '=cmd',
      nivel: null,
    }),
    intrusa: await aluno({
      nome: 'Intrusa',
      email: 'intrusa@spec092-b.local',
      empresa: EMPRESA_B,
    }),
  };

  await matricular(turmas.c, alunos.ana);
  await matricular(turmas.a, alunos.ana);
  await matricular(turmas.inativa, alunos.ana);
  await matricular(turmas.b, alunos.beto);
  await matricular(turmas.deB, alunos.intrusa);
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

describe('SPEC-092/AC-001 — todos do clube, nenhum de outro', () => {
  it('o arquivo é o clube inteiro, com os dados do banco', async () => {
    const linhas = await exportarELer();
    expect(linhas).toEqual([
      CABECALHO_DE_3,
      // D4 — só as ativas, e em ordem alfabética: A antes de C, e a inativa
      // fora, embora a matrícula exista.
      [
        'Ana',
        'ana@spec092.local',
        '(11) 99999-0000',
        'Iniciante',
        'Turma A',
        'Turma C',
        '',
        'ativo',
      ],
      [
        'Beto',
        'beto@spec092.local',
        '',
        'Iniciante',
        'Turma B',
        '',
        '',
        'desativado',
      ],
      ['Caio', 'caio@spec092.local', '', 'Iniciante', '', '', '', 'desativado'],
      ['Duda', 'duda@spec092.local', '', 'Iniciante', '', '', '', 'pendente'],
      ['Edu', 'edu@spec092.local', '', 'Iniciante', '', '', '', 'desativado'],
      // D5 — o telefone que começa com `=` sai com `'`. D4 — sem nível, vazio.
      ['Fabi', 'fabi@spec092.local', "'=cmd", '', '', '', '', 'ativo'],
    ]);
  });

  it('nada do outro clube: nem aluno, nem turma, nem e-mail', async () => {
    const { conteudo } = await exportacao.exportar(EMPRESA);
    expect(conteudo).not.toContain('Intrusa');
    expect(conteudo).not.toContain('spec092-b.local');
    expect(conteudo).not.toContain('Turma do Outro Clube');

    // E o outro clube vê só o dele.
    const deB = await exportarELer(EMPRESA_B);
    expect(deB.slice(1).map((l) => l[1])).toEqual(['intrusa@spec092-b.local']);
    expect(deB[1][4]).toBe('Turma do Outro Clube');
  });

  it('a contagem bate com o banco: uma linha por aluno do clube', async () => {
    const linhas = await exportarELer();
    const noBanco = await db.aluno.findMany({
      where: { companyId: EMPRESA },
      select: { usuario: { select: { email: true } } },
    });
    expect(
      linhas
        .slice(1)
        .map((l) => l[1])
        .sort(),
    ).toEqual(noBanco.map((a) => a.usuario.email).sort());
  });
});

describe('SPEC-092/AC-002 — Turma 4…N só quando alguém passa de 3', () => {
  it('um aluno em 5 turmas ativas: Turma 1 a 5, e os outros com as extras vazias', async () => {
    const d = await turma('Turma D');
    const e = await turma('Turma E');
    await matricular(turmas.b, alunos.ana);
    await matricular(e, alunos.ana);
    await matricular(d, alunos.ana);

    const linhas = await exportarELer();
    expect(linhas[0]).toEqual([
      'Nome',
      'E-mail',
      'Telefone',
      'Nível',
      'Turma 1',
      'Turma 2',
      'Turma 3',
      'Turma 4',
      'Turma 5',
      'Status',
    ]);
    expect(linhas[1].slice(4, 9)).toEqual([
      'Turma A',
      'Turma B',
      'Turma C',
      'Turma D',
      'Turma E',
    ]);
    expect(linhas[2].slice(4)).toEqual([
      'Turma B',
      '',
      '',
      '',
      '',
      'desativado',
    ]);
    for (const linha of linhas) expect(linha).toHaveLength(10);
  });

  it('a turma inativa não conta para o N', async () => {
    const outras = [
      await turma('Inativa 2', { status: 'inativa' }),
      await turma('Inativa 3', { status: 'inativa' }),
    ];
    for (const t of outras) await matricular(t, alunos.ana);
    await matricular(turmas.b, alunos.ana);

    const [cabecalho, ana] = await exportarELer();
    // Ana tem 6 matrículas, 3 delas ativas: o cabeçalho continua com 3.
    expect(cabecalho).toEqual(CABECALHO_DE_3);
    expect(ana.slice(4, 7)).toEqual(['Turma A', 'Turma B', 'Turma C']);
  });
});

describe('SPEC-092/AC-003 — o Status pelo banco', () => {
  it('ativo, desativado pelo aluno, pela conta, pendente, e desativado vence pendente', async () => {
    const linhas = await exportarELer();
    const status = Object.fromEntries(linhas.slice(1).map((l) => [l[0], l[7]]));
    expect(status).toEqual({
      Ana: 'ativo',
      Beto: 'desativado', // alunos.status = inativo
      Caio: 'desativado', // usuarios.status = inativo
      Duda: 'pendente', // senha_temporaria = true
      Edu: 'desativado', // inativo E senha_temporaria: desativado vence
      Fabi: 'ativo',
    });
  });
});

describe('SPEC-092/AC-004 — o que o aluno escreveu volta igual pelo `csv.ts`', () => {
  it("fórmula ganha `'`; `;`, aspas e quebra de linha vão entre aspas", async () => {
    await q(
      `UPDATE usuarios SET nome = $1, telefone = $2 WHERE email = 'ana@spec092.local'`,
      '=HYPERLINK("http://x"; "Ana")',
      '+55 11\n9999',
    );
    await q(
      `UPDATE usuarios SET nome = $1 WHERE email = 'beto@spec092.local'`,
      '@Beto; "o Rei"',
    );

    const linhas = await exportarELer();
    const porEmail = new Map(linhas.slice(1).map((l) => [l[1], l]));
    expect(porEmail.get('ana@spec092.local')?.slice(0, 3)).toEqual([
      `'=HYPERLINK("http://x"; "Ana")`,
      'ana@spec092.local',
      "'+55 11\n9999",
    ]);
    expect(porEmail.get('beto@spec092.local')?.[0]).toBe(`'@Beto; "o Rei"`);
    // Seis alunos, seis linhas: nenhuma quebra de linha partiu um aluno.
    expect(linhas).toHaveLength(7);
  });
});

describe('SPEC-092/AC-006 — sem a coluna Status, o arquivo passa na conferência de hoje', () => {
  /** Tira a última coluna (Status) e regrava no mesmo formato. */
  function semStatus(conteudo: string): string {
    return (
      '\uFEFF' +
      analisarCsv(conteudo, ';')
        .map(
          (campos) =>
            campos.slice(0, -1).map(celulaDaPlanilha).join(';') + '\r\n',
        )
        .join('')
    );
  }

  it('nenhum erro de cabeçalho; os de e-mail são os esperados pela D7', async () => {
    const { conteudo } = await exportacao.exportar(EMPRESA);
    const arquivo = semStatus(conteudo);
    expect(arquivo).not.toContain('Status');
    expect(arquivo.split('\r\n')[0]).toBe(
      '\uFEFFNome;E-mail;Telefone;Nível;Turma 1;Turma 2;Turma 3',
    );

    // Sem `rejects`: erro de cabeçalho (COLUNA_DESCONHECIDA, COLUNA_SEM_NOME,
    // PLANILHA_SEM_CABECALHO) é exceção, e derrubaria a promessa aqui.
    const relatorio = await importacao().conferir(EMPRESA, arquivo);

    expect(relatorio.total).toBe(6);
    // Toda linha é recusada pelo e-mail que já existe (D7)...
    const deEmail = relatorio.erros.filter((e) => e.coluna === 'email');
    expect(deEmail.map((e) => e.linha)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(deEmail.every((e) => e.mensagem === MENSAGEM_EMAIL_JA_EXISTE)).toBe(
      true,
    );
    // ...e o único outro erro é o nível vazio da Fabi, que a D4 exporta vazio
    // e a SPEC-091/D2 exige na importação. Nenhum é de turma: as turmas
    // exportadas são as ativas, com o nome que a conferência procura.
    expect(relatorio.erros.filter((e) => e.coluna !== 'email')).toEqual([
      { linha: 7, coluna: 'nivel', mensagem: 'O nível é obrigatório.' },
    ]);
  });

  it('com Status, a conferência de hoje recusa pelo cabeçalho (D7)', async () => {
    const { conteudo } = await exportacao.exportar(EMPRESA);
    await expect(
      importacao().conferir(EMPRESA, conteudo),
    ).rejects.toMatchObject({
      response: { code: 'COLUNA_DESCONHECIDA', colunas: ['Status'] },
    });
  });
});

describe('SPEC-092/AC-010 — com alunos em até 10 turmas, o arquivo sem Status passa na conferência', () => {
  /** Tira a última coluna (Status) e regrava no mesmo formato. */
  function semStatus(conteudo: string): string {
    return (
      '﻿' +
      analisarCsv(conteudo, ';')
        .map(
          (campos) =>
            campos.slice(0, -1).map(celulaDaPlanilha).join(';') + '\r\n',
        )
        .join('')
    );
  }

  /** Ana nas três do `beforeEach` (A, C e a inativa) e em mais `extras`. */
  async function anaEmMais(extras: number): Promise<string[]> {
    const nomes = Array.from(
      { length: extras },
      (_, i) => `Extra ${String(i + 1).padStart(2, '0')}`,
    );
    for (const nome of nomes) await matricular(await turma(nome), alunos.ana);
    return nomes;
  }

  it('Ana em 10 turmas ativas: Turma 1 a 10, e nenhum erro de cabeçalho nem de turma', async () => {
    // A, C e 8 extras = 10 ativas (a inativa não conta).
    const extras = await anaEmMais(8);
    const { conteudo } = await exportacao.exportar(EMPRESA);
    const arquivo = semStatus(conteudo);
    const cabecalho = analisarCsv(arquivo, ';')[0];
    expect(cabecalho).toEqual([
      'Nome',
      'E-mail',
      'Telefone',
      'Nível',
      ...Array.from({ length: 10 }, (_, i) => `Turma ${i + 1}`),
    ]);
    expect(analisarCsv(arquivo, ';')[1].slice(4)).toEqual([
      ...extras,
      'Turma A',
      'Turma C',
    ]);

    // Sem `rejects`: um erro de cabeçalho seria exceção e derrubaria aqui.
    const relatorio = await importacao().conferir(EMPRESA, arquivo);
    expect(relatorio.total).toBe(6);
    expect(relatorio.erros.filter((e) => e.coluna.startsWith('turma'))).toEqual(
      [],
    );
    // Os de e-mail (D7) e o nível vazio da Fabi, como na AC-006.
    expect(relatorio.erros.filter((e) => e.coluna !== 'email')).toEqual([
      { linha: 7, coluna: 'nivel', mensagem: 'O nível é obrigatório.' },
    ]);
  });

  it('D9 — com um aluno em 11 turmas, o arquivo sai com Turma 11, e a importação o recusa dizendo o máximo', async () => {
    await anaEmMais(9);
    const { conteudo } = await exportacao.exportar(EMPRESA);
    expect(analisarCsv(conteudo, ';')[0].slice(-2)).toEqual([
      'Turma 11',
      'Status',
    ]);
    await expect(
      importacao().conferir(EMPRESA, semStatus(conteudo)),
    ).rejects.toMatchObject({
      response: {
        code: 'COLUNA_DESCONHECIDA',
        colunas: ['Turma 11'],
        message: expect.stringContaining('O máximo é turma 10') as unknown,
      },
    });
  });
});
