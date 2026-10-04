/**
 * SPEC-083/TASK-005 — **a importação com turma e com convite, contra o
 * Postgres de verdade.**
 *
 * ## Por que banco, e não o dublê
 *
 * Quase tudo o que se julga aqui é do banco: a turma achada entre as ATIVAS
 * da empresa (e não as da outra), a contagem de alocados e de reposições que
 * decide a capacidade, o lote que entra inteiro ou não entra, e a conferência
 * refeita SOB a trava — que só se prova com outra conexão mudando o estado no
 * meio. Um dublê responderia o que o teste mandasse.
 *
 * ## O que fica para o FIT-057 (TASK-009b)
 *
 * As medições de prazo por amostras (AC-045, AC-050, a parte medida do
 * AC-050, AC-056) e a corrida com barreira por `pg_blocking_pids` (AC-013,
 * AC-046, AC-047). O que este arquivo prova da corrida é **determinístico**:
 * o gancho `aoTravar` muda o estado por outra conexão no instante em que a
 * importação já segura a trava do clube e ainda não travou as turmas, e a
 * resposta tem de ser o `422` refeito — sem tempo, sem barreira, sem sorte
 * de ordem. É a prova que a S7 (conferir a capacidade só fora da trava)
 * derruba.
 *
 * As respostas passam pelo CONTROLLER: a tradução de `55P03`/`57014` em 409
 * mora na borda (D3, passo 5), e uma prova que chamasse o serviço direto
 * ficaria verde com a tradução arrancada.
 */
import { createHash, randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { resposta, type Resposta, I6 } from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { MemoriaProvedorDeEmail } from '../../src/email/memoria-provedor-de-email';
import type { MotivoDaFalha } from '../../src/email/provedor-de-email';
import {
  etapaDaImportacao,
  ImportacaoDeAlunosService,
  type EtapaDeEscrita,
  type GanchosDaImportacao,
} from '../../src/people/importacao/importacao-de-alunos.service';
import { ImportacaoController } from '../../src/people/importacao/importacao.controller';
import type {
  ImportacaoConcluidaDto,
  RelatorioDeImportacaoDto,
} from '../../src/people/importacao/dto/importacao-response.dto';
import { mensagemDeNivelIncompativel } from '../../src/people/nivel-efetivo';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const base = 'c0830005-0000-4000-8000-0000000000';
const EMPRESA = `${base}0a`;
const EMPRESA_B = `${base}0b`;
const GESTOR = `${base}e1`;
const INICIANTE = `${base}b1`;
const INTERMEDIARIO = `${base}b2`;
const QUADRA = `${base}d1`;
const NIVEL_B = `${base}b9`;
const QUADRA_B = `${base}d9`;

const MODELOS = {
  remetente: 'convites@spec083i.teste.local',
  responderPara: 'suporte@spec083i.teste.local',
  urlCliente: 'https://cliente.spec083i.teste.local',
};

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string, ...v: unknown[]) => db.$executeRawUnsafe(sql, ...v);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

let seq = 0;
/** Um e-mail novo por linha, para nenhum caso colidir com outro. */
const email = (rotulo: string) => {
  seq += 1;
  return `s083i-${rotulo}-${seq}@teste.local`;
};

function emDias(dias: number): string {
  // Base no fuso do clube, e não no relógio UTC (lição do FIT-035).
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

async function montarEmpresas(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube SPEC-083 Importacao','spec-083-imp-${EMPRESA}',now())`,
  );
  // Dois níveis, e o primeiro é Iniciante (INV-075c): a linha sem nível conta
  // como ele, e a turma de Intermediário recusa a linha sem nível (I4).
  await q(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${INICIANTE}','${EMPRESA}','Iniciante',1),('${INTERMEDIARIO}','${EMPRESA}','Intermediário',2)`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','gestor-s083i@teste.local','h','Gestora','company_admin','${EMPRESA}',now())`,
  );

  // A outra empresa, com uma turma de nome que o arquivo vai citar (AC-008).
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA_B}','Outro clube SPEC-083','spec-083-imp-${EMPRESA_B}',now())`,
  );
  await q(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${NIVEL_B}','${EMPRESA_B}','Iniciante',1)`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA_B}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA_B}','${EMPRESA_B}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA_B}' LIMIT 1),80,'ativa')`,
  );
}

async function turma(
  nome: string,
  opcoes: {
    nivel?: string;
    capacidade?: number;
    status?: 'ativa' | 'inativa';
    empresa?: string;
  } = {},
): Promise<string> {
  const id = randomUUID();
  const empresa = opcoes.empresa ?? EMPRESA;
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ($1::uuid,$2::uuid,$3,$4::uuid,$5,$6::turma_status,$7::uuid)`,
    id,
    empresa,
    nome,
    empresa === EMPRESA ? QUADRA : QUADRA_B,
    opcoes.capacidade ?? 20,
    opcoes.status ?? 'ativa',
    opcoes.nivel ?? (empresa === EMPRESA ? INICIANTE : NIVEL_B),
  );
  return id;
}

/** Um aluno que já existe, para encher turma (não é o caminho em julgamento). */
async function alunoExistente(): Promise<string> {
  const usuarioId = randomUUID();
  const alunoId = randomUUID();
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ($1::uuid,$2,'h','Existente','aluno',$3::uuid,now())`,
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
  return alunoId;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,now())`,
    turmaId,
    alunoId,
  );

let ocSeq = 0;
async function aulaFutura(turmaId: string, data: string): Promise<string> {
  ocSeq += 1;
  const id = randomUUID();
  const hora = String(6 + (ocSeq % 14)).padStart(2, '0');
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ($1::uuid,$2::uuid,$3::uuid,$4::date,$5::time,$6::time,'TURMA',$7::uuid,'pendente_pagamento',now())`,
    id,
    EMPRESA,
    QUADRA,
    data,
    `${hora}:00`,
    `${hora}:30`,
    turmaId,
  );
  return id;
}

/** Uma reposição já marcada na aula, sem passar pelo serviço (molde da 057). */
async function reposicaoMarcada(
  aulaId: string,
  turmaDeOrigem: string,
): Promise<void> {
  const visitante = await alunoExistente();
  const perdida = await aulaFutura(turmaDeOrigem, emDias(-2));
  const falta = randomUUID();
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ($1::uuid,$2::uuid,$3::uuid,$4::uuid,now())`,
    falta,
    EMPRESA,
    perdida,
    visitante,
  );
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,aluno_id,falta_id,ocupacao_id) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,$4::uuid)`,
    EMPRESA,
    visitante,
    falta,
    aulaId,
  );
}

/** As quatro tabelas da importação, contadas na empresa. */
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

const GESTOR_DO_TOKEN = {
  sub: GESTOR,
  email: 'gestor-s083i@teste.local',
  nome: 'Gestora',
  role: 'company_admin',
  companyId: EMPRESA,
} as unknown as AccessTokenPayload;

function montarServico(ganchos: GanchosDaImportacao = {}) {
  const memoria = new MemoriaProvedorDeEmail();
  const servico = new ImportacaoDeAlunosService(
    p,
    new AcessoService(p, memoria, MODELOS),
    memoria,
    MODELOS,
    ganchos,
  );
  return { servico, memoria, controller: new ImportacaoController(servico) };
}

/** Pela rota (o controller, com a tradução da borda). */
async function pelaRota(
  conteudo: string,
  opcoes: {
    convidar?: string;
    ganchos?: GanchosDaImportacao;
    falharCom?: MotivoDaFalha;
    conferir?: boolean;
  } = {},
): Promise<{ r: Resposta; memoria: MemoriaProvedorDeEmail }> {
  const { controller, memoria } = montarServico(opcoes.ganchos);
  if (opcoes.falharCom) memoria.falharCom(opcoes.falharCom);
  const r = await resposta(
    controller.importar(
      GESTOR_DO_TOKEN,
      opcoes.conferir ? 'true' : undefined,
      { buffer: Buffer.from(conteudo, 'utf8') } as Express.Multer.File,
      opcoes.convidar,
    ),
  );
  return { r, memoria };
}

const corpoDe = <T>(r: Resposta) => r.corpo as T;
const relatorioDo422 = (r: Resposta) =>
  (r.erro as { getResponse(): RelatorioDeImportacaoDto }).getResponse();

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  await montarEmpresas();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, EMPRESA_B);
  await db.$disconnect();
});

// ==========================================================================
// REQ-002 — a turma
// ==========================================================================

describe('SPEC-083/AC-007 — a turma pelo nome, com caixa, acento e espaços diferentes', () => {
  it('casa a turma ativa, e o aluno nasce em `turma_alunos`', async () => {
    const t = await turma('Terça 19h');
    const ana = email('ana');
    const csv = `nome;email;turma\r\nAna;${ana};  TERCA    19H \r\n`;

    const conferida = await pelaRota(csv, { conferir: true });
    expect(corpoDe<RelatorioDeImportacaoDto>(conferida.r).linhas).toEqual([
      expect.objectContaining({ turmaId: t, turmaNome: 'Terça 19h' }),
    ]);

    const { r } = await pelaRota(csv);
    expect(r.status).toBe(200);
    const [criado] = corpoDe<ImportacaoConcluidaDto>(r).criados;
    const matricula = await db.turmaAluno.findMany({
      where: { turmaId: t },
      select: { alunoId: true },
    });
    expect(matricula).toEqual([{ alunoId: criado.alunoId }]);
  });
});

describe('SPEC-083/AC-008 — turma inexistente, inativa ou de outra empresa', () => {
  it.each([
    ['inexistente', () => Promise.resolve('Turma que não existe')],
    [
      'inativa',
      async () => {
        await turma('Quinta 7h', { status: 'inativa' });
        return 'Quinta 7h';
      },
    ],
    [
      'de outra empresa',
      async () => {
        await turma('Sexta 18h', { empresa: EMPRESA_B });
        return 'Sexta 18h';
      },
    ],
  ])(
    '%s: erro na linha, coluna turma, com as ativas; nada escrito',
    async (_caso, preparar) => {
      await turma('Ativa A');
      await turma('Ativa B');
      const citada = await preparar();
      const antes = await contarTudo();

      const { r } = await pelaRota(
        `nome;email;turma\r\nAna;${email('ana')};${citada}\r\n`,
      );

      expect(r.status).toBe(422);
      expect(r.code).toBe('PLANILHA_COM_ERROS');
      expect(relatorioDo422(r).erros).toEqual([
        {
          linha: 2,
          coluna: 'turma',
          mensagem: `A turma "${citada}" não existe entre as turmas ativas. As ativas são: Ativa A, Ativa B.`,
        },
      ]);
      expect(await contarTudo()).toEqual(antes);
    },
  );

  it('lista no máximo 10 ativas, e diz quantas sobraram', async () => {
    for (let i = 1; i <= 12; i++) {
      await turma(`Turma ${String(i).padStart(2, '0')}`);
    }
    const { r } = await pelaRota(
      `nome;email;turma\r\nAna;${email('ana')};Nenhuma\r\n`,
      { conferir: true },
    );
    const [erro] = corpoDe<RelatorioDeImportacaoDto>(r).erros;
    expect(erro.mensagem).toBe(
      'A turma "Nenhuma" não existe entre as turmas ativas. As ativas são: Turma 01, Turma 02, Turma 03, Turma 04, Turma 05, Turma 06, Turma 07, Turma 08, Turma 09, Turma 10 e mais 2.',
    );
  });
});

describe('SPEC-083/AC-009 — duas ativas com o mesmo nome normalizado', () => {
  it('erro na linha dizendo quantas, e nada escrito', async () => {
    await turma('Sábado 8h');
    await turma('sabado  8H');
    const antes = await contarTudo();

    const { r } = await pelaRota(
      `nome;email;turma\r\nAna;${email('ana')};Sábado 8h\r\n`,
    );

    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem:
          'Há 2 turmas ativas chamadas "Sábado 8h". Renomeie uma delas no Admin para a planilha dizer qual é.',
      },
    ]);
    expect(await contarTudo()).toEqual(antes);
  });
});

describe('SPEC-083/AC-010 — o nível da linha contra o da turma', () => {
  it('linha de nível X em turma de nível Y, e linha SEM nível em turma que não é do primeiro: o texto do gestor da SPEC-075, e nada escrito', async () => {
    await turma('Iniciantes', { nivel: INICIANTE });
    await turma('Intermediários', { nivel: INTERMEDIARIO });
    const antes = await contarTudo();

    const { r } = await pelaRota(
      [
        'nome;email;nivel;turma',
        `Ana;${email('ana')};Intermediário;Iniciantes`,
        `Beto;${email('beto')};;Intermediários`,
        // O controle: sem nível, na turma do primeiro nível, entra.
        `Cris;${email('cris')};;Iniciantes`,
      ].join('\r\n'),
    );

    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem: mensagemDeNivelIncompativel('gestor', 'Iniciante', {
          id: INTERMEDIARIO,
          nome: 'Intermediário',
          doPrimeiro: false,
        }),
      },
      {
        linha: 3,
        coluna: 'turma',
        mensagem: mensagemDeNivelIncompativel('gestor', 'Intermediário', {
          id: INICIANTE,
          nome: 'Iniciante',
          doPrimeiro: true,
        }),
      },
    ]);
    // O texto é o do GESTOR, que diz o que fazer — e não o do aluno.
    expect(relatorioDo422(r).erros[1].mensagem).toBe(
      'Esta turma é do nível Intermediário, e este aluno ainda não tem nível — ele conta como Iniciante. Para alocá-lo, defina o nível dele.',
    );
    expect(relatorioDo422(r).linhas.map((l) => l.linha)).toEqual([4]);
    expect(await contarTudo()).toEqual(antes);
  });
});

describe('SPEC-083/AC-011 — a capacidade, pela ordem do arquivo', () => {
  async function turmaComTresVagas(): Promise<string> {
    const t = await turma('Cinco lugares', { capacidade: 5 });
    await matricular(t, await alunoExistente());
    await matricular(t, await alunoExistente());
    return t;
  }

  const arquivo = (n: number) =>
    [
      'nome;email;turma',
      ...Array.from(
        { length: n },
        (_, i) => `Aluno ${i + 1};${email('cap')};Cinco lugares`,
      ),
    ].join('\r\n');

  it('C vagas e C+1 linhas: o erro cai na linha C+1, e nada é escrito', async () => {
    await turmaComTresVagas();
    const antes = await contarTudo();

    const { r } = await pelaRota(arquivo(4));

    expect(r.status).toBe(422);
    // Linhas 2, 3, 4 cabem; a 5 (a quarta de dados) é a primeira que passa.
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 5,
        coluna: 'turma',
        mensagem:
          'A turma "Cinco lugares" tem 3 vaga(s) livre(s), e a planilha põe 4 aluno(s) nela. Esta é a primeira linha que não cabe.',
      },
    ]);
    expect(await contarTudo()).toEqual(antes);
  });

  it('com C linhas, as C entram', async () => {
    const t = await turmaComTresVagas();
    const { r } = await pelaRota(arquivo(3));
    expect(r.status).toBe(200);
    expect(await db.turmaAluno.count({ where: { turmaId: t } })).toBe(5);
  });
});

describe('SPEC-083/AC-012 — a aula lotada, contando as reposições, para k alunos de uma vez', () => {
  it('as reposições somadas aos k do arquivo passam da capacidade numa aula futura: erro, e nada escrito; sem a reposição, entram', async () => {
    // Capacidade 3, um alocado: a matrícula aceita 2 (1 + 2 = 3). Mas a aula
    // do dia tem uma reposição marcada, e com os dois do arquivo ficaria com
    // 4 corpos — a primeira linha cabe (3), a segunda não.
    const t = await turma('Com reposição', { capacidade: 3 });
    const origem = await turma('Origem', { capacidade: 50 });
    await matricular(t, await alunoExistente());
    const aula = await aulaFutura(t, emDias(5));
    await reposicaoMarcada(aula, origem);
    const antes = await contarTudo();

    const csv = [
      'nome;email;turma',
      `Ana;${email('rep')};Com reposição`,
      `Beto;${email('rep')};Com reposição`,
    ].join('\r\n');
    const { r } = await pelaRota(csv);

    expect(r.status).toBe(422);
    const [erro] = relatorioDo422(r).erros;
    expect(erro).toMatchObject({ linha: 3, coluna: 'turma' });
    expect(erro.mensagem).toContain('ficaria acima da capacidade');
    expect(await contarTudo()).toEqual(antes);

    // O controle: é a reposição que lota. Sem ela, o mesmo arquivo entra.
    await q(
      `DELETE FROM reposicoes_de_aula WHERE ocupacao_id = $1::uuid`,
      aula,
    );
    const semReposicao = await pelaRota(csv);
    expect(semReposicao.r.status).toBe(200);
    expect(await db.turmaAluno.count({ where: { turmaId: t } })).toBe(3);
  });
});

/**
 * SPEC-083/D3 e INV-083g — **a conferência é aviso; a garantia é a segunda
 * passada.** O gancho `aoTravar` roda na sessão da importação logo depois da
 * trava do clube, e ANTES do `FOR UPDATE` das turmas e da escrita de
 * usuários: o que outra conexão confirmar ali, a importação tem de ver.
 *
 * Não é o AC-013 (o FIT-057, com barreira e `pg_blocking_pids`, é da
 * TASK-009b): é a mesma regra, sem corrida de tempo.
 */
describe('SPEC-083/D3 — a conferência refeita sob a trava (determinístico, sem FIT)', () => {
  it('outra conexão ocupa a última vaga depois da conferência: 422 com o relatório refeito, e nada escrito nas quatro tabelas', async () => {
    const t = await turma('Última vaga', { capacidade: 2 });
    await matricular(t, await alunoExistente());
    const intrusa = await alunoExistente();
    let ocupou = false;

    const csv = `nome;email;turma\r\nAna;${email('vaga')};Última vaga\r\n`;
    // A conferência de fora passa: há uma vaga.
    expect(
      corpoDe<RelatorioDeImportacaoDto>(
        (await pelaRota(csv, { conferir: true })).r,
      ).erros,
    ).toEqual([]);
    const antes = await contarTudo();

    const { r } = await pelaRota(csv, {
      ganchos: {
        aoTravar: async () => {
          // Por OUTRA conexão (o `db` fora da transação), e confirmada.
          await matricular(t, intrusa);
          ocupou = true;
        },
      },
    });

    expect(ocupou).toBe(true);
    expect(r.status).toBe(422);
    expect(r.code).toBe('PLANILHA_COM_ERROS');
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma',
        mensagem: 'A turma "Última vaga" já está cheia (capacidade 2).',
      },
    ]);
    // A intrusa é a única matrícula nova; nada da importação ficou.
    expect(await contarTudo()).toEqual({
      ...antes,
      matriculas: antes.matriculas + 1,
    });
  });

  it('outra conexão cria conta com um e-mail do arquivo: o 23505 da etapa de usuários vira 422 com o erro de e-mail', async () => {
    const roubado = email('corrida');
    let criou = false;
    const csv = `nome;email\r\nAna;${email('ok')}\r\nBeto;${roubado}\r\n`;
    const antes = await contarTudo();

    const { r } = await pelaRota(csv, {
      ganchos: {
        aoTravar: async () => {
          await q(
            `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES (gen_random_uuid(),$1,'h','Concorrente','aluno',$2::uuid,now())`,
            roubado,
            EMPRESA,
          );
          criou = true;
        },
      },
    });

    expect(criou).toBe(true);
    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 3,
        coluna: 'email',
        mensagem: 'Já existe uma conta com este e-mail.',
      },
    ]);
    // Só a conta concorrente existe a mais; a do Ana (linha boa) não ficou.
    expect(await contarTudo()).toEqual({
      ...antes,
      usuarios: antes.usuarios + 1,
    });
  });
});

// ==========================================================================
// REQ-003 — o tempo
// ==========================================================================

describe('SPEC-083/AC-014 — 300 linhas (150 convidadas), bcrypt de verdade, numa chamada', () => {
  it('importa sem P2028; a duração e o tempo das quatro escritas vão para o log (LIM-083m)', async () => {
    await turma('Lote', { capacidade: 100 });
    const linhas = ['nome;email;turma'];
    for (let i = 1; i <= 300; i++) {
      linhas.push(`Aluno ${i};${email('lote')};${i <= 100 ? 'Lote' : ''}`);
    }
    // Linhas pares da planilha (4, 6, …, 300 — e a 2): 150 convidadas.
    const convidar = Array.from({ length: 150 }, (_, i) => 2 + i * 2).join(',');
    const escritas: { etapa: EtapaDeEscrita; ms: number }[] = [];

    const inicio = Date.now();
    const { r, memoria } = await pelaRota(linhas.join('\r\n'), {
      convidar,
      ganchos: { aoMedirEscrita: (etapa, ms) => escritas.push({ etapa, ms }) },
    });
    const duracao = Date.now() - inicio;

    expect(r.erro).toBeUndefined();
    expect(r.status).toBe(200);
    const { criados } = corpoDe<ImportacaoConcluidaDto>(r);
    expect(criados).toHaveLength(300);
    expect(criados.filter((c) => c.convite?.email === 'enviado')).toHaveLength(
      150,
    );
    expect(criados.filter((c) => c.senhaTemporaria)).toHaveLength(150);
    expect(await contarTudo()).toEqual({
      usuarios: 300,
      alunos: 300,
      matriculas: 100,
      convites: 150,
    });
    expect(escritas.map((e) => e.etapa)).toEqual([
      'usuarios',
      'alunos',
      'turma_alunos',
      'convites_de_acesso',
    ]);
    // AC-032, de quebra: 150 convidados, duas chamadas ao provedor.
    expect(memoria.blocos.map((b) => b.length)).toEqual([100, 50]);

    // Não é asserção: é o registro que o CLI_AUDIT.md transcreve (AC-014).
    console.log(
      `AC-014 medida: ${JSON.stringify({
        linhas: 300,
        convidadas: 150,
        duracaoTotalMs: duracao,
        escritasMs: Object.fromEntries(
          escritas.map((e) => [e.etapa, Math.round(e.ms * 10) / 10]),
        ),
      })}`,
    );
  });
});

// ==========================================================================
// REQ-004 — quem recebe
// ==========================================================================

describe('SPEC-083/AC-017 — `convidar` escolhe as linhas', () => {
  const dez = () =>
    [
      'nome;email',
      ...Array.from(
        { length: 10 },
        (_, i) => `Pessoa ${i + 2};${email('dez')}`,
      ),
    ].join('\r\n');

  it('com convidar=3,5, só as linhas 3 e 5 ganham convite; as outras, senha como hoje', async () => {
    const { r } = await pelaRota(dez(), { convidar: '3,5' });
    expect(r.status).toBe(200);
    const { criados } = corpoDe<ImportacaoConcluidaDto>(r);

    const comConvite = criados.filter((c) => c.convite).map((c) => c.linha);
    const comSenha = criados
      .filter((c) => c.senhaTemporaria)
      .map((c) => c.linha);
    expect(comConvite).toEqual([3, 5]);
    expect(comSenha).toEqual([2, 4, 6, 7, 8, 9, 10, 11]);

    // No banco: os dois convites são exatamente das contas das linhas 3 e 5.
    const convites = await db.conviteDeAcesso.findMany({
      where: { companyId: EMPRESA },
      select: { usuario: { select: { email: true } } },
    });
    expect(convites.map((c) => c.usuario.email).sort()).toEqual(
      criados
        .filter((c) => c.convite)
        .map((c) => c.email)
        .sort(),
    );
  });

  it.each([['99'], ['3,99'], ['abc'], ['3;5'], ['1']])(
    'convidar=%s responde 400 CONVIDAR_LINHA_INVALIDA, e nada é escrito',
    async (convidar) => {
      const antes = await contarTudo();
      const { r } = await pelaRota(dez(), { convidar });
      expect(r.status).toBe(400);
      expect(r.code).toBe('CONVIDAR_LINHA_INVALIDA');
      expect(await contarTudo()).toEqual(antes);
    },
  );
});

describe('SPEC-083/AC-018 — a linha convidada nasce sem senha conhecida; a não convidada, idêntica à de hoje', () => {
  it('senha_temporaria, convite vivo com a impressão do hash gravado, um hash só por arquivo, e nenhuma senha conhecida confere', async () => {
    const convidadaA = email('conv');
    const convidadaB = email('conv');
    const comSenha = email('senha');
    const { r } = await pelaRota(
      `nome;email\r\nAna;${convidadaA}\r\nBia;${convidadaB}\r\nCris;${comSenha}\r\n`,
      { convidar: '2,3' },
    );
    expect(r.status).toBe(200);
    const { criados } = corpoDe<ImportacaoConcluidaDto>(r);
    expect(criados[0]).not.toHaveProperty('senhaTemporaria');
    expect(criados[1]).not.toHaveProperty('senhaTemporaria');
    const senhaDaCris = criados[2].senhaTemporaria as string;

    const usuarios = await db.usuario.findMany({
      where: { email: { in: [convidadaA, convidadaB, comSenha] } },
      select: {
        id: true,
        email: true,
        senhaHash: true,
        senhaTemporaria: true,
        senhaTemporariaExpiraEm: true,
      },
    });
    const por = (e: string) => usuarios.find((u) => u.email === e)!;
    const [a, b, cris] = [por(convidadaA), por(convidadaB), por(comSenha)];

    for (const u of [a, b, cris]) {
      expect(u.senhaTemporaria).toBe(true);
      expect(u.senhaTemporariaExpiraEm).toBeInstanceOf(Date);
    }
    // D4 — um segredo por importação: as duas convidadas têm o MESMO hash, e
    // ele não é o da linha com senha.
    expect(a.senhaHash).toBe(b.senhaHash);
    expect(a.senhaHash).not.toBe(cris.senhaHash);

    // Um convite vivo por convidada, com a impressão do hash gravado.
    for (const u of [a, b]) {
      const vivos = await db.conviteDeAcesso.findMany({
        where: { usuarioId: u.id, usadoEm: null, revogadoEm: null },
      });
      expect(vivos).toHaveLength(1);
      expect(vivos[0].impressaoCredencial).toBe(sha256(u.senhaHash));
      expect(vivos[0].criadoPorId).toBe(GESTOR);
      expect(vivos[0].expiraEm.getTime()).toBeGreaterThan(Date.now());
    }
    expect(
      await db.conviteDeAcesso.count({ where: { usuarioId: cris.id } }),
    ).toBe(0);

    // Nenhuma senha que alguém conheça entra na conta convidada: nem a `pck-`
    // que o mesmo arquivo gerou, nem as óbvias.
    for (const tentativa of [
      senhaDaCris,
      '',
      convidadaA,
      'pck-ACDEFG',
      'Ana',
    ]) {
      expect(await bcrypt.compare(tentativa, a.senhaHash)).toBe(false);
    }
    // A não convidada é a de hoje: a senha da resposta confere.
    expect(await bcrypt.compare(senhaDaCris, cris.senhaHash)).toBe(true);
  });
});

describe('SPEC-083/AC-019 — por linha convidada, `enviado` ou `falhou` com motivo', () => {
  it('provedor aceitando: `enviado`, gravado no convite, e o e-mail leva o link do token gravado', async () => {
    const ana = email('env');
    const { r, memoria } = await pelaRota(
      `nome;email\r\nAna Souza;${ana}\r\n`,
      {
        convidar: '2',
      },
    );
    expect(corpoDe<ImportacaoConcluidaDto>(r).criados[0].convite).toEqual({
      email: 'enviado',
    });
    const convite = await db.conviteDeAcesso.findFirstOrThrow({
      where: { usuario: { email: ana } },
    });
    expect(convite.emailResultado).toBe('enviado');
    expect(convite.emailMotivo).toBeNull();

    expect(memoria.enviados).toHaveLength(1);
    const [mensagem] = memoria.enviados;
    expect(mensagem.to).toBe(ana);
    expect(mensagem.subject).toBe(
      'Clube SPEC-083 Importacao convidou você para o PlayCK',
    );
    const token = new RegExp(
      `${MODELOS.urlCliente}/ativar/([A-Za-z0-9_-]{43})`,
    ).exec(mensagem.text)?.[1];
    expect(token).toBeDefined();
    expect(sha256(token as string)).toBe(convite.tokenHash);
  });

  it.each<MotivoDaFalha>([
    'cota',
    'indisponivel',
    'tempo_esgotado',
    'configuracao',
  ])(
    'provedor falhando com %s: a importação responde o sucesso, a conta existe, e o convite guarda `falhou` e o motivo',
    async (motivo) => {
      const ana = email('falha');
      const { r } = await pelaRota(`nome;email\r\nAna;${ana}\r\n`, {
        convidar: '2',
        falharCom: motivo,
      });
      expect(r.status).toBe(200);
      expect(corpoDe<ImportacaoConcluidaDto>(r).criados[0].convite).toEqual({
        email: 'falhou',
        motivo,
      });
      const convite = await db.conviteDeAcesso.findFirstOrThrow({
        where: { usuario: { email: ana } },
      });
      expect(convite.emailResultado).toBe('falhou');
      expect(convite.emailMotivo).toBe(motivo);
      expect(convite.emailEm).toBeInstanceOf(Date);
    },
  );
});

// ==========================================================================
// AC-051 — o COMMIT protegido, contra o banco
// ==========================================================================

/**
 * A metade de banco do AC-051: **uma importação que começa a escrever com
 * pouco prazo nunca termina com o `COMMIT` cancelado** — ou conclui, ou
 * desiste inteira com 409 e o texto I6, e a etapa que falhou fica registrada
 * (ajuste, escrita ou reposição). O gancho encurta o `playck.prazo` NA SESSÃO
 * da importação, depois da instrução inicial.
 *
 * Não mede tempo, e por isso não é dos testes de prazo da TASK-009b: o
 * desfecho depende da máquina, e o caso afirma o que vale nos dois.
 */
describe('SPEC-083/AC-051 — pouco prazo para escrever: conclui ou desiste inteira, nunca um COMMIT cancelado', () => {
  it.each([50, 10, 1])('com %i ms de prazo restante', async (restanteMs) => {
    await turma('Prazo curto', { capacidade: 50 });
    const linhas = ['nome;email;turma'];
    for (let i = 1; i <= 40; i++) {
      linhas.push(`Aluno ${i};${email('prazo')};Prazo curto`);
    }
    const antes = await contarTudo();
    let falhaRegistrada: unknown = null;

    const { r } = await pelaRota(linhas.join('\r\n'), {
      convidar: '2,3,4,5',
      ganchos: {
        aoTravar: async ({ tx }) => {
          await tx.$queryRawUnsafe(
            `SELECT set_config('playck.prazo', (clock_timestamp() + interval '${restanteMs} milliseconds')::text, true)`,
          );
        },
        depoisDoRollback: (erro) => {
          falhaRegistrada = erro;
        },
      },
    });

    if (r.status === 200) {
      expect(await contarTudo()).toEqual({
        usuarios: antes.usuarios + 40,
        alunos: antes.alunos + 40,
        matriculas: antes.matriculas + 40,
        convites: antes.convites + 4,
      });
      return;
    }
    // Desistiu: 409 com o texto I6, numa etapa que tem prazo de instrução
    // — e não um erro sem etapa, que é o que um COMMIT cancelado seria.
    expect({ status: r.status, code: r.code, message: r.message }).toEqual({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    const etapa = etapaDaImportacao(falhaRegistrada);
    expect([
      'ajuste',
      'usuarios',
      'alunos',
      'turma_alunos',
      'convites_de_acesso',
      'reposicao',
    ]).toContain(etapa);
    console.log(`AC-051 (${restanteMs} ms): desistiu na etapa ${etapa}`);
    expect(await contarTudo()).toEqual(antes);
  });
});
