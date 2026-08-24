import { ordenarChavesParaLock, StorageLockKey } from './storage-lock-key';
import { tentarLockDeChave } from './advisory-lock';

// SPEC-017/TASK-005 — AC-020/INV-043: o `bigint` tem UMA fonte.
//
// Colisão é inofensiva (duas chaves se serializam à toa). O risco real é o
// inverso: dois trechos calculando número DIFERENTE para a mesma string, e
// achando que travaram a mesma coisa. Aí não há lock nenhum, e nada falha —
// até o dia em que um DELETE roda no meio de um PUT.

const KEY = `empresas/a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a/quadra/c3d4e5f6-33ef-4333-8333-3f3e3d3c3b3a/${'a'.repeat(64)}.webp`;

describe('StorageLockKey', () => {
  it('é determinístico', () => {
    expect(StorageLockKey.fromObjectKey(KEY)).toBe(
      StorageLockKey.fromObjectKey(KEY),
    );
  });

  it('o algoritmo é FIXO — sha256, 8 bytes, big-endian, com sinal', () => {
    // Valor congelado. Mudar qualquer uma das quatro escolhas quebra todo
    // lock já tomado, e este teste é o que obriga a mudança a ser
    // deliberada em vez de acidental.
    expect(StorageLockKey.fromObjectKey('playck')).toBe(-755961181511603538n);
    expect(StorageLockKey.fromObjectKey('')).toBe(-2039914840885289964n);
  });

  it('cabe em bigint assinado do Postgres', () => {
    const LIMITE = 2n ** 63n;
    for (const entrada of ['a', KEY, 'x'.repeat(5000), '🙂']) {
      const valor = StorageLockKey.fromObjectKey(entrada);
      expect(valor).toBeLessThan(LIMITE);
      expect(valor).toBeGreaterThanOrEqual(-LIMITE);
    }
  });

  it('produz valores NEGATIVOS — e é por isso que o tipo é assinado', () => {
    // Se alguém trocar para `readBigUInt64BE`, metade das chaves passa a
    // estourar o `bigint` do Postgres. Este teste prova que o caso existe.
    const negativos = ['playck', 'a', 'quadra'].map((k) =>
      StorageLockKey.fromObjectKey(k),
    );
    expect(negativos.some((v) => v < 0n)).toBe(true);
  });

  it('PARIDADE (AC-020): o mesmo número em todos os pontos de uso', async () => {
    // O ponto de uso real é o `tentarLockDeChave`. Se ele calculasse o
    // número por conta própria, este teste pegaria a divergência.
    let recebido: bigint | null = null;
    const tx = {
      $queryRaw: (_q: TemplateStringsArray, ...valores: unknown[]) => {
        recebido = valores[0] as bigint;
        return Promise.resolve([{ tomou: true }]);
      },
    };
    await tentarLockDeChave(tx, KEY);
    expect(recebido).toBe(StorageLockKey.fromObjectKey(KEY));
  });
});

describe('ordenarChavesParaLock — AC-021', () => {
  it('devolve em ordem lexicográfica', () => {
    expect(ordenarChavesParaLock(['c', 'a', 'b'])).toEqual(['a', 'b', 'c']);
  });

  it('tira duplicata — pedir o mesmo lock duas vezes é pedir uma', () => {
    expect(ordenarChavesParaLock(['b', 'a', 'b'])).toEqual(['a', 'b']);
  });

  it('ordena pela CHAVE, não pelo bigint', () => {
    // Se um dia o algoritmo do hash mudar, a ordem continua a mesma nos dois
    // lados do grafo. Ordenar pelo número faria duas versões do código
    // conviverem com ordens diferentes durante um deploy — que é exatamente
    // quando um deadlock apareceria.
    // Par escolhido porque as duas ordens DIVERGEM: 'aaa' < 'k4' como
    // string, mas hash('aaa') > hash('k4') como número. Sem um par assim, o
    // teste passaria mesmo com a implementação errada.
    const chaves = ['k4', 'aaa'];
    const porBigint = [...chaves].sort((x, y) =>
      StorageLockKey.fromObjectKey(x) < StorageLockKey.fromObjectKey(y)
        ? -1
        : 1,
    );
    expect(ordenarChavesParaLock(chaves)).toEqual(['aaa', 'k4']);
    expect(porBigint).toEqual(['k4', 'aaa']);
  });

  it('não altera o array recebido', () => {
    const original = ['c', 'a'];
    ordenarChavesParaLock(original);
    expect(original).toEqual(['c', 'a']);
  });
});
