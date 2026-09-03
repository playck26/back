/**
 * SPEC-043 — sobe a aplicação REAL, com Prisma REAL, para as provas FIT.
 *
 * Diferença deliberada em relação a `test/utils/create-test-app.ts`: aquele
 * substitui o `PrismaService` por um dublê, e dublê não prova `EXCLUDE`,
 * `DEFERRABLE` nem lock. Aqui nada é substituído — o app fala com o
 * `DATABASE_URL` do ambiente, que `exigirBancoLocal()` garante ser local.
 *
 * **Chama `configurarApp`, a mesma função do `src/main.ts`** (lição da 6ª
 * validação cruzada): o `ValidationPipe`, o `forbidNonWhitelisted` e o
 * prefixo são os de produção, não uma cópia.
 *
 * **Duas instâncias, de propósito.** O FIT-010 abre dois `PrismaClient`
 * porque "concorrência não se prova em conexão compartilhada". Pelo HTTP, o
 * equivalente é subir dois apps — cada um com a própria pool — e mandar cada
 * requisição do par para um app diferente. Um app só, com uma pool só,
 * poderia serializar por acidente e provar nada.
 */
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { App } from 'supertest/types';
import { AppModule } from '../../src/app.module';
import { configurarApp } from '../../src/common/validation/configurar-app';

// Os mesmos placebos do `ci.yml`: o StorageModule valida as seis variáveis do
// Spaces no boot (SPEC-017), e nenhum FIT fala com o bucket. `??=` para o CI
// poder sobrescrever sem que o teste dependa disso.
const PLACEBO: Record<string, string> = {
  JWT_ACCESS_SECRET: 'fit-access-secret',
  JWT_REFRESH_SECRET: 'fit-refresh-secret',
  SPACES_REGION: 'nyc3',
  SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
  SPACES_BUCKET: 'playck-ci',
  SPACES_CDN_URL: 'https://playck-ci.nyc3.cdn.digitaloceanspaces.com',
  SPACES_KEY: 'ci-spaces-key',
  SPACES_SECRET: 'ci-spaces-secret',
};

export function garantirAmbienteDeFit(): void {
  for (const [chave, valor] of Object.entries(PLACEBO)) {
    process.env[chave] ??= valor;
  }
}

export async function subirAppReal(): Promise<INestApplication<App>> {
  garantirAmbienteDeFit();
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleRef.createNestApplication<INestApplication<App>>();
  configurarApp(app);
  await app.init();
  return app;
}
