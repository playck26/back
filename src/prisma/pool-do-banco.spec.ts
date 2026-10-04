import { Logger } from '@nestjs/common';
import { registrarPoolDoBanco } from './pool-do-banco';
import { PrismaService } from './prisma.service';

// AC-011 — cinco sentinelas distintas, uma por parte da URL que não pode
// vazar. Nenhuma é substring de outra, nem de "connection_limit"/"20".
const SENTINELAS = {
  usuario: 'sentinelausuarioqk',
  senha: 'sentinelasenhazv',
  host: 'sentinelahostwj.exemplo',
  banco: 'sentinelabancoyx',
  opcao: 'sentinelaopcaorb',
};
const URL_COM_LIMITE = `postgresql://${SENTINELAS.usuario}:${SENTINELAS.senha}@${SENTINELAS.host}:5432/${SENTINELAS.banco}?sslmode=require&options=${SENTINELAS.opcao}&connection_limit=20`;
const URL_SEM_LIMITE = URL_COM_LIMITE.replace('&connection_limit=20', '');

function capturar() {
  const mensagens: unknown[] = [];
  const logger = {
    log: (m: unknown) => mensagens.push(m),
    warn: (m: unknown) => mensagens.push(m),
  };
  return { logger, mensagens, texto: () => JSON.stringify(mensagens) };
}

function semVazamento(texto: string) {
  for (const s of Object.values(SENTINELAS)) expect(texto).not.toContain(s);
  expect(texto).not.toContain('@');
  expect(texto).not.toContain('://');
}

describe('SPEC-081 AC-011 — o pool do banco na subida, sem vazar a URL', () => {
  it('com connection_limit=20: registra connectionLimit 20 e nenhuma sentinela', () => {
    const c = capturar();
    registrarPoolDoBanco(URL_COM_LIMITE, c.logger);

    expect(c.mensagens).toEqual([
      { evento: 'pool_do_banco', connectionLimit: 20, poolTimeout: null },
    ]);
    semVazamento(c.texto());
  });

  it('pool_timeout também é lido, e só ele além do limite', () => {
    const c = capturar();
    registrarPoolDoBanco(`${URL_COM_LIMITE}&pool_timeout=15`, c.logger);
    expect(c.mensagens).toEqual([
      { evento: 'pool_do_banco', connectionLimit: 20, poolTimeout: 15 },
    ]);
    semVazamento(c.texto());
  });

  it('sem o parâmetro: connectionLimit null, e um aviso', () => {
    const c = capturar();
    registrarPoolDoBanco(URL_SEM_LIMITE, c.logger);

    expect(c.mensagens[0]).toEqual({
      evento: 'pool_do_banco',
      connectionLimit: null,
      poolTimeout: null,
    });
    expect(c.mensagens).toHaveLength(2);
    expect(c.mensagens[1]).toMatchObject({
      evento: 'pool_do_banco_sem_limite',
    });
    semVazamento(c.texto());
  });

  it('URL ausente ou inválida não quebra a subida nem ecoa o texto', () => {
    for (const url of [undefined, '', `nao-e-url ${SENTINELAS.senha}`]) {
      const c = capturar();
      registrarPoolDoBanco(url, c.logger);
      expect(c.mensagens[0]).toMatchObject({ connectionLimit: null });
      semVazamento(c.texto());
    }
  });

  it('o PrismaService registra na subida, pelo Logger do Nest', () => {
    const mensagens: unknown[] = [];
    const log = jest
      .spyOn(Logger.prototype, 'log')
      .mockImplementation((m: unknown) => void mensagens.push(m));
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation((m: unknown) => void mensagens.push(m));
    const antes = process.env.DATABASE_URL;
    process.env.DATABASE_URL = URL_COM_LIMITE;
    try {
      new PrismaService().onModuleInit();
    } finally {
      if (antes === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = antes;
      log.mockRestore();
      warn.mockRestore();
    }

    expect(mensagens).toEqual([
      { evento: 'pool_do_banco', connectionLimit: 20, poolTimeout: null },
    ]);
    semVazamento(JSON.stringify(mensagens));
  });
});
