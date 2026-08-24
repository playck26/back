import { comLockDeChaves, tentarLockDeChave } from './advisory-lock';
import { StorageLockKey } from './storage-lock-key';

// SPEC-017/TASK-005 — a ORDEM de aquisição (AC-021). Aqui dá para observar
// cada chamada; o que só o banco prova (locks simultâneos, soltar no
// rollback) está em `test/banco/fila-worker.db-spec.ts`.

function txQueRegistra(respostas: boolean[]) {
  const pedidos: bigint[] = [];
  let i = 0;
  return {
    pedidos,
    tx: {
      $queryRaw: (_q: TemplateStringsArray, ...valores: unknown[]) => {
        pedidos.push(valores[0] as bigint);
        return Promise.resolve([{ tomou: respostas[i++] ?? true }]);
      },
    },
  };
}

const chaves = ['zzz', 'aaa', 'mmm'];

describe('comLockDeChaves', () => {
  it('pede os locks em ordem LEXICOGRÁFICA da chave, não na ordem recebida', async () => {
    // Ordem fixa é o que impede ciclo entre dois caminhos que precisam das
    // mesmas duas chaves. Sem ela, um upload que pegue A depois B, contra
    // uma exclusão que pegue B depois A, fecha o ciclo.
    const { pedidos, tx } = txQueRegistra([true, true, true]);

    await comLockDeChaves(tx, chaves, () => Promise.resolve('ok'));

    expect(pedidos).toEqual(
      ['aaa', 'mmm', 'zzz'].map((k) => StorageLockKey.fromObjectKey(k)),
    );
  });

  it('roda a ação quando consegue todos', async () => {
    const { tx } = txQueRegistra([true, true]);
    await expect(
      comLockDeChaves(tx, ['a', 'b'], () => Promise.resolve('feito')),
    ).resolves.toBe('feito');
  });

  it('desiste INTEIRO quando falha um lock — nem roda a ação', async () => {
    // Meia escrita com metade dos locks é pior que escrita nenhuma.
    const { pedidos, tx } = txQueRegistra([true, false]);
    let rodou = false;

    const resultado = await comLockDeChaves(tx, ['a', 'b', 'c'], () => {
      rodou = true;
      return Promise.resolve('feito');
    });

    expect(resultado).toBeNull();
    expect(rodou).toBe(false);
    // E para de pedir no primeiro que falha: insistir nos seguintes só
    // acumularia lock que ninguém vai usar.
    expect(pedidos).toHaveLength(2);
  });

  it('pede uma vez só quando a mesma chave aparece duas vezes', async () => {
    const { pedidos, tx } = txQueRegistra([true]);
    await comLockDeChaves(tx, ['a', 'a'], () => Promise.resolve('ok'));
    expect(pedidos).toHaveLength(1);
  });

  it('sem chave nenhuma, roda a ação direto', async () => {
    const { pedidos, tx } = txQueRegistra([]);
    await expect(
      comLockDeChaves(tx, [], () => Promise.resolve('ok')),
    ).resolves.toBe('ok');
    expect(pedidos).toEqual([]);
  });
});

describe('tentarLockDeChave', () => {
  it('devolve false quando o banco diz que não tomou', async () => {
    const { tx } = txQueRegistra([false]);
    await expect(tentarLockDeChave(tx, 'a')).resolves.toBe(false);
  });

  it('devolve false — e não `undefined` — quando a consulta não traz linha', async () => {
    // Fail-closed: resposta que não dá para interpretar não pode virar
    // "tomou o lock".
    const tx = { $queryRaw: () => Promise.resolve([]) };
    await expect(tentarLockDeChave(tx, 'a')).resolves.toBe(false);
  });
});
