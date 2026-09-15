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
import { ContagemPorIp } from '../src/common/throttle/contagem-por-ip';
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

/**
 * Como `/auth/login`: sem guard de auth, e com teto de força bruta.
 *
 * `@ContagemPorIp()` é o que a 4ª validação cruzada cobrou. Sem ela, um
 * Bearer válido comprava um balde novo — e **este produto tem
 * auto-cadastro**, então "um balde por conta" é o mesmo que limite nenhum.
 */
@Controller('publica')
class PublicaController {
  @Get()
  @Throttle({ default: { limit: TETO, ttl: 60_000 } })
  @ContagemPorIp()
  ok() {
    return { ok: true };
  }
}

/**
 * DEF-031 — uma rota de força bruta própria, para os visitantes medidos em
 * produção não dividirem balde com os casos acima (que usam o IP do socket).
 */
@Controller('login-simulado')
class LoginSimuladoController {
  @Get()
  @Throttle({ default: { limit: TETO, ttl: 60_000 } })
  @ContagemPorIp()
  ok() {
    return { ok: true };
  }
}

/** A mesma rota SEM a marca, para provar que a marca é quem faz a diferença. */
@Controller('publica-sem-marca')
class PublicaSemMarcaController {
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
  controllers: [
    ProtegidaController,
    PublicaController,
    PublicaSemMarcaController,
    LoginSimuladoController,
  ],
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

  it('token válido NÃO compra balde novo em rota de força bruta', async () => {
    // A aresta que a 4ª validação cruzada achou. Sem `@ContagemPorIp()`,
    // este último pedido voltava 200 — e com auto-cadastro, o teto de 10
    // tentativas viraria "10 vezes o número de contas que o atacante criar".
    for (let i = 0; i < TETO; i++) {
      await request(app.getHttpServer()).get('/publica').expect(200);
    }
    await request(app.getHttpServer()).get('/publica').expect(429);

    await request(app.getHttpServer())
      .get('/publica')
      .set('Authorization', tokenDe('conta-criada-pelo-atacante'))
      .expect(429);
  });

  it('e a marca é quem faz a diferença — sem ela, o balde é do usuário', async () => {
    // O contraste importa: prova que o 429 acima vem da marca, e não de
    // alguma outra coisa ter mudado no caminho.
    for (let i = 0; i < TETO; i++) {
      await request(app.getHttpServer()).get('/publica-sem-marca').expect(200);
    }
    await request(app.getHttpServer()).get('/publica-sem-marca').expect(429);

    await request(app.getHttpServer())
      .get('/publica-sem-marca')
      .set('Authorization', tokenDe('outra-conta'))
      .expect(200);
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

  /**
   * DEF-031 — **medido em produção:** atrás do App Platform, o socket (`req.ip`)
   * é o servidor de entrada da DigitalOcean, o mesmo para todo visitante, e
   * `do-connecting-ip` traz o visitante (a plataforma sobrescreve o valor que o
   * cliente manda). Aqui o socket é um só para todos os pedidos — como lá.
   */
  describe('DEF-031 — o balde é do VISITANTE, não do balanceador', () => {
    const tentar = (ip: string, extra: Record<string, string> = {}) => {
      let pedido = request(app.getHttpServer())
        .get('/login-simulado')
        .set('do-connecting-ip', ip);
      for (const [nome, valor] of Object.entries(extra)) {
        pedido = pedido.set(nome, valor);
      }
      return pedido;
    };

    it('dois visitantes atrás do mesmo balanceador têm baldes separados — o defeito', async () => {
      for (let i = 0; i < TETO; i++) {
        await tentar('203.0.113.10').expect(200);
      }
      await tentar('203.0.113.10').expect(429);

      // Antes da correção, este era 429: a senha errada de um gastava a cota
      // do outro, e o 11º cadastro em 15 minutos do clube inteiro era barrado.
      await tentar('198.51.100.20').expect(200);
    });

    it('o limite continua existindo — não virou "tirei o limite"', async () => {
      for (let i = 0; i < TETO; i++) {
        await tentar('203.0.113.30').expect(200);
      }
      await tentar('203.0.113.30').expect(429);
    });

    it('IPv6: trocar de endereço dentro do mesmo /64 NÃO compra balde novo', async () => {
      for (let i = 0; i < TETO; i++) {
        await tentar(`2804:8aa4:3e19:5600::${i + 1}`).expect(200);
      }
      await tentar('2804:8aa4:3e19:5600:f4f4:824f:9fb1:ea9d').expect(429);
      // Outro /64 é outra pessoa.
      await tentar('2804:8aa4:3e19:5601::1').expect(200);
    });

    it('`X-Forwarded-For` forjado não compra balde novo', async () => {
      for (let i = 0; i < TETO; i++) {
        await tentar('203.0.113.50').expect(200);
      }
      await tentar('203.0.113.50', { 'X-Forwarded-For': '192.0.2.88' }).expect(
        429,
      );
    });
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
