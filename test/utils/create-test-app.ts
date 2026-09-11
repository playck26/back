import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/common/validation/configurar-app';
import { PrismaService } from '../../src/prisma/prisma.service';

/**
 * **`testTimeout` mora em `jest-e2e.json`, e este comentário é o porquê.**
 *
 * JSON não aceita comentário, e quem lê `"testTimeout": 30000` lá não tem como
 * saber de onde o número veio. Ele veio de um caso medido: a suíte rodou no
 * **default de 5 s** por 23 arquivos, e a 24ª (`me-professores`, SPEC-047) fez
 * a `classes.e2e-spec.ts` estourar — **não por lentidão dela**, mas porque cada
 * arquivo aqui **sobe um app Nest inteiro**, e o custo é de contenção entre
 * workers, não do teste.
 *
 * Medido, não deduzido: com 23 arquivos, `pnpm run test:e2e` verde; com 24, a
 * `classes` falhou por *timeout* e a `classes` sozinha passou 3 de 3.
 *
 * 30 s é folga para a contenção **sem esconder um travamento de verdade** —
 * um teste que passe disso está pendurado, não ocupado.
 */
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
