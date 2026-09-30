import type { LoggerService } from '@nestjs/common';

/**
 * SPEC-081/D3 — **o tamanho do pool deixa de ser palpite.**
 *
 * Sem `connection_limit` na URL, o Prisma escolhe o pool sozinho
 * (`núcleos × 2 + 1`), e ninguém sabia quanto era em produção: a
 * `DATABASE_URL` vem cifrada na spec do App Platform. Medido na avaliação:
 * pool 3 desaba a 1 tela/s (`P2024`); pool 17, a 5 telas/s.
 *
 * O Back NÃO reescreve a URL — ela continua sendo a fonte de verdade. Esta
 * função só LÊ dois parâmetros e os registra na subida. **Nenhum outro campo
 * da URL entra no objeto registrado**: nem usuário, nem senha, nem host, nem
 * banco, nem os outros parâmetros (AC-011).
 */
export interface PoolDoBanco {
  evento: 'pool_do_banco';
  connectionLimit: number | null;
  poolTimeout: number | null;
}

function numero(valor: string | null): number | null {
  if (valor === null || valor.trim() === '') return null;
  const n = Number(valor);
  return Number.isFinite(n) ? n : null;
}

export function lerPoolDoBanco(databaseUrl: string | undefined): PoolDoBanco {
  let params: URLSearchParams | null = null;
  try {
    params = databaseUrl ? new URL(databaseUrl).searchParams : null;
  } catch {
    // URL inválida: registra sem os números, e sem ecoar o texto recebido.
    params = null;
  }
  return {
    evento: 'pool_do_banco',
    connectionLimit: numero(params?.get('connection_limit') ?? null),
    poolTimeout: numero(params?.get('pool_timeout') ?? null),
  };
}

export function registrarPoolDoBanco(
  databaseUrl: string | undefined,
  logger: Pick<LoggerService, 'log' | 'warn'>,
): PoolDoBanco {
  const pool = lerPoolDoBanco(databaseUrl);
  logger.log(pool);
  if (pool.connectionLimit === null) {
    logger.warn({
      evento: 'pool_do_banco_sem_limite',
      mensagem:
        'DATABASE_URL sem connection_limit: o Prisma escolhe o pool sozinho (núcleos × 2 + 1). Produção usa 20 (OPERATIONS.md).',
    });
  }
  return pool;
}
