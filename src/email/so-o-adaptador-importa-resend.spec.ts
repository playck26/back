import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

// SPEC-083/AC-029 — INV-083h: só o adaptador conhece a Resend.
//
// Um segundo arquivo que importasse o SDK seria um segundo lugar onde a chave
// encontra a rede e onde erro da Resend vira decisão — sem passar pela
// tradução para os motivos da D8, nem pelo teto de 10 s. O gate varre `src/`
// inteiro, `.spec.ts` incluídos: dublê de teste que importa o pacote é um
// segundo dono também.

const SRC = join(__dirname, '..');
const ADAPTADOR = 'email/resend-provedor-de-email.ts';

/**
 * O nome do pacote entra por concatenação, e não escrito dentro das aspas,
 * para este arquivo não casar consigo mesmo. A conferência de que ele foi
 * varrido está no próprio teste.
 */
const PACOTE = 'resend';
const IMPORTA_O_PACOTE = new RegExp(
  String.raw`(?:\bfrom\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)['"]` +
    PACOTE +
    String.raw`(?:/[^'"]*)?['"]`,
);

function arquivosTs(diretorio: string): string[] {
  return readdirSync(diretorio, { recursive: true, encoding: 'utf8' })
    .filter((nome) => nome.endsWith('.ts'))
    .map((nome) => join(diretorio, nome));
}

function relativo(arquivo: string): string {
  return relative(SRC, arquivo).split(sep).join('/');
}

describe('AC-029 — só o adaptador importa o SDK da Resend (INV-083h)', () => {
  it('a expressão pega toda forma de importar o pacote, e só ele', () => {
    const importam = [
      `import { Resend } from '${PACOTE}';`,
      `import type { CreateEmailOptions } from "${PACOTE}";`,
      `export { Resend } from '${PACOTE}';`,
      `import { algo } from '${PACOTE}/interno';`,
      `const { Resend } = require('${PACOTE}');`,
      `const modulo = await import('${PACOTE}');`,
    ];
    const naoImportam = [
      `import { ResendProvedorDeEmail } from './${PACOTE}-provedor-de-email';`,
      `import outro from '${PACOTE}-outro-pacote';`,
      `// a porta esconde a ${PACOTE} de quem envia`,
    ];

    for (const linha of importam) {
      expect({ linha, casa: IMPORTA_O_PACOTE.test(linha) }).toEqual({
        linha,
        casa: true,
      });
    }
    for (const linha of naoImportam) {
      expect({ linha, casa: IMPORTA_O_PACOTE.test(linha) }).toEqual({
        linha,
        casa: false,
      });
    }
  });

  it('em src/, exatamente um arquivo importa o pacote: o adaptador', () => {
    const arquivos = arquivosTs(SRC);
    // A varredura andou de verdade: achou o adaptador, este próprio arquivo
    // (então os `.spec.ts` entram) e um arquivo de outro módulo.
    expect(arquivos.map(relativo)).toEqual(
      expect.arrayContaining([
        ADAPTADOR,
        'email/so-o-adaptador-importa-resend.spec.ts',
        'app.module.ts',
      ]),
    );

    const importam = arquivos
      .filter((arquivo) => IMPORTA_O_PACOTE.test(readFileSync(arquivo, 'utf8')))
      .map(relativo);

    expect(importam).toEqual([ADAPTADOR]);
  });
});
