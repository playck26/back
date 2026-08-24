import { KeyReferenceRegistry } from './key-reference-checker';

// SPEC-017/TASK-005 — INV-044. O que este arquivo prova é o fail-closed:
// sem checker, o silêncio significa "não sei", nunca "pode apagar".

const KEY = 'empresas/a/quadra/b/c.webp';

describe('KeyReferenceRegistry', () => {
  let registry: KeyReferenceRegistry;

  beforeEach(() => {
    registry = new KeyReferenceRegistry();
  });

  it('SEM checker responde "referenciada" — fail-closed (INV-044)', async () => {
    // Uma fundação no ar antes do consumidor não pode apagar por não saber
    // quem aponta. Se esta linha virar `false`, o worker esvazia o bucket.
    expect(registry.temChecker()).toBe(false);
    await expect(registry.estaReferenciada(KEY)).resolves.toBe(true);
  });

  it('com checker, obedece a resposta dele', async () => {
    registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    await expect(registry.estaReferenciada(KEY)).resolves.toBe(false);
  });

  it('passa a chave adiante sem alterar', async () => {
    let recebida: string | null = null;
    registry.registrar({
      estaReferenciada: (k) => {
        recebida = k;
        return Promise.resolve(true);
      },
    });
    await registry.estaReferenciada(KEY);
    expect(recebida).toBe(KEY);
  });

  it('recusa DOIS checkers — dois donos da mesma pergunta', () => {
    // O worker não teria como saber qual obedecer, e escolher em silêncio é
    // escolher errado metade das vezes.
    const checker = { estaReferenciada: () => Promise.resolve(true) };
    registry.registrar(checker);
    expect(() => registry.registrar(checker)).toThrow(/já existe/i);
  });

  it('lembra que JÁ TEVE checker depois de perdê-lo (AC-014c)', () => {
    // É o que distingue "ainda não chegou" de "sumiu". Sem isso, os dois
    // estados são indistinguíveis, e o fail-closed disfarça o defeito de
    // normalidade.
    expect(registry.jaTeveChecker()).toBe(false);
    registry.registrar({ estaReferenciada: () => Promise.resolve(true) });
    registry.desregistrar();
    expect(registry.temChecker()).toBe(false);
    expect(registry.jaTeveChecker()).toBe(true);
  });

  it('checker que sumiu volta ao fail-closed', async () => {
    registry.registrar({ estaReferenciada: () => Promise.resolve(false) });
    registry.desregistrar();
    await expect(registry.estaReferenciada(KEY)).resolves.toBe(true);
  });
});
