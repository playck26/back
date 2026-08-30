import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  dataExiste,
  FUSO_DO_CLUBE,
  hojeNoFusoDoClube,
  mesCorrenteNoFusoDoClube,
} from './date-time.util';

/**
 * SPEC-023 — **a prova do fuso, e ela guarda um defeito que já existe.**
 *
 * O projeto não tinha fuso em lugar nenhum: `grep -rn "America/"` não
 * devolvia nada, e "hoje" era `Date.UTC(...)` do relógio do servidor —
 * `ClassesService.myUpcomingClasses` faz isso **até hoje**.
 *
 * Para quase tudo isso passa despercebido. Para a regra "não sai no dia da
 * aula" (REQ-004) não passa: o Brasil é UTC-3, então **das 21h à meia-noite
 * locais o UTC já está no dia seguinte**. Aula de terça 19h, aluno tentando
 * sair às 21h30 de segunda — em UTC já é terça, e ele levaria `AULA_HOJE` no
 * dia errado.
 *
 * **Aula à noite é o horário mais comum de clube de tênis.** O caso raro é o
 * caso normal, e é por isso que estas provas usam justamente esse horário.
 *
 * ---
 *
 * **DEF-020 (2026-08-29) — o "até hoje" acima durou uma semana, e custou.**
 *
 * O comentário dizia, em letras claras, que `myUpcomingClasses` continuava em
 * UTC. Ficou escrito aqui, verde, enquanto o Israel via o horário errado no
 * app: aula das 22h sumindo de "próximas aulas" às 21h. **Documentar o
 * defeito não é o mesmo que impedi-lo** — e era só o que este arquivo fazia.
 *
 * Eram sete lugares calculando "hoje" em UTC contra dois usando o fuso. O
 * que estas provas ganharam foi a varredura abaixo: agora o arquivo não
 * descreve o defeito, ele **fecha** o defeito.
 */
describe('hojeNoFusoDoClube', () => {
  it('às 21h30 de uma segunda em São Paulo, "hoje" ainda é segunda', () => {
    // 2026-08-24 é uma segunda. 21h30 em São Paulo = 00h30 UTC de terça.
    const seguraANoite = new Date('2026-08-25T00:30:00.000Z');

    expect(hojeNoFusoDoClube(seguraANoite).toISOString().slice(0, 10)).toBe(
      '2026-08-24',
    );
  });

  it('e o cálculo ingênuo em UTC erraria esse mesmo instante', () => {
    // Esta prova não testa o nosso código: ela **documenta o defeito** que a
    // função existe para evitar, e falha se alguém "simplificar" a função de
    // volta para UTC achando que dá no mesmo.
    const seguraANoite = new Date('2026-08-25T00:30:00.000Z');
    const ingenuo = new Date(
      Date.UTC(
        seguraANoite.getUTCFullYear(),
        seguraANoite.getUTCMonth(),
        seguraANoite.getUTCDate(),
      ),
    );

    expect(ingenuo.toISOString().slice(0, 10)).toBe('2026-08-25');
    expect(hojeNoFusoDoClube(seguraANoite)).not.toEqual(ingenuo);
  });

  it('de manhã, os dois concordam — é a hora em que o defeito não aparece', () => {
    // 09h em São Paulo = 12h UTC do mesmo dia. É por isso que o problema
    // sobrevive: quem testa de manhã nunca o vê.
    const deManha = new Date('2026-08-24T12:00:00.000Z');

    expect(hojeNoFusoDoClube(deManha).toISOString().slice(0, 10)).toBe(
      '2026-08-24',
    );
  });

  it('devolve meia-noite UTC, que é o formato das colunas @db.Date', () => {
    const data = hojeNoFusoDoClube(new Date('2026-08-24T12:00:00.000Z'));

    expect(data.toISOString()).toBe('2026-08-24T00:00:00.000Z');
  });

  it('o fuso é explícito, não herdado do relógio do servidor', () => {
    // O servidor roda em UTC (DigitalOcean). Herdar o fuso dele seria
    // herdar uma decisão que ninguém tomou.
    expect(FUSO_DO_CLUBE).toBe('America/Sao_Paulo');
  });
});

// ---------------------------------------------------------------------------
// DEF-020 — o que faltava: um mecanismo, não um aviso.
// ---------------------------------------------------------------------------

const SRC = join(__dirname, '..');

/**
 * O único arquivo onde "que dia é hoje" pode ser calculado. Se um dia houver
 * fuso por empresa, é aqui que ele entra — e este gate é o que garante que
 * não exista um oitavo lugar decidindo sozinho.
 */
const DONO_DA_CONVENCAO = join(SRC, 'courts', 'date-time.util.ts');

function arquivosDeCodigo(dir: string): string[] {
  const saida: string[] = [];
  for (const nome of readdirSync(dir)) {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) {
      saida.push(...arquivosDeCodigo(caminho));
      continue;
    }
    if (!nome.endsWith('.ts') || nome.endsWith('.spec.ts')) continue;
    saida.push(caminho);
  }
  return saida;
}

/**
 * Comentário citando `getUTCFullYear()` é documentação do defeito — e existe
 * de propósito em `date-time.util.ts`. Só o código conta.
 */
function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

describe('o fuso do clube é a única convenção de "hoje"', () => {
  const arquivos = arquivosDeCodigo(SRC);

  it('varreu o código de verdade — senão o teste passa por vacuidade', () => {
    expect(arquivos.length).toBeGreaterThan(50);
    expect(arquivos).toContain(DONO_DA_CONVENCAO);
  });

  it('nenhum serviço calcula "hoje" a partir do relógio UTC do servidor', () => {
    const infratores: string[] = [];

    for (const caminho of arquivos) {
      if (caminho === DONO_DA_CONVENCAO) continue;
      const codigo = semComentarios(readFileSync(caminho, 'utf8'));
      // `getUTCFullYear()` só aparece quando alguém está montando a data de
      // "agora" — ler o ano de uma coluna `@db.Date` não precisa dele.
      if (/getUTCFullYear\s*\(\s*\)/.test(codigo)) {
        infratores.push(
          `${caminho.replace(/\\/g, '/').split('/src/')[1]} → use hojeNoFusoDoClube()`,
        );
      }
    }

    // A mensagem nomeia o arquivo e o que fazer: sem isso, quem vê vermelho
    // gasta a primeira meia hora procurando onde.
    expect(infratores).toEqual([]);
  });
});

describe('o mês corrente também é do clube, não do servidor', () => {
  it('às 21h30 de 31 de dezembro, o mês corrente ainda é dezembro', () => {
    // 2027-01-01T00:30:00Z = 21:30 de 31/12/2026 em São Paulo. Sem isto, o
    // gestor pedia a agenda sem `mes` e recebia janeiro — vazio, sem nada na
    // tela explicando por quê.
    const reveillon = new Date('2027-01-01T00:30:00.000Z');

    expect(mesCorrenteNoFusoDoClube(reveillon)).toBe('2026-12');
    expect(reveillon.toISOString().slice(0, 7)).toBe('2027-01');
  });

  it('em horário comercial, concorda com o UTC', () => {
    expect(mesCorrenteNoFusoDoClube(new Date('2026-08-29T13:00:00.000Z'))).toBe(
      '2026-08',
    );
  });
});

/**
 * Validação cruzada da SPEC-026, achado 4 — data que não existe no calendário.
 *
 * O regex do DTO aceitava `3[01]` em qualquer mês, e `parseDateOnly` então
 * **normalizava em silêncio**: a rota respondia `200` com as aulas de um dia
 * diferente do pedido.
 */
describe('data inexistente não vira outro dia em silêncio', () => {
  it.each([
    ['2026-04-31', '31 de abril'],
    ['2026-02-30', '30 de fevereiro'],
    ['2026-02-29', '29 de fevereiro fora de ano bissexto'],
    ['2027-11-31', '31 de novembro'],
  ])('rejeita %s (%s)', (data) => {
    expect(dataExiste(data)).toBe(false);
  });

  it.each(['2026-09-01', '2026-12-31', '2024-02-29', '2026-01-31'])(
    'aceita %s',
    (data) => {
      expect(dataExiste(data)).toBe(true);
    },
  );

  it('o JS normalizaria em silêncio — é isto que a função impede', () => {
    // Sem esta prova, `dataExiste` poderia estar sempre devolvendo `false` e
    // os `rejeita` acima continuariam verdes pela metade errada.
    expect(
      new Date('2026-04-31T00:00:00.000Z').toISOString().slice(0, 10),
    ).toBe('2026-05-01');
  });
});
