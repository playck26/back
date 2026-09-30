import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { MARCADOR_DO_PRAZO } from '../common/lock/prazo-de-espera';
import {
  clienteContado,
  ehEscritaDeModelo,
  RAMO_MAIS_CARO,
  type Ida,
} from '../../test/utils/cliente-contado-da-matricula';

/**
 * SPEC-082/AC-017 — **nenhuma escrita nasce sem o prazo**, em todos os ramos
 * que escrevem (achado 082-V4-03).
 *
 * Toda aquisição de lock das três transações leitoras acontece com o
 * `lock_timeout` recalculado imediatamente antes dela (D2b). Uma escrita nova
 * pela API de modelo do Prisma — um `tx.turmaAluno.create` que voltasse — não
 * carrega o `WITH` que recalcula, e a checagem de FK dela esperaria com um
 * valor antigo. Este gate é o que fica vermelho nesse dia.
 *
 * **Dinâmico:** executa os QUATRO ramos que escrevem, pelo cliente que
 * registra o texto de cada instrução (`cliente-contado-da-matricula.ts`), e
 * afirma que toda instrução `INSERT`/`UPDATE`/`DELETE` e todo `FOR UPDATE`/
 * `FOR KEY SHARE` contêm o marcador `playck.prazo`. A lista das escritas de
 * cada ramo vem do inventário do State: uma a mais ou a menos fica vermelha.
 *
 * **Estrutural:** nos corpos das três transações, e do que elas chamam, o
 * gate recusa qualquer escrita pela API de modelo.
 */

/** O rótulo de uma instrução crua que escreve ou trava linha; `null` se não. */
function classificar(sql: string): string | null {
  const insert = /INSERT\s+INTO\s+(\w+)/.exec(sql);
  if (insert) return `INSERT ${insert[1]}`;
  const update = /UPDATE\s+(\w+)\s+SET[\s\S]*?estado\s*=\s*'(\w+)'/.exec(sql);
  if (update) return `UPDATE ${update[1]} '${update[2]}'`;
  const updateSemEstado = /UPDATE\s+(\w+)\s+SET/.exec(sql);
  if (updateSemEstado) return `UPDATE ${updateSemEstado[1]}`;
  const del = /DELETE\s+FROM\s+(\w+)/.exec(sql);
  if (del) return `DELETE ${del[1]}`;
  const lock = /FOR\s+(UPDATE|KEY\s+SHARE|SHARE|NO\s+KEY\s+UPDATE)\b/.exec(sql);
  if (lock) {
    // A tabela travada é a do `FROM` principal — o `prazo_r` do `WITH` é a
    // variável do prazo, não uma tabela.
    const tabelas = [...sql.matchAll(/FROM\s+([a-z_]+)/g)]
      .map((m) => m[1])
      .filter((t) => t !== 'prazo_r');
    return `FOR ${lock[1].replace(/\s+/g, ' ')} ${tabelas[0] ?? '?'}`;
  }
  return null;
}

function escritasELocks(idas: Ida[]): { rotulo: string; sql: string }[] {
  return idas
    .filter((i): i is Ida & { sql: string } => i.sql !== null)
    .map((i) => ({ rotulo: classificar(i.sql), sql: i.sql }))
    .filter((i): i is { rotulo: string; sql: string } => i.rotulo !== null);
}

const RAMOS = [
  {
    nome: 'ramo 1 — entrar com sucesso e gestor ativo',
    cenario: RAMO_MAIS_CARO,
    executar: (c: ReturnType<typeof clienteContado>) => c.entrar(),
    esperadas: [
      'FOR UPDATE turmas',
      'INSERT turma_alunos',
      'INSERT notificacoes',
    ],
  },
  {
    nome: 'ramo 2 — allocateStudent com sucesso',
    cenario: RAMO_MAIS_CARO,
    executar: (c: ReturnType<typeof clienteContado>) => c.allocateStudent(),
    esperadas: ['FOR UPDATE turmas', 'INSERT turma_alunos'],
  },
  {
    nome: 'ramo 3 — confirmar com sucesso (linha atendida)',
    cenario: RAMO_MAIS_CARO,
    executar: (c: ReturnType<typeof clienteContado>) => c.confirmar(),
    esperadas: [
      'FOR UPDATE turmas',
      'FOR UPDATE lista_de_espera',
      'FOR UPDATE turmas',
      'INSERT turma_alunos',
      'INSERT notificacoes',
      "UPDATE lista_de_espera 'atendida'",
    ],
  },
  {
    nome: 'ramo 4 — confirmar com recusa de domínio (turma cheia, linha encerrada)',
    cenario: { ...RAMO_MAIS_CARO, turmaCheiaNaTransacao: true },
    executar: (c: ReturnType<typeof clienteContado>) => c.confirmar(),
    esperadas: [
      'FOR UPDATE turmas',
      'FOR UPDATE lista_de_espera',
      'FOR UPDATE turmas',
      "UPDATE lista_de_espera 'encerrada'",
    ],
  },
];

describe('SPEC-082/AC-017 — nenhuma escrita nasce sem o prazo (dinâmico)', () => {
  describe.each(RAMOS)('$nome', ({ cenario, executar, esperadas }) => {
    let idas: Ida[];

    beforeAll(async () => {
      const cliente = clienteContado(cenario);
      await executar(cliente);
      idas = cliente.idas;
    });

    it('as escritas e os locks de linha são exatamente os do inventário', () => {
      expect(escritasELocks(idas).map((i) => i.rotulo)).toEqual(esperadas);
    });

    it('cada uma delas leva o marcador playck.prazo', () => {
      const semPrazo = escritasELocks(idas)
        .filter((i) => !i.sql.includes(MARCADOR_DO_PRAZO))
        .map((i) => i.rotulo);
      expect(semPrazo).toEqual([]);
    });

    it('nenhuma escrita pela API de modelo do Prisma', () => {
      expect(idas.filter(ehEscritaDeModelo).map((i) => i.rotulo)).toEqual([]);
    });
  });

  it('o ramo 4 é mesmo uma recusa que encerra a linha (e não uma exceção)', async () => {
    const cliente = clienteContado({
      ...RAMO_MAIS_CARO,
      turmaCheiaNaTransacao: true,
    });
    await expect(cliente.confirmar()).resolves.toMatchObject({
      ok: false,
      code: 'TURMA_CHEIA',
    });
    expect(cliente.idas[cliente.idas.length - 1].rotulo).toBe('COMMIT');
  });
});

/**
 * **Estrutural** — os corpos das três transações e do que elas chamam, lidos
 * como texto. É o complemento do dinâmico: um ramo que nenhum dos quatro
 * percorre (uma recusa nova, um `if` novo) ainda passa por aqui.
 */
describe('SPEC-082/AC-017 — nenhuma escrita pela API de modelo (estrutural)', () => {
  const RAIZ = join(__dirname, '..', '..');

  /** O corpo de uma função/método, do cabeçalho até a chave que o fecha. */
  function corpo(arquivo: string, cabecalho: RegExp): string {
    const texto = readFileSync(join(RAIZ, arquivo), 'utf8');
    const inicio = texto.search(cabecalho);
    if (inicio < 0) throw new Error(`${arquivo}: ${cabecalho} não encontrado`);
    const abre = texto.indexOf('{', texto.indexOf(')', inicio));
    let profundidade = 0;
    for (let i = abre; i < texto.length; i++) {
      if (texto[i] === '{') profundidade++;
      if (texto[i] === '}') profundidade--;
      if (profundidade === 0) return texto.slice(inicio, i + 1);
    }
    throw new Error(`${arquivo}: ${cabecalho} sem fim`);
  }

  const ESCRITA_DE_MODELO =
    /\b(?:tx|db|this\.tx)\s*\.\s*(\w+)\s*\.\s*(create|createMany|createManyAndReturn|update|updateMany|updateManyAndReturn|upsert|delete|deleteMany)\s*\(/g;

  const CORPOS: [string, RegExp][] = [
    ['src/classes/matricula-do-aluno.service.ts', /\n {2}async entrar\(/],
    [
      'src/classes/matricula-do-aluno.service.ts',
      /\n {2}async entrarNaTransacao\(/,
    ],
    ['src/classes/classes.service.ts', /\n {2}async allocateStudent\(/],
    ['src/fila-de-espera/fila-de-espera.service.ts', /\n {2}async confirmar\(/],
    [
      'src/fila-de-espera/fila-de-espera.service.ts',
      /\n {2}private async encerrar\(/,
    ],
    [
      'src/classes/matricula-com-prazo.ts',
      /export async function inserirMatriculaComPrazo\(/,
    ],
    ['src/push/aviso-do-gesto-do-aluno.ts', /\n {2}async despachar\(/],
    [
      'src/people/nivel-efetivo.ts',
      /export async function travarNivelDaEmpresa\(/,
    ],
    ['src/people/nivel-efetivo.ts', /export async function recusaPorNivel\(/],
    [
      'src/people/nivel-efetivo.ts',
      /export async function nivelEfetivoDoAluno\(/,
    ],
    [
      'src/classes/ocupacao-da-ocorrencia.ts',
      /export async function aulasQueAMatriculaLotaria\(/,
    ],
    [
      'src/classes/ocupacao-da-ocorrencia.ts',
      /export async function carregarConjuntos\(/,
    ],
  ];

  it.each(CORPOS)('%s — %s', (arquivo, cabecalho) => {
    const texto = corpo(arquivo, cabecalho);
    expect(texto.length).toBeGreaterThan(40);
    const achadas = [...texto.matchAll(ESCRITA_DE_MODELO)].map(
      (m) => `${m[1]}.${m[2]}`,
    );
    expect(achadas).toEqual([]);
  });

  it('a varredura enxerga escrita de modelo quando ela existe (controle)', () => {
    const achadas = [
      ...'await tx.turmaAluno.create({ data })'.matchAll(ESCRITA_DE_MODELO),
    ].map((m) => `${m[1]}.${m[2]}`);
    expect(achadas).toEqual(['turmaAluno.create']);
  });
});
