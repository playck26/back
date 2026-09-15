import { Logger, type INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import { CABECALHO_DA_SONDA } from '../src/common/throttle/diagnostico-de-ip';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock } from './utils/prisma-mock';

/**
 * DEF-031 — o diagnóstico está LIGADO no app que produção monta
 * (`configurarApp`), e não muda resposta nenhuma.
 */
describe('DEF-031 — diagnóstico de IP ligado no app (e2e)', () => {
  let app: INestApplication<App>;
  let log: jest.SpyInstance;

  beforeEach(async () => {
    log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation(() => undefined);
    app = await createTestApp(buildPrismaMock());
  });

  afterEach(async () => {
    log.mockRestore();
    await app.close();
  });

  const registrosDoDiagnostico = (): string[] =>
    (log.mock.calls as unknown[][])
      .map((chamada) => String(chamada[0]))
      .filter((mensagem) => mensagem.startsWith('{"sonda":'));

  it('com a sonda, registra; a resposta é a mesma de sem a sonda', async () => {
    const sem = await request(app.getHttpServer()).get(
      '/api/v1/rota-que-nao-existe',
    );
    const com = await request(app.getHttpServer())
      .get('/api/v1/rota-que-nao-existe')
      .set(CABECALHO_DA_SONDA, 'e2e')
      .set('do-connecting-ip', '192.0.2.77');

    expect(com.status).toBe(sem.status);
    expect(com.body).toEqual(sem.body);
    const registros = registrosDoDiagnostico();
    expect(registros).toHaveLength(1);
    expect(registros[0]).toContain('"doConnectingIp":"192.0.2.77"');
  });

  it('sem a sonda, nada é registrado', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/rota-que-nao-existe')
      .set('do-connecting-ip', '192.0.2.77');
    expect(registrosDoDiagnostico()).toHaveLength(0);
  });
});
