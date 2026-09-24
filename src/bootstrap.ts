import { SwaggerModule } from '@nestjs/swagger';
import { criarAppDeProducao } from './common/validation/configurar-app';
import { buildSwaggerConfig } from './swagger.config';

/**
 * **O caminho de arranque de produção, agora EXECUTÁVEL por teste.**
 *
 * SPEC-071/TASK-001. Este corpo morava em `main.ts`, dentro de uma função que
 * nenhum teste importava — e por isso **tudo o que ele faz depois de receber o
 * app ficava sem prova**. O limite está declarado desde a 7ª rodada de
 * validação da SPEC-001, em `configurar-app.ts`, e três sabotagens passaram por
 * ele antes de alguém o fechar:
 *
 * | Tentativa | A sabotagem que passou |
 * |---|---|
 * | gate de texto no `main.ts` | obter as opções e nunca chamar `enableCors` |
 * | espião na fábrica | um `app.use` que reescreve cabeçalho, **depois** dela |
 * | log das chamadas do app | um `SwaggerModule.setup` a mais: o Swagger não é o app |
 *
 * **A lição das três é uma só:** o espaço de maneiras de mexer num app depois
 * de recebê-lo é infinito, e nenhum gate sobre o TEXTO do `main.ts` o cobre.
 * O que cobre é executar o caminho e afirmar o conjunto completo do que ele
 * fez — e, para o que não atravessa objeto nenhum (`process.on`, `process.env`),
 * olhar o arquivo.
 *
 * ## O que as provas exigem deste arquivo
 *
 * `bootstrap.spec.ts` afirma **duas coisas complementares**, e a spec diz que
 * nenhuma é completa sozinha:
 *
 * - **o log dinâmico** — o multiconjunto exato das chamadas que `app` e
 *   `SwaggerModule` recebem, acessores inclusive;
 * - **a allowlist AST** — a lista de statements **deste arquivo inteiro**:
 *   imports enumerados e nenhum lateral, uma declaração exportada, **nenhum
 *   statement executável no nível superior**, e o corpo abaixo.
 *
 * **Mexer aqui fica vermelho de propósito.** Vermelho, neste arquivo, quer
 * dizer *"revise explicitamente o contrato de inicialização"* — não falso
 * positivo. Se o corpo passar de dez statements, ganhar categoria nova de
 * efeito, ou nascer uma segunda função de orquestração, a `LIM-071h` manda
 * trocar a allowlist por função extraída e testável.
 */
export async function bootstrap(): Promise<void> {
  // **O app já nasce configurado.** Prefixo, helmet, cookie-parser e
  // `ValidationPipe` moram em `criarAppDeProducao`, e é ESSA função que a
  // prova executa (`bootstrap-de-producao.spec.ts`) — a 7ª validação cruzada
  // mostrou que provar `configurarApp` direto não provava o chamador.
  const app = await criarAppDeProducao();

  // Fallback é a lista de dev de .env.example, nunca `true` — refletir
  // qualquer origem (allow-all) combinado com credentials:true é o
  // anti-padrão de CORS mais citado pelo OWASP (deixaria qualquer site
  // ler resposta autenticada via cookie da vítima); se CORS_ORIGINS
  // faltar em produção por engano, o app deve falhar fechado (rejeitar
  // a origem real, erro visível no console do navegador) em vez de
  // falhar aberto (vulnerável em silêncio).
  const DEFAULT_DEV_CORS_ORIGINS = [
    'http://localhost:3001',
    'http://localhost:3002',
    'http://localhost:3003',
  ];
  const corsOrigins = (process.env.CORS_ORIGINS ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins.length > 0 ? corsOrigins : DEFAULT_DEV_CORS_ORIGINS,
    credentials: true,
  });

  const swaggerDocument = SwaggerModule.createDocument(
    app,
    buildSwaggerConfig(),
  );
  SwaggerModule.setup('api/docs', app, swaggerDocument);

  await app.listen(process.env.PORT ?? 3000);
}
