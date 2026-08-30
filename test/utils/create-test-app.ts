import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/common/validation/configurar-app';
import { PrismaService } from '../../src/prisma/prisma.service';

// **Chama `configurarApp`, a MESMA função que o `src/main.ts` chama.**
//
// O comentário que estava aqui dizia "replica exatamente o setup de
// src/main.ts" — e era uma cópia manual, livre para divergir. A 6ª validação
// cruzada usou justamente isso: trocar o pipe no `main.ts` por
// `new ValidationPipe({})` não derrubava nenhum e2e, porque este arquivo
// montava o seu próprio. Comentário pedindo cuidado não é ligação.
//
// CORS e Swagger continuam fora — dependem de ambiente e não afetam chamadas
// por Supertest.
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
  configurarApp(app);
  await app.init();
  return app;
}
