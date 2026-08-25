import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  UseGuards,
  type INestApplication,
} from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule, JwtService } from '@nestjs/jwt';
import { Test } from '@nestjs/testing';
import { Throttle, ThrottlerModule } from '@nestjs/throttler';
import request from 'supertest';
import { AppModule } from '../src/app.module';
import { ThrottlerPorUsuario } from '../src/storage/limite-de-upload';

/**
 * SPEC-017/TASK-006 — a prova que faltava, e que a 3ª validação cruzada
 * cobrou.
 *
 * **O defeito que este arquivo existe para impedir:** o guard contava por
 * `request.user.sub`, mas `APP_GUARD` roda **antes** do `JwtAuthGuard` de
 * rota. Em produção, `request.user` era sempre `undefined` e toda rota
 * autenticada caía no IP — enquanto três documentos afirmavam "conta por
 * usuário". Ficou um deploy inteiro assim.
 *
 * **Por que o unitário não pegou:** ele entregava `request.user` na mão. O
 * e2e de upload também não, porque o fixture é sem auth e monta o próprio
 * módulo. Nenhum dos dois tinha a forma do `AppModule`: guard global mais
 * guard de rota.
 *
 * Por isso a prova aqui é **comportamental, não de inspeção**. Não pergunta
 * "que chave o guard calculou"; pergunta o que o servidor faz — dois
 * usuários no **mesmo IP** têm baldes separados. Se voltar a contar por IP,
 * o segundo usuário toma 429 e este teste cai.
 */

const SEGREDO = 'segredo-do-e2e-de-throttle';
const TETO = 2;

/** Faz o que o `JwtAuthGuard` faz, e onde ele faz: **na rota**. */
@Injectable()
class AuthDeRota implements CanActivate {
  canActivate(ctx: ExecutionContext): boolean {
    ctx.switchToHttp().getRequest<{ user?: unknown }>().user = {
      sub: 'quem-o-guard-global-NAO-ve',
    };
    return true;
  }
}

@Controller('protegida')
@UseGuards(AuthDeRota)
class ProtegidaController {
  @Get()
  @Throttle({ default: { limit: TETO, ttl: 60_000 } })
  ok() {
    return { ok: true };
  }
}

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      ignoreEnvFile: true,
      load: [() => ({ JWT_ACCESS_SECRET: SEGREDO })],
    }),
    ThrottlerModule.forRoot([{ name: 'default', ttl: 60_000, limit: 100 }]),
    JwtModule.register({}),
  ],
  controllers: [ProtegidaController],
  providers: [{ provide: APP_GUARD, useClass: ThrottlerPorUsuario }],
})
class ModuloComAFormaDoAppModule {}

describe('throttle por usuário — com a forma do AppModule', () => {
  let app: INestApplication;
  let jwt: JwtService;

  const tokenDe = (sub: string): string =>
    `Bearer ${jwt.sign({ sub }, { secret: SEGREDO })}`;

  beforeAll(async () => {
    const mod = await Test.createTestingModule({
      imports: [ModuloComAFormaDoAppModule],
    }).compile();
    app = mod.createNestApplication();
    jwt = app.get(JwtService);
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  it('dois usuários no MESMO IP têm baldes separados', async () => {
    // O primeiro estoura o próprio teto...
    for (let i = 0; i < TETO; i++) {
      await request(app.getHttpServer())
        .get('/protegida')
        .set('Authorization', tokenDe('usuario-a'))
        .expect(200);
    }
    const excedente = await request(app.getHttpServer())
      .get('/protegida')
      .set('Authorization', tokenDe('usuario-a'));
    expect(excedente.status).toBe(429);
    expect(excedente.body).toMatchObject({ code: 'REQUISICOES_DEMAIS' });

    // ...e o segundo, do mesmo IP, não paga por isso. Era exatamente o
    // defeito de contar por IP: o wi-fi do clube é um IP só.
    await request(app.getHttpServer())
      .get('/protegida')
      .set('Authorization', tokenDe('usuario-b'))
      .expect(200);
  });

  it('sem token, o balde é do IP — e é compartilhado', async () => {
    for (let i = 0; i < TETO; i++) {
      await request(app.getHttpServer()).get('/protegida').expect(200);
    }

    // Rota pública não tem quem identificar, e o IP é o que sobra. Aqui o
    // compartilhamento é o comportamento certo, não o defeito.
    await request(app.getHttpServer()).get('/protegida').expect(429);
  });

  it('token FORJADO não compra um balde novo', async () => {
    // O balde de IP já está estourado pelo teste acima. Um `sub` inventado
    // e assinado com outra chave não pode escapar dele — se o guard fizesse
    // `decode` em vez de `verify`, escaparia, e o limite viraria decoração.
    const forjado = jwt.sign(
      { sub: 'sub-inventado' },
      { secret: 'chave-do-atacante' },
    );

    await request(app.getHttpServer())
      .get('/protegida')
      .set('Authorization', `Bearer ${forjado}`)
      .expect(429);
  });
});

describe('o AppModule real usa este guard', () => {
  it('o APP_GUARD registrado é o ThrottlerPorUsuario', () => {
    // Sem esta asserção, trocar o `useClass` de volta para o `ThrottlerGuard`
    // padrão passaria em tudo: o unitário instancia a classe direto, e o e2e
    // acima monta o próprio módulo. Foi a mutação que a validação cruzada
    // apontou como sobrevivente.
    const providers = Reflect.getMetadata('providers', AppModule) as Array<{
      provide?: unknown;
      useClass?: unknown;
    }>;

    const guards = providers.filter((p) => p?.provide === APP_GUARD);

    expect(guards).toHaveLength(1);
    expect(guards[0].useClass).toBe(ThrottlerPorUsuario);
  });
});
