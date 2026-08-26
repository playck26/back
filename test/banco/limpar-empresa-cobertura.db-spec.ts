/**
 * A cobertura de `limparEmpresa`, conferida contra o SCHEMA (2026-08-26).
 *
 * ## Por que este arquivo existe
 *
 * `limparEmpresa` guarda uma **lista escrita à mão** das tabelas que
 * pertencem a uma empresa. E esta lista já custou caro duas vezes:
 *
 * 1. **2026-08-24** — o incidente. As suítes apagavam tabela inteira sem
 *    `WHERE`, e a digital do acidente foi a própria lista: *"morreu tudo o
 *    que estava nela, sobrou tudo o que não estava"*;
 * 2. **2026-08-26** — a SPEC-020 criou `esportes_de_quadra` e
 *    `categorias_de_quadra`, ninguém as acrescentou, e a `matriz-raiz` — a
 *    rede de regressão da raiz de lock — ficou vermelha inteira com um erro
 *    de FK que não tinha nada a ver com lock.
 *
 * A segunda foi barulhenta e barata. **A próxima pode não ser**: uma tabela
 * nova sem FK para `empresas` não bloqueia o `DELETE`, então a limpeza
 * simplesmente deixa lixo — e suíte que deixa lixo falha depois, em outro
 * arquivo, por motivo que não é o dela.
 *
 * ## Por que ele lê o schema, e não outra lista
 *
 * Lista escrita à mão envelhece junto com quem a escreveu. Esta lê o
 * `information_schema` e quebra **no dia** em que aparecer tabela com
 * `company_id` que `limparEmpresa` não conhece — que é exatamente quando
 * alguém precisa ser avisado. Mesma costura da AC-017 da SPEC-018 para as
 * colunas de mídia.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { TABELAS_DA_EMPRESA } from './limpar-empresa';

jest.setTimeout(60_000);

// Esta suíte só LÊ, mas usa a mesma trava: apontar para produção por engano
// não deve nem chegar a abrir conexão.
exigirBancoLocal();

const prisma = new PrismaClient();

/**
 * Tabelas com `company_id` que **não** entram na limpeza, com o motivo
 * escrito.
 *
 * **Exceção sem motivo escrito vira lista à mão outra vez**, que é o que este
 * arquivo existe para evitar.
 */
const FORA_DA_LIMPEZA: ReadonlyArray<{ tabela: string; porque: string }> = [
  {
    tabela: 'arquivos_pendentes_exclusao',
    porque:
      'É a fila de exclusão do storage, e NÃO tem FK para `empresas` de ' +
      'propósito: a chave enfileirada precisa sobreviver à linha que a ' +
      'referenciava, senão apagar o recurso levaria junto a ordem de apagar ' +
      'o arquivo dele. Não bloqueia o DELETE da empresa, e quem a limpa é ' +
      'cada suíte que a usa.',
  },
];

async function tabelasComCompanyId(): Promise<
  { tabela: string; temFkParaEmpresas: boolean }[]
> {
  return prisma.$queryRawUnsafe(`
    SELECT c.table_name AS tabela,
           EXISTS (
             SELECT 1
             FROM information_schema.table_constraints tc
             JOIN information_schema.constraint_column_usage ccu
               ON ccu.constraint_name = tc.constraint_name
             WHERE tc.table_name = c.table_name
               AND tc.constraint_type = 'FOREIGN KEY'
               AND ccu.table_name = 'empresas'
           ) AS "temFkParaEmpresas"
    FROM information_schema.columns c
    WHERE c.column_name = 'company_id'
      AND c.table_schema = 'public'
    ORDER BY c.table_name
  `);
}

describe('limparEmpresa — a cobertura conferida contra o schema', () => {
  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('o schema de fato tem tabelas com `company_id`', async () => {
    // **Controle positivo.** Sem ele, uma consulta quebrada devolveria zero
    // linhas e todas as asserções abaixo passariam por não terem o que
    // procurar — e o teste que existe para avisar viraria o que garante
    // silêncio.
    const achadas = await tabelasComCompanyId();
    expect(achadas.length).toBeGreaterThanOrEqual(TABELAS_DA_EMPRESA.length);
  });

  it('toda tabela com `company_id` está na limpeza OU declarada como exceção', async () => {
    const naLista = new Set<string>(TABELAS_DA_EMPRESA);
    const excecoes = new Set(FORA_DA_LIMPEZA.map((e) => e.tabela));

    const orfas = (await tabelasComCompanyId())
      .map((t) => t.tabela)
      .filter((t) => !naLista.has(t) && !excecoes.has(t));

    expect(orfas).toEqual([]);
  });

  it('toda tabela que BLOQUEIA o delete da empresa está na limpeza', async () => {
    // O caso barulhento, e o que aconteceu em 26/08: FK `RESTRICT` para
    // `empresas` faz o `DELETE FROM empresas` falhar, e a suíte inteira cai.
    // Exceção declarada não vale aqui — se bloqueia, tem de ser limpa.
    const naLista = new Set<string>(TABELAS_DA_EMPRESA);

    const bloqueiam = (await tabelasComCompanyId())
      .filter((t) => t.temFkParaEmpresas)
      .map((t) => t.tabela)
      .filter((t) => !naLista.has(t));

    expect(bloqueiam).toEqual([]);
  });

  it('a lista não tem tabela que não existe mais', async () => {
    // O outro lado: tabela removida do schema e esquecida aqui faz todo
    // `limparEmpresa` estourar com "relation does not exist".
    const noSchema = new Set(
      (await tabelasComCompanyId()).map((t) => t.tabela),
    );
    const fantasmas = TABELAS_DA_EMPRESA.filter((t) => !noSchema.has(t));

    expect(fantasmas).toEqual([]);
  });

  it('toda exceção declarada existe no schema e tem motivo escrito', async () => {
    const noSchema = new Set(
      (await tabelasComCompanyId()).map((t) => t.tabela),
    );

    for (const e of FORA_DA_LIMPEZA) {
      expect(noSchema.has(e.tabela)).toBe(true);
      expect(e.porque.length).toBeGreaterThan(40);
    }
  });

  it('nenhuma exceção declarada bloqueia o delete da empresa', async () => {
    // Uma exceção com FK `RESTRICT` seria uma bomba armada: passaria neste
    // arquivo e derrubaria a suíte que tentasse apagar a empresa.
    const bloqueiam = new Set(
      (await tabelasComCompanyId())
        .filter((t) => t.temFkParaEmpresas)
        .map((t) => t.tabela),
    );

    for (const e of FORA_DA_LIMPEZA) {
      expect(bloqueiam.has(e.tabela)).toBe(false);
    }
  });
});
