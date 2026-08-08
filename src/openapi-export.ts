import { writeFileSync } from 'node:fs';
import { NestFactory } from '@nestjs/core';
import { SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { buildSwaggerConfig } from './swagger.config';

// Gera openapi.json sem subir porta HTTP nem tocar o banco (PrismaService é
// lazy — ver prisma.service.ts) — usado pelos 3 frontends para gerar tipos
// TypeScript (ADR-001), inclusive antes do Neon estar provisionado.
async function run() {
  const app = await NestFactory.create(AppModule, { logger: false });
  app.setGlobalPrefix('api/v1');
  const document = SwaggerModule.createDocument(app, buildSwaggerConfig());
  writeFileSync('openapi.json', JSON.stringify(document, null, 2));
  await app.close();
  console.log('openapi.json gerado.');
}

void run();
