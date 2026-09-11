import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * DEF-031 — **o limite por IP era um limite para o app inteiro.**
 *
 * ## O defeito
 *
 * O throttle cai no `req.ip` onde a contagem tem de ser por IP
 * (SPEC-017/TASK-006): `/auth/login` e as rotas públicas, **10 a cada 15
 * minutos**, para conter força bruta de quem ainda não é ninguém.
 *
 * O Express, **sem `trust proxy`, ignora o `X-Forwarded-For`** e devolve o IP
 * do socket. Atrás do balanceador do DigitalOcean esse IP é o mesmo para todo
 * visitante — então os 10 não eram por pessoa, eram do clube inteiro. **Numa
 * leva de cadastros, o 11º em 15 minutos leva `429`**, e uma senha digitada
 * errada gasta a cota de outra pessoa.
 *
 * ## Por que a prova é esta, e não `expect(app.get('trust proxy')).toBe(1)`
 *
 * Aquilo seria prova de existência da linha. **O que importa é o balde**: duas
 * pessoas diferentes precisam ter contas separadas. Este arquivo faz dois
 * visitantes gastarem o balde e afere que um não derruba o outro — e, sem a
 * configuração, é exatamente isso que quebra.
 */
const ROTA = '/api/v1/auth/login';

/** Credencial errada de propósito: o que se mede é o BALDE, não o login. */
const CORPO = { email: 'ninguem@x.com', senha: 'senha-errada-1234' };

describe('DEF-031 — o limite por IP é por PESSOA, não pelo app inteiro (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    // Ninguém existe: o login sempre falha, e o que sobra é a contagem.
    prisma.usuario.findUnique.mockResolvedValue(null);
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  const tentar = (ip: string) =>
    request(app.getHttpServer())
      .post(ROTA)
      .set('X-Forwarded-For', ip)
      .send(CORPO);

  it('**dois visitantes têm baldes separados**', async () => {
    // O primeiro gasta o balde inteiro (10 por 15 min).
    for (let i = 0; i < 10; i++) {
      await tentar('203.0.113.10');
    }
    // O 11º dele é recusado — o limite existe e funciona.
    await tentar('203.0.113.10').expect(429);

    // **E o segundo passa.** Sem `trust proxy`, os dois compartilhariam o IP do
    // balanceador e este `401` seria `429` — o cadastro de uma pessoa
    // derrubado pela senha errada de outra.
    await tentar('198.51.100.20').expect(401);
  });

  it('o limite CONTINUA existindo — não foi afrouxado para caber a leva', async () => {
    // A correção não pode virar "tirei o limite". Força bruta segue contida:
    // 10 por IP, e o 11º do MESMO IP é recusado.
    for (let i = 0; i < 10; i++) {
      await tentar('203.0.113.30');
    }
    await tentar('203.0.113.30').expect(429);
  });

  it('**`1` e não `true`: o cliente não compra balde novo forjando a cadeia**', async () => {
    // `X-Forwarded-For` é texto que o cliente escreve. Com `trust proxy: true`,
    // o Express leria o PRIMEIRO da cadeia — e quem quisesse burlar mandaria um
    // IP falso na frente e ganharia um balde novo a cada requisição.
    //
    // Com `1`, o Express confia só no ÚLTIMO salto (o balanceador), então o
    // que vale é o mesmo IP nas duas chamadas abaixo, por mais que a frente
    // mude.
    for (let i = 0; i < 10; i++) {
      await tentar(`10.0.0.${i}, 203.0.113.40`);
    }
    await tentar('10.0.0.99, 203.0.113.40').expect(429);
  });
});
