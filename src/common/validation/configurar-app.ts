import { ValidationPipe, type ValidationPipeOptions } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';

/**
 * **A configuração de app-level que produção e e2e compartilham.**
 *
 * ## O achado 3 da 6ª validação cruzada
 *
 * A rodada anterior criou uma fábrica só do `ValidationPipe` e eu chamei
 * aquilo de "fechar o buraco". Não fechou. O revisor mostrou a sabotagem de
 * uma linha:
 *
 * ```ts
 * // main.ts
 * app.useGlobalPipes(new ValidationPipe({}));
 * ```
 *
 * As 884 provas continuavam verdes; as provas do decorador também, porque
 * construíam o pipe pela fábrica em vez de pelo app; e **os e2e também não
 * pegavam**, porque cada um montava o seu próprio `ValidationPipe` — inclusive
 * `test/utils/create-test-app.ts`, cujo comentário afirmava *"replica
 * exatamente o setup de `src/main.ts`"* e era uma cópia manual, livre para
 * divergir.
 *
 * A fábrica tinha tirado a duplicação **de dentro da prova** e deixado
 * intacta a ligação que importa: produção → configuração. Este arquivo fecha
 * essa: `main.ts` e `createTestApp` chamam a MESMA função, então uma
 * divergência entre os dois deixou de ser possível por construção, em vez de
 * ser evitada por um comentário pedindo cuidado.
 *
 * ## O que fica de fora, e por quê
 *
 * CORS, Swagger e `listen` continuam no `main.ts`: dependem de ambiente
 * (`process.env`), e arrastá-los para cá obrigaria o e2e a montar ambiente
 * para exercitar rota. Não afetam nenhuma chamada por Supertest.
 *
 * ## Sobre `transform: true`
 *
 * O comentário que estava aqui dizia que a fronteira do UUID de corpo
 * **depende** dele. **Medido, é falso** — só a configuração inteiramente
 * padrão (`{}`) perde a normalização, porque o `ValidationPipe` devolve
 * `classToPlain(entity)` sempre que `validatorOptions` não está vazio. A
 * medição está registrada em prova (`uuid-no-corpo.gate.spec.ts`). Mantemos
 * `transform: true` porque é o que o resto do projeto espera de um DTO
 * validado — não porque a normalização penda dele.
 */
export const OPCOES_DE_VALIDACAO: ValidationPipeOptions = {
  whitelist: true,
  transform: true,
  forbidNonWhitelisted: true,
};

export function criarValidationPipe(): ValidationPipe {
  return new ValidationPipe(OPCOES_DE_VALIDACAO);
}

export const PREFIXO_DA_API = 'api/v1';

/**
 * Aplica no app tudo o que produção aplica e que muda o comportamento de uma
 * rota. Chamado por `main.ts` e por `createTestApp`.
 */
export function configurarApp(app: INestApplication): INestApplication {
  app.setGlobalPrefix(PREFIXO_DA_API);
  // CSP desligado: o CSP padrão do helmet bloqueia o script/style inline que o
  // Swagger UI usa (recomendação da própria doc do NestJS). Demais headers
  // continuam ativos.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.useGlobalPipes(criarValidationPipe());
  return app;
}

/**
 * **O caminho que o `main.ts` executa para nascer com a fronteira aplicada.**
 *
 * ## O achado 4 da 7ª rodada
 *
 * A prova HTTP chamava `configurarApp` diretamente, e por isso a sabotagem
 * continuava passando: trocar por `new ValidationPipe({})` DENTRO do
 * `bootstrap()` deixava as 891 provas verdes, porque nenhuma delas executava
 * o caminho de bootstrap. `expect(typeof configurarApp).toBe('function')` não
 * prova chamador nenhum — era prova de existência disfarçada de prova de
 * ligação.
 *
 * Agora `bootstrap()` não constrói app: ele pede um a esta função. O teste
 * (`bootstrap-de-producao.spec.ts`) executa **esta função**, com o
 * `NestFactory` dublado, e confere o pipe que ela instala.
 *
 * **O que continua sem prova, e fica declarado como LIMITE:** que o
 * `main.ts` chame isto e não mexa no app depois. Um
 * `app.useGlobalPipes(new ValidationPipe({}))` acrescentado após esta
 * chamada ainda passaria. Fechar isso exigiria subir o app de produção de
 * verdade, com banco — o que esta máquina não faz. É risco declarado, não
 * pendência escondida.
 */
export async function criarAppDeProducao(): Promise<INestApplication> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { NestFactory } = require('@nestjs/core') as {
    NestFactory: { create: (m: unknown) => Promise<INestApplication> };
  };
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { AppModule } = require('../../app.module') as { AppModule: unknown };
  return configurarApp(await NestFactory.create(AppModule));
}
