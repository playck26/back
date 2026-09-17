/**
 * SPEC-057/TASK-001 — utilitários das suítes de banco para a configuração da
 * presença automática.
 *
 * **A configuração é um singleton do BANCO, não da empresa**: toda suíte que a
 * mexe precisa devolvê-la ao estado de nascença, senão a próxima suíte herda um
 * job ligado. Devolver exige passar por cima do próprio trigger que a protege
 * (corte imutável, ambiente declarado uma vez) — e passar por cima é
 * exatamente o bypass de owner DDL declarado na LIM-057o. Aqui ele é usado de
 * propósito, e só aqui.
 */
import type { PrismaClient } from '@prisma/client';

/** Login de teste que herda do papel de runtime da aplicação. */
export const LOGIN_RUNTIME_DE_TESTE = 'teste_playck_runtime_login';
/** Login de teste que herda do papel operacional. */
export const LOGIN_OPERADOR_DE_TESTE = 'teste_presenca_operador_login';

/**
 * Os logins do provisionamento, na forma de teste: `NOLOGIN` (a sessão do
 * teste chega a eles por `SET ROLE`), `INHERIT`, membros só do grupo. Papéis
 * são do cluster, então a criação é idempotente.
 */
export async function garantirLoginsDeTeste(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN_RUNTIME_DE_TESTE}') THEN
        CREATE ROLE ${LOGIN_RUNTIME_DE_TESTE} NOLOGIN INHERIT IN ROLE playck_app_runtime;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${LOGIN_OPERADOR_DE_TESTE}') THEN
        CREATE ROLE ${LOGIN_OPERADOR_DE_TESTE} NOLOGIN INHERIT IN ROLE presenca_auto_operador;
      END IF;
    END $$`);
}

/**
 * Logins **com LOGIN e senha**, para as provas que precisam de uma CONEXÃO
 * inteira como o papel — e não de `SET ROLE` numa transação. É o caso do
 * worker: a trava de credencial olha `current_user` da conexão dele, e os
 * serviços abrem as próprias transações. Senha fixa e sem valor: o banco da
 * suíte é local e descartável (`exigirBancoLocal`).
 */
export const CONEXAO_RUNTIME_DE_TESTE = 'teste_runtime_conexao';
export const CONEXAO_OPERADOR_DE_TESTE = 'teste_operador_conexao';
const SENHA_DA_CONEXAO_DE_TESTE = 'teste-057-conexao';

export async function garantirConexoesDeTeste(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(`
    DO $$
    BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CONEXAO_RUNTIME_DE_TESTE}') THEN
        CREATE ROLE ${CONEXAO_RUNTIME_DE_TESTE} LOGIN PASSWORD '${SENHA_DA_CONEXAO_DE_TESTE}'
          INHERIT IN ROLE playck_app_runtime;
      END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${CONEXAO_OPERADOR_DE_TESTE}') THEN
        CREATE ROLE ${CONEXAO_OPERADOR_DE_TESTE} LOGIN PASSWORD '${SENHA_DA_CONEXAO_DE_TESTE}'
          INHERIT IN ROLE presenca_auto_operador;
      END IF;
    END $$`);
}

/** A `DATABASE_URL` da suíte, trocando só usuário e senha. */
export function urlDaConexaoDeTeste(login: string): string {
  const url = new URL(process.env.DATABASE_URL ?? '');
  url.username = login;
  url.password = SENHA_DA_CONEXAO_DE_TESTE;
  return url.toString();
}

/** Declara o ambiente `teste` com a flag desligada — o ato do provisionamento. */
export async function declararAmbienteDeTeste(db: PrismaClient): Promise<void> {
  await db.$executeRawUnsafe(
    'ALTER TABLE public.config_presenca_automatica DISABLE TRIGGER USER',
  );
  try {
    await db.$executeRawUnsafe(
      `UPDATE public.config_presenca_automatica SET ambiente = 'teste'`,
    );
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE public.config_presenca_automatica ENABLE TRIGGER USER',
    );
  }
}

/** Desligada, sem corte, sem ambiente, com a linha presente. */
export async function redefinirConfigDePresenca(
  db: PrismaClient,
): Promise<void> {
  await db.$executeRawUnsafe(
    'ALTER TABLE public.config_presenca_automatica DISABLE TRIGGER USER',
  );
  try {
    await db.$executeRawUnsafe(
      'INSERT INTO public.config_presenca_automatica DEFAULT VALUES ON CONFLICT (id) DO NOTHING',
    );
    await db.$executeRawUnsafe(
      'UPDATE public.config_presenca_automatica SET habilitada = false, ativada_em = NULL, ambiente = NULL',
    );
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE public.config_presenca_automatica ENABLE TRIGGER USER',
    );
  }
}

/**
 * Liga o job para um teste, com o corte escolhido pelo teste — de novo por
 * cima do trigger, porque o teste precisa controlar o relógio do corte.
 */
export async function ligarPresencaAutomatica(
  db: PrismaClient,
  ativadaEm: Date,
): Promise<void> {
  await db.$executeRawUnsafe(
    'ALTER TABLE public.config_presenca_automatica DISABLE TRIGGER USER',
  );
  try {
    await db.$executeRawUnsafe(
      `UPDATE public.config_presenca_automatica SET ambiente = 'teste', ativada_em = $1::timestamptz, habilitada = true`,
      ativadaEm.toISOString(),
    );
  } finally {
    await db.$executeRawUnsafe(
      'ALTER TABLE public.config_presenca_automatica ENABLE TRIGGER USER',
    );
  }
}
