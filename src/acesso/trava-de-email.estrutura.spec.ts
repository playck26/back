import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  FOLGA_DO_TIMEOUT_MS,
  LATENCIA_DE_ORCAMENTO_MS,
} from '../common/lock/prazo-de-espera';
import { TIMEOUT_DA_IMPORTACAO_MS } from '../people/importacao/importacao-de-alunos.service';
import {
  MAX_IDAS_SOB_A_TRAVA_DE_EMAIL,
  PRAZO_DA_TRAVA_DE_EMAIL_MS,
  TIMEOUT_DA_TRAVA_DE_EMAIL_MS,
} from './trava-de-email';

/**
 * SPEC-086/AC-026 — **a prova estrutural da chave da trava por e-mail.**
 *
 * É prova de FORMA, e é declarada assim (spec, "A prova estrutural da
 * chave"). A de comportamento é o P8 da matriz de pares: cada escritor contra
 * a referência E4, com a chave desligada, grava UMA conta só.
 *
 * Duas coisas:
 * 1. o prefixo `usuarios.email:` só aparece em `trava-de-email.ts` — um
 *    escritor que montasse a chave por conta própria, com outro prefixo,
 *    teria uma trava que nenhum outro enxerga (S21);
 * 2. cada um dos oito escritores chama `travarEmailsParaCriarConta` — e a
 *    chamada vem ANTES de qualquer outra instrução da transação dele.
 */
const SRC = join(__dirname, '..');

function arquivosTs(dir: string): string[] {
  return readdirSync(dir).flatMap((nome) => {
    const caminho = join(dir, nome);
    if (statSync(caminho).isDirectory()) return arquivosTs(caminho);
    return nome.endsWith('.ts') && !nome.endsWith('.spec.ts') ? [caminho] : [];
  });
}

const relativo = (p: string) => relative(SRC, p).split('\\').join('/');

describe('SPEC-086/AC-026 — a chave da trava é montada num lugar só', () => {
  it('o prefixo `usuarios.email:` só existe em `acesso/trava-de-email.ts`', () => {
    const onde = arquivosTs(SRC)
      .filter((p) => readFileSync(p, 'utf8').includes('usuarios.email:'))
      .map(relativo);
    expect(onde).toEqual(['acesso/trava-de-email.ts']);
  });

  /**
   * Os oito escritores, e o trecho que vem logo antes da trava. A trava tem
   * de ser a primeira instrução da transação: entre o `$transaction(` e a
   * chamada não pode haver outro `await tx.`.
   */
  const ESCRITORES: [string, string, string][] = [
    ['E1', 'auth/auth.service.ts', 'async registerAluno('],
    ['E2', 'auth/invites.service.ts', 'private async aceitarNaTransacao('],
    ['E4', 'people/students.service.ts', 'async create('],
    [
      'E5a/E5b',
      'people/teachers.service.ts',
      'private async criarContaNaTransacao(',
    ],
    [
      'E6',
      'people/importacao/importacao-de-alunos.service.ts',
      'private async escreverNaTransacao(',
    ],
    ['E7', 'companies/companies.service.ts', 'async create(dto'],
    ['E8', 'companies/companies.service.ts', 'async criarAdmin('],
  ];

  it.each(ESCRITORES)(
    '%s (%s): a trava é a primeira instrução da transação',
    (_e, arquivo, ancora) => {
      const texto = readFileSync(join(SRC, arquivo), 'utf8');
      const inicio = texto.indexOf(ancora);
      expect(inicio).toBeGreaterThanOrEqual(0);
      // A âncora é única: um segundo método com o mesmo começo tornaria a
      // prova ambígua.
      expect(texto.indexOf(ancora, inicio + 1)).toBe(-1);
      const trava = texto.indexOf('travarEmailsParaCriarConta(', inicio);
      expect(trava).toBeGreaterThan(inicio);
      // Da âncora até a trava: nenhuma instrução no cliente da transação.
      expect(texto.slice(inicio, trava)).not.toMatch(/await tx\./);
    },
  );

  /**
   * O orçamento e o `timeout` amarrados à mesma conta da matrícula (D3), e
   * cada transação que cria conta com o `timeout` explícito. Sem ele vale o
   * padrão de 5 s do Prisma — menor que o orçamento de 5 s mais o trabalho
   * do vencedor —, e o E2 respondia 500 (`P2028`) na Neon (run 37958329679).
   */
  it('orçamento = 2 s + idas × 250 ms; timeout = orçamento + idas × 250 ms + 1 s', () => {
    expect(PRAZO_DA_TRAVA_DE_EMAIL_MS).toBe(
      2_000 + MAX_IDAS_SOB_A_TRAVA_DE_EMAIL * LATENCIA_DE_ORCAMENTO_MS,
    );
    expect(TIMEOUT_DA_TRAVA_DE_EMAIL_MS).toBe(
      PRAZO_DA_TRAVA_DE_EMAIL_MS +
        MAX_IDAS_SOB_A_TRAVA_DE_EMAIL * LATENCIA_DE_ORCAMENTO_MS +
        FOLGA_DO_TIMEOUT_MS,
    );
    expect([PRAZO_DA_TRAVA_DE_EMAIL_MS, TIMEOUT_DA_TRAVA_DE_EMAIL_MS]).toEqual([
      5_000, 9_000,
    ]);
    expect(TIMEOUT_DA_IMPORTACAO_MS).toBe(15_000 + PRAZO_DA_TRAVA_DE_EMAIL_MS);
  });

  const TIMEOUTS: [string, string, number][] = [
    ['E1', 'auth/auth.service.ts', 1],
    ['E2', 'auth/invites.service.ts', 1],
    ['E4', 'people/students.service.ts', 1],
    ['E5b', 'people/teachers.service.ts', 1],
    ['E5a', 'acesso/acesso.service.ts', 1],
    ['E7/E8', 'companies/companies.service.ts', 2],
  ];

  it.each(TIMEOUTS)(
    '%s (%s): a transação que cria conta declara o timeout da trava',
    (_e, arquivo, vezes) => {
      const texto = readFileSync(join(SRC, arquivo), 'utf8');
      expect(
        texto.split('timeout: TIMEOUT_DA_TRAVA_DE_EMAIL_MS').length - 1,
      ).toBe(vezes);
    },
  );
});
