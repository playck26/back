/**
 * SPEC-062/FIT-047 — **a posse do aparelho, por HTTP, com duas contas.**
 *
 * INV-062d: um `endpoint`, um dono. A autenticação prova a **conta**, nunca o
 * controle do aparelho — e transferir por declaração seria sequestro de
 * avisos (achado v2-06 da SPEC-061, que derrubou uma versão inteira).
 *
 * O que se prova aqui, pelos caminhos de produção:
 *
 *   (a) assinar duas vezes, mesma conta, mesmo `endpoint` → **uma** linha
 *       (AC-001). O app reconcilia a cada abertura; criar linha nova a cada
 *       vez encheria a tabela de duplicatas do mesmo aparelho;
 *   (b) o `endpoint` de outra conta → **`409 ENDPOINT_EM_USO`** (AC-002), e a
 *       linha do dono original **intacta**;
 *   (c) `DELETE` só apaga o que é seu (D2a-2): a conta B não consegue apagar
 *       a assinatura de A, e recebe **`204` do mesmo jeito** — resposta
 *       diferente por existência transformaria a rota em oráculo de
 *       assinaturas alheias;
 *   (d) a rota da chave pública é **pública**, responde `no-store`, e leva a
 *       impressão da privada (D1b) — que é o insumo do gate G7;
 *   (e) **INV-062f**: `endpoint`, `p256dh` e `auth` **não voltam** em resposta
 *       nenhuma. São credencial: quem os tiver manda push naquele aparelho.
 *
 * Sem par VAPID configurado o serviço nasce desligado (AC-009), então o
 * ambiente de FIT define as três variáveis com um par **de teste, gerado
 * aqui** — nunca o de produção.
 */
import type { INestApplication } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import request from 'supertest';
import type { App } from 'supertest/types';
import * as webpush from 'web-push';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { subirAppReal } from './app-real';
import { idsDoCenario, login, montarCenario, type Sessao } from './cenario';

const C = idsDoCenario(7);

jest.setTimeout(600_000);
exigirBancoLocal();

// **Par de teste, gerado agora.** Nunca o de produção: uma FIT que precisasse
// do par real teria de recebê-lo por variável, e aí o segredo passaria a
// existir em mais um lugar — exatamente o que a INV-062b evita.
const PAR = webpush.generateVAPIDKeys();
process.env.PUSH_VAPID_PUBLIC_KEY = PAR.publicKey;
process.env.PUSH_VAPID_PRIVATE_KEY = PAR.privateKey;
process.env.PUSH_VAPID_SUBJECT = 'mailto:fit@playck.test';

const db = new PrismaClient();
let app: INestApplication<App>;
let dono: Sessao;
let outra: Sessao;

const ENDPOINT = 'https://push.exemplo.test/fit-047-aparelho-1';
const ASSINATURA = {
  endpoint: ENDPOINT,
  p256dh: 'BLc4xRzKlKORKWlbdgFaBrrPK3ydWAHo4M0gs0i1oEKgPpWG5VEmUYIWwFvwwqgqYktFB5W0LcQ',
  auth: 'FPssNDTKnInHVndSTdbKFw',
};

beforeAll(async () => {
  await limparEmpresa(db, C.EMPRESA);
  await montarCenario(db, C);
  app = await subirAppReal();
  dono = await login(app, C.ALUNO1_EMAIL);
  outra = await login(app, C.ALUNO2_EMAIL);
});

afterAll(async () => {
  await app?.close();
  await limparEmpresa(db, C.EMPRESA);
  await db.$disconnect();
});

beforeEach(async () => {
  await db.assinaturaPush.deleteMany({ where: { companyId: C.EMPRESA } });
  // **As notificações também.** A primeira versão deste arquivo só limpava
  // assinaturas, e o caso (f) recebeu `409` no PRIMEIRO pedido: o teste (e)
  // tinha deixado um aviso pendente para a mesma pessoa, e o índice parcial
  // recusou — corretamente. O teste estava errado, o índice não.
  //
  // Fica como prova lateral de que a INV-062g vale **entre execuções**, e não
  // só dentro de uma.
  await db.notificacao.deleteMany({ where: { companyId: C.EMPRESA } });
});

function comToken(sessao: Sessao) {
  return { Authorization: `Bearer ${sessao.accessToken}` };
}

describe('FIT-047 (d) — a chave pública', () => {
  it('é pública, não guarda cache e leva a impressão da privada', async () => {
    const res = await request(app.getHttpServer()).get(
      '/api/v1/push/chave-publica',
    );

    expect(res.status).toBe(200);
    expect(res.body.chave).toBe(PAR.publicKey);
    // D1b — `no-store`: guardar em cache anula a razão de ela vir por rota.
    // Depois de uma rotação, o aparelho assinaria com a chave velha e o erro
    // só apareceria no envio, longe da causa.
    expect(res.headers['cache-control']).toContain('no-store');
    // O insumo do G7. Não é segredo: 32 bytes aleatórios atrás de um sha256.
    expect(res.body.impressaoDaPrivada).toMatch(/^[0-9a-f]{64}$/);
    // E a impressão NÃO é a chave, nem parte dela.
    expect(res.body.impressaoDaPrivada).not.toContain(PAR.privateKey);
  });
});

describe('FIT-047 (a) — assinar duas vezes não cria duas linhas (AC-001)', () => {
  it('a segunda chamada atualiza, e a tabela continua com uma', async () => {
    const primeira = await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send(ASSINATURA);
    expect(primeira.status).toBe(204);

    const segunda = await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send({ ...ASSINATURA, p256dh: 'chave-rotacionada-pelo-navegador' });
    expect(segunda.status).toBe(204);

    const linhas = await db.assinaturaPush.findMany({
      where: { companyId: C.EMPRESA },
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].p256dh).toBe('chave-rotacionada-pelo-navegador');
  });
});

describe('FIT-047 (b) — endpoint de outra conta (AC-002, INV-062d)', () => {
  it('recusa com 409 e NÃO toca na linha do dono', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send(ASSINATURA)
      .expect(204);

    const invasao = await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(outra))
      .send(ASSINATURA);

    expect(invasao.status).toBe(409);
    expect(invasao.body.code).toBe('ENDPOINT_EM_USO');

    // O ponto inteiro: a assinatura continua sendo de quem era. Transferir
    // por declaração seria sequestro — a autenticação prova a conta, não o
    // controle do aparelho.
    const linhas = await db.assinaturaPush.findMany({
      where: { companyId: C.EMPRESA },
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].usuarioId).toBe(C.ALUNO1_USUARIO);
  });
});

describe('FIT-047 (c) — o DELETE só apaga o que é seu (D2a-2)', () => {
  it('a conta errada recebe 204 e não apaga nada', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send(ASSINATURA)
      .expect(204);

    // `204` do mesmo jeito: resposta diferente por existência transformaria
    // a rota em oráculo de assinaturas alheias.
    await request(app.getHttpServer())
      .delete('/api/v1/push/assinatura')
      .set(comToken(outra))
      .send({ endpoint: ENDPOINT })
      .expect(204);

    expect(
      await db.assinaturaPush.count({ where: { companyId: C.EMPRESA } }),
    ).toBe(1);
  });

  it('o dono apaga a própria, e o 204 se repete quando já não existe', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send(ASSINATURA)
      .expect(204);

    await request(app.getHttpServer())
      .delete('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send({ endpoint: ENDPOINT })
      .expect(204);

    expect(
      await db.assinaturaPush.count({ where: { companyId: C.EMPRESA } }),
    ).toBe(0);

    // Idempotente, e com a mesma resposta.
    await request(app.getHttpServer())
      .delete('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send({ endpoint: ENDPOINT })
      .expect(204);
  });
});

describe('FIT-047 (e) — INV-062f: a credencial não volta em resposta nenhuma', () => {
  it('nem no 204 de assinar, nem no 409, nem no aviso de teste', async () => {
    const assinar = await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send(ASSINATURA);
    const conflito = await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(outra))
      .send(ASSINATURA);
    const teste = await request(app.getHttpServer())
      .post('/api/v1/push/teste')
      .set(comToken(dono));

    for (const res of [assinar, conflito, teste]) {
      const corpo = JSON.stringify(res.body ?? '');
      expect(corpo).not.toContain(ASSINATURA.endpoint);
      expect(corpo).not.toContain(ASSINATURA.p256dh);
      expect(corpo).not.toContain(ASSINATURA.auth);
    }
  });
});

describe('FIT-047 (f) — o teto do aviso de teste (D6)', () => {
  it('um pendente por pessoa: o segundo é 409 TESTE_JA_ENFILEIRADO', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/push/assinatura')
      .set(comToken(dono))
      .send(ASSINATURA)
      .expect(204);

    const primeiro = await request(app.getHttpServer())
      .post('/api/v1/push/teste')
      .set(comToken(dono));
    expect(primeiro.status).toBe(201);

    const segundo = await request(app.getHttpServer())
      .post('/api/v1/push/teste')
      .set(comToken(dono));

    // **`409`, não `429`:** ter um teste ainda pendente é conflito de ESTADO,
    // não excesso de ritmo. O `429` é do teto horário.
    expect(segundo.status).toBe(409);
    expect(segundo.body.code).toBe('TESTE_JA_ENFILEIRADO');
  });
});
