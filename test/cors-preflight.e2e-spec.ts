import { Controller, Get, INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { opcoesDeCors } from '../src/common/validation/cors';

/**
 * **SPEC-070/AC-001, AC-004 e AC-005 — o EFEITO da política.**
 *
 * A prova de **forma** (`cors.spec.ts`) derruba as políticas permissivas sem
 * depender do que eu imaginei. Esta aqui depende: ela testa **as origens que eu
 * escolhi**, e por isso os quatro negativos são nomeados na spec em vez de
 * ficarem a meu critério.
 *
 * ## `LIM-070f` — o que esta suíte NÃO prova
 *
 * Ela sobe um módulo mínimo e aplica `opcoesDeCors()`: prova que **as opções
 * produzem os cabeçalhos**, sem banco. O elo *"produção executa isso"* é de
 * outra prova — o espião em `criarAppDeProducao` e a `AC-002` da SPEC-071, que
 * afirma a sequência completa do que o `bootstrap()` dispara.
 */

const APP = 'https://app.playck.com.br';
const ADMIN = 'https://admin.playck.com.br';
const SUPER = 'https://super.playck.com.br';
const NORMATIVAS = [APP, ADMIN, SUPER];

@Controller('teste')
class ControleDeTeste {
  @Get()
  ping(): string {
    return 'pong';
  }
}

describe('o preflight declara validade e respeita a lista', () => {
  let app: INestApplication;

  beforeAll(async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ControleDeTeste],
    }).compile();
    app = modulo.createNestApplication();
    app.enableCors(opcoesDeCors({ CORS_ORIGINS: NORMATIVAS.join(',') }));
    await app.init();
  });

  afterAll(async () => {
    await app.close();
  });

  const preflight = (origem?: string) => {
    const req = request(app.getHttpServer())
      .options('/teste')
      .set('Access-Control-Request-Method', 'GET');
    return origem === undefined ? req : req.set('Origin', origem);
  };

  // **AC-001** — o valor é literal. Trocar `600` por `0` ou por `5` fica
  // vermelho, e é a única coisa que impede o conserto silencioso.
  it('AC-001: responde 204 com `Access-Control-Max-Age: 600`', async () => {
    const r = await preflight(APP);
    expect(r.status).toBe(204);
    expect(r.headers['access-control-max-age']).toBe('600');
  });

  // **AC-004** — cada origem normativa, com o PRÓPRIO valor e com credenciais.
  // A segunda asserção é o conserto do B07: sem ela, perder `credentials`
  // derrubaria a autenticação por cookie e a AC ficaria verde.
  it.each(NORMATIVAS)(
    'AC-004: %s recebe o próprio valor e credenciais',
    async (origem) => {
      const r = await preflight(origem);
      expect(r.headers['access-control-allow-origin']).toBe(origem);
      expect(r.headers['access-control-allow-credentials']).toBe('true');
    },
  );

  // **AC-005** — os quatro negativos, nomeados na spec. O terceiro é o que
  // derruba uma política por expressão regular: `…playck.com.br.evil.example`
  // *contém* o domínio e não é ele.
  it.each([
    ['externa', 'https://evil.example'],
    ['irmão não listado', 'https://outro.playck.com.br'],
    ['sufixo colado', 'https://app.playck.com.br.evil.example'],
    ['`Origin: null`', 'null'],
  ])(
    'AC-005: origem %s NÃO recebe o cabeçalho de origem',
    async (_nome, origem) => {
      const r = await preflight(origem);
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    },
  );

  // **O controle**, e ele existe para distinguir *"recusou"* de *"a requisição
  // nem chegou"*. Sem `Origin` não há preflight de CORS: o middleware passa
  // adiante, e o que responde é a aplicação.
  it('controle: sem `Origin` não é preflight, e a resposta vem da aplicação', async () => {
    const r = await preflight(undefined);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    // Houve resposta HTTP — a diferença entre recusa e ausência de servidor.
    expect(r.status).toBeGreaterThan(0);
  });

  // A sabotagem que a spec nomeia: apagar `admin` da lista. Sem esta prova,
  // manter uma origem e perder as outras duas passava.
  it('sabotagem: uma lista sem `admin` recusa `admin`', async () => {
    const modulo = await Test.createTestingModule({
      controllers: [ControleDeTeste],
    }).compile();
    const encolhido = modulo.createNestApplication();
    encolhido.enableCors(opcoesDeCors({ CORS_ORIGINS: `${APP},${SUPER}` }));
    await encolhido.init();
    try {
      const r = await request(encolhido.getHttpServer())
        .options('/teste')
        .set('Origin', ADMIN)
        .set('Access-Control-Request-Method', 'GET');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
    } finally {
      await encolhido.close();
    }
  });
});
