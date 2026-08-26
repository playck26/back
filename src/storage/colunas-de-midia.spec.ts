import { Prisma } from '@prisma/client';
import { COLUNAS_DE_MIDIA } from './colunas-de-midia';

/**
 * SPEC-018/TASK-007 — **a prova da AC-017, e ela é a razão de a INV-045
 * sobreviver.**
 *
 * A invariante diz que o checker cobre **todas** as colunas de mídia.
 * Invariante assim morre em silêncio: alguém acrescenta uma coluna de chave
 * daqui a seis meses, esquece do checker, e o worker passa a apagar arquivo
 * em uso — sem erro, sem alerta, só a imagem sumindo.
 *
 * **Por isso este arquivo não compara a lista contra outra lista.** Ele lê o
 * **schema** (via DMMF do Prisma, que é gerado a partir de
 * `schema.prisma`) e falha no dia em que aparecer uma coluna de chave que
 * ninguém ensinou ao checker. Lista escrita à mão envelhece junto com quem a
 * escreveu; teste que lê o schema quebra exatamente quando alguém precisa
 * ser avisado.
 *
 * A 5ª rodada de validação cruzada foi explícita: *"se for só uma asserção
 * manual, apodrece."*
 */

/**
 * As colunas que **guardam chave e não são referência de mídia**, com o
 * motivo escrito.
 *
 * **Exceção sem motivo escrito vira lista à mão outra vez**, que é o que
 * este arquivo existe para evitar. Acrescentar uma linha aqui é uma decisão
 * que alguém precisa defender no diff, não um jeito de calar o teste.
 */
const NAO_SAO_REFERENCIA: ReadonlyArray<{
  modelo: string;
  campo: string;
  porque: string;
}> = [
  {
    modelo: 'ArquivoPendenteExclusao',
    campo: 'key',
    porque:
      'É a chave que está NA FILA para ser apagada, não uma referência a ' +
      'ela. Tratá-la como referência faria toda chave enfileirada parecer ' +
      '"ainda em uso", e o worker nunca apagaria nada — o fail-closed viraria ' +
      'permanente sem ninguém notar.',
  },
];

/**
 * Descobre, no schema, tudo que se parece com coluna de chave de objeto.
 *
 * O critério é o **nome do campo terminando em `Key`**, que é a convenção
 * que este projeto usa nas quatro colunas de mídia e na fila. É
 * deliberadamente **largo**: um falso positivo obriga alguém a declarar uma
 * exceção com motivo (barulhento, e barato); um falso negativo deixaria a
 * coluna nova passar em silêncio, que é o defeito que a AC-017 previne.
 */
function colunasDeChaveNoSchema(): { modelo: string; campo: string }[] {
  const achadas: { modelo: string; campo: string }[] = [];
  for (const modelo of Prisma.dmmf.datamodel.models) {
    for (const campo of modelo.fields) {
      // `/key$/i`, e nao `/Key$/`: o campo da fila chama-se `key`, em
      // minuscula. A primeira versao deste regex exigia maiuscula e nao o
      // encontrava — o teste de controle positivo pegou, que e para isso
      // que ele existe.
      if (/key$/i.test(campo.name) && campo.type === 'String') {
        achadas.push({ modelo: modelo.name, campo: campo.name });
      }
    }
  }
  return achadas;
}

const chave = (c: { modelo: string; campo: string }) =>
  `${c.modelo}.${c.campo}`;

describe('AC-017 — a cobertura do checker é conferida contra o SCHEMA', () => {
  it('o schema de fato tem colunas de chave (o teste não passa por vazio)', () => {
    // **Controle positivo.** Sem ele, um regex quebrado ou um DMMF vazio
    // fariam todas as asserções abaixo passarem por não encontrarem nada —
    // e o teste que existe para avisar viraria o que garante silêncio.
    const achadas = colunasDeChaveNoSchema();
    expect(achadas.length).toBeGreaterThanOrEqual(
      COLUNAS_DE_MIDIA.length + NAO_SAO_REFERENCIA.length,
    );
  });

  it('toda coluna de chave do schema está coberta OU declarada como exceção', () => {
    // A prova da INV-045. Quando alguém acrescentar `quadras.imagem_capa_key`
    // e não ensinar ao checker, é aqui que descobre — e não em produção, com
    // o worker apagando a capa de uma quadra em uso.
    const cobertas = new Set(COLUNAS_DE_MIDIA.map(chave));
    const excecoes = new Set(NAO_SAO_REFERENCIA.map(chave));

    const orfas = colunasDeChaveNoSchema()
      .filter((c) => !cobertas.has(chave(c)) && !excecoes.has(chave(c)))
      .map(chave);

    expect(orfas).toEqual([]);
  });

  it('a lista não cobre coluna que não existe mais no schema', () => {
    // O outro lado: coluna removida do schema e esquecida aqui viraria uma
    // consulta a um campo inexistente — erro em runtime, dentro do worker,
    // que o fail-closed transformaria em "nunca mais apaga nada".
    const noSchema = new Set(colunasDeChaveNoSchema().map(chave));
    const fantasmas = COLUNAS_DE_MIDIA.map(chave).filter(
      (c) => !noSchema.has(c),
    );

    expect(fantasmas).toEqual([]);
  });

  it('toda exceção declarada existe no schema e tem motivo escrito', () => {
    // Exceção que sobra depois que a coluna some vira permissão esquecida.
    const noSchema = new Set(colunasDeChaveNoSchema().map(chave));
    for (const e of NAO_SAO_REFERENCIA) {
      expect(noSchema.has(chave(e))).toBe(true);
      expect(e.porque.length).toBeGreaterThan(40);
    }
  });

  it('não há coluna declarada duas vezes', () => {
    const nomes = COLUNAS_DE_MIDIA.map(chave);
    expect(new Set(nomes).size).toBe(nomes.length);
  });

  it('as quatro colunas de mídia da SPEC-018 estão lá, pelo nome', () => {
    // Redundante com o teste do schema **de propósito**: este falha com uma
    // mensagem que diz QUAL coluna sumiu, e serve de documentação de quais
    // são elas para quem abre o arquivo.
    expect(COLUNAS_DE_MIDIA.map(chave).sort()).toEqual([
      'Empresa.logoKey',
      'Professor.fotoKey',
      'Quadra.imagemKey',
      'Usuario.fotoKey',
    ]);
  });
});
