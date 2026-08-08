import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import cookieParser from 'cookie-parser';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { PrismaService } from '../../src/prisma/prisma.service';

// Replica exatamente o setup de app-level de src/main.ts (prefixo,
// cookie-parser, ValidationPipe) — as suítes e2e não passam por
// bootstrap(), então cada peça precisa ser montada aqui manualmente ou os
// testes não refletem o comportamento real da rota (ex.: sem
// setGlobalPrefix, `/auth/login` nem existiria; sem ValidationPipe,
// nenhum DTO seria validado). CORS e Swagger ficam de fora — não afetam
// chamadas via Supertest.
export async function createTestApp(
  prismaMock: unknown,
): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  })
    .overrideProvider(PrismaService)
    .useValue(prismaMock)
    .compile();

  const app = moduleRef.createNestApplication<INestApplication<App>>();
  app.setGlobalPrefix('api/v1');
  app.use(cookieParser());
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  await app.init();
  return app;
}
