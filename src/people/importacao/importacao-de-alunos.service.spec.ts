import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ImportacaoDeAlunosService } from './importacao-de-alunos.service';
import {
  ImportacaoController,
  decodificarPlanilha,
} from './importacao.controller';
import type { RelatorioDeImportacaoDto } from './dto/importacao-response.dto';
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
type DadosDoUsuario = { email: string; telefone: string | null };
type DadosDoAluno = { nivelId: string | null };

/**
 * O serviço com um Prisma de mentira, **e a transação aberta para olhar**: o
 * `tx` registra o que a importação mandou gravar, e é por ele que se prova o
 * que vai para `usuarios.telefone` e `alunos.nivel_id` sem banco.
 */
function montar(
  overrides: {
    usuarios?: { email: string }[];
    niveis?: { id: string; nome: string }[];
  } = {},
) {
  const tx = {
    usuario: {
      create: jest
        .fn<
          Promise<{ id: string; email: string }>,
          [{ data: DadosDoUsuario }]
        >()
        .mockImplementation(({ data }) =>
          Promise.resolve({ id: `u-${data.email}`, email: data.email }),
        ),
    },
    aluno: {
      create: jest
        .fn<Promise<{ id: string }>, [{ data: DadosDoAluno }]>()
        .mockResolvedValue({ id: 'a-1' }),
    },
  };
  const prisma = {
    usuario: {
      findMany: jest.fn().mockResolvedValue(overrides.usuarios ?? []),
    },
    nivel: { findMany: jest.fn().mockResolvedValue(overrides.niveis ?? []) },
    $transaction: jest.fn((fn: (t: typeof tx) => Promise<unknown>) => fn(tx)),
  };
  const servico = new ImportacaoDeAlunosService(
    prisma as unknown as PrismaService,
  );
  return { servico, prisma, tx };
}

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
    const { servico: s, tx } = montar();
    await s.importar(
      'c1',
      'nome;email;telefone\r\nAna;ana@x.com;(11) 99999-0000\r\nBeto;beto@x.com;\r\n',
    );
    // É o `tx.usuario.create` que vira a linha de `usuarios`: o que a
    // importação manda para ele é o que o banco grava.
    const telefones = tx.usuario.create.mock.calls.map(
      ([arg]) => arg.data.telefone,
    );
    expect(telefones).toEqual(['(11) 99999-0000', null]);
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
    const { servico: s, prisma, tx } = montar();
    await expect(
      s.importar('c1', 'nome;email;dataNascimento\r\nAna;ana@x.com;1990-05-10'),
    ).rejects.toMatchObject({ response: { code: 'COLUNA_DESCONHECIDA' } });
    // Contar as escritas, e não só "lançou": uma implementação que gravasse
    // e depois lançasse também ficaria vermelha no `rejects`.
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(tx.usuario.create).not.toHaveBeenCalled();
    expect(tx.aluno.create).not.toHaveBeenCalled();
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
    const { servico: s, tx } = montar({ niveis: NIVEIS });
    await s.importar(
      'c1',
      'nome;email;nivel\r\nAna;ana@x.com;\r\nBeto;beto@x.com;Intermediário\r\n',
    );
    const gravados = tx.aluno.create.mock.calls.map(
      ([arg]) => arg.data.nivelId,
    );
    // `n1` aqui seria a S8: o primeiro nível gravado no lugar do vazio.
    expect(gravados).toEqual([null, 'n2']);
  });
});

/**
 * SPEC-083/TASK-001 — **a coluna `turma` é reconhecida, mas ainda não é
 * processada.** A busca pelo nome (D3) é da TASK-005, que depende da SPEC-082.
 * Até lá, a linha com turma é ERRO na conferência, e não um valor ignorado em
 * silêncio. **Este bloco é provisório: a TASK-005 o troca pelos casos da D3.**
 */
describe('SPEC-083 — turma: erro provisório até a TASK-005', () => {
  it('só a linha COM turma recebe o erro, na coluna `turma`', async () => {
    const r = await conferir(
      ['Ana,ana@x.com,,,Turma Terça 19h', 'Beto,beto@x.com,,,'],
      { niveis: NIVEIS },
    );
    expect(r.erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem: expect.stringContaining(
          'ainda não é processada nesta versão',
        ) as unknown,
      },
    ]);
    // A linha sem turma, no mesmo arquivo, continua válida.
    expect(r.linhas.map((l) => l.linha)).toEqual([3]);
  });

  it('**a importação recusa o arquivo, e não importa o aluno sem a turma**', async () => {
    const { servico: s, prisma } = montar();
    await expect(
      s.importar('c1', 'nome;email;turma\r\nAna;ana@x.com;Turma Terça 19h\r\n'),
    ).rejects.toMatchObject({ response: { code: 'PLANILHA_COM_ERROS' } });
    // Ignorar a turma importaria a Ana fora da turma que o gestor escreveu.
    expect(prisma.$transaction).not.toHaveBeenCalled();
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

  it('**passa na conferência sem erro de cabeçalho**; o erro provisório de turma cai só na linha que tem turma', async () => {
    const { servico: s } = montar({ niveis: NIVEIS });
    const controller = new ImportacaoController(s);

    // Não lançar já é a prova de cabeçalho: `COLUNA_DESCONHECIDA` e
    // `PLANILHA_SEM_CABECALHO` são exceções, e não erros de linha.
    const r = (await controller.importar(
      { companyId: 'c1' } as AccessTokenPayload,
      'true',
      { buffer: MODELO } as Express.Multer.File,
    )) as RelatorioDeImportacaoDto;

    expect(r.total).toBe(3);
    // A Ana (linha 2) é a única com turma no modelo. Até a TASK-005, a coluna
    // turma é reconhecida e ainda não processada: o erro é dela, e só dela.
    expect(r.erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem: expect.stringContaining('Turma Terça 19h') as unknown,
      },
    ]);
    expect(r.linhas).toEqual([
      {
        linha: 3,
        nome: 'Carlos Lima',
        email: 'carlos@exemplo.com',
        telefone: '(11) 98888-7777',
        nivelId: null,
      },
      {
        linha: 4,
        nome: 'Beatriz Rocha',
        email: 'beatriz@exemplo.com',
        telefone: null,
        nivelId: 'n2',
      },
    ]);
  });
});
