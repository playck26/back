import { ImportacaoDeAlunosService } from './importacao-de-alunos.service';
import type { PrismaService } from '../../prisma/prisma.service';

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
function servico(
  overrides: {
    usuarios?: { email: string }[];
    niveis?: { id: string; nome: string }[];
  } = {},
) {
  const prisma = {
    usuario: {
      findMany: jest.fn().mockResolvedValue(overrides.usuarios ?? []),
    },
    nivel: { findMany: jest.fn().mockResolvedValue(overrides.niveis ?? []) },
  };
  return new ImportacaoDeAlunosService(prisma as unknown as PrismaService);
}

const CABECALHO = 'nome,email,telefone,dataNascimento,nivel';

async function conferir(
  linhas: string[],
  overrides?: Parameters<typeof servico>[0],
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

  it('aceita o cabeçalho como o gestor escreveria', async () => {
    // `data de nascimento` com espaços e acento é o que sai de uma planilha
    // feita à mão. Recusá-lo transformaria o primeiro uso numa caça ao nome
    // exato da coluna.
    const r = await servico().conferir(
      'c1',
      'Nome,E-mail,Data de Nascimento\nAna,ana@x.com,1990-05-10',
    );
    expect(r.erros).toEqual([]);
    expect(r.linhas[0].dataNascimento?.toISOString().slice(0, 10)).toBe(
      '1990-05-10',
    );
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

  it('data implausível: erro naquela linha, com a MESMA regra da SPEC-036 (AC-010)', async () => {
    const r = await conferir([
      'Ana,ana@x.com,,2099-01-01,',
      'Beto,beto@x.com,,2026-02-31,',
    ]);
    // `2026-02-31` casa o formato e não existe. Reimplementar a regra aqui
    // criaria uma segunda verdade sobre datas plausíveis — e a primeira a
    // divergir seria esta, que ninguém olha depois de importar.
    expect(erroNa(r, 2)?.coluna).toBe('dataNascimento');
    expect(erroNa(r, 3)?.coluna).toBe('dataNascimento');
    expect(r.validas).toBe(0);
  });

  it('nível inexistente: erro com os nomes DISPONÍVEIS (AC-011)', async () => {
    const r = await conferir(['Ana,ana@x.com,,,Avancado'], {
      niveis: [
        { id: 'n1', nome: 'Iniciante' },
        { id: 'n2', nome: 'Intermediário' },
      ],
    });
    // Listar os que existem é a diferença entre "não existe" e "escolha um
    // destes" — e evita a segunda tentativa com outro palpite.
    expect(erroNa(r, 2)?.mensagem).toContain('Iniciante, Intermediário');
  });

  it('nível casa SEM acento e SEM caixa', async () => {
    const r = await conferir(['Ana,ana@x.com,,,intermediario'], {
      niveis: [{ id: 'n2', nome: 'Intermediário' }],
    });
    expect(r.erros).toEqual([]);
    expect(r.linhas[0].nivelId).toBe('n2');
  });

  it('só nome e e-mail já basta — 29% de completude é estado legítimo (D9)', async () => {
    const r = await conferir(['Ana,ana@x.com,,,']);
    expect(r.erros).toEqual([]);
    expect(r.linhas[0]).toMatchObject({
      nome: 'Ana',
      email: 'ana@x.com',
      telefone: null,
      dataNascimento: null,
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
