/**
 * SPEC-064/TASK-003 — **a data de "hoje" é a do CLUBE, nunca a do servidor de
 * banco.**
 *
 * ## O defeito, que era de produção, e a CI pegou
 *
 * A primeira versão de `encerrarAlvoMorto` comparava com `CURRENT_DATE` — a
 * data do **servidor de banco**. O do CI roda em **UTC**; o clube vive em
 * `America/Sao_Paulo`. Entre 21h e meia-noite locais (00h–03h UTC) o banco já
 * virou o dia, e **toda aula de hoje à noite seria encerrada como "já
 * passou"**: fila viva morta por acidente de fuso, às vésperas da aula.
 *
 * A CI rodou às **02:55 UTC** — 23:55 em São Paulo — e o caso do prazo ficou
 * vermelho porque a linha havia sido encerrada antes de o varredor chamar.
 * `CURRENT_DATE` aparecia **só nesse arquivo**; o resto do projeto usa
 * `hojeNoFusoDoClube()` desde sempre.
 *
 * ## Por que este teste é unitário, e não de banco
 *
 * **Eu escrevi primeiro um caso no db-spec, e ele não provava nada.** O
 * PostgreSQL local desta máquina roda com `TimeZone = America/Sao_Paulo`, então
 * `CURRENT_DATE` ali **já é** a data do clube: o caso ficava verde com o
 * defeito dentro. Sabotei de volta para `CURRENT_DATE` e ele passou — o que é
 * a definição de teste que não prova nada, e eu tinha escrito no comentário
 * dele a palavra *"determinístico"*.
 *
 * O caso foi removido. O que julga o defeito é a **data que o serviço manda**,
 * e isso se observa sem banco nenhum: com um relógio injetado, o valor ligado à
 * consulta tem de ser `hojeNoFusoDoClube(aquele instante)`.
 *
 * É a mesma família do gate que lê `confdelsetcols` da FK e do que confere as
 * opções da transação da purga: **o artefato, não o ambiente em que ele rodou.**
 */
import { VarredorDaFilaService } from './varredor-da-fila.service';
import { ConfigOperacaoService } from '../company-settings/config-operacao.service';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import type { PrismaService } from '../prisma/prisma.service';

/** 02:55 UTC do dia 21 = 23:55 do dia 20 em São Paulo. */
const MADRUGADA_UTC = new Date('2026-09-21T02:55:00.000Z');

function varredorComEspiao(): {
  varredor: VarredorDaFilaService;
  sqls: { texto: string; valores: unknown[] }[];
} {
  const sqls: { texto: string; valores: unknown[] }[] = [];
  const prisma = {
    $executeRaw: (partes: TemplateStringsArray, ...valores: unknown[]) => {
      sqls.push({ texto: partes.join('?'), valores });
      return Promise.resolve(0);
    },
    $queryRaw: () => Promise.resolve([]),
  } as unknown as PrismaService;

  return {
    varredor: new VarredorDaFilaService(
      prisma,
      new ConfigOperacaoService(prisma),
    ),
    sqls,
  };
}

describe('SPEC-064 — o varredor não pergunta a data ao servidor de banco', () => {
  it('a data ligada à consulta é a de HOJE NO CLUBE, derivada do relógio injetado', async () => {
    const { varredor, sqls } = varredorComEspiao();

    await varredor.executarCiclo(() => MADRUGADA_UTC.getTime());

    const encerrar = sqls.find((s) => s.texto.includes('alvo indisponivel'));
    expect(encerrar).toBeDefined();

    // 23:55 em São Paulo ainda é dia 20 — e é o dia 20 que tem de chegar ao
    // banco. Com `CURRENT_DATE` nada chegaria: a lista de valores viria vazia.
    const esperado = hojeNoFusoDoClube(MADRUGADA_UTC)
      .toISOString()
      .slice(0, 10);
    expect(esperado).toBe('2026-09-20');
    expect(encerrar!.valores).toContain(esperado);
  });

  it('a consulta NÃO menciona `CURRENT_DATE`', () => {
    // A data do servidor não pode voltar por descuido — e num `$executeRaw`
    // ela entraria como texto, sem parâmetro nenhum para este teste observar.
    const { varredor, sqls } = varredorComEspiao();
    return varredor
      .executarCiclo(() => MADRUGADA_UTC.getTime())
      .then(() => {
        for (const s of sqls) {
          expect(s.texto).not.toContain('CURRENT_DATE');
        }
      });
  });
});
