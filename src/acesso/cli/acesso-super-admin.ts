import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import {
  BCRYPT_COST,
  gerarSenhaTemporaria,
  senhaTemporariaExpiraEm,
} from '../../common/utils/senha-temporaria';

/**
 * **O último degrau do acesso ao painel** — `pnpm acesso:sadmin`.
 *
 *     pnpm acesso:sadmin -- listar
 *     pnpm acesso:sadmin -- redefinir --email <e-mail> --confirmar
 *
 * ## Por que isto existe
 *
 * O gestor (`company_admin`) já tem quem o socorra: o super admin gera uma
 * senha temporária para ele (SPEC-016/AC-002). **O super admin não tem
 * ninguém acima.** Até aqui, perder a senha dele significava `UPDATE` direto
 * no banco — operação sem registro, sem regra e feita na pressa, que é como
 * nasce incidente. O `STATUS.md` carregava isso como lacuna ALTA "sem
 * contorno" desde 2026-08-22.
 *
 * **Terminal, e não tela.** Uma rota nova seria superfície permanente para
 * resolver um caso raro, e não funcionaria justamente no cenário que importa:
 * ninguém consegue entrar. A CLI funciona com o app fora do ar.
 *
 * ## O que ela NÃO faz
 *
 * Não cria conta, não promove ninguém a super admin, não reativa conta
 * inativa e não imprime hash, host, usuário ou URL. Só devolve o acesso de
 * quem já é super admin, com senha temporária que **expira** e que o primeiro
 * login obriga a trocar.
 *
 * **Lê exclusivamente `ACESSO_ADMIN_DATABASE_URL`.** Nunca recorre a
 * `DATABASE_URL` nem a `MIGRATION_DATABASE_URL`: a credencial deste comando é
 * uma decisão de quem opera, não herança do ambiente onde ele calhou de rodar.
 */
export const VARIAVEL_DA_CREDENCIAL = 'ACESSO_ADMIN_DATABASE_URL';

export type ClienteDeAcesso = Pick<
  PrismaClient,
  '$queryRawUnsafe' | '$executeRawUnsafe' | '$transaction' | '$disconnect'
>;

export interface AmbienteDaCli {
  env: Record<string, string | undefined>;
  conectar: (url: string) => ClienteDeAcesso;
  escrever: (linha: string) => void;
}

interface SuperAdmin {
  id: string;
  nome: string;
  email: string;
  status: string;
  senhaTemporaria: boolean;
  expiraEm: Date | null;
}

/** Devolve o exit code; nunca lança. */
export async function executarCli(
  argv: readonly string[],
  ambiente: AmbienteDaCli,
): Promise<number> {
  const args = argv.filter((a) => a !== '--');
  const comando = args[0];
  const { escrever, env } = ambiente;

  if (comando !== 'listar' && comando !== 'redefinir') {
    escrever(
      'uso: acesso:sadmin -- listar | redefinir --email <e-mail> --confirmar',
    );
    return 1;
  }

  const url = env[VARIAVEL_DA_CREDENCIAL];
  if (!url) {
    escrever(`erro: ${VARIAVEL_DA_CREDENCIAL} ausente; nada foi conectado.`);
    return 1;
  }

  let email = '';
  if (comando === 'redefinir') {
    email = (valorDe(args, '--email') ?? '').trim().toLowerCase();
    if (!email) {
      escrever('erro: --email é obrigatório; nada foi conectado.');
      return 1;
    }
    // `--confirmar` é a fricção deliberada: o comando derruba a sessão do
    // super admin e invalida a senha atual. Pedir a confirmação no próprio
    // comando evita o engano de histórico do terminal.
    if (!args.includes('--confirmar')) {
      escrever(
        'erro: falta --confirmar. Isto invalida a senha atual e encerra as ' +
          'sessões abertas deste super admin; nada foi conectado.',
      );
      return 1;
    }
  }

  let cliente: ClienteDeAcesso | null = null;
  try {
    cliente = ambiente.conectar(url);
    const supers = await cliente.$queryRawUnsafe<SuperAdmin[]>(
      `SELECT id::text AS id, nome, email, status::text AS status,
              senha_temporaria AS "senhaTemporaria",
              senha_temporaria_expira_em AS "expiraEm"
         FROM usuarios
        WHERE role = 'super_admin'
        ORDER BY email`,
    );

    if (comando === 'listar') {
      escrever(`super admins: ${supers.length}`);
      for (const s of supers) {
        escrever(
          `  ${s.email} · ${s.nome} · conta ${s.status}` +
            (s.senhaTemporaria
              ? ` · senha temporária até ${formatar(s.expiraEm)}`
              : ' · senha definitiva'),
        );
      }
      return 0;
    }

    const alvo = supers.find((s) => s.email.toLowerCase() === email);
    if (!alvo) {
      // Sem dizer se o e-mail existe com outro papel: a resposta é a mesma
      // para "não existe" e "não é super admin", como nas rotas (AC-006).
      escrever('erro: SUPER_ADMIN_NAO_ENCONTRADO; nenhuma senha foi trocada.');
      return 1;
    }
    if (alvo.status !== 'ativo') {
      // Mesma escolha da rota do gestor (AC-007b): conta inativa é recusada,
      // não reativada em silêncio. Reativar é outra decisão, de outra pessoa.
      escrever('erro: CONTA_INATIVA; reative a conta antes de gerar senha.');
      return 1;
    }

    const senha = gerarSenhaTemporaria();
    const senhaHash = await bcrypt.hash(senha, BCRYPT_COST);
    const expiraEm = senhaTemporariaExpiraEm();

    await cliente.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `UPDATE usuarios
            SET senha_hash = $1, senha_temporaria = true,
                senha_temporaria_expira_em = $2::timestamptz, updated_at = now()
          WHERE id = $3::uuid`,
        senhaHash,
        expiraEm.toISOString(),
        alvo.id,
      );
      // INV-030 — senha nova com sessão velha viva é senha decorativa. É o
      // ACHADO-002 da SPEC-009, e vale igual fora do HTTP.
      await tx.$executeRawUnsafe(
        `UPDATE refresh_tokens SET revoked_at = now()
          WHERE usuario_id = $1::uuid AND revoked_at IS NULL`,
        alvo.id,
      );
    });

    escrever(`ok: senha temporária gerada para ${alvo.email}.`);
    escrever(`senha:    ${senha}`);
    escrever(`expira:   ${formatar(expiraEm)}`);
    escrever(
      'Entregue por canal privado. O primeiro login exige trocá-la, e as ' +
        'sessões abertas deste usuário foram encerradas.',
    );
    return 0;
  } catch (causa) {
    escrever(`erro: ${motivo(causa)}; nenhuma senha foi trocada.`);
    return 1;
  } finally {
    if (cliente) {
      await cliente.$disconnect().catch(() => undefined);
    }
  }
}

function valorDe(args: readonly string[], nome: string): string | undefined {
  const i = args.indexOf(nome);
  return i >= 0 ? args[i + 1] : undefined;
}

function formatar(instante: Date | null): string {
  return instante ? new Date(instante).toISOString() : '(sem prazo)';
}

/** Nunca devolve texto do driver: ele cita host e usuário. */
function motivo(causa: unknown): string {
  const nome = causa instanceof Error ? causa.constructor.name : '';
  if (nome === 'PrismaClientInitializationError') return 'CONEXAO_FALHOU';
  return nome === 'PrismaClientKnownRequestError' ? 'BANCO_RECUSOU' : 'FALHA';
}

/* istanbul ignore next -- ponto de entrada; a lógica é `executarCli`. */
if (require.main === module) {
  void executarCli(process.argv.slice(2), {
    env: process.env,
    conectar: (url) => new PrismaClient({ datasources: { db: { url } } }),

    escrever: (linha) => console.log(linha),
  }).then((codigo) => {
    process.exitCode = codigo;
  });
}
