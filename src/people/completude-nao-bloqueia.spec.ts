import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, sep } from 'node:path';

/**
 * SPEC-036/AC-012 — **a completude não bloqueia nada, e esta é a prova.**
 *
 * ## Por que uma varredura, e não um caso de e2e
 *
 * Um e2e provaria que **uma** rota não bloqueia. A afirmação da D4 é sobre
 * **todas** — "nenhum portão novo, nenhuma rota que passe a exigir cadastro
 * completo". Provar isso caso a caso exigiria um teste por rota, e o teste que
 * faltasse seria exatamente o da rota que alguém fechou.
 *
 * **Ausência se prova por varredura.** É o mesmo formato dos gates que este
 * projeto já tem: o DEF-016 varre os enums publicados, o `fuso-do-clube.spec`
 * varre `getUTCFullYear()`. Os dois pagaram o próprio custo mais de uma vez.
 *
 * ## O que este gate fica vermelho para dizer
 *
 * *"Alguém está lendo a completude fora do módulo que a calcula."* Não é
 * proibido para sempre — é proibido **em silêncio**. O dia em que o clube
 * decidir exigir cadastro completo para reservar, esta linha cai junto com a
 * decisão, e não antes dela.
 *
 * ## Por que uma spec que introduz a palavra "completude" precisa disto
 *
 * Porque a primeira pessoa a ler `percentual: 71` vai querer usá-lo como
 * requisito. É a leitura natural, e é justamente a que ninguém autorizou: o
 * item 14 do backlog diz **"faixa de incentivo NÃO BLOQUEANTE"**, e uma
 * barreira entre o aluno e a quadra teria nascido de um número, não de uma
 * decisão.
 */
const SRC = join(__dirname, '..');

/** Onde a completude PODE ser lida: quem a calcula e quem a serve. */
const PERMITIDOS = [
  'people/completude-do-cadastro.ts',
  'people/completude-do-cadastro.spec.ts',
  'people/completude-nao-bloqueia.spec.ts',
  'people/students.service.ts',
  'people/students.service.spec.ts',
  'people/dto/people-response.dto.ts',
];

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosTs(caminho);
    return nome.endsWith('.ts') ? [caminho] : [];
  });
}

/** Comentário citando a completude é documentação, não uso. */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('SPEC-036/AC-012 — a completude não vira portão', () => {
  const relativos = arquivosTs(SRC).map((c) => ({
    caminho: c,
    rel: c.split(sep).join('/').split('/src/')[1],
  }));

  it('a varredura ACHOU arquivos — senão o teste abaixo passa por vacuidade', () => {
    // Sem esta linha, um `readdir` que devolvesse `[]` faria o gate ficar
    // verde para sempre. É a mesma proteção que o DEF-016 tem.
    expect(relativos.length).toBeGreaterThan(50);
    expect(
      relativos.some((r) => r.rel === 'people/completude-do-cadastro.ts'),
    ).toBe(true);
  });

  it('ninguém lê `calcularCompletude` nem `percentual` fora do módulo', () => {
    const infratores: string[] = [];

    for (const { caminho, rel } of relativos) {
      if (PERMITIDOS.includes(rel)) continue;
      const codigo = semComentarios(readFileSync(caminho, 'utf8'));
      if (/calcularCompletude|CAMPOS_DA_COMPLETUDE/.test(codigo)) {
        infratores.push(`${rel} → lê a completude fora do módulo dela`);
      }
      // `cadastro.percentual` num `if`, num `throw` ou num guard é o formato
      // exato do portão que a D4 proíbe.
      if (/cadastro\s*\.\s*percentual/.test(codigo)) {
        infratores.push(`${rel} → decide por \`cadastro.percentual\``);
      }
    }

    // A mensagem precisa dizer QUAL, senão o próximo a ver isto vermelho gasta
    // a primeira meia hora descobrindo onde olhar.
    expect(infratores).toEqual([]);
  });
});
