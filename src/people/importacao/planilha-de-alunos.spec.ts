import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { analisarCsv, detectarSeparador, linhasComNumero } from './csv';
import { ExportacaoDeAlunosService } from './exportacao-de-alunos.service';
import {
  celulaDaPlanilha,
  montarPlanilhaDeAlunos,
  nomeDoArquivoDaPlanilha,
  quantasColunasDeTurma,
  statusNaPlanilha,
  type AlunoDaPlanilha,
} from './planilha-de-alunos';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * SPEC-092 — a planilha exportada, sem banco.
 *
 * **Toda prova de formato relê o arquivo pelo `csv.ts`**, que é o leitor da
 * importação. Comparar o texto com uma string esperada provaria só que o
 * escritor escreve o que o teste espera; reler pelo leitor de verdade prova
 * que o que sai daqui é o que a importação entende.
 */

const aluno = (parcial: Partial<AlunoDaPlanilha> = {}): AlunoDaPlanilha => ({
  nome: 'Ana Souza',
  email: 'ana@clube.local',
  telefone: '(11) 99999-0000',
  nivel: 'Iniciante',
  turmas: [],
  status: 'ativo',
  ...parcial,
});

/** O arquivo, relido pelo leitor da importação. */
function reler(conteudo: string): string[][] {
  return linhasComNumero(conteudo).map((l) => l.campos);
}

describe('SPEC-092 — o formato do modelo (D1)', () => {
  it('BOM, `;` e CRLF, com cada linha terminada em CRLF', () => {
    const arquivo = montarPlanilhaDeAlunos([aluno()]);
    expect(arquivo.charCodeAt(0)).toBe(0xfeff);
    expect(detectarSeparador(arquivo)).toBe(';');
    expect(arquivo.endsWith('\r\n')).toBe(true);
    // Nenhum `\n` sozinho: todo fim de linha é CRLF.
    expect(arquivo.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
  });

  it('as sete primeiras colunas têm os rótulos do modelo, byte a byte', () => {
    // O modelo distribuído mora na fixture que a SPEC-091 já confere contra o
    // Admin. Mudar um rótulo aqui sem mudar lá reprova.
    const modelo = readFileSync(
      join(
        __dirname,
        '..',
        '..',
        '..',
        'test',
        'fixtures',
        'modelo-alunos.csv',
      ),
      'utf8',
    );
    const cabecalhoDoModelo = reler(modelo)[0];
    const [cabecalho] = reler(montarPlanilhaDeAlunos([aluno()]));
    expect(cabecalho.slice(0, 7)).toEqual(cabecalhoDoModelo);
    expect(cabecalho).toEqual([...cabecalhoDoModelo, 'Status']);
  });

  it('o aluno sem nível e sem telefone sai com as células vazias (D4)', () => {
    const [, linha] = reler(
      montarPlanilhaDeAlunos([aluno({ nivel: null, telefone: null })]),
    );
    expect(linha).toEqual([
      'Ana Souza',
      'ana@clube.local',
      '',
      '',
      '',
      '',
      '',
      'ativo',
    ]);
  });

  it('clube sem aluno: só o cabeçalho', () => {
    expect(reler(montarPlanilhaDeAlunos([]))).toEqual([
      [
        'Nome',
        'E-mail',
        'Telefone',
        'Nível',
        'Turma 1',
        'Turma 2',
        'Turma 3',
        'Status',
      ],
    ]);
  });
});

describe('SPEC-092/AC-002 — as colunas de turma crescem com o aluno', () => {
  it('um aluno em 5 turmas dá Turma 1 a 5; os outros ficam com as extras vazias', () => {
    const cinco = ['A', 'B', 'C', 'D', 'E'];
    const linhas = reler(
      montarPlanilhaDeAlunos([
        aluno({ email: 'cinco@clube.local', turmas: cinco }),
        aluno({ email: 'uma@clube.local', turmas: ['A'] }),
      ]),
    );
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
    expect(linhas[1].slice(4, 9)).toEqual(cinco);
    expect(linhas[2].slice(4, 9)).toEqual(['A', '', '', '', '']);
    // O Status continua na última coluna das duas.
    expect(linhas.map((l) => l[9])).toEqual(['Status', 'ativo', 'ativo']);
  });

  it('ninguém acima de 3: só Turma 1 a 3', () => {
    const [cabecalho] = reler(
      montarPlanilhaDeAlunos([aluno({ turmas: ['A', 'B', 'C'] })]),
    );
    expect(cabecalho.filter((c) => c.startsWith('Turma'))).toEqual([
      'Turma 1',
      'Turma 2',
      'Turma 3',
    ]);
    expect(quantasColunasDeTurma([aluno({ turmas: ['A'] })])).toBe(3);
    expect(quantasColunasDeTurma([])).toBe(3);
  });
});

describe('SPEC-092/AC-003 — o Status (D3)', () => {
  const casos: [string, Parameters<typeof statusNaPlanilha>[0], string][] = [
    [
      'ativo',
      { alunoInativo: false, contaInativa: false, senhaTemporaria: false },
      'ativo',
    ],
    [
      'desativado pelo aluno',
      { alunoInativo: true, contaInativa: false, senhaTemporaria: false },
      'desativado',
    ],
    [
      'desativado pela conta',
      { alunoInativo: false, contaInativa: true, senhaTemporaria: false },
      'desativado',
    ],
    [
      'pendente',
      { alunoInativo: false, contaInativa: false, senhaTemporaria: true },
      'pendente',
    ],
    [
      'desativado com senha temporária: desativado vence',
      { alunoInativo: true, contaInativa: false, senhaTemporaria: true },
      'desativado',
    ],
    [
      'conta desativada com senha temporária: desativado vence',
      { alunoInativo: false, contaInativa: true, senhaTemporaria: true },
      'desativado',
    ],
  ];

  it.each(casos)('%s', (_rotulo, situacao, esperado) => {
    expect(statusNaPlanilha(situacao)).toBe(esperado);
  });
});

describe('SPEC-092/AC-004 — proteção contra fórmula e aspas (D5)', () => {
  it.each([
    ['=HYPERLINK("x")', `"'=HYPERLINK(""x"")"`],
    ['+55 11 99999-0000', "'+55 11 99999-0000"],
    ['-1', "'-1"],
    ['@SOMA', "'@SOMA"],
    ['\tescondido', "'\tescondido"],
    ['\rescondido', `"'\rescondido"`],
    ['Souza; Ana', '"Souza; Ana"'],
    ['Ana "Aninha"', '"Ana ""Aninha"""'],
    ['linha 1\nlinha 2', '"linha 1\nlinha 2"'],
    ['Ana Souza', 'Ana Souza'],
    ['ana-souza@clube.local', 'ana-souza@clube.local'],
    ['(11) 99999-0000', '(11) 99999-0000'],
    ['', ''],
  ])('%j sai como %j', (valor, celula) => {
    expect(celulaDaPlanilha(valor)).toBe(celula);
  });

  it('o arquivo relido pelo `csv.ts` devolve os valores certos', () => {
    const perigosos = aluno({
      nome: '=1+1',
      email: 'perigo@clube.local',
      telefone: '+55 (11) 9999-0000',
      nivel: 'Nível "A"; avançado',
      turmas: ['@Turma', '-Sábado\n9h', 'Terça; 19h'],
    });
    const linhas = analisarCsv(
      montarPlanilhaDeAlunos([perigosos]),
      detectarSeparador(montarPlanilhaDeAlunos([perigosos])),
    );
    expect(linhas[1]).toEqual([
      "'=1+1",
      'perigo@clube.local',
      "'+55 (11) 9999-0000",
      'Nível "A"; avançado',
      "'@Turma",
      "'-Sábado\n9h",
      'Terça; 19h',
      'ativo',
    ]);
    // Uma linha de aluno, e nenhuma a mais: a quebra de linha ficou dentro da
    // célula, e não partiu o aluno em dois.
    expect(linhas).toHaveLength(2);
  });
});

describe('SPEC-092/D6 — o nome do arquivo e a consulta única', () => {
  it('a data é a de hoje no fuso do clube, não em UTC', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([]) };
    const servico = new ExportacaoDeAlunosService(
      prisma as unknown as PrismaService,
    );
    // 23h30 de 29/10 em São Paulo já é 30/10 em UTC.
    const { nomeDoArquivo } = await servico.exportar(
      'c1',
      new Date('2026-10-30T02:30:00Z'),
    );
    expect(nomeDoArquivo).toBe('alunos-2026-10-29.csv');
    expect(nomeDoArquivoDaPlanilha('2026-01-02')).toBe('alunos-2026-01-02.csv');
  });

  it('uma consulta só, com o clube como parâmetro (DEF-013)', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        {
          nome: 'Ana',
          email: 'ana@clube.local',
          telefone: null,
          nivel: 'Iniciante',
          aluno_inativo: false,
          conta_inativa: false,
          senha_temporaria: true,
          turmas: ['A'],
        },
        {
          nome: 'Beto',
          email: 'beto@clube.local',
          telefone: '1',
          nivel: null,
          aluno_inativo: true,
          conta_inativa: false,
          senha_temporaria: true,
          turmas: [],
        },
      ]),
    };
    const servico = new ExportacaoDeAlunosService(
      prisma as unknown as PrismaService,
    );
    const alunos = await servico.alunosDoClube('clube-x');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$queryRaw.mock.calls[0] as [{ values: unknown[] }])[0];
    expect(sql.values).toEqual(['clube-x']);
    expect(alunos.map((a) => a.status)).toEqual(['pendente', 'desativado']);
  });
});
