import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * SPEC-069/AC-012 — **o método que criava ação sem alvo não existe mais.**
 *
 * ## Por que uma prova de TEXTO, e não de comportamento
 *
 * Método sem chamador continua verde em todas as outras provas: o gesto de
 * trocar professor passa a gravar o evento, e o método antigo poderia
 * continuar lá, intacto, esperando o próximo caso de uso que precisasse de
 * "uma ação rapidinho". Nenhum teste de comportamento o alcançaria, porque
 * ninguém o chama.
 *
 * ## O que ela NÃO pega, dito antes que alguém descubra sozinho
 *
 * Um `criarAcaoSemEfeito()` com outro nome passa aqui. **A proteção de
 * comportamento é o `acao_exige_alvo`** (Deploy 2, AC-003), que recusa no
 * `COMMIT` qualquer ação sem efeito, qualquer que seja o nome de quem a
 * criou. As duas juntas são a proteção; nenhuma sozinha.
 *
 * Por isso o segundo caso existe: ele não julga NOME, julga **quem tem
 * permissão de criar ação**. Um caminho novo de auditoria em outro arquivo
 * reprova aqui e obriga quem o escreveu a decidir, por escrito, se ele grava
 * efeito na mesma transação — que é exatamente a pergunta que a SPEC-069
 * existe para fazer.
 *
 * ## A lápide também reprova
 *
 * Citar o nome do método removido num comentário deixaria este arquivo
 * vermelho. É de propósito: um projeto que documenta o que apagou acaba
 * afrouxando o gate para caber a documentação.
 */

/** Todo `.ts` sob `src/`, menos este arquivo (que precisa citar o nome). */
function arquivosDoSrc(): string[] {
  const raiz = resolve(__dirname, '..', '..');
  const achados: string[] = [];
  const andar = (dir: string) => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const caminho = join(dir, entrada.name);
      if (entrada.isDirectory()) andar(caminho);
      else if (entrada.name.endsWith('.ts')) achados.push(caminho);
    }
  };
  andar(raiz);
  return achados.filter((c) => resolve(c) !== resolve(__filename));
}

/**
 * Os arquivos de PRODUÇÃO que podem criar uma ação administrativa.
 *
 * **Exceção sem motivo escrito vira lista à mão**, e este projeto já pagou
 * por isso em `limpar-empresa.ts`. Cada entrada diz por que o caminho dela é
 * legítimo — ou seja, onde está o efeito que acompanha a ação.
 */
const PODEM_CRIAR_ACAO: ReadonlyArray<{ arquivo: string; porque: string }> = [
  {
    arquivo: 'common/auditoria/registrador-de-acao.ts',
    porque:
      'É o registrador. Os quatro pontos de criação são preguiçosos e ' +
      'sempre acompanhados do efeito, na mesma transação: ocupação, ' +
      'matrícula, turma (SPEC-069) e o lote de ocupações.',
  },
  {
    arquivo: 'creditos/creditos-admin.service.ts',
    porque:
      'O lançamento e a retirada de crédito criam a ação DENTRO da ' +
      'transação, imediatamente antes do movimento — `movimentos_acao_fkey` ' +
      'a exige. O efeito é o próprio movimento do ledger.',
  },
];

describe('SPEC-069/AC-012 — ação sem alvo não tem mais de onde nascer', () => {
  it('o método sem alvo da SPEC-068 não existe em nenhum lugar de `src/`', () => {
    const culpados = arquivosDoSrc().filter((caminho) =>
      readFileSync(caminho, 'utf8').includes('garantirAcao'),
    );
    expect(
      culpados.map((c) => relative(resolve(__dirname, '..', '..'), c)),
    ).toEqual([]);
  });

  it('só os caminhos DECLARADOS criam ação administrativa', () => {
    const raiz = resolve(__dirname, '..', '..');
    const criadores = arquivosDoSrc()
      .filter((c) => !c.endsWith('.spec.ts'))
      .filter((caminho) => {
        const texto = readFileSync(caminho, 'utf8');
        return (
          /acaoAdministrativa\.(create|createMany|upsert)/.test(texto) ||
          /INSERT INTO acoes_administrativas/i.test(texto)
        );
      })
      .map((c) => relative(raiz, c).split('\\').join('/'))
      .sort();

    expect(criadores).toEqual(
      PODEM_CRIAR_ACAO.map((e) => e.arquivo)
        .slice()
        .sort(),
    );
  });

  it('cada exceção declara o efeito que acompanha a ação', () => {
    for (const entrada of PODEM_CRIAR_ACAO) {
      expect(entrada.porque.length).toBeGreaterThan(40);
    }
  });
});
