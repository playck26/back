import { ValidationPipe } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import { AppModule } from './app.module';
import { buildSwaggerConfig } from './swagger.config';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');
  // CSP desligado: o CSP padrão do helmet bloqueia o script/style inline
  // que o Swagger UI usa (recomendação da própria doc do NestJS,
  // https://docs.nestjs.com/security/helmet) — sem isso `/api/docs`
  // quebra. Demais headers do helmet (X-Content-Type-Options, HSTS,
  // remoção de X-Powered-By, etc.) continuam ativos.
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );

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
