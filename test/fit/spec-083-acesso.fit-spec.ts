import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  ConsoleLogger,
  type INestApplication,
  type LoggerService,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import request, { type Response } from 'supertest';
import type { App } from 'supertest/types';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import {
  PROVEDOR_DE_EMAIL,
  type MotivoDaFalha,
} from '../../src/email/provedor-de-email';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { comNivelDaFixture } from '../banco/nivel-da-fixture';
import { bodyOf } from '../utils/http';
import { subirAppReal } from './app-real';

/**
 * SPEC-083/TASK-004 (parte A) — **o link de ativação e a ficha do aluno, pela
 * HTTP, contra o Postgres de verdade.**
 *
 * ## Por que banco de verdade, e não o dublê dos outros e2e
 *
 * Quase tudo o que está em julgamento aqui é do banco: o `FOR UPDATE`, a
 * reivindicação condicional (`usado_em IS NULL ... AND expira_em > now()`), o
 * índice parcial, a impressão comparada com o `senha_hash` que outro caminho
 * (regenerar, trocar a `pck-`) acabou de gravar, e os refresh tokens que o
 * login real cria e a ativação derruba. Um dublê responderia o que o teste
 * mandasse — inclusive "deu certo" para uma reivindicação sem `WHERE`.
 *
 * Sobe o app inteiro (`subirAppReal`, o mesmo dos FITs: `configurarApp`, o
 * pipe de produção) com o provedor de e-mail **memória**, que é de onde o
 * teste lê o link — o token cru não existe em nenhum outro lugar (INV-083f).
 *
 * ## Por que em `test/fit`, e não num `.e2e-spec.ts`
 *
 * **Precisa de `DATABASE_URL` local e migrado**, e a trava `exigirBancoLocal`
 * recusa qualquer outro. Nasceu como `test/acesso.e2e-spec.ts`, e a revisão da
 * TASK-004a mediu o que isso fazia: o passo `pnpm test:e2e` do job `build` roda
 * **sem** `DATABASE_URL` e **antes** do `prisma migrate deploy` — os e2e são de
 * Prisma dublado por desenho —, então a trava lançava ao carregar o arquivo e o
 * job fechava vermelho, levando junto o `test:banco`, o build e o conferidor do
 * `openapi.json`. Pular sem banco também não serve: gate que pula é gate que
 * mente.
 *
 * Aqui ele entra no `fit-critical`, o job obrigatório do PR, que migra antes de
 * rodar e cria a role da limpeza no `globalSetup` do `jest-fit.json` — o mesmo
 * lugar das outras suítes de app real com banco (`spec-054-catalogo`,
 * `spec-078-avisos`). O write-set da spec ainda diz `test/acesso.e2e-spec.ts`:
 * a troca é um delta a registrar nela.
 *
 * ## O limite por IP
 *
 * As rotas públicas e o login contam 10 por IP a cada 15 min, e esta suíte faz
 * dezenas. Cada chamada pública leva um `do-connecting-ip` próprio — o
 * cabeçalho que o limite lê (DEF-031). O limite em si tem prova própria em
 * `throttle-por-usuario.e2e-spec.ts`; aqui ele só atrapalharia.
 */

exigirBancoLocal();
jest.setTimeout(60_000);

// Antes de o app subir: o `EmailModule` lê no boot. O provedor é forçado a
// `memoria` (nenhum e-mail sai daqui, mesmo com um `.env` que diga outra
// coisa), e os endereços são de teste, para o AC-041 provar que vêm da
// configuração e não de um literal.
process.env.EMAIL_PROVEDOR = 'memoria';
process.env.EMAIL_REMETENTE = 'convites@remetente.teste.local';
process.env.EMAIL_RESPONDER_PARA = 'respostas@suporte.teste.local';
process.env.URL_CLIENTE = 'https://cliente.teste.local';
const URL_CLIENTE = 'https://cliente.teste.local';

const base = 'c0830004-0000-4000-8000-0000000000';
const EMPRESA = `${base}0a`;
const EMPRESA_B = `${base}0b`;
const GESTOR = `${base}1a`;
const NOME_DO_CLUBE = 'Clube SPEC-083 Acesso';
const GESTOR_EMAIL = 'spec083-acesso-gestor@teste.local';
const GESTOR_SENHA = 'senha-do-gestor-083';

const db = new PrismaClient();
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const ler = <T>(sql: string, ...v: unknown[]) =>
  db.$queryRawUnsafe<T[]>(sql, ...v);

const sha256 = (valor: string) =>
  createHash('sha256').update(valor).digest('hex');

let app: INestApplication<App>;
let memoria: MemoriaProvedorDeEmail;
let tokenDoGestor: string;
/** O corpo do 410, lido do caso "inexistente" e comparado byte a byte. */
let corpoDoLinkInvalido: string;

let ipSeq = 0;
/** Um visitante novo por chamada pública (ver o cabeçalho). */
function ip(): string {
  ipSeq += 1;
  return `10.83.${Math.floor(ipSeq / 250)}.${(ipSeq % 250) + 1}`;
}

const http = () => request(app.getHttpServer());

const consultar = (token: string) =>
  http()
    .get(`/api/v1/public/ativacao/${encodeURIComponent(token)}`)
    .set('do-connecting-ip', ip());

const ativar = (token: string, senha: string) =>
  http()
    .post('/api/v1/public/ativacao')
    .set('do-connecting-ip', ip())
    .send({ token, senha });

const enviar = (alunoId: string) =>
  http()
    .post(`/api/v1/students/${alunoId}/convite-de-acesso`)
    .set('Authorization', `Bearer ${tokenDoGestor}`);

const situacao = (alunoId: string) =>
  http()
    .get(`/api/v1/students/${alunoId}/convite-de-acesso`)
    .set('Authorization', `Bearer ${tokenDoGestor}`);

async function login(email: string, senha: string) {
  return http()
    .post('/api/v1/auth/login')
    .set('do-connecting-ip', ip())
    .send({ email, senha });
}

interface Aluno {
  alunoId: string;
  usuarioId: string;
  email: string;
  /** A senha temporária, quando a conta tem uma. */
  senha: string;
  primeiroNome: string;
}

let alunoSeq = 0;
/**
 * Um aluno pronto, por SQL: conta com senha temporária conhecida (custo 4,
 * fixture) e ficha aprovada. O AC-022 cria o seu pelo `POST /students`, o
 * caminho de verdade; os outros só precisam de uma conta no estado certo.
 */
async function novoAluno(
  opcoes: { senhaTemporaria?: boolean; empresa?: string } = {},
): Promise<Aluno> {
  alunoSeq += 1;
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  const email = `spec083-acesso-${alunoSeq}@teste.local`;
  const senha = `pck-TESTE${alunoSeq}`;
  const temporaria = opcoes.senhaTemporaria ?? true;
  const empresa = opcoes.empresa ?? EMPRESA;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,senha_temporaria,senha_temporaria_expira_em,updated_at)
     VALUES ($1::uuid,$2,$3,$4,'aluno',$5::uuid,$6,${temporaria ? "now() + interval '7 days'" : 'NULL'},now())`,
    usuarioId,
    email,
    await bcrypt.hash(senha, 4),
    `Aluna${alunoSeq} da Silva`,
    empresa,
    temporaria,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ($1::uuid,$2::uuid,$3::uuid,'aprovado')`,
    alunoId,
    usuarioId,
    empresa,
  );
  return {
    alunoId,
    usuarioId,
    email,
    senha,
    primeiroNome: `Aluna${alunoSeq}`,
  };
}

/** O token do último e-mail capturado — o único lugar onde ele existe. */
function tokenDoUltimoEmail(): string {
  const mensagem = memoria.enviados[memoria.enviados.length - 1];
  const achado =
    /https:\/\/cliente\.teste\.local\/ativar\/([A-Za-z0-9_-]{43})\n/.exec(
      mensagem?.text ?? '',
    );
  if (!achado) {
    throw new Error('nenhum e-mail com link de ativação foi capturado');
  }
  return achado[1];
}

/** Envia pela ficha (200) e devolve o token do e-mail. */
async function enviarEPegarToken(aluno: Aluno): Promise<string> {
  await enviar(aluno.alunoId).expect(200);
  return tokenDoUltimoEmail();
}

interface LinhaDeConvite {
  id: string;
  token_hash: string;
  usado_em: Date | null;
  revogado_em: Date | null;
  expira_em: Date;
  email_resultado: string | null;
  email_motivo: string | null;
  email_em: Date | null;
}

const convitesDe = (usuarioId: string) =>
  ler<LinhaDeConvite>(
    `SELECT id, token_hash, usado_em, revogado_em, expira_em,
            email_resultado::text AS email_resultado, email_motivo, email_em
       FROM convites_de_acesso WHERE usuario_id = $1::uuid
      ORDER BY criado_em, id`,
    usuarioId,
  );

async function contaDe(usuarioId: string) {
  const [linha] = await ler<{
    senha_hash: string;
    senha_temporaria: boolean;
    senha_temporaria_expira_em: Date | null;
  }>(
    `SELECT senha_hash, senha_temporaria, senha_temporaria_expira_em FROM usuarios WHERE id = $1::uuid`,
    usuarioId,
  );
  return linha;
}

/** O 410 da D7: mesmo status, mesmo corpo, byte a byte. */
function expectLinkInvalido(res: Response): void {
  expect(res.status).toBe(410);
  expect(res.text).toBe(corpoDoLinkInvalido);
}

async function montarFixture(): Promise<void> {
  for (const [id, nome] of [
    [EMPRESA, NOME_DO_CLUBE],
    [EMPRESA_B, 'Clube SPEC-083 Acesso B'],
  ] as const) {
    await q(
      comNivelDaFixture(
        `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${id}','${nome}','spec-083-acesso-${id}',now())`,
      ),
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ($1::uuid,$2,$3,'Gestora 083','company_admin',$4::uuid,now())`,
    GESTOR,
    GESTOR_EMAIL,
    await bcrypt.hash(GESTOR_SENHA, 4),
    EMPRESA,
  );
}

beforeAll(async () => {
  // A role que a limpeza usa nas tabelas append-only já foi criada pelo
  // `globalSetup` do `jest-fit.json`.
  for (const empresa of [EMPRESA, EMPRESA_B]) {
    await limparEmpresa(db, empresa);
  }
  await montarFixture();

  app = await subirAppReal();
  const provedor = app.get<unknown>(PROVEDOR_DE_EMAIL);
  // Se não for o de memória, esta suíte estaria mandando e-mail de verdade.
  expect(provedor).toBeInstanceOf(MemoriaProvedorDeEmail);
  memoria = provedor as MemoriaProvedorDeEmail;

  const res = await login(GESTOR_EMAIL, GESTOR_SENHA);
  expect(res.status).toBe(200);
  tokenDoGestor = bodyOf<{ accessToken: string }>(res).accessToken;

  // A referência do 410: um token bem formado que nunca existiu.
  const ref = await consultar(randomBytes(32).toString('base64url'));
  expect(ref.status).toBe(410);
  corpoDoLinkInvalido = ref.text;
});

beforeEach(() => {
  memoria.limpar();
});

afterAll(async () => {
  await app?.close();
  for (const empresa of [EMPRESA, EMPRESA_B]) {
    await limparEmpresa(db, empresa);
  }
  await db.$disconnect();
});

describe('SPEC-083 — o corpo do 410 (D7)', () => {
  it('é o LINK_INVALIDO, e nada além', () => {
    expect(JSON.parse(corpoDoLinkInvalido)).toEqual({
      statusCode: 410,
      code: 'LINK_INVALIDO',
      message: 'Este link não vale mais. Peça um novo convite ao seu clube.',
    });
  });
});

describe('AC-020 — consultar o link não o consome', () => {
  it('200 com o primeiro nome e o clube, duas vezes; e depois ele ainda ativa', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);

    for (let vez = 0; vez < 2; vez += 1) {
      const res = await consultar(token).expect(200);
      expect(bodyOf<object>(res)).toEqual({
        primeiroNome: aluno.primeiroNome,
        empresa: { nome: NOME_DO_CLUBE },
      });
    }
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(convite.usado_em).toBeNull();

    await ativar(token, 'senha-nova-da-aluna').expect(204);
  });
});

describe('AC-021 — os oito casos da D7: 410 com o mesmo corpo, no GET e no POST', () => {
  /**
   * Um caso por motivo. Em cada um: o GET e o POST respondem o corpo de
   * referência, byte a byte, e o POST não mexe na senha.
   */
  async function confereMorto(token: string, usuarioId?: string) {
    const antes = usuarioId ? await contaDe(usuarioId) : null;
    expectLinkInvalido(await consultar(token));
    expectLinkInvalido(await ativar(token, 'senha-que-nao-entra'));
    if (usuarioId) {
      expect((await contaDe(usuarioId)).senha_hash).toBe(antes?.senha_hash);
    }
  }

  it('1. inexistente (bem formado, nunca emitido)', async () => {
    await confereMorto(randomBytes(32).toString('base64url'));
  });

  it('2. malformado', async () => {
    for (const token of [
      'nao-e-um-token',
      'a'.repeat(44),
      `${'a'.repeat(42)}=`,
    ]) {
      await confereMorto(token);
    }
  });

  it('3. usado', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await ativar(token, 'senha-nova-da-aluna').expect(204);
    await confereMorto(token, aluno.usuarioId);
  });

  it('4. revogado', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await q(
      `UPDATE convites_de_acesso SET revogado_em = now() WHERE token_hash = $1`,
      sha256(token),
    );
    await confereMorto(token, aluno.usuarioId);
  });

  it('5. expirado', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await q(
      `UPDATE convites_de_acesso SET expira_em = now() - interval '1 second' WHERE token_hash = $1`,
      sha256(token),
    );
    await confereMorto(token, aluno.usuarioId);
  });

  it('6. senha trocada depois da emissão (e a conta continua com senha temporária: só a impressão recusa)', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await q(
      `UPDATE usuarios SET senha_hash = $1 WHERE id = $2::uuid`,
      await bcrypt.hash('pck-OUTRA', 4),
      aluno.usuarioId,
    );
    expect((await contaDe(aluno.usuarioId)).senha_temporaria).toBe(true);
    await confereMorto(token, aluno.usuarioId);
  });

  it('7. usuário inativo', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await q(
      `UPDATE usuarios SET status = 'inativo' WHERE id = $1::uuid`,
      aluno.usuarioId,
    );
    await confereMorto(token, aluno.usuarioId);
  });

  it('8. empresa inativa', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await q(
      `UPDATE empresas SET status = 'inativa' WHERE id = $1::uuid`,
      EMPRESA,
    );
    try {
      await confereMorto(token, aluno.usuarioId);
    } finally {
      await q(
        `UPDATE empresas SET status = 'ativa' WHERE id = $1::uuid`,
        EMPRESA,
      );
    }
    // Controle: com a empresa de volta, o mesmo link vale. Sem ele, o 410
    // acima poderia ser de qualquer outro motivo.
    await consultar(token).expect(200);
  });
});

describe('AC-022 — ativar: 204, a senha nova entra, as sessões caem, e o portão de aceite aparece', () => {
  it('do cadastro pelo gestor até o primeiro acesso', async () => {
    // O caminho de verdade: o gestor cadastra, e a conta nasce com a `pck-`.
    const criado = await http()
      .post('/api/v1/students')
      .set('Authorization', `Bearer ${tokenDoGestor}`)
      .send({
        nome: 'Joana Pereira Lima',
        email: 'spec083-acesso-joana@teste.local',
      })
      .expect(201);
    const { id: alunoId, senhaTemporaria } = bodyOf<{
      id: string;
      senhaTemporaria: string;
    }>(criado);
    const [{ usuario_id: usuarioId }] = await ler<{ usuario_id: string }>(
      `SELECT usuario_id FROM alunos WHERE id = $1::uuid`,
      alunoId,
    );

    // Duas sessões abertas com a `pck-`, antes do link: a ativação tem de
    // derrubar as duas.
    for (let vez = 0; vez < 2; vez += 1) {
      expect(
        (await login('spec083-acesso-joana@teste.local', senhaTemporaria))
          .status,
      ).toBe(200);
    }
    const vivasAntes = await ler<{ n: number }>(
      `SELECT count(*)::int AS n FROM refresh_tokens WHERE usuario_id = $1::uuid AND revoked_at IS NULL`,
      usuarioId,
    );
    expect(vivasAntes[0].n).toBe(2);

    await enviar(alunoId).expect(200);
    const token = tokenDoUltimoEmail();

    const res = await ativar(token, 'senha-nova-da-joana').expect(204);
    expect(res.text).toBe('');
    // Sem login automático (D7): nenhuma sessão nasce numa rota pública.
    expect(res.headers['set-cookie']).toBeUndefined();

    const conta = await contaDe(usuarioId);
    expect(conta.senha_temporaria).toBe(false);
    expect(conta.senha_temporaria_expira_em).toBeNull();
    const sessoes = await ler<{ total: number; vivas: number }>(
      `SELECT count(*)::int AS total,
              count(*) FILTER (WHERE revoked_at IS NULL)::int AS vivas
         FROM refresh_tokens WHERE usuario_id = $1::uuid`,
      usuarioId,
    );
    expect(sessoes[0]).toEqual({ total: 2, vivas: 0 });

    // A `pck-` morreu junto (o `senha_hash` é outro); a senha nova entra.
    expect(
      (await login('spec083-acesso-joana@teste.local', senhaTemporaria)).status,
    ).toBe(401);
    const entrou = await login(
      'spec083-acesso-joana@teste.local',
      'senha-nova-da-joana',
    );
    expect(entrou.status).toBe(200);
    const sessao = bodyOf<{
      accessToken: string;
      usuario: { senhaTemporaria: boolean };
    }>(entrou);
    expect(sessao.usuario.senhaTemporaria).toBe(false);

    // O primeiro acesso cai no portão de aceite, como o de qualquer conta
    // criada pelo gestor (I12): o termo não é aceito na tela do link.
    const portao = await http()
      .get('/api/v1/me/cadastro')
      .set('Authorization', `Bearer ${sessao.accessToken}`)
      .expect(403);
    expect(bodyOf<{ code: string }>(portao).code).toBe('ACEITE_PENDENTE');
  });
});

describe('AC-023 — uso único, e senha curta não gasta o link', () => {
  it('o mesmo link duas vezes: a segunda é 410', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await ativar(token, 'senha-nova-da-aluna').expect(204);
    const depois = await contaDe(aluno.usuarioId);
    expectLinkInvalido(await ativar(token, 'outra-senha-qualquer'));
    expect((await contaDe(aluno.usuarioId)).senha_hash).toBe(depois.senha_hash);
  });

  it('senha de 7 caracteres → 400; o link continua valendo e ativa depois', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    const curta = await ativar(token, '1234567').expect(400);
    expect(curta.text).not.toBe(corpoDoLinkInvalido);
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(convite.usado_em).toBeNull();
    await consultar(token).expect(200);
    await ativar(token, '12345678').expect(204);
  });
});

describe('AC-024 — senha trocada por outro caminho mata o link (INV-083c)', () => {
  it('regenerar a senha temporária do aluno', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await http()
      .post(`/api/v1/students/${aluno.alunoId}/senha-temporaria`)
      .set('Authorization', `Bearer ${tokenDoGestor}`)
      .expect(200);
    // Continua com senha temporária: quem recusa é a impressão.
    expect((await contaDe(aluno.usuarioId)).senha_temporaria).toBe(true);
    expectLinkInvalido(await consultar(token));
    expectLinkInvalido(await ativar(token, 'senha-que-nao-entra'));
    expect(
      bodyOf<{ situacao: string }>(await situacao(aluno.alunoId).expect(200))
        .situacao,
    ).toBe('nao_enviado');
  });

  it('entrar com a `pck-` e trocá-la', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    const entrou = await login(aluno.email, aluno.senha);
    expect(entrou.status).toBe(200);
    await http()
      .post('/api/v1/auth/trocar-senha')
      .set(
        'Authorization',
        `Bearer ${bodyOf<{ accessToken: string }>(entrou).accessToken}`,
      )
      .send({ senhaAtual: aluno.senha, novaSenha: 'senha-escolhida-no-app' })
      .expect(200);
    const antes = await contaDe(aluno.usuarioId);
    expectLinkInvalido(await consultar(token));
    expectLinkInvalido(await ativar(token, 'senha-que-nao-entra'));
    expect((await contaDe(aluno.usuarioId)).senha_hash).toBe(antes.senha_hash);
    expect((await login(aluno.email, 'senha-escolhida-no-app')).status).toBe(
      200,
    );
  });

  // O terceiro caminho, gerar o acesso do professor, é da parte B da TASK-004.
});

describe('AC-026 — provedor fora: a ficha responde o sucesso de hoje, e o convite fica gravado com o motivo', () => {
  it.each<MotivoDaFalha>([
    'cota',
    'indisponivel',
    'tempo_esgotado',
    'configuracao',
  ])('%s', async (motivo) => {
    const aluno = await novoAluno();
    memoria.falharCom(motivo);
    const res = await enviar(aluno.alunoId).expect(200);
    const corpo = bodyOf<{
      situacao: string;
      motivo: string;
      expiraEm: string;
    }>(res);
    expect(corpo).toMatchObject({ situacao: 'falhou', motivo });

    const convites = await convitesDe(aluno.usuarioId);
    expect(convites).toHaveLength(1);
    expect(convites[0]).toMatchObject({
      usado_em: null,
      revogado_em: null,
      email_resultado: 'falhou',
      email_motivo: motivo,
    });
    expect(convites[0].email_em).not.toBeNull();
    expect(corpo.expiraEm).toBe(convites[0].expira_em.toISOString());
    // A tentativa chegou ao provedor (uma chamada), e nada foi aceito.
    expect(memoria.blocos).toHaveLength(1);
    expect(memoria.enviados).toHaveLength(0);
  });
});

describe('AC-027 — Host, Origin e X-Forwarded-Host forjados não mudam o link (INV-083e)', () => {
  it('o link do e-mail continua sendo URL_CLIENTE/ativar/<token>', async () => {
    const aluno = await novoAluno();
    await enviar(aluno.alunoId)
      .set('Host', 'atacante.example')
      .set('Origin', 'https://atacante.example')
      .set('X-Forwarded-Host', 'atacante.example')
      .set('X-Forwarded-Proto', 'http')
      .expect(200);

    const [mensagem] = memoria.enviados;
    expect(`${mensagem.html}\n${mensagem.text}`).not.toContain('atacante');
    const token = tokenDoUltimoEmail();
    const link = `${URL_CLIENTE}/ativar/${token}`;
    expect(mensagem.text).toContain(`\n${link}\n`);
    expect(mensagem.html).toContain(`href="${link}"`);
    // E o token do link é o do convite gravado — não um parecido.
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(convite.token_hash).toBe(sha256(token));
  });
});

describe('AC-031 — nada de token, link ou senha no log, ao enviar e ao ativar (INV-083f)', () => {
  it('Logger, console e stdout/stderr capturados durante os gestos', async () => {
    const capturado: string[] = [];
    const anotar = (...partes: unknown[]) => {
      capturado.push(
        partes
          .map((p) => (typeof p === 'string' ? p : JSON.stringify(p)))
          .join(' '),
      );
    };
    const logger: LoggerService = {
      log: anotar,
      error: anotar,
      warn: anotar,
      debug: anotar,
      verbose: anotar,
      fatal: anotar,
    };
    const espioes = [
      jest.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
        anotar(String(c));
        return true;
      }),
      jest.spyOn(process.stderr, 'write').mockImplementation((c: unknown) => {
        anotar(String(c));
        return true;
      }),
      ...(['log', 'info', 'warn', 'error', 'debug'] as const).map((m) =>
        jest.spyOn(console, m).mockImplementation(anotar),
      ),
    ];
    const aluno = await novoAluno();
    const segredos: string[] = [aluno.senha];
    app.useLogger(logger);
    try {
      // Enviar com o provedor recusando: é o caminho que LOGA (o controle
      // positivo de que a captura está ligada).
      memoria.falharCom('indisponivel');
      await enviar(aluno.alunoId).expect(200);
      memoria.falharCom(null);
      // Reenviar com sucesso, e ativar: senha curta (400), certa (204), e de
      // novo (410).
      await enviar(aluno.alunoId).expect(200);
      const token = tokenDoUltimoEmail();
      segredos.push(
        token,
        `${URL_CLIENTE}/ativar/${token}`,
        encodeURIComponent(token),
      );
      await ativar(token, 'curta').expect(400);
      segredos.push('curta');
      await ativar(token, 'senha-secreta-da-aluna').expect(204);
      segredos.push('senha-secreta-da-aluna');
      expectLinkInvalido(await ativar(token, 'senha-secreta-2'));
      segredos.push('senha-secreta-2');
    } finally {
      espioes.forEach((e) => e.mockRestore());
      // De volta ao que o módulo de teste do Nest usa: só erro no console.
      app.useLogger(new ConsoleLogger({ logLevels: ['error'] }));
    }

    const tudo = capturado.join('\n');
    // Controle positivo: a falha de envio foi registrada, com o id do convite.
    expect(tudo).toContain('convite_de_acesso_nao_enviado');
    for (const segredo of segredos) {
      expect(tudo).not.toContain(segredo);
    }
  });
});

describe('AC-033 — as cinco situações do aluno, com em, expiraEm e motivo coerentes', () => {
  /** O contrato que o cartão do Admin lê (AC-038): estas quatro chaves. */
  async function ler083(alunoId: string) {
    const res = await situacao(alunoId).expect(200);
    expect(Object.keys(bodyOf<object>(res)).sort()).toEqual([
      'em',
      'expiraEm',
      'motivo',
      'situacao',
    ]);
    return bodyOf<{
      situacao: string;
      em: string | null;
      expiraEm: string | null;
      motivo: string | null;
    }>(res);
  }

  it('nao_enviado: conta com senha temporária e nenhum convite', async () => {
    const aluno = await novoAluno();
    expect(await ler083(aluno.alunoId)).toEqual({
      situacao: 'nao_enviado',
      em: null,
      expiraEm: null,
      motivo: null,
    });
  });

  it('enviado: o instante do envio e a validade, como gravados', async () => {
    const aluno = await novoAluno();
    const postado = bodyOf<object>(await enviar(aluno.alunoId).expect(200));
    const [convite] = await convitesDe(aluno.usuarioId);
    const esperado = {
      situacao: 'enviado',
      em: convite.email_em?.toISOString(),
      expiraEm: convite.expira_em.toISOString(),
      motivo: null,
    };
    expect(await ler083(aluno.alunoId)).toEqual(esperado);
    // O POST responde a mesma situação, já com o resultado do envio.
    expect(postado).toEqual(esperado);
    const seteDias = 7 * 24 * 60 * 60 * 1000;
    expect(
      Math.abs(convite.expira_em.getTime() - Date.now() - seteDias),
    ).toBeLessThan(60_000);
  });

  it('falhou: recusado pelo provedor, com o motivo', async () => {
    const aluno = await novoAluno();
    memoria.falharCom('recusado');
    await enviar(aluno.alunoId).expect(200);
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(await ler083(aluno.alunoId)).toEqual({
      situacao: 'falhou',
      em: convite.email_em?.toISOString(),
      expiraEm: convite.expira_em.toISOString(),
      motivo: 'recusado',
    });
  });

  it('falhou: sem resultado gravado (o processo caiu depois do commit) → sem_confirmacao', async () => {
    const aluno = await novoAluno();
    await enviar(aluno.alunoId).expect(200);
    await q(
      `UPDATE convites_de_acesso SET email_resultado = NULL, email_motivo = NULL, email_em = NULL WHERE usuario_id = $1::uuid`,
      aluno.usuarioId,
    );
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(await ler083(aluno.alunoId)).toEqual({
      situacao: 'falhou',
      em: null,
      expiraEm: convite.expira_em.toISOString(),
      motivo: 'sem_confirmacao',
    });
  });

  it('expirado: vivo e vencido', async () => {
    const aluno = await novoAluno();
    await enviar(aluno.alunoId).expect(200);
    await q(
      `UPDATE convites_de_acesso SET expira_em = now() - interval '1 minute' WHERE usuario_id = $1::uuid`,
      aluno.usuarioId,
    );
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(await ler083(aluno.alunoId)).toEqual({
      situacao: 'expirado',
      em: convite.email_em?.toISOString(),
      expiraEm: convite.expira_em.toISOString(),
      motivo: null,
    });
  });

  it('ativado: pelo link, com o instante da ativação', async () => {
    const aluno = await novoAluno();
    const token = await enviarEPegarToken(aluno);
    await ativar(token, 'senha-nova-da-aluna').expect(204);
    const [convite] = await convitesDe(aluno.usuarioId);
    expect(await ler083(aluno.alunoId)).toEqual({
      situacao: 'ativado',
      em: convite.usado_em?.toISOString(),
      expiraEm: null,
      motivo: null,
    });
  });
});

describe('AC-034 — reenviar revoga o vivo e emite outro', () => {
  it('o link antigo vira 410, o novo funciona, e só há um vivo', async () => {
    const aluno = await novoAluno();
    const antigo = await enviarEPegarToken(aluno);
    const novo = await enviarEPegarToken(aluno);
    expect(novo).not.toBe(antigo);

    const convites = await convitesDe(aluno.usuarioId);
    expect(convites).toHaveLength(2);
    expect(convites[0].token_hash).toBe(sha256(antigo));
    expect(convites[0].revogado_em).not.toBeNull();
    expect(convites[1].token_hash).toBe(sha256(novo));
    expect(convites[1].revogado_em).toBeNull();
    expect(convites[1].usado_em).toBeNull();

    expectLinkInvalido(await consultar(antigo));
    expectLinkInvalido(await ativar(antigo, 'senha-pelo-link-antigo'));
    await consultar(novo).expect(200);
    await ativar(novo, 'senha-pelo-link-novo').expect(204);
  });

  it('reenviar um EXPIRADO também o revoga (o índice o conta como vivo)', async () => {
    const aluno = await novoAluno();
    await enviar(aluno.alunoId).expect(200);
    await q(
      `UPDATE convites_de_acesso SET expira_em = now() - interval '1 minute' WHERE usuario_id = $1::uuid`,
      aluno.usuarioId,
    );
    const novo = await enviarEPegarToken(aluno);
    const vivos = (await convitesDe(aluno.usuarioId)).filter(
      (c) => c.usado_em === null && c.revogado_em === null,
    );
    expect(vivos).toHaveLength(1);
    expect(vivos[0].token_hash).toBe(sha256(novo));
  });
});

describe('AC-035 (o que não é corrida) — a ficha é da empresa do gestor', () => {
  it('aluno de outra empresa → 404 no GET e no POST, e nada é emitido', async () => {
    const deFora = await novoAluno({ empresa: EMPRESA_B });
    await situacao(deFora.alunoId).expect(404);
    await enviar(deFora.alunoId).expect(404);
    expect(await convitesDe(deFora.usuarioId)).toHaveLength(0);
    expect(memoria.blocos).toHaveLength(0);
  });

  it('sem login → 401', async () => {
    const aluno = await novoAluno();
    await http()
      .get(`/api/v1/students/${aluno.alunoId}/convite-de-acesso`)
      .expect(401);
    await http()
      .post(`/api/v1/students/${aluno.alunoId}/convite-de-acesso`)
      .expect(401);
  });
});

describe('AC-036 — conta com senha própria: 409 CONTA_JA_ATIVADA, e nada é emitido', () => {
  it('nem convite, nem e-mail', async () => {
    const aluno = await novoAluno({ senhaTemporaria: false });
    const res = await enviar(aluno.alunoId).expect(409);
    expect(bodyOf<{ code: string }>(res).code).toBe('CONTA_JA_ATIVADA');
    expect(await convitesDe(aluno.usuarioId)).toHaveLength(0);
    expect(memoria.blocos).toHaveLength(0);
    expect(
      bodyOf<{ situacao: string }>(await situacao(aluno.alunoId).expect(200))
        .situacao,
    ).toBe('ativado');
  });
});

describe('AC-041 — remetente e responder-para da configuração, pela ficha', () => {
  it('"<clube> via PlayCK" <EMAIL_REMETENTE>, e reply-to EMAIL_RESPONDER_PARA', async () => {
    const aluno = await novoAluno();
    await enviar(aluno.alunoId).expect(200);
    expect(memoria.enviados).toHaveLength(1);
    expect(memoria.enviados[0]).toMatchObject({
      from: `"${NOME_DO_CLUBE} via PlayCK" <convites@remetente.teste.local>`,
      replyTo: 'respostas@suporte.teste.local',
      to: aluno.email,
      subject: `${NOME_DO_CLUBE} convidou você para o PlayCK`,
    });
  });
});
