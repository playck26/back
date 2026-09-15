import type { NextFunction, Request, Response } from 'express';
import {
  CABECALHO_DA_SONDA,
  criarDiagnosticoDeIp,
  type RegistroDoDiagnostico,
} from './diagnostico-de-ip';

/**
 * DEF-031 — o diagnóstico que MEDE o que o App Platform entrega, antes de
 * escolher a chave do limite por IP.
 *
 * O que ele não pode fazer é tão importante quanto o que faz: registrar IP de
 * quem não pediu, ou mudar a resposta de alguém.
 */

function requisicao(
  headers: Record<string, string>,
  extras: Partial<Request> = {},
): Request {
  return {
    headers,
    ip: '10.244.0.7',
    ips: [],
    socket: { remoteAddress: '10.244.0.7' },
    method: 'GET',
    originalUrl: '/api/docs-json',
    ...extras,
  } as unknown as Request;
}

describe('diagnostico-de-ip (DEF-031)', () => {
  let registros: RegistroDoDiagnostico[];
  let next: jest.Mock;
  const res = {} as Response;
  const diagnostico = () => criarDiagnosticoDeIp((r) => registros.push(r));

  beforeEach(() => {
    registros = [];
    next = jest.fn();
  });

  it('sem o cabeçalho da sonda: não registra NADA, e segue', () => {
    diagnostico()(
      requisicao({
        'do-connecting-ip': '198.51.100.9',
        'x-forwarded-for': '198.51.100.9, 10.0.0.1',
      }),
      res,
      next as NextFunction,
    );
    expect(registros).toEqual([]);
    expect(next).toHaveBeenCalledTimes(1);
  });

  it('com a sonda: registra os cabeçalhos de IP como chegaram, e segue', () => {
    diagnostico()(
      requisicao({
        [CABECALHO_DA_SONDA]: 'forjado-do-connecting-ip',
        'do-connecting-ip': '192.0.2.77',
        'x-forwarded-for': '192.0.2.88, 162.158.1.1',
        'cf-connecting-ip': '198.51.100.9',
        'x-real-ip': '10.0.0.5',
        authorization: 'Bearer segredo',
        cookie: 'refresh=segredo',
      }),
      res,
      next as NextFunction,
    );
    expect(next).toHaveBeenCalledTimes(1);
    expect(registros).toEqual([
      {
        sonda: 'forjado-do-connecting-ip',
        metodo: 'GET',
        rota: '/api/docs-json',
        doConnectingIp: '192.0.2.77',
        xForwardedFor: '192.0.2.88, 162.158.1.1',
        cfConnectingIp: '198.51.100.9',
        xRealIp: '10.0.0.5',
        remoteAddress: '10.244.0.7',
        reqIp: '10.244.0.7',
      },
    ]);
  });

  it('nunca registra token nem cookie, mesmo com a sonda', () => {
    diagnostico()(
      requisicao({
        [CABECALHO_DA_SONDA]: 'x',
        authorization: 'Bearer segredo',
        cookie: 'refresh=segredo',
      }),
      res,
      next as NextFunction,
    );
    expect(JSON.stringify(registros)).not.toContain('segredo');
  });

  it('cabeçalho ausente vira null, não string vazia nem undefined', () => {
    diagnostico()(
      requisicao({ [CABECALHO_DA_SONDA]: 'sem-nada' }),
      res,
      next as NextFunction,
    );
    expect(registros[0]).toMatchObject({
      doConnectingIp: null,
      xForwardedFor: null,
      cfConnectingIp: null,
      xRealIp: null,
    });
  });

  it('a sonda é cortada em 40 caracteres — ninguém escreve um livro no log', () => {
    diagnostico()(
      requisicao({ [CABECALHO_DA_SONDA]: 'a'.repeat(500) }),
      res,
      next as NextFunction,
    );
    expect(registros[0].sonda).toHaveLength(40);
  });
});
