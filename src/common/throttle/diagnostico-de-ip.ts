import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

/**
 * DEF-031 — **TEMPORÁRIO: medir o que o App Platform entrega, antes de escolher
 * a chave do limite por IP.** Sai no commit que corrigir o DEF-031.
 *
 * ## Por que medir, e não corrigir direto
 *
 * A correção da back#95 era `trust proxy = 1`, supondo um salto só com o IP do
 * visitante no `X-Forwarded-For`. **A documentação da DigitalOcean diz outra
 * coisa:** no App Platform, o `X-Forwarded-For` traz o IP do servidor de
 * entrada da DigitalOcean, e o do visitante vem em `do-connecting-ip`. Com
 * `trust proxy = 1`, todo mundo continuaria no mesmo balde.
 *
 * E trocar às cegas para `do-connecting-ip` pode ser pior que hoje: se a
 * plataforma NÃO sobrescrever o valor que o cliente manda, cada tentativa de
 * força bruta inventaria um IP e ganharia um balde novo. **Só uma medição em
 * produção responde**, e documentação não é medição.
 *
 * ## O que ele faz, e o que não pode fazer
 *
 * - Registra **só** requisições que trazem `x-playck-diagnostico-ip` — as
 *   sondas de quem mede. Ninguém mais tem IP no log por causa disto.
 * - Registra **só** cabeçalhos de IP. Nunca `authorization` nem `cookie`.
 * - **Não muda resposta**, não consome limite e não depende de rota: a sonda
 *   pode ir num `GET` qualquer, sem gastar o balde de login de ninguém.
 */
export const CABECALHO_DA_SONDA = 'x-playck-diagnostico-ip';

export type RegistroDoDiagnostico = {
  sonda: string;
  metodo: string;
  rota: string;
  doConnectingIp: string | null;
  xForwardedFor: string | null;
  cfConnectingIp: string | null;
  xRealIp: string | null;
  remoteAddress: string | null;
  reqIp: string | null;
};

function cabecalho(req: Request, nome: string): string | null {
  const valor = req.headers[nome];
  if (Array.isArray(valor)) return valor.join(', ');
  return typeof valor === 'string' ? valor : null;
}

export function criarDiagnosticoDeIp(
  registrar: (registro: RegistroDoDiagnostico) => void,
) {
  return (req: Request, _res: Response, next: NextFunction): void => {
    const sonda = cabecalho(req, CABECALHO_DA_SONDA);
    if (sonda !== null) {
      registrar({
        sonda: sonda.slice(0, 40),
        metodo: req.method,
        rota: req.originalUrl,
        doConnectingIp: cabecalho(req, 'do-connecting-ip'),
        xForwardedFor: cabecalho(req, 'x-forwarded-for'),
        cfConnectingIp: cabecalho(req, 'cf-connecting-ip'),
        xRealIp: cabecalho(req, 'x-real-ip'),
        remoteAddress: req.socket?.remoteAddress ?? null,
        reqIp: req.ip ?? null,
      });
    }
    next();
  };
}

const logger = new Logger('DiagnosticoDeIp');

export const diagnosticoDeIp = criarDiagnosticoDeIp((registro) =>
  logger.log(JSON.stringify(registro)),
);
