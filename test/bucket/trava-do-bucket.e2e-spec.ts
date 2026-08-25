import {
  BUCKET_ESPERADO,
  conferirBucketEsperado,
  EMPRESA_DE_TESTE,
  PREFIXO_DE_TESTE,
} from './exigir-bucket-de-teste';

/**
 * SPEC-017/TASK-007 — **a trava do FIT-006 tem prova própria, e ela roda no
 * CI.**
 *
 * O `fit-006.bucket-spec.ts` escreve e apaga no bucket real, então não roda
 * no CI e nunca vai rodar: exige credencial. Mas isso deixaria a *trava* sem
 * verificação nenhuma — e a trava é justamente a peça que impede a suíte de
 * repetir o incidente de 2026-08-24 com outro recurso.
 *
 * Este arquivo é `e2e-spec` de propósito: roda em `pnpm test:e2e`, **sem
 * credencial**, portanto no CI. Se alguém afrouxar a trava, o CI cai antes
 * de qualquer objeto ser tocado.
 */
describe('a trava do FIT-006', () => {
  it('recusa qualquer bucket que não seja o esperado', () => {
    expect(() => conferirBucketEsperado('outro-bucket')).toThrow(
      /só aceita o bucket "playck-media"/,
    );
  });

  it('aceita o esperado', () => {
    expect(() => conferirBucketEsperado(BUCKET_ESPERADO)).not.toThrow();
  });

  it.each([
    ['vazio', ''],
    ['com espaço à toa', ' playck-media'],
    ['prefixo do esperado', 'playck'],
    ['esperado com sufixo', 'playck-media-prod'],
    ['caixa diferente', 'PlayCK-Media'],
  ])('recusa %s', (_nome, bucket) => {
    expect(() => conferirBucketEsperado(bucket)).toThrow();
  });

  it('a mensagem diz que é trava, não aviso', () => {
    // A diferença importa: a versão anterior era uma asserção dentro do
    // primeiro `it`. Com o bucket errado, o Jest marcava aquele teste como
    // falho e SEGUIA rodando os outros, que escrevem e apagam. Teste
    // vermelho não impede o próximo de rodar.
    expect(() => conferirBucketEsperado('errado')).toThrow(
      /nenhum teste desta suíte roda/,
    );
  });

  it('o prefixo é derivado da empresa de teste, e não de outra coisa', () => {
    // Se o prefixo pudesse ser montado à mão, alguém o apontaria para uma
    // empresa real sem perceber.
    expect(PREFIXO_DE_TESTE).toBe(`empresas/${EMPRESA_DE_TESTE}/`);
    expect(PREFIXO_DE_TESTE.endsWith('/')).toBe(true);
  });
});
