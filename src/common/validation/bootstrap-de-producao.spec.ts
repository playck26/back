import { ValidationPipe } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { criarAppDeProducao, OPCOES_DE_VALIDACAO } from './configurar-app';
import { opcoesDeCors } from './cors';

/**
 * **A prova do BOOTSTRAP — achado 4 da 7ª rodada.**
 *
 * A prova HTTP chamava `configurarApp` diretamente, e por isso a sabotagem de
 * uma linha continuava passando:
 *
 * ```ts
 * // main.ts
 * app.useGlobalPipes(new ValidationPipe({}));
 * ```
 *
 * As 891 provas ficavam verdes, porque nenhuma executava o caminho de
 * bootstrap. E a guarda que eu tinha escrito —
 * `expect(typeof configurarApp).toBe('function')` — não provava chamador
 * nenhum: era prova de existência disfarçada de prova de ligação.
 *
 * Esta suíte executa **`criarAppDeProducao`**, a função que o `bootstrap()`
 * chama, com o `NestFactory` dublado — o dublê é do container do Nest, não da
 * configuração, que é o objeto do julgamento. Trocar o pipe lá dentro derruba
 * daqui.
 *
 * ## O que ela NÃO prova, e fica como LIMITE declarado
 *
 * Que o `main.ts` não mexa no app **depois** de receber. Um
 * `useGlobalPipes(new ValidationPipe({}))` acrescentado na linha seguinte
 * ainda passaria. Fechar isso exigiria subir o app de produção com banco, e
 * esta máquina não faz — Docker não sobe, e o Postgres local recusa conexão.
 *
 * É a fresta que sobra depois de sete rodadas, e ela está registrada como
 * limite na planta e na spec — não como pendência, e não como resolvida.
 */
jest.mock('@nestjs/core', () => ({
  ...jest.requireActual<typeof import('@nestjs/core')>('@nestjs/core'),
  NestFactory: { create: jest.fn() },
}));

interface AppDublado extends Partial<INestApplication> {
  useGlobalPipes: jest.Mock<INestApplication, [unknown]>;
  setGlobalPrefix: jest.Mock;
  use: jest.Mock;
  // SPEC-070/D4 — o CORS passou a ser instalado por `criarAppDeProducao`.
  // Tipado com o argumento como `unknown`: sem isso, `mock.calls[0][0]`
  // vira `any` e o lint recusa o acesso.
  enableCors: jest.Mock<void, [unknown]>;
}

function appDublado(): AppDublado {
  return {
    useGlobalPipes: jest.fn<INestApplication, [unknown]>(),
    setGlobalPrefix: jest.fn(),
    use: jest.fn(),
    enableCors: jest.fn<void, [unknown]>(),
  };
}

describe('o bootstrap de produção nasce com a fronteira aplicada', () => {
  let app: AppDublado;

  beforeEach(async () => {
    app = appDublado();
    (NestFactory.create as jest.Mock).mockResolvedValue(app);
    await criarAppDeProducao();
  });

  it('instala um `ValidationPipe` global', () => {
    expect(app.useGlobalPipes).toHaveBeenCalledTimes(1);
    const instalado: unknown = app.useGlobalPipes.mock.calls[0][0];
    expect(instalado).toBeInstanceOf(ValidationPipe);
  });

  it('e com as opções que a fronteira do UUID de corpo exige', () => {
    // A medição da 5ª rodada: só a configuração inteiramente padrão (`{}`)
    // perde a normalização. Esta prova é o que faz `new ValidationPipe({})`
    // no bootstrap virar vermelho em vez de silêncio.
    const pipe = app.useGlobalPipes.mock.calls[0][0] as {
      validatorOptions?: Record<string, unknown>;
      isTransformEnabled?: boolean;
    };

    expect(pipe.validatorOptions).toMatchObject({
      whitelist: OPCOES_DE_VALIDACAO.whitelist,
      forbidNonWhitelisted: OPCOES_DE_VALIDACAO.forbidNonWhitelisted,
    });
    expect(pipe.isTransformEnabled).toBe(OPCOES_DE_VALIDACAO.transform);
  });

  // **SPEC-070/AC-006, cláusula 1 — a LIGAÇÃO, provada por execução.**
  //
  // Duas tentativas de provar isto por texto caíram na validação: um gate que
  // exigia "obtém as opções e não declara `origin` inline" passava com
  // `const o = opcoesDeCors(env); void o;`, sem chamar nada. Aqui a fábrica é
  // EXECUTADA, e o espião conta a chamada.
  //
  // A comparação é com **o objeto inteiro** devolvido por `opcoesDeCors` — e
  // não com `origin`, que era o defeito B07: `credentials` podia cair sem
  // ninguém notar.
  it('instala o CORS com EXATAMENTE as opções de `opcoesDeCors`', () => {
    expect(app.enableCors).toHaveBeenCalledTimes(1);
    expect(app.enableCors.mock.calls[0][0]).toEqual(opcoesDeCors(process.env));
  });

  it('e com o prefixo e os middlewares de rota', () => {
    // Sem estes, `configurarApp` poderia encolher para só o pipe e nenhuma
    // prova notaria — o prefixo é o que faz `/api/v1/...` existir.
    expect(app.setGlobalPrefix).toHaveBeenCalledWith('api/v1');
    // helmet e cookie-parser. (O diagnóstico de IP do DEF-031 saiu depois da
    // medição em produção.)
    expect(app.use).toHaveBeenCalledTimes(2);
  });
});
