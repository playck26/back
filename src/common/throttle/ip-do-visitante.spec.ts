import type { Request } from 'express';
import { chaveDoIp, chaveDoVisitante } from './ip-do-visitante';

/**
 * DEF-031 — **a chave do limite "por IP" é o visitante, não o balanceador.**
 *
 * Medido em produção (2026-09-15, `PROXIMO-PASSO.md`): `req.ip` é o servidor de
 * entrada da DigitalOcean, o mesmo para todo mundo; o `X-Forwarded-For` termina na
 * Cloudflare e aceita valor forjado na frente; **`do-connecting-ip` traz o
 * visitante, e a plataforma sobrescreve o valor que o cliente manda**.
 */

function req(headers: Record<string, unknown>, ip?: string): Request {
  return { headers, ip } as unknown as Request;
}

describe('chaveDoIp — a normalização', () => {
  it('IPv4 fica como está', () => {
    expect(chaveDoIp('201.87.254.107')).toBe('201.87.254.107');
  });

  it('IPv4 embutido em IPv6 (o que o Node entrega do socket) vira o IPv4', () => {
    expect(chaveDoIp('::ffff:100.127.3.147')).toBe('100.127.3.147');
  });

  it('IPv6 conta pelo prefixo /64 — um /64 inteiro é UMA pessoa', () => {
    // Um provedor entrega um /64 por cliente: contar o endereço inteiro daria ao
    // atacante 2^64 baldes.
    expect(chaveDoIp('2804:8aa4:3e19:5600:f4f4:824f:9fb1:ea9d')).toBe(
      '2804:8aa4:3e19:5600::/64',
    );
    expect(chaveDoIp('2804:8aa4:3e19:5600::1')).toBe(
      '2804:8aa4:3e19:5600::/64',
    );
  });

  it('grafias diferentes do mesmo /64 dão a mesma chave (zeros, maiúsculas, `::`)', () => {
    const chave = chaveDoIp('2804:8aa4:3e19:5600::abcd');
    expect(chaveDoIp('2804:8AA4:3E19:5600:0:0:0:1')).toBe(chave);
    // Zero à esquerda num grupo: `08aa` e `8aa` são o mesmo número.
    expect(chaveDoIp('2804:08aa:3e19:5600::1')).toBe(
      chaveDoIp('2804:8aa:3e19:5600::2'),
    );
  });

  it('/64 diferente é outra chave', () => {
    expect(chaveDoIp('2804:8aa4:3e19:5601::1')).not.toBe(
      chaveDoIp('2804:8aa4:3e19:5600::1'),
    );
  });

  it('`::` no começo do endereço também expande', () => {
    expect(chaveDoIp('::1')).toBe('0:0:0:0::/64');
  });

  it('o que não é IP volta como veio — não inventa chave', () => {
    expect(chaveDoIp('x')).toBe('x');
  });
});

describe('chaveDoVisitante — de onde vem o IP', () => {
  it('usa `do-connecting-ip` quando é IP válido, e não o socket', () => {
    expect(
      chaveDoVisitante(
        req({ 'do-connecting-ip': '201.87.254.107' }, '::ffff:100.127.3.147'),
      ),
    ).toBe('201.87.254.107');
  });

  it('dois visitantes atrás do mesmo balanceador têm chaves diferentes — o defeito', () => {
    const socketDaDigitalOcean = '::ffff:100.127.3.147';
    expect(
      chaveDoVisitante(
        req({ 'do-connecting-ip': '203.0.113.10' }, socketDaDigitalOcean),
      ),
    ).not.toBe(
      chaveDoVisitante(
        req({ 'do-connecting-ip': '198.51.100.20' }, socketDaDigitalOcean),
      ),
    );
  });

  it.each([
    ['ausente', {}],
    ['vazio', { 'do-connecting-ip': '' }],
    ['inválido', { 'do-connecting-ip': '192.0.2.300' }],
    ['texto', { 'do-connecting-ip': 'nao-sou-ip' }],
    ['lista', { 'do-connecting-ip': ['203.0.113.10', '198.51.100.20'] }],
  ])('cabeçalho %s cai no IP do socket, normalizado', (_nome, headers) => {
    expect(chaveDoVisitante(req(headers, '::ffff:10.0.0.1'))).toBe('10.0.0.1');
  });

  it('`X-Forwarded-For` é IGNORADO — o valor forjado passa por ele (medido)', () => {
    expect(
      chaveDoVisitante(
        req({ 'x-forwarded-for': '192.0.2.88, 172.64.222.119' }, '10.0.0.1'),
      ),
    ).toBe('10.0.0.1');
  });

  it('sem cabeçalho e sem socket, uma chave fixa — nunca vazia', () => {
    expect(chaveDoVisitante(req({}))).toBe('desconhecido');
  });
});
