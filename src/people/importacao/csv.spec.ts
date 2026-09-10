import { analisarCsv, linhasComNumero } from './csv';

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
    expect(analisarCsv('a,b,c\n1,2,3')).toEqual([
      ['a', 'b', 'c'],
      ['1', '2', '3'],
    ]);
  });

  it('vírgula DENTRO do campo, entre aspas', () => {
    // É o motivo de as aspas existirem. `split(',')` daria quatro campos.
    expect(analisarCsv('nome,cidade\n"Souza, Ana",Santos')).toEqual([
      ['nome', 'cidade'],
      ['Souza, Ana', 'Santos'],
    ]);
  });

  it('aspas escapadas dobram', () => {
    expect(analisarCsv('a\n"ele disse ""oi"""')).toEqual([
      ['a'],
      ['ele disse "oi"'],
    ]);
  });

  it('quebra de linha DENTRO do campo não termina a linha', () => {
    const csv = 'obs\n"linha 1\nlinha 2"\nfim';
    expect(analisarCsv(csv)).toEqual([['obs'], ['linha 1\nlinha 2'], ['fim']]);
  });

  it('`\\r\\n` é UM fim de linha, não dois', () => {
    // O Excel do Windows sempre grava assim. Sem o salto duplo, todo arquivo
    // dele teria uma linha vazia entre cada duas de verdade.
    expect(analisarCsv('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('**o BOM do Excel some** — e é o caso mais traiçoeiro', () => {
    const comBom = '\uFEFFnome,email\nAna,ana@x.com';
    const [cabecalho] = analisarCsv(comBom);
    // Sem esta remoção, a primeira coluna se chamaria `\uFEFFnome` e a
    // planilha inteira seria recusada apontando para uma coluna que, na tela,
    // está escrita certa.
    expect(cabecalho[0]).toBe('nome');
  });

  it('campo vazio no fim da linha é preservado', () => {
    // `a,b,` tem TRÊS campos, e o terceiro é vazio. Perdê-lo desalinharia
    // todas as colunas seguintes da linha.
    expect(analisarCsv('a,b,')).toEqual([['a', 'b', '']]);
  });

  it('arquivo que termina com quebra de linha não ganha linha vazia', () => {
    expect(analisarCsv('a\n')).toEqual([['a']]);
  });

  it('campo entre aspas com BOM antes: o BOM sai, as aspas funcionam', () => {
    expect(analisarCsv('\uFEFF"nome"\nAna')).toEqual([['nome'], ['Ana']]);
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
});
