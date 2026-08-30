import { SwaggerModule } from '@nestjs/swagger';
import { criarAppDeProducao } from './common/validation/configurar-app';
import { buildSwaggerConfig } from './swagger.config';

async function bootstrap() {
  // **O app já nasce configurado.** Prefixo, helmet, cookie-parser e
  // `ValidationPipe` moram em `criarAppDeProducao`, e é ESSA função que a
  // prova executa (`bootstrap-de-producao.spec.ts`) — a 7ª validação cruzada
  // mostrou que provar `configurarApp` direto não provava o chamador.
  //
  // **Limite declarado:** nada impede acrescentar um `useGlobalPipes` depois
  // desta linha. Fechar isso pediria subir o app com banco, o que esta
  // máquina não faz.
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
void bootstrap();
