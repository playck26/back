import { ValidationPipe, type INestApplication } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { PassportModule } from '@nestjs/passport';
import { Test } from '@nestjs/testing';
import { ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  CourtCategoriesController,
  CourtSportsController,
} from '../src/courts/court-catalogs.controller';
import {
  CategoriasDeQuadraService,
  EsportesDeQuadraService,
} from '../src/courts/catalogos-de-quadra';
import { JwtAccessStrategy } from '../src/auth/strategies/jwt-access.strategy';
import { PrismaService } from '../src/prisma/prisma.service';

/**
 * SPEC-020/TASK-002 — os catálogos por HTTP.
 *
 * ## O que SÓ aparece aqui
 *
 * **Que os decorators de rota sobrevivem à herança.** Os dois controllers
 * herdam `@Get`/`@Post`/`@Patch`/`@Delete` de uma classe base abstrata, e
 * isso é uma aposta no comportamento do Nest — os testes de serviço passariam
 * intactos com as rotas não registradas, e o defeito só apareceria como 404
 * em produção.
 *
 * Este arquivo existe primeiro por isso. As regras de negócio têm prova
 * própria; o que se prova aqui é que **existe rota**.
 *
 * ## E que os papéis são os certos
 *
 * O contrato desta spec dá o `GET` a `aluno` e `professor` — por isso o
 * `RolesGuard` em vez do `CompanyAdminGuard` de `levels`. A escrita continua
 * só do gestor, e `super_admin` fica de fora dos dois lados por não ter
 * empresa.
 */

const SEGREDO = 'segredo-de-teste-catalogos';
const EMPRESA = '11111111-1111-4111-8111-111000200001';
const OPCAO = '22222222-2222-4222-8222-222000200002';

describe('catálogos de quadra (e2e)', () => {
  let app: INestApplication<App>;
  let jwt: JwtService;
  type Opcao = {
    id: string;
    companyId: string;
    nome: string;
    ordem: number;
    createdAt: Date;
  };
  /**
   * **Um mapa POR catálogo.** A primeira versão deste dublê tinha um só, e o
   * teste "os dois catálogos são independentes" ficou vermelho — apontando
   * para o mock, não para o produto. Dublê que compartilha estado entre duas
   * coisas que o produto separa testa o dublê.
   */
  let opcoesPorCatalogo: Record<string, Map<string, Opcao>>;
  let quadrasUsando: number;

  beforeAll(async () => {
    process.env.JWT_ACCESS_SECRET = SEGREDO;

    const delegate = (catalogo: string) => ({
      findMany: () =>
        Promise.resolve([...opcoesPorCatalogo[catalogo].values()]),
      findFirst: ({ where }: { where: Record<string, unknown> }) => {
        const alvo = [...opcoesPorCatalogo[catalogo].values()].find((o) => {
          if (where.id !== undefined && typeof where.id === 'string') {
            return o.id === where.id && o.companyId === where.companyId;
          }
          const filtro = where.nome as
            { equals: string; mode?: string } | undefined;
          if (filtro === undefined) return false;
          const excluido = (where.id as { not?: string } | undefined)?.not;

          // **O dublê HONRA o `mode`, e isto não é preciosismo.** A primeira
          // versão comparava com `toLowerCase()` sempre — então o teste do
          // 409 passava mesmo que o serviço não pedisse `insensitive`, e o
          // comportamento central desta task não era provado por nada.
          //
          // Achado por sabotagem: trocar o `mode` no serviço não derrubava
          // teste nenhum.
          const igual =
            filtro.mode === 'insensitive'
              ? o.nome.toLowerCase() === filtro.equals.toLowerCase()
              : o.nome === filtro.equals;

          return o.companyId === where.companyId && igual && o.id !== excluido;
        });
        return Promise.resolve(alvo ?? null);
      },
      create: ({
        data,
      }: {
        data: { companyId: string; nome: string; ordem: number };
      }) => {
        const mapa = opcoesPorCatalogo[catalogo];
        const nova = {
          id: `${catalogo}-${mapa.size}`,
          createdAt: new Date(),
          ...data,
        };
        mapa.set(nova.id, nova);
        return Promise.resolve(nova);
      },
      update: ({
        where,
        data,
      }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const mapa = opcoesPorCatalogo[catalogo];
        const atual = mapa.get(where.id)!;
        const nova = {
          ...atual,
          ...(data.nome ? { nome: data.nome as string } : {}),
        };
        mapa.set(where.id, nova);
        return Promise.resolve(nova);
      },
      delete: ({ where }: { where: { id: string } }) => {
        const mapa = opcoesPorCatalogo[catalogo];
        const alvo = mapa.get(where.id)!;
        mapa.delete(where.id);
        return Promise.resolve(alvo);
      },
    });

    const prisma = {
      usuario: {
        // O `JwtAuthGuard` lê o banco a cada requisição (INV-008/INV-013).
        findUnique: () =>
          Promise.resolve({ senhaTemporaria: false, status: 'ativo' }),
      },
      esporteDeQuadra: delegate('esporte'),
      categoriaDeQuadra: delegate('categoria'),
      quadra: { count: () => Promise.resolve(quadrasUsando) },
    };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }),
        ThrottlerModule.forRoot([{ ttl: 60_000, limit: 10_000 }]),
        PassportModule,
        JwtModule.register({ secret: SEGREDO }),
      ],
      controllers: [CourtSportsController, CourtCategoriesController],
      providers: [
        EsportesDeQuadraService,
        CategoriasDeQuadraService,
        JwtAccessStrategy,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    app = moduleRef.createNestApplication();
    app.setGlobalPrefix('api/v1');
    app.useGlobalPipes(new ValidationPipe({ whitelist: true }));
    jwt = moduleRef.get(JwtService);
    await app.init();
  });

  beforeEach(() => {
    const semente = (): Map<string, Opcao> =>
      new Map([
        [
          OPCAO,
          {
            id: OPCAO,
            companyId: EMPRESA,
            nome: 'Saibro',
            ordem: 0,
            createdAt: new Date(),
          },
        ],
      ]);
    opcoesPorCatalogo = { esporte: semente(), categoria: semente() };
    quadrasUsando = 0;
  });

  afterAll(async () => {
    await app.close();
  });

  const token = (role: string, companyId: string | null = EMPRESA) =>
    jwt.sign(
      { sub: 'u1', role, companyId },
      { secret: SEGREDO, expiresIn: '5m' },
    );

  const CAMINHOS = ['court-sports', 'court-categories'] as const;

  describe.each(CAMINHOS)('/%s', (caminho) => {
    const url = `/api/v1/${caminho}`;

    it('A ROTA EXISTE — os decorators sobreviveram à herança', async () => {
      // O teste que este arquivo existe para ter. Se o Nest não registrasse
      // handlers herdados de classe base, aqui daria 404 e todo o resto da
      // TASK-002 estaria verde mentindo.
      const res = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${token('company_admin')}`);

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
    });

    it('o gestor cria', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token('company_admin')}`)
        .send({ nome: 'Sintética', ordem: 1 });

      expect(res.status).toBe(201);
      expect((res.body as { nome: string }).nome).toBe('Sintética');
    });

    it('409 em nome repetido — e IGNORANDO maiúscula, que o banco não ignora', async () => {
      // O defeito que esta spec existe para resolver: "Saibro" e "saibro"
      // viravam dois filtros na tela do aluno.
      const res = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token('company_admin')}`)
        .send({ nome: 'SAIBRO' });

      expect(res.status).toBe(409);
      expect((res.body as { code: string }).code).toBe('NOME_EM_USO');
    });

    it('422 em nome só de espaço — o `trim` antes do julgamento', async () => {
      // `" "` passaria por um `@MinLength(1)` e viraria opção de nome
      // invisível na barra de filtro.
      const res = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token('company_admin')}`)
        .send({ nome: '   ' });

      expect(res.status).toBe(422);
      expect((res.body as { code: string }).code).toBe('NOME_OBRIGATORIO');
    });

    it('renomear para o PRÓPRIO nome não é conflito consigo mesmo', async () => {
      const res = await request(app.getHttpServer())
        .patch(`${url}/${OPCAO}`)
        .set('Authorization', `Bearer ${token('company_admin')}`)
        .send({ nome: 'Saibro' });

      expect(res.status).toBe(200);
    });

    it('422 ao remover opção EM USO, e a mensagem diz quantas quadras', async () => {
      quadrasUsando = 3;

      const res = await request(app.getHttpServer())
        .delete(`${url}/${OPCAO}`)
        .set('Authorization', `Bearer ${token('company_admin')}`);

      expect(res.status).toBe(422);
      expect((res.body as { quadras: number }).quadras).toBe(3);
    });

    it('remove opção sem quadra', async () => {
      const res = await request(app.getHttpServer())
        .delete(`${url}/${OPCAO}`)
        .set('Authorization', `Bearer ${token('company_admin')}`);

      expect(res.status).toBe(204);
    });

    it('404 para opção de OUTRA empresa — nunca 403', async () => {
      // 403 confirmaria que a opção existe. Mesma regra da AC-014 da SPEC-018.
      const res = await request(app.getHttpServer())
        .patch(`${url}/${OPCAO}`)
        .set(
          'Authorization',
          `Bearer ${token('company_admin', 'outra-empresa-9999')}`,
        )
        .send({ nome: 'X' });

      expect(res.status).toBe(404);
    });

    it('aluno e professor LEEM', async () => {
      for (const papel of ['aluno', 'professor']) {
        const res = await request(app.getHttpServer())
          .get(url)
          .set('Authorization', `Bearer ${token(papel)}`);
        expect(res.status).toBe(200);
      }
    });

    it('aluno NÃO escreve', async () => {
      const res = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token('aluno')}`)
        .send({ nome: 'Não deveria' });

      expect(res.status).toBe(403);
    });

    it('super_admin fica de fora dos dois lados — não tem empresa', async () => {
      const leitura = await request(app.getHttpServer())
        .get(url)
        .set('Authorization', `Bearer ${token('super_admin', null)}`);
      expect(leitura.status).toBe(403);

      const escrita = await request(app.getHttpServer())
        .post(url)
        .set('Authorization', `Bearer ${token('super_admin', null)}`)
        .send({ nome: 'X' });
      expect(escrita.status).toBe(403);
    });

    it('sem token: 401', async () => {
      const res = await request(app.getHttpServer()).get(url);
      expect(res.status).toBe(401);
    });
  });

  it('os dois catálogos são INDEPENDENTES', async () => {
    // Se a base compartilhada tivesse estado, criar em um apareceria no
    // outro — e o clube veria "Saibro" na lista de esportes.
    await request(app.getHttpServer())
      .post('/api/v1/court-sports')
      .set('Authorization', `Bearer ${token('company_admin')}`)
      .send({ nome: 'Beach Tennis' });

    const categorias = await request(app.getHttpServer())
      .get('/api/v1/court-categories')
      .set('Authorization', `Bearer ${token('company_admin')}`);

    const nomes = (categorias.body as { nome: string }[]).map((o) => o.nome);
    expect(nomes).not.toContain('Beach Tennis');
  });
});
