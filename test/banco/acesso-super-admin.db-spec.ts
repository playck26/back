/**
 * **A recuperação de acesso do super admin, contra banco real.**
 *
 * O unitário prova quem a CLI recusa; aqui prova-se o que ela ESCREVE, que é
 * o que importa numa emergência: a senha antiga morre, a nova é temporária e
 * expira, e as sessões abertas param de valer. Mock não prova nenhuma das
 * três — a última é `UPDATE` noutra tabela, dentro da mesma transação.
 */
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import {
  executarCli,
  VARIAVEL_DA_CREDENCIAL,
} from '../../src/acesso/cli/acesso-super-admin';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '05740000-0000-4000-8000-000000000001';
const SUPER = '05740000-0000-4000-8000-000000000002';
const GESTOR = '05740000-0000-4000-8000-000000000003';
const SENHA_ANTIGA = 'AntigaDoSuper#2026';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

const saida: string[] = [];
const cli = (argv: string[]) => {
  saida.length = 0;
  return executarCli(argv, {
    env: { [VARIAVEL_DA_CREDENCIAL]: process.env.DATABASE_URL },
    conectar: () => db,
    escrever: (l) => saida.push(l),
  });
};

async function usuario(id: string, email: string, role: string) {
  const hash = await bcrypt.hash(SENHA_ANTIGA, 10);
  // O super admin não tem empresa (ele é da plataforma); o gestor tem.
  const empresa = role === 'super_admin' ? 'NULL' : `'${EMPRESA}'`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,status,senha_temporaria,updated_at)
     VALUES ('${id}','${email}','${hash}','${email}','${role}',${empresa},'ativo',false,now())`,
  );
}

async function lerUsuario(id: string) {
  const [u] = await db.$queryRawUnsafe<
    {
      senhaHash: string;
      senhaTemporaria: boolean;
      expiraEm: Date | null;
      status: string;
    }[]
  >(
    `SELECT senha_hash AS "senhaHash", senha_temporaria AS "senhaTemporaria",
            senha_temporaria_expira_em AS "expiraEm", status::text AS status
       FROM usuarios WHERE id = $1::uuid`,
    id,
  );
  return u;
}

async function sessaoAberta(usuarioId: string) {
  await q(
    `INSERT INTO refresh_tokens (id,usuario_id,token_hash,expires_at,created_at)
     VALUES (gen_random_uuid(),'${usuarioId}','hash-de-sessao',now() + interval '7 days',now())`,
  );
}

const sessoesVivas = async (usuarioId: string) => {
  const [r] = await db.$queryRawUnsafe<{ n: bigint }[]>(
    `SELECT count(*) AS n FROM refresh_tokens WHERE usuario_id = $1::uuid AND revoked_at IS NULL`,
    usuarioId,
  );
  return Number(r.n);
};

beforeEach(async () => {
  await db.$executeRawUnsafe(
    `DELETE FROM refresh_tokens WHERE usuario_id IN ('${SUPER}','${GESTOR}')`,
  );
  await db.$executeRawUnsafe(`DELETE FROM usuarios WHERE id = '${SUPER}'`);
  await limparEmpresa(db, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube do acesso','clube-acesso-${EMPRESA}',now())`,
  );
  await usuario(SUPER, 'super@acesso.local', 'super_admin');
  await usuario(GESTOR, 'gestor@acesso.local', 'company_admin');
});

afterAll(async () => {
  await db.$executeRawUnsafe(
    `DELETE FROM refresh_tokens WHERE usuario_id IN ('${SUPER}','${GESTOR}')`,
  );
  await db.$executeRawUnsafe(`DELETE FROM usuarios WHERE id = '${SUPER}'`);
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('acesso:sadmin — redefinir', () => {
  it('troca a senha, marca como temporária com prazo e encerra as sessões', async () => {
    await sessaoAberta(SUPER);
    const antes = await lerUsuario(SUPER);

    const codigo = await cli([
      'redefinir',
      '--email',
      'super@acesso.local',
      '--confirmar',
    ]);

    expect(codigo).toBe(0);
    const depois = await lerUsuario(SUPER);
    expect(depois.senhaHash).not.toBe(antes.senhaHash);
    expect(depois.senhaTemporaria).toBe(true);
    expect(depois.expiraEm).toBeInstanceOf(Date);
    expect(depois.expiraEm!.getTime()).toBeGreaterThan(Date.now());
    expect(await sessoesVivas(SUPER)).toBe(0);

    // A senha impressa é a que passa a valer — e a antiga morre.
    const senha = /senha:\s+(\S+)/.exec(saida.join('\n'))![1];
    expect(await bcrypt.compare(senha, depois.senhaHash)).toBe(true);
    expect(await bcrypt.compare(SENHA_ANTIGA, depois.senhaHash)).toBe(false);
  });

  it('não toca em gestor: e-mail de company_admin é recusado', async () => {
    const antes = await lerUsuario(GESTOR);

    const codigo = await cli([
      'redefinir',
      '--email',
      'gestor@acesso.local',
      '--confirmar',
    ]);

    expect(codigo).toBe(1);
    expect(saida.join('\n')).toContain('SUPER_ADMIN_NAO_ENCONTRADO');
    expect(await lerUsuario(GESTOR)).toEqual(antes);
  });

  it('super admin inativo é recusado, e a conta continua inativa', async () => {
    await q(`UPDATE usuarios SET status = 'inativo' WHERE id = '${SUPER}'`);
    const antes = await lerUsuario(SUPER);

    const codigo = await cli([
      'redefinir',
      '--email',
      'super@acesso.local',
      '--confirmar',
    ]);

    expect(codigo).toBe(1);
    expect(saida.join('\n')).toContain('CONTA_INATIVA');
    expect(await lerUsuario(SUPER)).toEqual(antes);
  });

  it('sem --confirmar não escreve nada, mesmo com o e-mail certo', async () => {
    await sessaoAberta(SUPER);
    const antes = await lerUsuario(SUPER);

    const codigo = await cli(['redefinir', '--email', 'super@acesso.local']);

    expect(codigo).toBe(1);
    expect(await lerUsuario(SUPER)).toEqual(antes);
    expect(await sessoesVivas(SUPER)).toBe(1);
  });

  it('listar mostra o super admin e não escreve no banco', async () => {
    const antes = await lerUsuario(SUPER);

    const codigo = await cli(['listar']);

    expect(codigo).toBe(0);
    expect(saida.join('\n')).toContain('super@acesso.local');
    expect(saida.join('\n')).not.toContain('gestor@acesso.local');
    expect(await lerUsuario(SUPER)).toEqual(antes);
  });
});
