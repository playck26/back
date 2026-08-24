import { Inject, Injectable, Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { S3StorageProvider } from './s3-storage.provider';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from './storage-provider.interface';
import {
  ConfiguracaoDeStorageInvalida,
  STORAGE_CONFIG,
  VARIAVEIS_DE_STORAGE,
} from './storage.config';
import { StorageModule } from './storage.module';

// SPEC-017/TASK-001 — a fiação. O que este arquivo prova é que a validação
// da config roda no BOOT: sem as seis variáveis, o módulo não instancia.
// Config validada só no primeiro upload seria descobrir endpoint errado
// com uma foto de aluno na mão.

const VALIDAS: Record<string, string> = {
  SPACES_REGION: 'nyc3',
  SPACES_ENDPOINT: 'https://nyc3.digitaloceanspaces.com',
  SPACES_BUCKET: 'playck-media',
  SPACES_CDN_URL: 'https://playck-media.nyc3.cdn.digitaloceanspaces.com',
  SPACES_KEY: 'chave-de-teste',
  SPACES_SECRET: 'segredo-de-teste',
};

/**
 * **O `ConfigService` é substituído, e a razão é um achado deste ciclo.**
 *
 * A primeira versão daqui montava o `ConfigModule.forRoot` com `load` e
 * limpava as variáveis de `process.env`. Parou de funcionar quando o
 * `StorageModule` passou a importar o `PrismaModule` — e o motivo não é o
 * Nest: **`@prisma/client` carrega o `.env` no `process.env`**, no import e
 * de novo ao instanciar o cliente. O `ConfigService` lê `process.env` ao
 * vivo, então a variável "ausente" reaparecia com o valor **real de
 * produção**, e o teste de fail-fast passava a compilar em vez de recusar.
 *
 * Medido: `node -e "require('@prisma/client')"` basta para
 * `process.env.SPACES_SECRET` sair de ausente para presente.
 *
 * Em produção isso é inofensivo (não há `.env` no container, e o `dotenv`
 * não sobrescreve variável já definida). Em teste, é a diferença entre
 * provar o fail-fast e provar nada — daí o dublê.
 */
function compilarCom(valores: Record<string, string | undefined>) {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
      StorageModule,
    ],
  })
    .overrideProvider(ConfigService)
    .useValue({ get: (nome: string) => valores[nome] })
    .compile();
}

describe('StorageModule', () => {
  it('o `.env` REALMENTE chega ao processo pelo Prisma — não pelo Nest', () => {
    // Este teste não prova o módulo: prova o ambiente, e existe para que
    // ninguém "conserte" o dublê acima achando que a limpeza de
    // `process.env` bastaria. Se um dia o Prisma parar de carregar o
    // `.env`, este teste cai e o comentário de cima vira mentira.
    for (const variavel of VARIAVEIS_DE_STORAGE) {
      delete process.env[variavel];
    }
    // `execSync` e não `require`: num processo limpo, sem o que este mesmo
    // arquivo já importou. É a única forma de medir o efeito do import.
    const saida = execSync(
      `node -e "require('@prisma/client'); console.log(process.env.SPACES_SECRET ? 'PRESENTE' : 'ausente')"`,
      { cwd: join(__dirname, '..', '..'), encoding: 'utf8' },
    );
    expect(saida.trim()).toBe('PRESENTE');
  });

  it('resolve a porta STORAGE_PROVIDER com as seis variáveis presentes', async () => {
    const modulo = await compilarCom(VALIDAS);

    const provider = modulo.get<StorageProvider>(STORAGE_PROVIDER);
    expect(provider).toBeInstanceOf(S3StorageProvider);
    expect(modulo.get(STORAGE_CONFIG)).toMatchObject({
      bucket: 'playck-media',
    });

    await modulo.close();
  });

  it('NÃO exporta a configuração: o segredo não atravessa a fronteira', async () => {
    // Achado da validação cruzada de 2026-08-24: o módulo exportava
    // `STORAGE_CONFIG`, e esse objeto carrega `key` e `secret`. Não havia
    // consumidor — era fronteira pública aberta à toa.
    @Injectable()
    class Curioso {
      constructor(@Inject(STORAGE_CONFIG) readonly config: unknown) {}
    }

    @Module({ imports: [StorageModule], providers: [Curioso] })
    class ModuloCurioso {}

    await expect(
      Test.createTestingModule({
        imports: [
          ConfigModule.forRoot({
            isGlobal: true,
            ignoreEnvFile: true,
            load: [() => VALIDAS],
          }),
          ModuloCurioso,
        ],
      }).compile(),
    ).rejects.toThrow(/STORAGE_CONFIG/);
  });

  it('mas a PORTA atravessa, e é o que os consumidores injetam', async () => {
    @Injectable()
    class Consumidor {
      constructor(
        @Inject(STORAGE_PROVIDER) readonly storage: StorageProvider,
      ) {}
    }

    @Module({ imports: [StorageModule], providers: [Consumidor] })
    class ModuloConsumidor {}

    const modulo = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          ignoreEnvFile: true,
          load: [() => VALIDAS],
        }),
        ModuloConsumidor,
      ],
    }).compile();

    expect(modulo.get(Consumidor).storage).toBeInstanceOf(S3StorageProvider);
    await modulo.close();
  });

  it('não sobe sem SPACES_SECRET — fail-fast no boot', async () => {
    await expect(
      compilarCom({ ...VALIDAS, SPACES_SECRET: undefined }),
    ).rejects.toBeInstanceOf(ConfiguracaoDeStorageInvalida);
  });
});
