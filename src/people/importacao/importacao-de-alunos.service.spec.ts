import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  MENSAGEM_ALTERACAO_EM_ANDAMENTO,
  MENSAGEM_OUTRA_PESSOA_NA_TURMA,
  MENSAGEM_SERVIDOR_OCUPADO,
} from '../../common/erros/erro-transitorio';
import {
  etapaDaImportacao,
  ImportacaoDeAlunosService,
  type EtapaDaImportacao,
} from './importacao-de-alunos.service';
import {
  ImportacaoController,
  decodificarPlanilha,
} from './importacao.controller';
import type { RelatorioDeImportacaoDto } from './dto/importacao-response.dto';
import { AcessoService } from '../../acesso/acesso.service';
import { MemoriaProvedorDeEmail } from '../../email/memoria-provedor-de-email';
import { LoteNovo } from '../nivel-efetivo';
import type { PrismaService } from '../../prisma/prisma.service';
import type { AccessTokenPayload } from '../../common/types/jwt-payload.type';

/**
 * SPEC-038/REQ-002 — a validação linha a linha.
 *
 * **A conferência não escreve nunca**, então ela se prova sem banco: o que
 * importa aqui é *qual linha* recebeu *qual erro*, e isso é decisão pura.
 *
 * O caso que mais vale é o do **e-mail repetido**: o erro vai na **segunda**
 * ocorrência e **cita a linha da primeira**. Sem a linha de origem, o gestor
 * recebe "este e-mail já apareceu" e procura a duplicata num arquivo de 300
 * linhas.
 */
/** Uma instrução crua que a transação mandou, já montada. */
interface Instrucao {
  sql: string;
  valores: unknown[];
}

function montarSql(primeiro: unknown, resto: unknown[]): Instrucao {
  const montado = Array.isArray(primeiro)
    ? Prisma.sql(primeiro as readonly string[], ...(resto as Prisma.Sql[]))
    : (primeiro as Prisma.Sql);
  return { sql: montado.sql, valores: montado.values };
}

/** Os arranjos de uma instrução de lote, na ordem do `unnest`. */
const arranjos = (i: Instrucao) =>
  i.valores.filter((v): v is unknown[] => Array.isArray(v));

type TurmaDoDuble = {
  id: string;
  nome: string;
  capacidade: number;
  nivelId: string;
  alocados?: number;
};

/**
 * O serviço com um Prisma de mentira, **e a transação aberta para olhar**:
 * desde a SPEC-083 a escrita é SQL cru em lote, e o `tx` registra cada
 * instrução montada. É por ela que se prova o que vai para
 * `usuarios.telefone` e `alunos.nivel_id` sem banco.
 */
function montar(
  overrides: {
    usuarios?: { email: string }[];
    niveis?: { id: string; nome: string }[];
    turmas?: TurmaDoDuble[];
  } = {},
) {
  const instrucoes: Instrucao[] = [];
  const niveis = overrides.niveis ?? [];
  const turmas = overrides.turmas ?? [];

  /** O que as conferências de turma leem — fora e dentro da transação. */
  const leitorDeTurma = {
    turmaAluno: {
      groupBy: jest.fn(() =>
        Promise.resolve(
          turmas
            .filter((t) => (t.alocados ?? 0) > 0)
            .map((t) => ({ turmaId: t.id, _count: { _all: t.alocados } })),
        ),
      ),
      findMany: jest.fn().mockResolvedValue([]),
    },
    // O primeiro nível é o primeiro da lista (o dublê já vem em ordem).
    nivel: {
      findMany: jest.fn().mockResolvedValue(niveis),
      findFirst: jest.fn().mockResolvedValue(niveis[0] ?? null),
    },
    // Nenhuma aula futura: a conferência de aula lotada passa em branco aqui;
    // a conta dela tem prova de banco (AC-012).
    ocupacaoQuadra: { findMany: jest.fn().mockResolvedValue([]) },
    faltaAvisada: { findMany: jest.fn().mockResolvedValue([]) },
    reposicaoDeAula: { findMany: jest.fn().mockResolvedValue([]) },
  };

  const responder = (i: Instrucao): unknown => {
    if (i.sql.includes('FROM empresas e2')) {
      const [tabelas, ids] = arranjos(i) as [string[], string[]];
      return tabelas.map((tabela, k) => ({
        tabela,
        achado: ids[k],
        empresa_nome: tabela === 'empresa' ? 'Clube Dublê' : null,
      }));
    }
    if (i.sql.includes('FROM turmas t2')) {
      return turmas.map((t) => ({
        id: t.id,
        nome: t.nome,
        capacidade: t.capacidade,
        nivel_id: t.nivelId,
        status: 'ativa',
      }));
    }
    if (i.sql.includes('INSERT INTO alunos')) {
      return (arranjos(i)[0] as string[]).map((id) => ({ id }));
    }
    return [{ ok: 1 }];
  };

  const tx = {
    ...leitorDeTurma,
    $queryRaw: jest.fn((primeiro: unknown, ...resto: unknown[]) => {
      const i = montarSql(primeiro, resto);
      instrucoes.push(i);
      return Promise.resolve(responder(i));
    }),
    $executeRaw: jest.fn((primeiro: unknown, ...resto: unknown[]) => {
      const i = montarSql(primeiro, resto);
      instrucoes.push(i);
      return Promise.resolve(arranjos(i)[0]?.length ?? 0);
    }),
  };
  const prisma = {
    ...leitorDeTurma,
    usuario: {
      findMany: jest.fn().mockResolvedValue(overrides.usuarios ?? []),
    },
    turma: {
      findMany: jest.fn().mockResolvedValue(
        turmas.map((t) => ({
          id: t.id,
          nome: t.nome,
          capacidade: t.capacidade,
          nivelId: t.nivelId,
        })),
      ),
    },
    conviteDeAcesso: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const memoria = new MemoriaProvedorDeEmail();
  const acesso = new AcessoService(
    prisma as unknown as PrismaService,
    memoria,
    MODELOS,
  );
  const servico = new ImportacaoDeAlunosService(
    prisma as unknown as PrismaService,
    acesso,
    memoria,
    MODELOS,
  );
  /** A instrução de escrita de uma tabela (a primeira que a insere). */
  const escritaDe = (tabela: string) =>
    instrucoes.find((i) => i.sql.includes(`INSERT INTO ${tabela} `));
  return { servico, prisma, tx, instrucoes, escritaDe, memoria };
}

const MODELOS = {
  remetente: 'convites@unit.teste.local',
  responderPara: 'suporte@unit.teste.local',
  urlCliente: 'https://cliente.unit.teste.local',
};

const GESTOR = '9a000000-0000-4000-8000-000000000001';

function servico(overrides?: Parameters<typeof montar>[0]) {
  return montar(overrides).servico;
}

const CABECALHO = 'nome,email,telefone,nivel,turma';

async function conferir(
  linhas: string[],
  overrides?: Parameters<typeof montar>[0],
) {
  return servico(overrides).conferir('c1', [CABECALHO, ...linhas].join('\n'));
}

/** O erro daquela linha, ou `undefined`. */
function erroNa(
  relatorio: { erros: { linha: number; coluna: string; mensagem: string }[] },
  linha: number,
) {
  return relatorio.erros.find((e) => e.linha === linha);
}

/** Os níveis de um clube de verdade, com o primeiro na frente (SPEC-075/D1). */
const NIVEIS = [
  { id: 'n1', nome: 'Iniciante' },
  { id: 'n2', nome: 'Intermediário' },
];

describe('SPEC-038 — o cabeçalho', () => {
  it('coluna desconhecida é ERRO, e nomeia qual (AC-004)', async () => {
    // Ignorá-la é como uma planilha com `e-mail` mal escrito é importada com
    // todos os e-mails vazios — e o gestor só descobre quando ninguém
    // consegue entrar.
    await expect(
      servico().conferir('c1', 'nome,email,apelido\nAna,a@x.com,Aninha'),
    ).rejects.toMatchObject({
      response: { code: 'COLUNA_DESCONHECIDA', colunas: ['apelido'] },
    });
  });

  it('sem `nome` ou `email` no cabeçalho é recusado (AC-003)', async () => {
    await expect(
      servico().conferir('c1', 'nome,telefone\nAna,119999'),
    ).rejects.toMatchObject({ response: { code: 'PLANILHA_SEM_CABECALHO' } });
  });

  it('só cabeçalho é recusado (AC-005)', async () => {
    // Importar zero alunos "com sucesso" seria uma resposta verdadeira e
    // inútil — o gestor acharia que funcionou.
    await expect(servico().conferir('c1', CABECALHO)).rejects.toMatchObject({
      response: { code: 'PLANILHA_VAZIA' },
    });
  });
});

describe('SPEC-038 — a validação por linha', () => {
  it('nome vazio: erro naquela linha (AC-006)', async () => {
    const r = await conferir([',ana@x.com,,,']);
    expect(erroNa(r, 2)?.coluna).toBe('nome');
    expect(r.validas).toBe(0);
  });

  it('e-mail malformado: erro naquela linha (AC-007)', async () => {
    const r = await conferir(['Ana,ana-arroba-x,,,']);
    expect(erroNa(r, 2)?.mensagem).toMatch(/não parece um e-mail/);
  });

  it('**e-mail repetido: erro na SEGUNDA, citando a PRIMEIRA** (AC-008)', async () => {
    const r = await conferir([
      'Ana,ana@x.com,,,',
      'Beto,beto@x.com,,,',
      'Ana de novo,ana@x.com,,,',
    ]);
    // O erro está na linha 4 e aponta para a 2. Sem a linha de origem, o
    // gestor procuraria a duplicata no arquivo inteiro.
    expect(erroNa(r, 4)?.mensagem).toContain('linha 2');
    expect(erroNa(r, 2)).toBeUndefined();
    // A primeira continua VÁLIDA: só a repetição é problema.
    expect(r.validas).toBe(2);
  });

  it('e-mail que já existe no banco: erro naquela linha (AC-009)', async () => {
    const r = await conferir(['Ana,ana@x.com,,,'], {
      usuarios: [{ email: 'ANA@x.com' }],
    });
    // Comparação sem caixa: `ANA@x.com` e `ana@x.com` são a mesma conta, e o
    // banco recusaria com `23505` se passasse daqui.
    expect(erroNa(r, 2)?.mensagem).toMatch(/já existe uma conta/i);
  });

  it('nível inexistente: erro com os nomes DISPONÍVEIS (AC-011)', async () => {
    const r = await conferir(['Ana,ana@x.com,,Avancado,'], { niveis: NIVEIS });
    // Listar os que existem é a diferença entre "não existe" e "escolha um
    // destes" — e evita a segunda tentativa com outro palpite.
    expect(erroNa(r, 2)?.coluna).toBe('nivel');
    expect(erroNa(r, 2)?.mensagem).toContain('Iniciante, Intermediário');
  });

  it('nível casa SEM acento e SEM caixa', async () => {
    const r = await conferir(['Ana,ana@x.com,,intermediario,'], {
      niveis: [{ id: 'n2', nome: 'Intermediário' }],
    });
    expect(r.erros).toEqual([]);
    expect(r.linhas[0].nivelId).toBe('n2');
  });

  it('só nome e e-mail já basta (D9)', async () => {
    const r = await conferir(['Ana,ana@x.com,,,']);
    expect(r.erros).toEqual([]);
    // `toEqual` com o objeto inteiro: prova também que os campos que saíram
    // na SPEC-083 (nascimento e emergência) não voltam como `null`.
    expect(r.linhas[0]).toEqual({
      linha: 2,
      nome: 'Ana',
      email: 'ana@x.com',
      telefone: null,
      nivelId: null,
      turmaId: null,
      turmaNome: null,
    });
  });

  it('o relatório conta total e válidas separadamente (AC-002)', async () => {
    const r = await conferir([
      'Ana,ana@x.com,,,',
      ',sem-nome@x.com,,,',
      'Beto,beto@x.com,,,',
    ]);
    expect(r.total).toBe(3);
    expect(r.validas).toBe(2);
    expect(r.erros).toHaveLength(1);
  });

  it('e-mail vira minúsculo — a conta é a mesma', async () => {
    const r = await conferir(['Ana,ANA@X.COM,,,']);
    expect(r.linhas[0].email).toBe('ana@x.com');
  });
});

/**
 * SPEC-083/D1 — **cinco colunas, em qualquer ordem, com `;` ou `,`.**
 *
 * O caso que motivou a spec é o primeiro: o Excel em português grava `;`, e o
 * analisador antigo via o cabeçalho inteiro como uma coluna desconhecida. A
 * planilha que o gestor acabou de salvar era recusada.
 */
describe('SPEC-083 — as cinco colunas (AC-001)', () => {
  it.each([
    [
      ';',
      'nome;email;telefone;nivel;turma\r\nAna Souza;ana@x.com;(11) 99999-0000;Iniciante;\r\n',
    ],
    [
      ',',
      'nome,email,telefone,nivel,turma\r\nAna Souza,ana@x.com,(11) 99999-0000,Iniciante,\r\n',
    ],
  ])(
    'o cabeçalho de `%s` é aceito, com todas as colunas lidas',
    async (_sep, csv) => {
      const r = await servico({ niveis: NIVEIS }).conferir('c1', csv);
      expect(r.erros).toEqual([]);
      expect(r.linhas).toEqual([
        {
          linha: 2,
          nome: 'Ana Souza',
          email: 'ana@x.com',
          telefone: '(11) 99999-0000',
          nivelId: 'n1',
          turmaId: null,
          turmaNome: null,
        },
      ]);
    },
  );

  it('em qualquer ordem: o cabeçalho decide onde está cada campo', async () => {
    const r = await servico({ niveis: NIVEIS }).conferir(
      'c1',
      'turma;nivel;telefone;email;nome\r\n;Intermediário;(21) 3333-4444;beto@x.com;Beto Lima\r\n',
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas[0]).toEqual({
      linha: 2,
      nome: 'Beto Lima',
      email: 'beto@x.com',
      telefone: '(21) 3333-4444',
      nivelId: 'n2',
      turmaId: null,
      turmaNome: null,
    });
  });

  it('com os apelidos `E-mail`, `Celular` e `Nível`, em qualquer caixa', async () => {
    const r = await servico({ niveis: NIVEIS }).conferir(
      'c1',
      'Nome;E-mail;Celular;Nível;Turma\r\nCris;cris@x.com;(11) 98888-7777;intermediario;\r\n',
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas[0]).toMatchObject({
      email: 'cris@x.com',
      telefone: '(11) 98888-7777',
      nivelId: 'n2',
    });
  });

  it('**arquivo só com `nome` e `email` é aceito**', async () => {
    const r = await servico({ niveis: NIVEIS }).conferir(
      'c1',
      'nome;email\r\nDani;dani@x.com\r\n',
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas[0]).toEqual({
      linha: 2,
      nome: 'Dani',
      email: 'dani@x.com',
      telefone: null,
      nivelId: null,
      turmaId: null,
      turmaNome: null,
    });
  });

  it('num arquivo de `;`, nome com vírgula sem aspas é UM nome (AC-003)', async () => {
    const r = await servico().conferir(
      'c1',
      'nome;email\r\nSouza, Ana;ana@x.com\r\n',
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas[0].nome).toBe('Souza, Ana');
  });

  it('**o telefone preenchido é gravado em `usuarios.telefone`**', async () => {
    const { servico: s, escritaDe } = montar();
    await s.importar(
      'c1',
      'nome;email;telefone\r\nAna;ana@x.com;(11) 99999-0000\r\nBeto;beto@x.com;\r\n',
      { gestorId: GESTOR },
    );
    // É o `INSERT` em lote que vira as linhas de `usuarios`: o quinto arranjo
    // do `unnest` é o telefone, e o vazio vai `''` — o `nullif` do SQL o
    // grava nulo (o db-spec da 038 confere a coluna).
    const usuarios = escritaDe('usuarios');
    expect(usuarios?.sql).toContain("nullif(d.telefone, '')");
    expect(arranjos(usuarios as Instrucao)[4]).toEqual(['(11) 99999-0000', '']);
  });
});

describe('SPEC-083 — as colunas antigas são recusadas (AC-002)', () => {
  const AS_CINCO = 'nome, email, telefone, nivel, turma';

  it('`dataNascimento` é 422 COLUNA_DESCONHECIDA, e a mensagem cita as cinco', async () => {
    await expect(
      servico().conferir(
        'c1',
        'nome,email,dataNascimento\nAna,ana@x.com,1990-05-10',
      ),
    ).rejects.toMatchObject({
      response: {
        statusCode: 422,
        code: 'COLUNA_DESCONHECIDA',
        colunas: ['dataNascimento'],
        message: expect.stringContaining(AS_CINCO) as unknown,
      },
    });
  });

  it('o cabeçalho do modelo antigo, inteiro, nomeia as três que saíram', async () => {
    // É o que o "Baixar modelo" do Admin gerava antes da SPEC-083 (I5).
    await expect(
      servico().conferir(
        'c1',
        'nome,email,telefone,dataNascimento,emergenciaNome,emergenciaTelefone,nivel\nAna,ana@x.com,,,,,',
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'COLUNA_DESCONHECIDA',
        colunas: ['dataNascimento', 'emergenciaNome', 'emergenciaTelefone'],
      },
    });
  });

  it('**e nada é escrito**: a transação nem abre', async () => {
    const { servico: s, prisma, instrucoes } = montar();
    await expect(
      s.importar(
        'c1',
        'nome;email;dataNascimento\r\nAna;ana@x.com;1990-05-10',
        { gestorId: GESTOR },
      ),
    ).rejects.toMatchObject({ response: { code: 'COLUNA_DESCONHECIDA' } });
    // Contar as escritas, e não só "lançou": uma implementação que gravasse
    // e depois lançasse também ficaria vermelha no `rejects`.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(instrucoes).toEqual([]);
  });
});

/**
 * SPEC-083/I4 e ADR-026 — **nível vazio grava NULO** (AC-005, sabotagem S8).
 *
 * O aluno sem nível conta como o primeiro, mas isso é resolvido na leitura.
 * Gravar o id do primeiro congelaria a ordem de hoje: o gestor reordena, e o
 * aluno ficaria preso no antigo primeiro. Por isso o teste usa um clube COM
 * níveis — num clube sem nível, nulo seria a única resposta possível, e o
 * caso não distinguiria nada.
 */
describe('SPEC-083 — nível vazio fica nulo (AC-005)', () => {
  it('na conferência: sem nível é `null`, e não o id do primeiro', async () => {
    const r = await conferir(
      ['Ana,ana@x.com,,,', 'Beto,beto@x.com,,Intermediário,'],
      {
        niveis: NIVEIS,
      },
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas.map((l) => l.nivelId)).toEqual([null, 'n2']);
  });

  it('**na escrita: `alunos.nivel_id` vai nulo**, e o da linha com nível vai com o id dele', async () => {
    const { servico: s, escritaDe } = montar({ niveis: NIVEIS });
    await s.importar(
      'c1',
      'nome;email;nivel\r\nAna;ana@x.com;\r\nBeto;beto@x.com;Intermediário\r\n',
      { gestorId: GESTOR },
    );
    const alunos = escritaDe('alunos') as Instrucao;
    // O terceiro arranjo do `unnest` é o nível; o vazio vai `''`, e o
    // `nullif(…)::uuid` o grava NULO. `n1` aqui seria a S8: o primeiro nível
    // gravado no lugar do vazio.
    expect(alunos.sql).toContain("nullif(d.nivel_id, '')::uuid");
    expect(arranjos(alunos)[2]).toEqual(['', 'n2']);
  });
});

/**
 * SPEC-083/D3 — **a turma pelo nome, entre as ativas.** O erro provisório da
 * TASK-001 ("a coluna turma ainda não é processada") saiu: a linha com turma
 * agora entra na turma, ou recebe o erro que diz por que não entra. As
 * contagens (capacidade com alocados, aula lotada com reposições) têm prova
 * contra o banco (`spec-083-importacao.db-spec.ts`); aqui fica a decisão
 * por linha.
 */
describe('SPEC-083/D3 — a turma da planilha', () => {
  const TERCA: TurmaDoDuble = {
    id: 't-terca',
    nome: 'Turma Terça 19h',
    capacidade: 10,
    nivelId: 'n1',
  };

  it('casa sem caixa, sem acento e com espaços diferentes; a linha válida leva o id e o nome cadastrado', async () => {
    const r = await conferir(['Ana,ana@x.com,,,  turma TERCA   19h '], {
      niveis: NIVEIS,
      turmas: [TERCA],
    });
    expect(r.erros).toEqual([]);
    expect(r.linhas[0]).toMatchObject({
      turmaId: 't-terca',
      turmaNome: 'Turma Terça 19h',
    });
  });

  it('turma que não está entre as ativas: erro na coluna turma; o clube sem turma ativa diz isso', async () => {
    const r = await conferir(['Ana,ana@x.com,,,Outra'], { niveis: NIVEIS });
    expect(r.erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem:
          'A turma "Outra" não existe — este clube não tem turma ativa.',
      },
    ]);
    expect(r.linhas).toEqual([]);
  });

  it('a busca é só entre as ATIVAS da empresa — o filtro vai no `where`', async () => {
    const { servico: s, prisma } = montar({ niveis: NIVEIS, turmas: [TERCA] });
    await s.conferir(
      'c1',
      [CABECALHO, 'Ana,ana@x.com,,,Turma Terça 19h'].join('\n'),
    );
    expect(prisma.turma.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { companyId: 'c1', status: 'ativa' } }),
    );
  });

  it('arquivo sem turma não paga a consulta de turmas', async () => {
    const { servico: s, prisma } = montar({ niveis: NIVEIS });
    await s.conferir('c1', [CABECALHO, 'Ana,ana@x.com,,,'].join('\n'));
    expect(prisma.turma.findMany).not.toHaveBeenCalled();
  });

  it('linha sem nível em turma que não é do primeiro nível: o texto do gestor (I4)', async () => {
    const r = await conferir(['Ana,ana@x.com,,,Turma Terça 19h'], {
      niveis: NIVEIS,
      turmas: [{ ...TERCA, nivelId: 'n2' }],
    });
    expect(r.erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem:
          'Esta turma é do nível Intermediário, e este aluno ainda não tem nível — ele conta como Iniciante. Para alocá-lo, defina o nível dele.',
      },
    ]);
  });

  it('a capacidade conta os alocados e cai na primeira linha que passa', async () => {
    const r = await conferir(
      [
        'Ana,ana@x.com,,,Turma Terça 19h',
        'Beto,beto@x.com,,,Turma Terça 19h',
        'Cris,cris@x.com,,,Turma Terça 19h',
      ],
      { niveis: NIVEIS, turmas: [{ ...TERCA, capacidade: 3, alocados: 1 }] },
    );
    expect(r.erros).toEqual([
      {
        linha: 4,
        coluna: 'turma',
        mensagem:
          'A turma "Turma Terça 19h" tem 2 vaga(s) livre(s), e a planilha põe 3 aluno(s) nela. Esta é a primeira linha que não cabe.',
      },
    ]);
    expect(r.linhas.map((l) => l.linha)).toEqual([2, 3]);
  });

  it('**a capacidade é conferida de novo dentro da transação** (sob as travas), e a importação recusa com 422 se ela mudou', async () => {
    // Fora da transação, a turma tem vaga; dentro, o dublê diz que encheu —
    // como se outra matrícula tivesse entrado entre a conferência e a trava.
    const {
      servico: s,
      tx,
      instrucoes,
    } = montar({
      niveis: NIVEIS,
      turmas: [{ ...TERCA, capacidade: 1 }],
    });
    tx.turmaAluno.groupBy.mockResolvedValueOnce([
      { turmaId: 't-terca', _count: { _all: 1 } },
    ]);
    await expect(
      s.importar(
        'c1',
        'nome;email;turma\r\nAna;ana@x.com;Turma Terça 19h\r\n',
        {
          gestorId: GESTOR,
        },
      ),
    ).rejects.toMatchObject({
      response: {
        code: 'PLANILHA_COM_ERROS',
        erros: [
          {
            linha: 2,
            coluna: 'turma',
            mensagem: 'A turma "Turma Terça 19h" já está cheia (capacidade 1).',
          },
        ],
      },
    });
    // Nenhuma escrita: a recusa veio antes delas.
    expect(instrucoes.some((i) => /INSERT INTO/.test(i.sql))).toBe(false);
  });
});

/**
 * SPEC-083/D5 — **quem recebe convite é o gestor que marca.** O campo
 * `convidar` traz os números de linha; um que não é linha válida do arquivo
 * recusa tudo com 400, antes de qualquer bcrypt ou transação.
 */
describe('SPEC-083/D5 — `convidar`', () => {
  const ARQUIVO = 'nome;email\r\nAna;ana@x.com\r\nBeto;beto@x.com\r\n';

  it.each([['4'], ['2,9'], ['x'], ['2;3'], ['1']])(
    'convidar=%s → 400 CONVIDAR_LINHA_INVALIDA, sem transação',
    async (convidar) => {
      const { servico: s, prisma } = montar();
      await expect(
        s.importar('c1', ARQUIVO, { gestorId: GESTOR, convidar }),
      ).rejects.toMatchObject({
        response: { statusCode: 400, code: 'CONVIDAR_LINHA_INVALIDA' },
      });
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  it('o campo repetido no multipart (chega como arranjo) é 400, e não 500', async () => {
    const { servico: s, prisma } = montar();
    await expect(
      s.importar('c1', ARQUIVO, {
        gestorId: GESTOR,
        convidar: ['2', '3'] as unknown as string,
      }),
    ).rejects.toMatchObject({
      response: { statusCode: 400, code: 'CONVIDAR_LINHA_INVALIDA' },
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('ausente, vazio ou com espaços: ninguém é convidado, e todos ganham senha', async () => {
    for (const convidar of [undefined, '', '  ']) {
      const { servico: s } = montar();
      const { criados } = await s.importar('c1', ARQUIVO, {
        gestorId: GESTOR,
        convidar,
      });
      expect(
        criados.map((c) => [c.senhaTemporaria !== undefined, c.convite]),
      ).toEqual([
        [true, undefined],
        [true, undefined],
      ]);
    }
  });

  it('a linha convidada sai sem senha e com o resultado do e-mail; a outra, com senha', async () => {
    const { servico: s, escritaDe, memoria } = montar();
    const { criados } = await s.importar('c1', ARQUIVO, {
      gestorId: GESTOR,
      convidar: ' 3 ',
    });
    expect(criados[0].senhaTemporaria).toMatch(/^pck-/);
    expect(criados[0].convite).toBeUndefined();
    expect(criados[1]).not.toHaveProperty('senhaTemporaria');
    expect(criados[1].convite).toEqual({ email: 'enviado' });
    // Um convite gravado, para a conta da linha 3, e um e-mail para ela.
    const convites = escritaDe('convites_de_acesso') as Instrucao;
    expect(arranjos(convites)[1]).toEqual([
      (arranjos(escritaDe('usuarios') as Instrucao)[0] as string[])[1],
    ]);
    expect(memoria.enviados.map((m) => m.to)).toEqual(['beto@x.com']);
  });

  it('sem convidada, nenhuma escrita de convite e nenhum e-mail', async () => {
    const { servico: s, escritaDe, memoria } = montar();
    await s.importar('c1', ARQUIVO, { gestorId: GESTOR });
    expect(escritaDe('convites_de_acesso')).toBeUndefined();
    expect(memoria.blocos).toEqual([]);
  });
});

/**
 * SPEC-083/D3 e AC-049 — **o modo `lote-novo` só matricula quem nasceu na
 * transação.** É a condição sob a qual dispensar a trava por aluno é correto:
 * um aluno de fora seria uma matrícula sem a trava dele.
 */
describe('SPEC-083/AC-049 — o `lote-novo` recusa aluno que não saiu do INSERT', () => {
  it('um aluno_id que não foi registrado é erro de programação (Error, não recusa ao gestor)', () => {
    const lote = new LoteNovo();
    lote.registrarCriados(['a1', 'a2']);
    expect(() => lote.exigirCriados(['a1', 'a2'])).not.toThrow();
    expect(() => lote.exigirCriados(['a1', 'de-fora'])).toThrow(
      /não saíram do INSERT desta transação \(de-fora\)/,
    );
    // Nada registrado: nada passa.
    expect(() => new LoteNovo().exigirCriados(['a1'])).toThrow(Error);
  });

  it('na importação, os ids de `turma_alunos` são os que o INSERT de `alunos` devolveu', async () => {
    const {
      servico: s,
      tx,
      escritaDe,
    } = montar({
      niveis: NIVEIS,
      turmas: [{ id: 't-terca', nome: 'Terça', capacidade: 10, nivelId: 'n1' }],
    });
    // O dublê devolve, do INSERT de alunos, um id que NÃO é o da linha: o
    // lote tem de recusar antes de escrever a matrícula.
    const original = tx.$queryRaw.getMockImplementation() as (
      ...a: unknown[]
    ) => Promise<unknown>;
    tx.$queryRaw.mockImplementation((primeiro: unknown, ...resto: unknown[]) =>
      montarSql(primeiro, resto).sql.includes('INSERT INTO alunos')
        ? Promise.resolve([{ id: 'aluno-que-nao-e-do-lote' }])
        : original(primeiro, ...resto),
    );
    await expect(
      s.importar('c1', 'nome;email;turma\r\nAna;ana@x.com;Terça\r\n', {
        gestorId: GESTOR,
      }),
    ).rejects.toThrow(/lote-novo/);
    expect(escritaDe('turma_alunos')).toBeUndefined();
  });
});

/**
 * SPEC-083/D2 — **a codificação vem dos bytes** (AC-004).
 *
 * O mesmo conteúdo — `nome;email;nivel`, `João;joao@exemplo.com;Intermediário`
 * — em três codificações, com os **bytes escritos aqui**, e não produzidos
 * por um codificador: se o teste gerasse os bytes com o próprio Node, ele
 * provaria que o Node concorda com ele mesmo.
 *
 * Só o `ã` e o `á` mudam de uma para outra: `c3 a3` / `c3 a1` em UTF-8, `e3` /
 * `e1` em Windows-1252.
 */
describe('SPEC-083 — a codificação vem dos bytes (AC-004)', () => {
  const hex = (...partes: string[]) =>
    Buffer.from(partes.join('').replace(/\s/g, ''), 'hex');

  /** `nome;email;nivel\r\n` — ASCII, igual nas três. */
  const CABECALHO_HEX = '6e6f6d65 3b 656d61696c 3b 6e6976656c 0d0a';
  /** `João;joao@exemplo.com;Intermediário\r\n` em UTF-8. */
  const LINHA_UTF8 =
    '4a6f c3a3 6f 3b 6a6f616f 40 6578656d706c6f 2e 636f6d 3b 496e7465726d656469 c3a1 72696f 0d0a';
  /** A mesma linha em Windows-1252. */
  const LINHA_1252 =
    '4a6f e3 6f 3b 6a6f616f 40 6578656d706c6f 2e 636f6d 3b 496e7465726d656469 e1 72696f 0d0a';

  const UTF8_COM_BOM = hex('efbbbf', CABECALHO_HEX, LINHA_UTF8);
  const UTF8_SEM_BOM = hex(CABECALHO_HEX, LINHA_UTF8);
  const WINDOWS_1252 = hex(CABECALHO_HEX, LINHA_1252);

  const CASOS: [string, Buffer][] = [
    ['UTF-8 com BOM', UTF8_COM_BOM],
    ['UTF-8 sem BOM', UTF8_SEM_BOM],
    ['Windows-1252', WINDOWS_1252],
  ];

  /** O mesmo teste que o controller faz: UTF-8 estrito decodifica ou lança.
   *  (Booleano, e não `toThrow(TypeError)`: o `TypeError` do Node vem de outro
   *  realm que o do jest, e o construtor não casa.) */
  const ehUtf8Valido = (bytes: Uint8Array): boolean => {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      return true;
    } catch {
      return false;
    }
  };

  it('**os bytes 1252 NÃO são UTF-8 válido** — sem isto, o caso não distingue nada', () => {
    // Se os bytes 1252 fossem UTF-8 válido, o primeiro decodificador os
    // aceitaria, e o ramo do `windows-1252` nunca seria exercitado.
    expect(ehUtf8Valido(WINDOWS_1252)).toBe(false);
    // E os dois de UTF-8 são: o ramo estrito é o que os lê.
    expect(ehUtf8Valido(UTF8_COM_BOM)).toBe(true);
    expect(ehUtf8Valido(UTF8_SEM_BOM)).toBe(true);
    // O que o controller fazia antes desta spec: o `ã` virava `\uFFFD`.
    expect(WINDOWS_1252.toString('utf8')).toContain('Jo\uFFFDo');
    // Três arquivos de fato diferentes.
    expect(UTF8_COM_BOM.equals(UTF8_SEM_BOM)).toBe(false);
    expect(UTF8_SEM_BOM.equals(WINDOWS_1252)).toBe(false);
  });

  it.each(CASOS)(
    '`decodificarPlanilha` lê %s com os acentos certos',
    (_nome, bytes) => {
      const texto = decodificarPlanilha(bytes);
      expect(texto).toContain('João');
      expect(texto).toContain('Intermediário');
      expect(texto).not.toContain('\uFFFD');
    },
  );

  it('**o BOM chega ao analisador, que o remove** (D2)', () => {
    // `ignoreBOM: true`: o decodificador não o engole, e a remoção continua
    // num lugar só — o analisador.
    expect(decodificarPlanilha(UTF8_COM_BOM).charCodeAt(0)).toBe(0xfeff);
  });

  /**
   * **Pelo controller, e não pela função solta.** É o caminho do upload: um
   * controller que voltasse ao `toString('utf8')` deixaria a função verde e
   * este caso vermelho.
   */
  it('pelo controller, as três produzem o MESMO relatório, com `João` e o nível casado', async () => {
    const relatorios: RelatorioDeImportacaoDto[] = [];
    for (const [, bytes] of CASOS) {
      const { servico: s } = montar({ niveis: NIVEIS });
      const controller = new ImportacaoController(s);
      relatorios.push(
        (await controller.importar(
          { companyId: 'c1' } as AccessTokenPayload,
          'true',
          { buffer: bytes } as Express.Multer.File,
        )) as RelatorioDeImportacaoDto,
      );
    }

    expect(relatorios[0]).toEqual({
      total: 1,
      validas: 1,
      erros: [],
      linhas: [
        {
          linha: 2,
          nome: 'João',
          email: 'joao@exemplo.com',
          telefone: null,
          nivelId: 'n2',
          turmaId: null,
          turmaNome: null,
        },
      ],
    });
    expect(relatorios[1]).toEqual(relatorios[0]);
    expect(relatorios[2]).toEqual(relatorios[0]);
  });
});

/**
 * SPEC-083/D2 e AC-006, a metade do Back — **a fixture do modelo passa na
 * conferência.** Ela tem os mesmos bytes do arquivo de referência da spec, que
 * é o que o Admin publica no "Baixar modelo" (a outra metade, TASK-007).
 */
describe('SPEC-083 — o modelo novo (AC-006, metade do Back)', () => {
  const MODELO = readFileSync(
    join(__dirname, '..', '..', '..', 'test', 'fixtures', 'modelo-alunos.csv'),
  );

  it('a fixture tem os bytes do modelo da spec: BOM, `;` e CRLF', () => {
    // O hash é o do `specs/changes/083-o-convite-que-chega-por-email/
    // modelo-alunos.csv`. Se o git converter o fim de linha (o
    // `.gitattributes` marca a fixture `-text` para isso não acontecer), é
    // aqui que fica vermelho, e não numa conferência que passaria com LF.
    expect(createHash('sha256').update(MODELO).digest('hex')).toBe(
      '5846b7ea861fef5fcf032c45f4cad048a5ffb4ca393f90aa99c3a25310a771a6',
    );
    expect([...MODELO.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(MODELO.subarray(3, 36).toString('latin1')).toBe(
      'nome;email;telefone;nivel;turma\r\n',
    );
  });

  /** A turma que o modelo cita, num clube que a tem ativa e no nível certo. */
  const TURMA_DO_MODELO: TurmaDoDuble = {
    id: 't-terca',
    nome: 'Turma Terça 19h',
    capacidade: 10,
    nivelId: 'n1',
  };

  const conferirModelo = async (turmas: TurmaDoDuble[]) => {
    const { servico: s } = montar({ niveis: NIVEIS, turmas });
    const controller = new ImportacaoController(s);
    // Não lançar já é a prova de cabeçalho: `COLUNA_DESCONHECIDA` e
    // `PLANILHA_SEM_CABECALHO` são exceções, e não erros de linha.
    return (await controller.importar(
      { companyId: 'c1' } as AccessTokenPayload,
      'true',
      { buffer: MODELO } as Express.Multer.File,
    )) as RelatorioDeImportacaoDto;
  };

  it('**passa na conferência sem nenhum erro**, num clube com a turma do exemplo', async () => {
    const r = await conferirModelo([TURMA_DO_MODELO]);

    // O erro provisório da TASK-001 ("a coluna turma ainda não é processada")
    // saiu na TASK-005: com a turma ativa, o modelo inteiro é válido, e a Ana
    // leva a turma achada pelo nome.
    expect(r.total).toBe(3);
    expect(r.erros).toEqual([]);
    expect(r.linhas).toEqual([
      {
        linha: 2,
        nome: 'Ana Souza',
        email: 'ana@exemplo.com',
        telefone: '(11) 99999-0000',
        nivelId: 'n1',
        turmaId: 't-terca',
        turmaNome: 'Turma Terça 19h',
      },
      {
        linha: 3,
        nome: 'Carlos Lima',
        email: 'carlos@exemplo.com',
        telefone: '(11) 98888-7777',
        nivelId: null,
        turmaId: null,
        turmaNome: null,
      },
      {
        linha: 4,
        nome: 'Beatriz Rocha',
        email: 'beatriz@exemplo.com',
        telefone: null,
        nivelId: 'n2',
        turmaId: null,
        turmaNome: null,
      },
    ]);
  });

  it('num clube SEM a turma do exemplo, o único erro é o de turma, e é de linha (não de cabeçalho)', async () => {
    const r = await conferirModelo([]);
    expect(r.erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem: expect.stringContaining('Turma Terça 19h') as unknown,
      },
    ]);
    expect(r.linhas.map((l) => l.linha)).toEqual([3, 4]);
  });
});

/**
 * SPEC-083/D3, passo 5, e AC-048 — **a tradução da importação, um caso por
 * etapa.** O erro nasce no dublê, na instrução daquela etapa, e a resposta
 * sai do CONTROLLER: é ele que traduz (a borda HTTP, como a D4 da 082), e é o
 * serviço que marca a etapa. Um caso que chamasse a função de tradução com a
 * etapa escrita à mão provaria a tabela, e não que o serviço marca certo.
 */
describe('SPEC-083/AC-048 — a tradução da importação, por etapa', () => {
  /** Como reconhecer, no dublê, a instrução de cada etapa. */
  const INSTRUCAO_DA_ETAPA: Record<
    EtapaDaImportacao,
    (sql: string) => boolean
  > = {
    travas: (s) => s.includes('pg_advisory_xact_lock_shared'),
    referenciadas: (s) => s.includes('FROM empresas e2'),
    turmas: (s) => s.includes('FROM turmas t2'),
    ajuste: (s) => s.includes('AS guardado'),
    usuarios: (s) => s.includes('INSERT INTO usuarios'),
    alunos: (s) => s.includes('INSERT INTO alunos'),
    turma_alunos: (s) => s.includes('INSERT INTO turma_alunos'),
    convites_de_acesso: (s) => s.includes('INSERT INTO convites_de_acesso'),
    reposicao: (s) =>
      s.includes("set_config('statement_timeout'") &&
      !s.includes('lock_timeout'),
  };

  const erroDoBanco = (sqlstate: string) =>
    new Prisma.PrismaClientKnownRequestError(`falhou com ${sqlstate}`, {
      code: 'P2010',
      clientVersion: 'teste',
      meta: { code: sqlstate },
    });

  /** Um arquivo que passa por TODAS as etapas: turma e convidada. */
  const ARQUIVO =
    'nome;email;turma\r\nAna;ana@x.com;Terça\r\nBeto;beto@x.com;\r\n';

  async function falharNa(etapa: EtapaDaImportacao, erro: Error) {
    const { servico: s, tx } = montar({
      niveis: NIVEIS,
      turmas: [{ id: 't-terca', nome: 'Terça', capacidade: 10, nivelId: 'n1' }],
    });
    let lancou = false;
    for (const metodo of ['$queryRaw', '$executeRaw'] as const) {
      const original = tx[metodo].getMockImplementation() as (
        ...a: unknown[]
      ) => Promise<unknown>;
      tx[metodo].mockImplementation(
        (primeiro: unknown, ...resto: unknown[]) => {
          if (
            !lancou &&
            INSTRUCAO_DA_ETAPA[etapa](montarSql(primeiro, resto).sql)
          ) {
            lancou = true;
            return Promise.reject(erro);
          }
          // `$queryRaw` e `$executeRaw` resolvem tipos diferentes no dublê; o
          // original é o de cada um.
          return original(primeiro, ...resto) as Promise<never>;
        },
      );
    }
    const controller = new ImportacaoController(s);
    let resposta: unknown;
    try {
      await controller.importar(
        { companyId: 'c1', sub: GESTOR } as AccessTokenPayload,
        undefined,
        { buffer: Buffer.from(ARQUIVO, 'utf8') } as Express.Multer.File,
        '3',
      );
    } catch (e) {
      resposta = e;
    }
    // A precondição: a instrução daquela etapa existiu e foi a que falhou.
    expect(lancou).toBe(true);
    return resposta;
  }

  const comoHttp = (e: unknown) => {
    expect(e).toBeInstanceOf(HttpException);
    const http = e as HttpException;
    const corpo = http.getResponse() as { code: string; message: string };
    return {
      status: http.getStatus(),
      code: corpo.code,
      message: corpo.message,
    };
  };

  const TODAS = Object.keys(INSTRUCAO_DA_ETAPA) as EtapaDaImportacao[];

  it.each(TODAS)(
    '55P03 na etapa %s → 409 MATRICULA_EM_ANDAMENTO, I4 só nas turmas',
    async (etapa) => {
      const e = await falharNa(etapa, erroDoBanco('55P03'));
      expect(comoHttp(e)).toEqual({
        status: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message:
          etapa === 'turmas'
            ? MENSAGEM_OUTRA_PESSOA_NA_TURMA
            : MENSAGEM_ALTERACAO_EM_ANDAMENTO,
      });
    },
  );

  const COM_PRAZO_DE_INSTRUCAO: EtapaDaImportacao[] = [
    'ajuste',
    'usuarios',
    'alunos',
    'turma_alunos',
    'convites_de_acesso',
    'reposicao',
  ];

  it.each(COM_PRAZO_DE_INSTRUCAO)(
    '57014 (o statement_timeout) na etapa %s → 409 com o texto I6 (LIM-083m)',
    async (etapa) => {
      const e = await falharNa(etapa, erroDoBanco('57014'));
      expect(comoHttp(e)).toEqual({
        status: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message: MENSAGEM_ALTERACAO_EM_ANDAMENTO,
      });
    },
  );

  it.each(TODAS.filter((t) => !COM_PRAZO_DE_INSTRUCAO.includes(t)))(
    '57014 na etapa %s, onde a importação não fixa statement_timeout, sobe como veio (500)',
    async (etapa) => {
      const erro = erroDoBanco('57014');
      const e = await falharNa(etapa, erro);
      expect(e).toBe(erro);
      expect(etapaDaImportacao(e)).toBe(etapa);
    },
  );

  it.each(['P2028', 'P2024'])(
    '%s → 503 SERVIDOR_OCUPADO com o texto I5',
    async (codigo) => {
      const erro = new Prisma.PrismaClientKnownRequestError('ocupado', {
        code: codigo,
        clientVersion: 'teste',
      });
      // O `P2028` é do `$transaction`, e não de uma instrução: sem etapa.
      const { servico: s, prisma } = montar();
      prisma.$transaction.mockRejectedValueOnce(erro);
      const controller = new ImportacaoController(s);
      let e: unknown;
      try {
        await controller.importar(
          { companyId: 'c1', sub: GESTOR } as AccessTokenPayload,
          undefined,
          {
            buffer: Buffer.from('nome;email\r\nAna;ana@x.com\r\n'),
          } as Express.Multer.File,
        );
      } catch (x) {
        e = x;
      }
      expect(comoHttp(e)).toEqual({
        status: 503,
        code: 'SERVIDOR_OCUPADO',
        message: MENSAGEM_SERVIDOR_OCUPADO,
      });
    },
  );

  it('um erro qualquer, sem SQLSTATE de espera, sobe como veio', async () => {
    const erro = erroDoBanco('23503');
    const e = await falharNa('alunos', erro);
    expect(e).toBe(erro);
    expect(etapaDaImportacao(e)).toBe('alunos');
  });
});
