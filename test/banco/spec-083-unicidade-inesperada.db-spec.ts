/**
 * SPEC-083/D3, passo 5 — **o `23505` da importação é decidido pela ETAPA em
 * que nasceu, e não pelo relatório** (achado DOR-083-R3-01).
 *
 * - **AC-052** — uma colisão fora da etapa de `usuarios` (aqui, o token do
 *   convite) sobe como `500`, **mesmo que** uma conferência refeita achasse
 *   erro de e-mail. O contraexemplo do validador da 3ª rodada: a colisão do
 *   token acontece, e uma conta com um e-mail do arquivo aparece depois do
 *   rollback. Quem decide pelo relatório (S16) responde `422` e mascara o
 *   defeito.
 * - **AC-053** — na etapa de `usuarios`, o `422` exige **erro de e-mail** no
 *   relatório refeito. Uma colisão de chave primária com relatório limpo (a),
 *   ou com erro só de turma (b), sobe como `500`. Quem traduz todo `23505` em
 *   `422` (S15) cai nos dois.
 *
 * As colisões são INJETADAS — no gerador de tokens (o `prepararConvite` do
 * `AcessoService`) e no gerador de ids (o gancho `gerarId`) —, porque numa
 * importação correta elas não acontecem: ids novos e token aleatório. É
 * exatamente por isso que, quando acontecem, são defeito.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { resposta, type Resposta } from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { sqlstateDoErro } from '../../src/courts/recusas-de-estoque';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import {
  etapaDaImportacao,
  ImportacaoDeAlunosService,
  MENSAGEM_EMAIL_JA_EXISTE,
  type GanchosDaImportacao,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const base = 'c0830005-0000-4000-8000-0000000001';
const EMPRESA = `${base}0a`;
const GESTOR = `${base}e1`;
const NIVEL = `${base}b1`;
const QUADRA = `${base}d1`;

const MODELOS = {
  remetente: 'convites@spec083u.teste.local',
  responderPara: 'suporte@spec083u.teste.local',
  urlCliente: 'https://cliente.spec083u.teste.local',
};

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);
const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

let seq = 0;
const email = (rotulo: string) => {
  seq += 1;
  return `s083u-${rotulo}-${seq}@teste.local`;
};

const GESTOR_DO_TOKEN = {
  sub: GESTOR,
  email: 'gestor-s083u@teste.local',
  nome: 'Gestora',
  role: 'company_admin',
  companyId: EMPRESA,
} as unknown as AccessTokenPayload;

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube SPEC-083 Unicidade','spec-083-uni-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${NIVEL}','${EMPRESA}','Iniciante',1)`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','gestor-s083u@teste.local','h','Gestora','company_admin','${EMPRESA}',now())`,
  );
}

async function alunoExistente(): Promise<{
  alunoId: string;
  usuarioId: string;
}> {
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,senha_temporaria,updated_at) VALUES ($1::uuid,$2,'h','Existente','aluno',$3::uuid,true,now())`,
    usuarioId,
    email('existente'),
    EMPRESA,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ($1::uuid,$2::uuid,$3::uuid,'aprovado','ativo')`,
    alunoId,
    usuarioId,
    EMPRESA,
  );
  return { alunoId, usuarioId };
}

/** Uma conta concorrente com o e-mail dado, criada e confirmada por fora. */
const contaConcorrente = (endereco: string) =>
  q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES (gen_random_uuid(),$1,'h','Concorrente','aluno',$2::uuid,now())`,
    endereco,
    EMPRESA,
  );

async function contarTudo() {
  const [r] = await db.$queryRawUnsafe<
    { usuarios: bigint; alunos: bigint; matriculas: bigint; convites: bigint }[]
  >(
    `SELECT (SELECT count(*) FROM usuarios WHERE company_id = $1::uuid AND role = 'aluno') AS usuarios,
            (SELECT count(*) FROM alunos WHERE company_id = $1::uuid) AS alunos,
            (SELECT count(*) FROM turma_alunos ta JOIN turmas t ON t.id = ta.turma_id WHERE t.company_id = $1::uuid) AS matriculas,
            (SELECT count(*) FROM convites_de_acesso WHERE company_id = $1::uuid) AS convites`,
    EMPRESA,
  );
  return {
    usuarios: Number(r.usuarios),
    alunos: Number(r.alunos),
    matriculas: Number(r.matriculas),
    convites: Number(r.convites),
  };
}

function montarServico(
  ganchos: GanchosDaImportacao,
  acesso?: AcessoService,
): ImportacaoDeAlunosService {
  const memoria = new MemoriaProvedorDeEmail();
  return new ImportacaoDeAlunosService(
    p,
    acesso ?? new AcessoService(p, memoria, MODELOS),
    memoria,
    MODELOS,
    ganchos,
  );
}

const pelaRota = (
  servico: ImportacaoDeAlunosService,
  conteudo: string,
  convidar?: string,
): Promise<Resposta> =>
  resposta(
    new ImportacaoController(servico).importar(
      GESTOR_DO_TOKEN,
      undefined,
      { buffer: Buffer.from(conteudo, 'utf8') } as Express.Multer.File,
      convidar,
    ),
  );

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-083/AC-052 — unicidade inesperada fora da etapa de usuários sobe como 500', () => {
  it('colisão do token do convite, e uma conta com e-mail do arquivo aparece depois do rollback: 500, nenhum 422, nada escrito', async () => {
    // Um convite que já existe, de outra conta: o hash dele é o que o gerador
    // injetado vai repetir.
    const dono = await alunoExistente();
    const hashRepetido = sha256(`token-que-ja-existe-${randomUUID()}`);
    await q(
      `INSERT INTO convites_de_acesso (company_id,usuario_id,criado_por_id,token_hash,impressao_credencial,expira_em)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4,'impressao',now() + interval '7 days')`,
      EMPRESA,
      dono.usuarioId,
      GESTOR,
      hashRepetido,
    );

    const real = new AcessoService(p, new MemoriaProvedorDeEmail(), MODELOS);
    const geradorComColisao = {
      prepararConvite: (u: { senhaHash: string }) => ({
        ...real.prepararConvite(u),
        tokenHash: hashRepetido,
      }),
    } as unknown as AcessoService;

    const ana = email('ana');
    const beto = email('beto');
    let ganchoRodou = false;
    const servico = montarServico(
      {
        depoisDoRollback: async () => {
          // Se a conta existisse ANTES, a colisão seria na etapa de usuários
          // e o caso provaria outra coisa. Ela nasce aqui: depois do rollback,
          // antes de a resposta ser decidida.
          await contaConcorrente(beto);
          ganchoRodou = true;
        },
      },
      geradorComColisao,
    );
    const antes = await contarTudo();

    const r = await pelaRota(
      servico,
      `nome;email\r\nAna;${ana}\r\nBeto;${beto}\r\n`,
      '2',
    );

    // As precondições: o gancho rodou, e a conta concorrente existe quando a
    // importação responde — uma conferência refeita AGORA acharia o e-mail.
    expect(ganchoRodou).toBe(true);
    expect(await db.usuario.count({ where: { email: beto } })).toBe(1);
    const refeita = await servico.conferir(
      EMPRESA,
      `nome;email\r\nAna;${ana}\r\nBeto;${beto}\r\n`,
    );
    expect(refeita.erros).toEqual([
      { linha: 3, coluna: 'email', mensagem: MENSAGEM_EMAIL_JA_EXISTE },
    ]);

    // O resultado: 500 (o erro original, sem tradução), e da etapa certa.
    expect(r.status).toBe(500);
    expect(sqlstateDoErro(r.erro)).toBe('23505');
    expect(etapaDaImportacao(r.erro)).toBe('convites_de_acesso');
    // Nada da importação: só a conta concorrente a mais.
    expect(await contarTudo()).toEqual({
      ...antes,
      usuarios: antes.usuarios + 1,
    });
  });
});

describe('SPEC-083/AC-053 — na etapa de usuários, o 422 exige erro de e-mail', () => {
  it('(a) colisão de chave primária com a conferência refeita sem erro nenhum: 500, nada escrito', async () => {
    const existente = await alunoExistente();
    const servico = montarServico({
      // A primeira conta do arquivo nasce com o id de uma conta que já existe.
      gerarId: (tabela, indice) =>
        tabela === 'usuarios' && indice === 0
          ? existente.usuarioId
          : randomUUID(),
    });
    const csv = `nome;email\r\nAna;${email('ana')}\r\nBeto;${email('beto')}\r\n`;
    const antes = await contarTudo();

    const r = await pelaRota(servico, csv);

    // Precondição: a conferência refeita não acha nada.
    expect((await servico.conferir(EMPRESA, csv)).erros).toEqual([]);
    expect(r.status).toBe(500);
    expect(sqlstateDoErro(r.erro)).toBe('23505');
    expect(etapaDaImportacao(r.erro)).toBe('usuarios');
    expect(await contarTudo()).toEqual(antes);
  });

  it('(b) colisão de chave primária com a conferência refeita com erro SÓ de turma: 500, nada escrito', async () => {
    const turma = randomUUID();
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ($1::uuid,$2::uuid,'Duas vagas',$3::uuid,2,'ativa',$4::uuid)`,
      turma,
      EMPRESA,
      QUADRA,
      NIVEL,
    );
    const existente = await alunoExistente();
    const outro = await alunoExistente();
    const servico = montarServico({
      gerarId: (tabela, indice) =>
        tabela === 'usuarios' && indice === 0
          ? existente.usuarioId
          : randomUUID(),
      // A capacidade muda DEPOIS do rollback: antes, a conferência refeita
      // sob a trava a teria visto, e a resposta seria o 422 de turma.
      depoisDoRollback: async () => {
        await q(
          `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,now()),(gen_random_uuid(),$1::uuid,$3::uuid,now())`,
          turma,
          existente.alunoId,
          outro.alunoId,
        );
      },
    });
    const csv = `nome;email;turma\r\nAna;${email('ana')};Duas vagas\r\n`;
    const antes = await contarTudo();

    const r = await pelaRota(servico, csv);

    // Precondição, as duas coisas: há erro de turma, e nenhum de e-mail.
    const refeita = await servico.conferir(EMPRESA, csv);
    expect(refeita.erros.map((e) => e.coluna)).toEqual(['turma']);
    expect(refeita.erros.some((e) => e.coluna === 'email')).toBe(false);

    expect(r.status).toBe(500);
    expect(sqlstateDoErro(r.erro)).toBe('23505');
    expect(etapaDaImportacao(r.erro)).toBe('usuarios');
    // As duas matrículas do gancho são as únicas novas.
    expect(await contarTudo()).toEqual({
      ...antes,
      matriculas: antes.matriculas + 2,
    });
  });
});
