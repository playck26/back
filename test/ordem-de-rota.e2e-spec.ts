import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock } from './utils/prisma-mock';
import {
  conflitosDeOrdem,
  gramaticaNaoSuportada,
  rotasDoApp,
  type Rota,
} from './utils/ordem-de-rota';

/**
 * **SPEC-067/TASK-003 — nenhuma rota literal registrada depois de uma
 * paramétrica que a casaria.**
 *
 * ## O defeito que isto impede de voltar
 *
 * DEF-039: `@Get('anteriores')` estava declarada depois de `@Get(':id')` em
 * `me-classes.controller.ts`. O Express casava o `:id`, o pipe de UUID recebia
 * a palavra `anteriores` e respondia **400 numa rota que existia**. A tela
 * "Aulas que já passaram" — o único lugar onde o aluno avalia uma aula — ficou
 * morta, e o comentário acima do `:id` avisava disso com todas as letras.
 *
 * A AC-001 da SPEC-066 protege `proximas`. **Este arquivo protege a próxima.**
 *
 * ## Por que o nome termina em `.e2e-spec.ts`
 *
 * A spec chamou este arquivo de `ordem-de-rota.gate.spec.ts`. **Nenhum runner o
 * executaria:** a config unitária procura só em `src/`, e a de e2e só casa
 * `.e2e-spec.ts`. Um teste que ninguém roda fica verde para sempre — é o gate
 * vazio em forma de arquivo. Este nome é o que o `pnpm test:e2e` do CI pega.
 */

describe('SPEC-067 — a regra, com rotas inventadas (as sabotagens)', () => {
  const r = (metodo: string, caminho: string): Rota => ({ metodo, caminho });

  it('AC-005 — literal DEPOIS da paramétrica que a casa: conflito, nomeando as duas', () => {
    const achados = conflitosDeOrdem([
      r('get', '/api/v1/me/classes/:id'),
      r('get', '/api/v1/me/classes/anteriores'),
    ]);
    expect(achados).toHaveLength(1);
    expect(achados[0]).toContain('GET /api/v1/me/classes/anteriores');
    expect(achados[0]).toContain('GET /api/v1/me/classes/:id');
  });

  it('a ordem certa — literal ANTES — não é conflito', () => {
    expect(
      conflitosDeOrdem([
        r('get', '/api/v1/me/classes/anteriores'),
        r('get', '/api/v1/me/classes/:id'),
      ]),
    ).toEqual([]);
  });

  it('parâmetro no MEIO também engole: `/a/:x/b` antes de `/a/c/b`', () => {
    // O caso que a 2ª rodada de validação perguntou se a regra cobria.
    expect(
      conflitosDeOrdem([r('get', '/a/:x/b'), r('get', '/a/c/b')]),
    ).toHaveLength(1);
  });

  it('método diferente não conflita: `POST :id` e `GET literal` convivem', () => {
    expect(
      conflitosDeOrdem([
        r('post', '/api/v1/me/classes/:id'),
        r('get', '/api/v1/me/classes/x'),
      ]),
    ).toEqual([]);
  });

  it('quantidade diferente de segmentos não conflita', () => {
    expect(conflitosDeOrdem([r('get', '/a/:id'), r('get', '/a/b/c')])).toEqual(
      [],
    );
  });

  it('rota IDÊNTICA registrada duas vezes: a segunda é inalcançável, e é conflito', () => {
    expect(conflitosDeOrdem([r('get', '/a/b'), r('get', '/a/b')])).toHaveLength(
      1,
    );
  });

  it.each([
    ['wildcard', '/api/v1/*'],
    ['wildcard nomeado (Express 5)', '/api/v1/*resto'],
    ['segmento opcional', '/api/v1/a/:id?'],
    ['grupo opcional (Express 5)', '/api/v1/a{/:id}'],
    ['parêntese de regex', '/api/v1/a/(\\d+)'],
    ['sufixo +', '/api/v1/a/:id+'],
    ['acento', '/api/v1/aulas-próximas'],
    ['til', '/api/v1/~a'],
    ['arroba', '/api/v1/@a'],
    ['porcento', '/api/v1/a%20b'],
  ])('AC-013 — %s é gramática não suportada', (_nome, caminho) => {
    expect(gramaticaNaoSuportada([r('get', caminho)])).toHaveLength(1);
  });

  it('literal e `:param` são aceitos', () => {
    expect(
      gramaticaNaoSuportada([
        r('get', '/api/v1/me/classes/:id'),
        r('get', '/api/v1/push/chave-publica'),
        r('get', '/api/v1/a_b/c.d'),
      ]),
    ).toEqual([]);
  });
});

describe('SPEC-067 — o app que não sobe não é acusado de ordem errada', () => {
  it('a falha de montagem diz que o APP NÃO SUBIU, e não menciona conflito', async () => {
    // Ressalva da 3ª rodada: se o módulo não subir por outro motivo, o gate não
    // pode parecer acusar a ordem das rotas. Nenhuma AC sabotava isto.
    const falhou = rotasDoApp(() =>
      Promise.reject(new Error('Nest could not resolve X')),
    );
    await expect(falhou).rejects.toThrow(/^O APP NAO SUBIU/);
    await expect(falhou).rejects.not.toThrow(
      /nunca e alcancada|registrada antes/,
    );
  });
});

describe('SPEC-067 — o roteador de verdade', () => {
  let rotas: Rota[];

  beforeAll(async () => {
    rotas = await rotasDoApp(() => createTestApp(buildPrismaMock()));
  });

  it('o gate LEU o roteador — senão, zero rotas dariam zero conflitos', () => {
    // **Um gate que não leu nada fica verde.** Se o Express mudar o nome da
    // pilha (já mudou de `_router` para `router` no 5), `lerRoteador` devolve
    // uma lista vazia e as duas provas abaixo passariam sem conferir coisa
    // alguma. Por isso: um piso, e uma rota conhecida que tem de estar lá.
    expect(rotas.length).toBeGreaterThanOrEqual(100);
    expect(rotas).toContainEqual({
      metodo: 'get',
      caminho: '/api/v1/me/classes/:id',
    });
  });

  it('AC-013 — nenhuma rota usa gramática que a regra não entende', () => {
    expect(gramaticaNaoSuportada(rotas)).toEqual([]);
  });

  it('AC-006 — nenhuma rota literal é engolida por uma paramétrica anterior', () => {
    // E AC-007 de graça: `me-classes.controller.ts` e `agenda.controller.ts`
    // têm `@Get(':id')` e `@Get(':data')` escritos DENTRO de comentários — os
    // avisos do DEF-039. A varredura textual da v1 acusava os dois. O roteador
    // nem os vê.
    expect(conflitosDeOrdem(rotas)).toEqual([]);
  });
});
