import { analisarCsv, detectarSeparador, linhasComNumero } from './csv';

/**
 * SPEC-038/TASK-001 — a tabela-verdade do analisador.
 *
 * **Um analisador se prova analisando.** Não há banco, transação nem
 * concorrência aqui: há uma gramática pequena e cinco casos que quebram a
 * implementação ingênua (`split(',')`).
 *
 * O caso do **BOM** é o que mais importa: sem removê-lo, a primeira coluna do
 * cabeçalho se chama `\uFEFFnome` e nunca casa com `nome`. A planilha inteira é
 * recusada com "coluna desconhecida" apontando para uma coluna que, na tela do
 * gestor, está escrita certa — e ele não tem como descobrir sozinho.
 */
describe('SPEC-038 — analisarCsv', () => {
  it('o caso simples', () => {
    expect(analisarCsv('a,b,c\n1,2,3', ',')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('vírgula DENTRO do campo, entre aspas', () => {
    // É o motivo de as aspas existirem. `split(',')` daria quatro campos.
    expect(analisarCsv('nome,cidade\n"Souza, Ana",Santos', ',')).toEqual([
      ['nome', 'cidade'],
      ['Souza, Ana', 'Santos'],
    ]);
  });

  it('aspas escapadas dobram', () => {
    expect(analisarCsv('a\n"ele disse ""oi"""', ',')).toEqual([
      ['a'],
      ['ele disse "oi"'],
    ]);
  });

  it('quebra de linha DENTRO do campo não termina a linha', () => {
    const csv = 'obs\n"linha 1\nlinha 2"\nfim';
    expect(analisarCsv(csv, ',')).toEqual([
      ['obs'],
      ['linha 1\nlinha 2'],
      ['fim'],
    ]);
  });

  it('`\\r\\n` é UM fim de linha, não dois', () => {
    // O Excel do Windows sempre grava assim. Sem o salto duplo, todo arquivo
    // dele teria uma linha vazia entre cada duas de verdade.
    expect(analisarCsv('a,b\r\n1,2\r\n', ',')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('**o BOM do Excel some** — e é o caso mais traiçoeiro', () => {
    const comBom = '\uFEFFnome,email\nAna,ana@x.com';
    const [cabecalho] = analisarCsv(comBom, ',');
    // Sem esta remoção, a primeira coluna se chamaria `\uFEFFnome` e a
    // planilha inteira seria recusada apontando para uma coluna que, na tela,
    // está escrita certa.
    expect(cabecalho[0]).toBe('nome');
  });

  it('campo vazio no fim da linha é preservado', () => {
    // `a,b,` tem TRÊS campos, e o terceiro é vazio. Perdê-lo desalinharia
    // todas as colunas seguintes da linha.
    expect(analisarCsv('a,b,', ',')).toEqual([['a', 'b', '']]);
  });

  it('arquivo que termina com quebra de linha não ganha linha vazia', () => {
    expect(analisarCsv('a\n', ',')).toEqual([['a']]);
  });

  it('campo entre aspas com BOM antes: o BOM sai, as aspas funcionam', () => {
    expect(analisarCsv('\uFEFF"nome"\nAna', ',')).toEqual([['nome'], ['Ana']]);
  });
});

describe('SPEC-038 — linhasComNumero', () => {
  it('**a numeração é a da PLANILHA**, e linha em branco não renumera', () => {
    const csv = 'nome,email\nAna,ana@x.com\n\nBeto,beto@x.com';
    const linhas = linhasComNumero(csv);

    // A linha 3 está em branco e some; o Beto continua sendo a linha **4**.
    // Renumerar faria o relatório apontar para a linha errada, e o gestor
    // procuraria o problema no lugar errado.
    expect(linhas.map((l) => l.numero)).toEqual([1, 2, 4]);
    expect(linhas[2].campos).toEqual(['Beto', 'beto@x.com']);
  });

  it('linha só com vírgulas conta como branca', () => {
    // O Excel grava assim quando a pessoa apaga o conteúdo mas não a linha.
    expect(linhasComNumero('a,b\n,\n1,2').map((l) => l.numero)).toEqual([1, 3]);
  });

  it('linha só com `;` conta como branca num arquivo de `;` (SPEC-083)', () => {
    // O mesmo gesto do Excel, no separador do Windows em português.
    expect(
      linhasComNumero('nome;email\r\n;\r\nAna;a@x.com').map((l) => l.numero),
    ).toEqual([1, 3]);
  });
});

/**
 * SPEC-083/D2 — **o separador vem do cabeçalho, e só dele.**
 *
 * O Excel em português grava `;`. O que este bloco prova é a regra inteira da
 * D2: conta fora de aspas, ganha o maior, empate ou nada vale `,`, e as linhas
 * de dados obedecem ao cabeçalho, sem votar.
 */
describe('SPEC-083 — detectarSeparador (D2)', () => {
  it('os dois cabeçalhos do modelo', () => {
    expect(detectarSeparador('nome;email;telefone;nivel;turma\r\n')).toBe(';');
    expect(detectarSeparador('nome,email,telefone,nivel,turma\n')).toBe(',');
  });

  it('ganha o que aparece mais, contando os dois', () => {
    // Dois `;` contra um `,`: o cabeçalho é de `;`, e a vírgula é parte do
    // nome de uma coluna (que o serviço recusará como desconhecida).
    expect(detectarSeparador('nome;email,x;nivel')).toBe(';');
    expect(detectarSeparador('nome,email;x,nivel')).toBe(',');
  });

  it('empate ou nenhum vale `,` — o separador de antes desta spec', () => {
    expect(detectarSeparador('nome;email,telefone')).toBe(',');
    expect(detectarSeparador('nome')).toBe(',');
    expect(detectarSeparador('')).toBe(',');
  });

  it('`;` entre aspas no cabeçalho não conta', () => {
    // Três `;` dentro das aspas e um `,` fora: sem respeitar as aspas, o
    // arquivo viraria de `;` e o cabeçalho se partiria no meio do nome.
    expect(detectarSeparador('"a;b;c;d",email')).toBe(',');
    // Aspas escapadas (`""`) não desalinham a contagem.
    expect(detectarSeparador('"x "";"" y";email;nivel')).toBe(';');
  });

  it('**só a primeira linha decide**: os dados não votam', () => {
    // A segunda linha tem quatro `;` e nenhuma vírgula. Se ela votasse, o
    // separador viraria `;` e o e-mail cairia na coluna errada.
    expect(
      detectarSeparador('nome,email\nAna;Beto;Cris;Dani;Edu,a@x.com'),
    ).toBe(',');
    expect(detectarSeparador('nome;email\r\nSouza, Ana, Filha;a@x.com')).toBe(
      ';',
    );
  });

  it('quebra de linha entre aspas não encerra a primeira linha', () => {
    // O `\n` está dentro das aspas: a primeira linha continua até o `\r\n`, e
    // os dois `;` depois dele contam.
    expect(detectarSeparador('"no\nme";email;nivel\r\nx,y,z,w,v')).toBe(';');
  });

  it('o BOM antes do cabeçalho não atrapalha', () => {
    expect(detectarSeparador('\uFEFFnome;email')).toBe(';');
  });
});

describe('SPEC-083 — o separador aplicado ao arquivo inteiro (AC-003)', () => {
  it('**num arquivo de `;`, nome com vírgula SEM aspas fica num campo só**', () => {
    const linhas = linhasComNumero(
      'nome;email;telefone\r\nSouza, Ana;ana@x.com;(11) 99999-0000\r\n',
    );
    // Com o analisador antigo (só vírgula), o cabeçalho era UMA coluna e esta
    // linha tinha dois campos: `Souza` e ` Ana;ana@x.com;(11) 99999-0000`.
    expect(linhas[0].campos).toEqual(['nome', 'email', 'telefone']);
    expect(linhas[1].campos).toEqual([
      'Souza, Ana',
      'ana@x.com',
      '(11) 99999-0000',
    ]);
  });

  it('num arquivo de `,`, um campo entre aspas com `;` também fica num só', () => {
    const linhas = linhasComNumero('nome,email\n"Ana; a do vôlei",ana@x.com\n');
    expect(linhas[1].campos).toEqual(['Ana; a do vôlei', 'ana@x.com']);
  });

  it('num arquivo de `;`, as aspas também funcionam', () => {
    const linhas = linhasComNumero('nome;email\r\n"Ana; Souza";ana@x.com\r\n');
    expect(linhas[1].campos).toEqual(['Ana; Souza', 'ana@x.com']);
  });

  it('**linha de dados com mais `;` que o cabeçalho não muda o separador**', () => {
    const linhas = linhasComNumero(
      'nome,email\nAna;Beto;Cris;Dani;Edu,ana@x.com\nFabi,fabi@x.com\n',
    );
    // O cabeçalho tem uma vírgula e nenhum `;`. A segunda linha, com quatro
    // `;`, continua partida por vírgula: dois campos, e não cinco.
    expect(linhas[1].campos).toEqual(['Ana;Beto;Cris;Dani;Edu', 'ana@x.com']);
    expect(linhas[2].campos).toEqual(['Fabi', 'fabi@x.com']);
  });

  it('`analisarCsv` obedece ao separador recebido, e o outro é texto', () => {
    // O analisador não detecta nada: quem chama decide. É isso que impede uma
    // linha de dados de reinterpretar o arquivo.
    expect(analisarCsv('a;b,c', ';')).toEqual([['a', 'b,c']]);
    expect(analisarCsv('a;b,c', ',')).toEqual([['a;b', 'c']]);
  });
});
