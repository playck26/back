import type { INestApplication } from '@nestjs/common';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { RedefinicaoService } from '../src/acesso/redefinicao.service';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

/**
 * SPEC-090/TASK-002 — **as três rotas do "esqueci minha senha", na camada
 * HTTP**, com o Prisma dublado (o job `e2e` do CI não tem banco). Aqui fica o
 * que a camada HTTP decide sozinha:
 *
 * - AC-004: o `202` sai antes de o serviço terminar (S1);
 * - AC-003 (a parte HTTP): a resposta não muda com o que o serviço faz;
 * - AC-011 (a parte HTTP): o `410` do token malformado e do inexistente, com
 *   o mesmo corpo, byte a byte;
 * - AC-015 (a parte HTTP): a senha curta é `400` do `ValidationPipe`, e o
 *   serviço nem é chamado;
 * - o limite por IP (`@LimiteDeLogin`, `@LimitePublico`), com o balde de cada
 *   rota.
 *
 * O que só o banco prova — o pedido gravado, a senha trocada, as travas — está
 * em `test/banco/spec-090-rotas.db-spec.ts` e `spec-090-corrida.db-spec.ts`.
 */

const REDEFINICAO_INVALIDA = {
  statusCode: 410,
  code: 'LINK_INVALIDO',
  message: 'Este link não vale mais. Peça outro em "Esqueceu a senha?".',
};

/** Um token bem formado (43 caracteres base64url) que nenhum pedido tem. */
const TOKEN_INEXISTENTE = 'dG9rZW4tcXVlLW5lbmh1bS1wZWRpZG8tdGVtLTEyMzQ';
const USUARIO = '00000000-0000-4000-8000-000000000901';

type PrismaComRedefinicao = PrismaMock & {
  pedidoDeRedefinicao: { findUnique: jest.Mock };
  tx: PrismaMock['tx'] & { pedidoDeRedefinicao: { findUnique: jest.Mock } };
};

/** O dublê de sempre, com o pedido que nenhum token acha. */
function prismaComRedefinicao(): PrismaComRedefinicao {
  const prisma = buildPrismaMock() as PrismaComRedefinicao;
  prisma.pedidoDeRedefinicao = {
    findUnique: jest.fn().mockResolvedValue(null),
  };
  prisma.tx.pedidoDeRedefinicao = {
    findUnique: jest.fn().mockResolvedValue(null),
  };
  return prisma;
}

let ipSeq = 0;
function ipNovo(): string {
  ipSeq += 1;
  return `10.92.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

/** Espera uma promessa por `ms`; `null` se não chegou. */
async function ate<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let t: NodeJS.Timeout | undefined;
  const r = await Promise.race([
    p,
    new Promise<null>((res) => (t = setTimeout(() => res(null), ms))),
  ]);
  clearTimeout(t);
  return r;
}

describe('SPEC-090 — as rotas do esqueci minha senha (e2e, Prisma dublado)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaComRedefinicao;
  let servico: RedefinicaoService;

  beforeEach(async () => {
    prisma = prismaComRedefinicao();
    app = await createTestApp(prisma);
    servico = app.get(RedefinicaoService);
  });

  afterEach(async () => {
    jest.restoreAllMocks();
    await app.close();
  });

  const pedir = (corpo: unknown, ip = ipNovo()) =>
    request(app.getHttpServer())
      .post('/api/v1/auth/esqueci-senha')
      .set('do-connecting-ip', ip)
      .send(corpo as object)
      .then((r) => r);

  describe('AC-004 — o 202 não espera o serviço (S1)', () => {
    it('com um solicitar que só resolve quando o teste mandar, o 202 chega antes', async () => {
      let liberar!: () => void;
      const pendente = new Promise<void>((r) => (liberar = r));
      const solicitar = jest
        .spyOn(servico, 'solicitar')
        .mockReturnValue(pendente);

      // Com `await` no controller, a resposta só sairia depois de `liberar()`
      // — e o teste só chama `liberar()` depois de a resposta chegar.
      const res = await ate(pedir({ email: 'alguem@exemplo.com' }), 5_000);
      expect(res).not.toBeNull();
      expect(res!.status).toBe(202);
      expect(res!.text).toBe('');
      expect(solicitar).toHaveBeenCalledWith('alguem@exemplo.com');

      liberar();
      await pendente;
    });
  });

  describe('AC-003 (camada HTTP) — a resposta não depende do que o serviço faz', () => {
    it('serviço que resolve, que rejeita e que não termina: o mesmo status, corpo e cabeçalhos de conteúdo', async () => {
      const comportamentos: Record<string, () => Promise<void>> = {
        'resolve@exemplo.com': () => Promise.resolve(),
        'rejeita@exemplo.com': () => Promise.reject(new Error('banco fora')),
        'pendura@exemplo.com': () => new Promise<void>(() => undefined),
      };
      jest
        .spyOn(servico, 'solicitar')
        .mockImplementation((email: string) => comportamentos[email]());

      const respostas: Response[] = [];
      for (const email of Object.keys(comportamentos)) {
        respostas.push(await pedir({ email }));
      }
      const assinatura = (r: Response) => ({
        status: r.status,
        corpo: r.text,
        tipo: r.headers['content-type'] as unknown,
        tamanho: r.headers['content-length'] as unknown,
      });
      expect(respostas).toHaveLength(3);
      expect(respostas[0].status).toBe(202);
      for (const r of respostas) {
        expect(assinatura(r)).toEqual(assinatura(respostas[0]));
      }
    });

    it.each<[string, unknown]>([
      ['e-mail malformado', { email: 'nao-e-email' }],
      ['sem e-mail', {}],
      ['campo a mais', { email: 'a@exemplo.com', outro: 1 }],
    ])(
      '%s: 400 do ValidationPipe, e o serviço não é chamado',
      async (_r, corpo) => {
        const solicitar = jest.spyOn(servico, 'solicitar');
        const res = await pedir(corpo);
        expect(res.status).toBe(400);
        expect(solicitar).not.toHaveBeenCalled();
      },
    );
  });

  describe('AC-011 (camada HTTP) — o 410 é um corpo só, byte a byte (S12)', () => {
    it('GET e POST com token malformado e com token inexistente: o mesmo texto', async () => {
      const respostas = [
        await request(app.getHttpServer())
          .get('/api/v1/public/redefinicao/nao-e-um-token')
          .set('do-connecting-ip', ipNovo()),
        await request(app.getHttpServer())
          .get(`/api/v1/public/redefinicao/${TOKEN_INEXISTENTE}`)
          .set('do-connecting-ip', ipNovo()),
        await request(app.getHttpServer())
          .post('/api/v1/public/redefinicao')
          .set('do-connecting-ip', ipNovo())
          .send({ token: 'curto', usuarioId: USUARIO, senha: '12345678' }),
        await request(app.getHttpServer())
          .post('/api/v1/public/redefinicao')
          .set('do-connecting-ip', ipNovo())
          .send({
            token: TOKEN_INEXISTENTE,
            usuarioId: USUARIO,
            senha: '12345678',
          }),
      ];
      expect(respostas[0].body).toEqual(REDEFINICAO_INVALIDA);
      for (const r of respostas) {
        expect(r.status).toBe(410);
        expect(r.text).toBe(respostas[0].text);
      }
      // O inexistente foi procurado pelo hash; o malformado, não.
      expect(prisma.pedidoDeRedefinicao.findUnique).toHaveBeenCalledTimes(1);
      expect(prisma.tx.pedidoDeRedefinicao.findUnique).toHaveBeenCalledTimes(1);
    });
  });

  describe('AC-015 (camada HTTP) — o corpo do POST é validado antes do serviço', () => {
    it.each<[string, Record<string, unknown>]>([
      [
        'senha com 7 caracteres',
        { token: TOKEN_INEXISTENTE, usuarioId: USUARIO, senha: '1234567' },
      ],
      [
        'usuarioId que não é UUID',
        { token: TOKEN_INEXISTENTE, usuarioId: 'u-1', senha: '12345678' },
      ],
      ['sem senha', { token: TOKEN_INEXISTENTE, usuarioId: USUARIO }],
      ['sem token', { usuarioId: USUARIO, senha: '12345678' }],
    ])('%s: 400, e o serviço não é chamado', async (_r, corpo) => {
      const redefinir = jest.spyOn(servico, 'redefinir');
      const res = await request(app.getHttpServer())
        .post('/api/v1/public/redefinicao')
        .set('do-connecting-ip', ipNovo())
        .send(corpo);
      expect(res.status).toBe(400);
      expect(redefinir).not.toHaveBeenCalled();
    });

    it('o usuarioId chega ao serviço na grafia canônica (UuidNoCorpo)', async () => {
      const redefinir = jest
        .spyOn(servico, 'redefinir')
        .mockResolvedValue(undefined);
      const res = await request(app.getHttpServer())
        .post('/api/v1/public/redefinicao')
        .set('do-connecting-ip', ipNovo())
        .send({
          token: TOKEN_INEXISTENTE,
          usuarioId: USUARIO.toUpperCase(),
          senha: '12345678',
        });
      expect(res.status).toBe(204);
      expect(res.text).toBe('');
      expect(redefinir).toHaveBeenCalledWith(
        TOKEN_INEXISTENTE,
        USUARIO,
        '12345678',
      );
    });
  });

  describe('o limite por IP, com o balde de cada rota (Q4)', () => {
    it('POST /auth/esqueci-senha: 10 por IP e o 11º é 429, mesmo com Bearer; o login do mesmo IP tem o seu balde', async () => {
      jest.spyOn(servico, 'solicitar').mockResolvedValue(undefined);
      const ip = '10.92.250.1';
      for (let i = 0; i < 10; i++) {
        expect((await pedir({ email: `x${i}@exemplo.com` }, ip)).status).toBe(
          202,
        );
      }
      const decimoPrimeiro = await request(app.getHttpServer())
        .post('/api/v1/auth/esqueci-senha')
        .set('do-connecting-ip', ip)
        .set('Authorization', 'Bearer qualquer.coisa.aqui')
        .send({ email: 'x10@exemplo.com' });
      expect(decimoPrimeiro.status).toBe(429);

      const login = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .set('do-connecting-ip', ip)
        .send({ email: 'x@exemplo.com', senha: '12345678' });
      expect(login.status).not.toBe(429);
    });

    it('GET /public/redefinicao/:token: 10 por IP e o 11º é 429', async () => {
      const ip = '10.92.250.2';
      for (let i = 0; i < 10; i++) {
        const r = await request(app.getHttpServer())
          .get(`/api/v1/public/redefinicao/${TOKEN_INEXISTENTE}`)
          .set('do-connecting-ip', ip);
        expect(r.status).toBe(410);
      }
      const r = await request(app.getHttpServer())
        .get(`/api/v1/public/redefinicao/${TOKEN_INEXISTENTE}`)
        .set('do-connecting-ip', ip);
      expect(r.status).toBe(429);
    });

    it('POST /public/redefinicao: 10 por IP e o 11º é 429', async () => {
      const ip = '10.92.250.3';
      const corpo = {
        token: TOKEN_INEXISTENTE,
        usuarioId: USUARIO,
        senha: '12345678',
      };
      for (let i = 0; i < 10; i++) {
        const r = await request(app.getHttpServer())
          .post('/api/v1/public/redefinicao')
          .set('do-connecting-ip', ip)
          .send(corpo);
        expect(r.status).toBe(410);
      }
      const r = await request(app.getHttpServer())
        .post('/api/v1/public/redefinicao')
        .set('do-connecting-ip', ip)
        .send(corpo);
      expect(r.status).toBe(429);
    });
  });
});
