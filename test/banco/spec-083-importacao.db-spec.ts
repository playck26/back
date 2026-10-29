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
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';
import { limparEmpresa } from './limpar-empresa';
import { resposta, type Resposta, I6 } from './spec-082-fixture';
import { AcessoService } from '../../src/acesso/acesso.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { SENHA_TEMPORARIA_VALIDADE_MS } from '../../src/common/utils/senha-temporaria';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import {
  filtroDasAulasFuturas,
  sqlDasAulasFuturas,
} from '../../src/classes/ocupacao-da-ocorrencia';
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
import {
  mensagemDeNivelIncompativel,
  primeiroNivel,
  sqlDoPrimeiroNivel,
} from '../../src/people/nivel-efetivo';
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
  urlAdmin: 'https://admin.spec083i.teste.local',
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

function montarServico(
  ganchos: GanchosDaImportacao = {},
  cliente: PrismaService = p,
) {
  const memoria = new MemoriaProvedorDeEmail();
  const servico = new ImportacaoDeAlunosService(
    cliente,
    new AcessoService(cliente, memoria, MODELOS),
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
    /** DEF-040 — outro cliente (o que registra as instruções). */
    cliente?: PrismaService;
  } = {},
): Promise<{ r: Resposta; memoria: MemoriaProvedorDeEmail }> {
  const { controller, memoria } = montarServico(opcoes.ganchos, opcoes.cliente);
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
    const csv = `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${ana};  TERCA    19H ;;Iniciante;;\r\n`;

    const conferida = await pelaRota(csv, { conferir: true });
    expect(corpoDe<RelatorioDeImportacaoDto>(conferida.r).linhas).toEqual([
      expect.objectContaining({
        turmas: [{ id: t, nome: 'Terça 19h', coluna: 'turma 1' }],
      }),
    ]);

    const antes = Date.now();
    const { r } = await pelaRota(csv);
    const depois = Date.now();
    expect(r.status).toBe(200);
    const [criado] = corpoDe<ImportacaoConcluidaDto>(r).criados;
    const matricula = await db.turmaAluno.findMany({
      where: { turmaId: t },
      select: { alunoId: true, createdAt: true },
    });
    expect(matricula.map((m) => m.alunoId)).toEqual([criado.alunoId]);
    // TIMESTAMP sem fuso: o instante em UTC, como a API de modelo grava — e
    // não deslocado pelo fuso da sessão (ver o AC-018). Folga de relógio só.
    expect(matricula[0].createdAt.getTime()).toBeGreaterThanOrEqual(
      antes - 5_000,
    );
    expect(matricula[0].createdAt.getTime()).toBeLessThanOrEqual(
      depois + 5_000,
    );
  });

  it('SPEC-091/D3 — um aluno em DUAS turmas (`turma 1` e `turma 3`): duas linhas em `turma_alunos`, as duas do mesmo aluno', async () => {
    const terca = await turma('Terça 19h');
    const quinta = await turma('Quinta 19h');
    const outra = await turma('Sábado 9h');
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('duas')};;Iniciante;Terça 19h;;quinta 19H\r\n`;

    const { r } = await pelaRota(csv);
    expect(r.status).toBe(200);
    const [criado] = corpoDe<ImportacaoConcluidaDto>(r).criados;
    const matriculas = await db.turmaAluno.findMany({
      where: { alunoId: criado.alunoId },
      select: { turmaId: true },
    });
    expect(matriculas.map((m) => m.turmaId).sort()).toEqual(
      [terca, quinta].sort(),
    );
    // A terceira turma ativa não recebe ninguém: o aluno não foi em todas.
    expect(await db.turmaAluno.count({ where: { turmaId: outra } })).toBe(0);
  });

  it('SPEC-091/AC-004 — um aluno nas TRÊS colunas: três linhas em `turma_alunos`, todas dele', async () => {
    const terca = await turma('Terça 19h');
    const quinta = await turma('Quinta 19h');
    const sabado = await turma('Sábado 9h');
    const outra = await turma('Domingo 8h');
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('tres')};;Iniciante;Terça 19h;Quinta 19h;Sábado 9h\r\n`;

    const { r } = await pelaRota(csv);
    expect(r.status).toBe(200);
    const [criado] = corpoDe<ImportacaoConcluidaDto>(r).criados;
    const matriculas = await db.turmaAluno.findMany({
      where: { alunoId: criado.alunoId },
      select: { turmaId: true },
    });
    expect(matriculas.map((m) => m.turmaId).sort()).toEqual(
      [terca, quinta, sabado].sort(),
    );
    expect(await db.turmaAluno.count({ where: { turmaId: outra } })).toBe(0);
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
        `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${email('ana')};${citada};;Iniciante;;\r\n`,
      );

      expect(r.status).toBe(422);
      expect(r.code).toBe('PLANILHA_COM_ERROS');
      expect(relatorioDo422(r).erros).toEqual([
        {
          linha: 2,
          coluna: 'turma 1',
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
      `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${email('ana')};Nenhuma;;Iniciante;;\r\n`,
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
      `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${email('ana')};Sábado 8h;;Iniciante;;\r\n`,
    );

    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma 1',
        mensagem:
          'Há 2 turmas ativas chamadas "Sábado 8h". Renomeie uma delas no Admin para a planilha dizer qual é.',
      },
    ]);
    expect(await contarTudo()).toEqual(antes);
  });
});

describe('SPEC-083/AC-010 — o nível da linha contra o da turma', () => {
  // SPEC-091/D2 — a linha SEM nível ("ele conta como Iniciante") deixou de
  // existir pela importação: o nível é obrigatório. A linha 3 passou a dizer o
  // nível do primeiro (Iniciante) com todas as letras, e a 5 prova a recusa
  // do vazio.
  it('linha de nível X em turma de nível Y (nos dois sentidos), e linha sem nível: o texto do gestor da SPEC-075, e nada escrito', async () => {
    await turma('Iniciantes', { nivel: INICIANTE });
    await turma('Intermediários', { nivel: INTERMEDIARIO });
    const antes = await contarTudo();

    const { r } = await pelaRota(
      [
        'nome;email;nivel;turma 1;telefone;turma 2;turma 3',
        `Ana;${email('ana')};Intermediário;Iniciantes;;;`,
        `Beto;${email('beto')};Iniciante;Intermediários;;;`,
        // O controle: Iniciante, na turma do primeiro nível, entra.
        `Cris;${email('cris')};Iniciante;Iniciantes;;;`,
        `Dani;${email('dani')};;Iniciantes;;;`,
      ].join('\r\n'),
    );

    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma 1',
        mensagem: mensagemDeNivelIncompativel('gestor', 'Iniciante', {
          id: INTERMEDIARIO,
          nome: 'Intermediário',
          doPrimeiro: false,
        }),
      },
      {
        linha: 3,
        coluna: 'turma 1',
        mensagem: mensagemDeNivelIncompativel('gestor', 'Intermediário', {
          id: INICIANTE,
          nome: 'Iniciante',
          doPrimeiro: false,
        }),
      },
      { linha: 5, coluna: 'nivel', mensagem: 'O nível é obrigatório.' },
    ]);
    // O texto é o do GESTOR, que diz o que fazer — e não o do aluno.
    expect(relatorioDo422(r).erros[1].mensagem).toBe(
      'Esta turma é do nível Intermediário, e este aluno é Iniciante. Para alocá-lo, mude o nível dele.',
    );
    expect(relatorioDo422(r).linhas.map((l) => l.linha)).toEqual([4]);
    expect(await contarTudo()).toEqual(antes);
  });
});

describe('SPEC-089/AC-007 — clube que não restringe por nível: a importação não recusa por nível', () => {
  it('as mesmas linhas do AC-010, com a chave desligada, entram as três', async () => {
    const ini = await turma('Iniciantes', { nivel: INICIANTE });
    const int = await turma('Intermediários', { nivel: INTERMEDIARIO });
    await q(
      `UPDATE empresas SET nivel_restringe_acesso = false WHERE id = '${EMPRESA}'`,
    );

    const { r } = await pelaRota(
      [
        'nome;email;nivel;turma 1;telefone;turma 2;turma 3',
        `Ana;${email('ana')};Intermediário;Iniciantes;;;`,
        `Beto;${email('beto')};Iniciante;Intermediários;;;`,
        `Cris;${email('cris')};Iniciante;Iniciantes;;;`,
      ].join('\r\n'),
    );

    expect(r.status).toBe(200);
    expect(corpoDe<ImportacaoConcluidaDto>(r).criados).toHaveLength(3);
    expect(await db.turmaAluno.count({ where: { turmaId: ini } })).toBe(2);
    expect(await db.turmaAluno.count({ where: { turmaId: int } })).toBe(1);
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
      'nome;email;turma 1;telefone;nivel;turma 2;turma 3',
      ...Array.from(
        { length: n },
        (_, i) => `Aluno ${i + 1};${email('cap')};Cinco lugares;;Iniciante;;`,
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
        coluna: 'turma 1',
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
      'nome;email;turma 1;telefone;nivel;turma 2;turma 3',
      `Ana;${email('rep')};Com reposição;;Iniciante;;`,
      `Beto;${email('rep')};Com reposição;;Iniciante;;`,
    ].join('\r\n');
    const { r } = await pelaRota(csv);

    expect(r.status).toBe(422);
    const [erro] = relatorioDo422(r).erros;
    expect(erro).toMatchObject({ linha: 3, coluna: 'turma 1' });
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

    // Na `turma 3`, e não na primeira: o erro refeito sob a trava tem de
    // apontar a coluna de onde a turma veio (SPEC-091/D4).
    const csv = `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${email('vaga')};;;Iniciante;;Última vaga\r\n`;
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
        coluna: 'turma 3',
        mensagem: 'A turma "Última vaga" já está cheia (capacidade 2).',
      },
    ]);
    // A intrusa é a única matrícula nova; nada da importação ficou.
    expect(await contarTudo()).toEqual({
      ...antes,
      matriculas: antes.matriculas + 1,
    });
  });

  it('lacuna b (2026-10-28): o erro achado SÓ sob a trava leva a coluna de origem — a conferência refeita depois volta limpa', async () => {
    // O caso acima não isola a origem: depois do rollback a intrusa continua
    // lá, a conferência refeita acha o mesmo erro e a resposta sai dela. Aqui
    // a intrusa sai antes da reconferência (`depoisDoRollback`), e a resposta
    // só pode vir do erro produzido dentro da transação.
    const t = await turma('Vaga que volta', { capacidade: 2 });
    await matricular(t, await alunoExistente());
    const intrusa = await alunoExistente();
    let ocupou = false;
    let liberou = false;

    const csv = `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${email('volta')};;;Iniciante;;Vaga que volta\r\n`;
    const antes = await contarTudo();

    const { r } = await pelaRota(csv, {
      ganchos: {
        aoTravar: async () => {
          await matricular(t, intrusa);
          ocupou = true;
        },
        depoisDoRollback: async () => {
          await q(
            `DELETE FROM turma_alunos WHERE turma_id = $1::uuid AND aluno_id = $2::uuid`,
            t,
            intrusa,
          );
          liberou = true;
        },
      },
    });

    expect([ocupou, liberou]).toEqual([true, true]);
    expect(r.status).toBe(422);
    expect(r.code).toBe('PLANILHA_COM_ERROS');
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma 3',
        mensagem: 'A turma "Vaga que volta" já está cheia (capacidade 2).',
      },
    ]);
    // A prova de que a reconferência voltou limpa: o mesmo arquivo, agora,
    // não tem erro.
    expect(
      corpoDe<RelatorioDeImportacaoDto>(
        (await pelaRota(csv, { conferir: true })).r,
      ).erros,
    ).toEqual([]);
    expect(await contarTudo()).toEqual(antes);
  });

  it('lacuna b, turma no MEIO da linha: cheia só sob a trava na `turma 2`, entre duas com vaga — o 422 aponta `turma 2`', async () => {
    // Revisão de 2026-10-28 sobre o d182fa0: no caso acima a turma com erro é
    // a única da linha, e trocar a coluna pela da primeira (ou da última)
    // turma da linha passava. Aqui só a coluna da própria turma acerta.
    const antesDela = await turma('Antes do meio', { capacidade: 2 });
    const t = await turma('Meio que volta', { capacidade: 2 });
    const depoisDela = await turma('Depois do meio', { capacidade: 2 });
    await matricular(t, await alunoExistente());
    const intrusa = await alunoExistente();
    let ocupou = false;
    let liberou = false;

    const csv = `nome;email;turma 1;telefone;nivel;turma 2;turma 3\r\nAna;${email('meio')};Antes do meio;;Iniciante;Meio que volta;Depois do meio\r\n`;
    const antes = await contarTudo();

    const { r } = await pelaRota(csv, {
      ganchos: {
        aoTravar: async () => {
          await matricular(t, intrusa);
          ocupou = true;
        },
        depoisDoRollback: async () => {
          await q(
            `DELETE FROM turma_alunos WHERE turma_id = $1::uuid AND aluno_id = $2::uuid`,
            t,
            intrusa,
          );
          liberou = true;
        },
      },
    });

    expect([ocupou, liberou]).toEqual([true, true]);
    expect(r.status).toBe(422);
    expect(r.code).toBe('PLANILHA_COM_ERROS');
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma 2',
        mensagem: 'A turma "Meio que volta" já está cheia (capacidade 2).',
      },
    ]);
    expect(
      corpoDe<RelatorioDeImportacaoDto>(
        (await pelaRota(csv, { conferir: true })).r,
      ).erros,
    ).toEqual([]);
    expect(await contarTudo()).toEqual(antes);
    expect(
      await db.turmaAluno.count({
        where: { turmaId: { in: [antesDela, depoisDela] } },
      }),
    ).toBe(0);
  });

  it('SPEC-091/A2 sob a trava: a linha que não cabe numa turma não toma a vaga da outra, e a seguinte não recebe erro falso', async () => {
    // Fora da trava tudo cabe (Primeira: 1 vaga para Ana; Segunda: 2 vagas
    // para Ana e Beto). Sob a trava, outra conexão ocupa uma vaga em cada:
    // Ana não cabe na Primeira; Beto cabe na única vaga da Segunda, porque
    // Ana deixou de disputá-la. Antes do conserto, Beto recebia "não cabe".
    const primeira = await turma('Primeira sob trava', { capacidade: 2 });
    const segunda = await turma('Segunda sob trava', { capacidade: 2 });
    await matricular(primeira, await alunoExistente());
    const intrusas = [await alunoExistente(), await alunoExistente()];

    const csv = [
      'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
      `Ana;${email('a2t')};;Iniciante;Primeira sob trava;Segunda sob trava;`,
      `Beto;${email('a2t')};;Iniciante;;;Segunda sob trava`,
    ].join('\r\n');
    expect(
      corpoDe<RelatorioDeImportacaoDto>(
        (await pelaRota(csv, { conferir: true })).r,
      ).erros,
    ).toEqual([]);

    const antes = await contarTudo();
    const { r } = await pelaRota(csv, {
      ganchos: {
        aoTravar: async () => {
          await matricular(primeira, intrusas[0]);
          await matricular(segunda, intrusas[1]);
        },
        // Fora, de novo, tudo cabe: a resposta vem do que a trava achou.
        depoisDoRollback: async () => {
          await q(
            `DELETE FROM turma_alunos WHERE aluno_id = ANY($1::uuid[])`,
            intrusas,
          );
        },
      },
    });
    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros).toEqual([
      {
        linha: 2,
        coluna: 'turma 1',
        mensagem: 'A turma "Primeira sob trava" já está cheia (capacidade 2).',
      },
    ]);
    expect(await contarTudo()).toEqual(antes);
  });

  it('outra conexão cria conta com um e-mail do arquivo: o 23505 da etapa de usuários vira 422 com o erro de e-mail', async () => {
    const roubado = email('corrida');
    let criou = false;
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('ok')};;Iniciante;;;\r\nBeto;${roubado};;Iniciante;;;\r\n`;
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
    const linhas = ['nome;email;turma 1;telefone;nivel;turma 2;turma 3'];
    for (let i = 1; i <= 300; i++) {
      linhas.push(
        `Aluno ${i};${email('lote')};${i <= 100 ? 'Lote' : ''};;Iniciante;;`,
      );
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
      'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
      ...Array.from(
        { length: 10 },
        (_, i) => `Pessoa ${i + 2};${email('dez')};;Iniciante;;;`,
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
    const antes = Date.now();
    const { r } = await pelaRota(
      `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${convidadaA};;Iniciante;;;\r\nBia;${convidadaB};;Iniciante;;;\r\nCris;${comSenha};;Iniciante;;;\r\n`,
      { convidar: '2,3' },
    );
    const depois = Date.now();
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
        createdAt: true,
        updatedAt: true,
      },
    });
    const por = (e: string) => usuarios.find((u) => u.email === e)!;
    const [a, b, cris] = [por(convidadaA), por(convidadaB), por(comSenha)];

    // O VALOR, e não só o tipo: as colunas são TIMESTAMP sem fuso, e o SQL
    // cru que gravasse um `timestamptz` cru seria convertido pelo fuso da
    // sessão — no banco local (`America/Sao_Paulo`), 3 h a menos que o
    // cadastro individual, que grava o instante em UTC pela API de modelo.
    // A folga de 5 s cobre o relógio, nunca um fuso.
    const FOLGA = 5_000;
    const noIntervalo = (d: Date, de: number, ate: number) => {
      expect(d.getTime()).toBeGreaterThanOrEqual(de - FOLGA);
      expect(d.getTime()).toBeLessThanOrEqual(ate + FOLGA);
    };
    for (const u of [a, b, cris]) {
      expect(u.senhaTemporaria).toBe(true);
      expect(u.senhaTemporariaExpiraEm).toBeInstanceOf(Date);
      noIntervalo(
        u.senhaTemporariaExpiraEm!,
        antes + SENHA_TEMPORARIA_VALIDADE_MS,
        depois + SENHA_TEMPORARIA_VALIDADE_MS,
      );
      noIntervalo(u.createdAt, antes, depois);
      noIntervalo(u.updatedAt, antes, depois);
    }
    // O mesmo para `alunos.created_at`, que é a ordem da lista de alunos: o
    // importado não pode cair abaixo de quem foi cadastrado à mão depois.
    const alunos = await db.aluno.findMany({
      where: { usuarioId: { in: [a.id, b.id, cris.id] } },
      select: { createdAt: true },
    });
    expect(alunos).toHaveLength(3);
    for (const al of alunos) noIntervalo(al.createdAt, antes, depois);
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
      `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna Souza;${ana};;Iniciante;;;\r\n`,
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
      const { r } = await pelaRota(
        `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${ana};;Iniciante;;;\r\n`,
        {
          convidar: '2',
          falharCom: motivo,
        },
      );
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
    const linhas = ['nome;email;turma 1;telefone;nivel;turma 2;turma 3'];
    for (let i = 1; i <= 40; i++) {
      linhas.push(`Aluno ${i};${email('prazo')};Prazo curto;;Iniciante;;`);
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

// ==========================================================================
// DEF-040 — as idas ao banco sob a trava do clube
// ==========================================================================

/**
 * DEF-040 — **a importação com turma dava 409 em produção, sem disputa.** A
 * trava do clube fixa `playck.prazo` em 2 s; entre ela e o primeiro `INSERT`
 * a transação fazia 10 instruções. A 167 ms por ida (o Back em Atlanta, o
 * Neon em São Paulo), o `RESTO_DO_PRAZO` chegava à escrita no piso de 1 ms, e
 * o `INSERT` estourava com `57014` — que a borda traduz em 409 (LIM-083m).
 *
 * O conserto não mexe no prazo nem na ordem das travas: junta as leituras.
 * **O que este teste trava é o número de instruções que a sessão da
 * importação manda ao banco** entre a trava do clube e a primeira escrita —
 * a grandeza que a latência multiplica. O tempo é prova local (CLI_AUDIT), e
 * não daqui: medir milissegundos no CI daria um teste que passa por sorte.
 *
 * As instruções são as que o Prisma registra no evento `query` de um cliente
 * próprio — o mesmo serviço, a mesma rota, só um cliente que conta.
 */
describe('DEF-040 — as instruções entre a trava do clube e a primeira escrita', () => {
  /** Três leituras (referenciadas com e-mail, turmas, dados) + o ajuste. */
  const TETO_ATE_A_ESCRITA = 4;
  /** As mesmas três leituras, e nenhuma ida por passo da busca binária. */
  const TETO_ATE_A_RECUSA = 3;

  async function comClienteQueConta<T>(
    corpo: (cliente: PrismaService, idas: string[]) => Promise<T>,
  ): Promise<T> {
    const cliente = new PrismaClient({
      log: [{ emit: 'event', level: 'query' }],
    });
    const idas: string[] = [];
    cliente.$on('query', (e) => idas.push(e.query));
    try {
      return await corpo(cliente as unknown as PrismaService, idas);
    } finally {
      await cliente.$disconnect();
    }
  }

  /** As instruções depois da trava do clube e antes da que casa `fim`. */
  function entre(idas: readonly string[], fim: RegExp): string[] {
    const trava = idas.findIndex((i) =>
      i.includes('pg_advisory_xact_lock_shared'),
    );
    expect(trava).toBeGreaterThanOrEqual(0);
    const ate = idas.findIndex((i, k) => k > trava && fim.test(i));
    expect(ate).toBeGreaterThan(trava);
    // A leitura do gancho `aoTravar` é de teste: em produção não há gancho, e
    // ela não é feita (ver `GanchosDaImportacao`).
    return idas
      .slice(trava + 1, ate)
      .filter((i) => !/pg_backend_pid\(\) AS pid/.test(i));
  }

  const resumo = (i: string) => i.replace(/\s+/g, ' ').trim().slice(0, 90);

  it(`com turma, aula futura, reposição e falta: no máximo ${TETO_ATE_A_ESCRITA} instruções até o INSERT de usuários`, async () => {
    const a = await turma('DEF-040 A', { capacidade: 10 });
    const b = await turma('DEF-040 B', { capacidade: 10 });
    const c = await turma('DEF-040 C', { capacidade: 10 });
    const aulaA = await aulaFutura(a, emDias(3));
    await aulaFutura(b, emDias(4));
    await aulaFutura(c, emDias(5));
    await reposicaoMarcada(aulaA, c);
    const membro = await alunoExistente();
    await matricular(a, membro);
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,now())`,
      EMPRESA,
      aulaA,
      membro,
    );
    // O arquivo do sintoma: uma linha em três turmas, outra em uma.
    const csv = [
      'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
      `Ana;${email('d040')};;Iniciante;DEF-040 A;DEF-040 B;DEF-040 C`,
      `Beto;${email('d040')};;Iniciante;DEF-040 A;;`,
    ].join('\r\n');

    await comClienteQueConta(async (cliente, idas) => {
      const { r } = await pelaRota(csv, { cliente });
      expect(r.status).toBe(200);
      const sob = entre(idas, /INSERT INTO usuarios/);
      console.log(
        `DEF040_IDAS ate_a_escrita=${sob.length}\n${sob.map(resumo).join('\n')}`,
      );
      expect(sob.length).toBeLessThanOrEqual(TETO_ATE_A_ESCRITA);
    });
    expect(await db.turmaAluno.count({ where: { turmaId: a } })).toBe(3);
  });

  it(`aula lotada achada só sob a trava, com busca binária: no máximo ${TETO_ATE_A_RECUSA} instruções até o ROLLBACK`, async () => {
    // Fora da trava cabem as três linhas na aula (capacidade 5, nenhuma
    // reposição). Sob a trava, outra conexão marca três reposições na aula:
    // sobram 2 lugares, e a terceira linha é a primeira que não cabe — a
    // resposta sai da busca binária, que ia ao banco a cada passo.
    const t = await turma('DEF-040 busca', { capacidade: 5 });
    const outra = await turma('DEF-040 origem', { capacidade: 5 });
    const aula = await aulaFutura(t, emDias(3));
    const csv = [
      'nome;email;telefone;nivel;turma 1;turma 2;turma 3',
      `Ana;${email('d040b')};;Iniciante;DEF-040 busca;;`,
      `Beto;${email('d040b')};;Iniciante;DEF-040 busca;;`,
      `Cris;${email('d040b')};;Iniciante;DEF-040 busca;;`,
    ].join('\r\n');
    const antes = await contarTudo();

    await comClienteQueConta(async (cliente, idas) => {
      const { r } = await pelaRota(csv, {
        cliente,
        ganchos: {
          aoTravar: async () => {
            for (let i = 0; i < 3; i++) await reposicaoMarcada(aula, outra);
          },
        },
      });
      expect(r.status).toBe(422);
      expect(relatorioDo422(r).erros.map((e) => [e.linha, e.coluna])).toEqual([
        [4, 'turma 1'],
      ]);
      expect(relatorioDo422(r).erros[0].mensagem).toMatch(
        /^A aula de \d\d\/\d\d da turma "DEF-040 busca" ficaria acima da capacidade/,
      );
      const sob = entre(idas, /^ROLLBACK/);
      console.log(
        `DEF040_IDAS ate_a_recusa=${sob.length}\n${sob.map(resumo).join('\n')}`,
      );
      expect(sob.length).toBeLessThanOrEqual(TETO_ATE_A_RECUSA);
    });
    expect(await contarTudo()).toEqual({
      ...antes,
      // As três reposições do gancho criaram três alunos "existentes".
      usuarios: antes.usuarios + 3,
      alunos: antes.alunos + 3,
    });
  });
});

/**
 * DEF-040 — **a conferência sob a trava lê os mesmos dados de antes**, agora
 * numa instrução só. Cada caso abaixo passa na conferência de fora (que não
 * mudou) e só pode falhar pela de dentro: é o que pega uma leitura única que
 * esqueça um conjunto, conte a aula errada ou misture turmas.
 */
describe('DEF-040 — a conferência sob a trava, dado por dado', () => {
  it('a falta avisada de um matriculado libera o lugar dele na aula (conjunto F)', async () => {
    // Capacidade 3: um matriculado que avisou falta e duas reposições. Sem a
    // falta, a aula teria 3 e o novo seria o 4º; com ela, ocupa 2 e cabe.
    const t = await turma('DEF-040 falta', { capacidade: 3 });
    const origem = await turma('DEF-040 falta origem');
    const aula = await aulaFutura(t, emDias(3));
    const membro = await alunoExistente();
    await matricular(t, membro);
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES (gen_random_uuid(),$1::uuid,$2::uuid,$3::uuid,now())`,
      EMPRESA,
      aula,
      membro,
    );
    await reposicaoMarcada(aula, origem);
    await reposicaoMarcada(aula, origem);
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('falta')};;Iniciante;DEF-040 falta;;\r\n`;

    const { r } = await pelaRota(csv);
    expect(r.status).toBe(200);
    expect(await db.turmaAluno.count({ where: { turmaId: t } })).toBe(2);
  });

  it('a reposição marcada depois da conferência lota a aula sob a trava (conjunto V)', async () => {
    const t = await turma('DEF-040 visita', { capacidade: 2 });
    const origem = await turma('DEF-040 visita origem');
    const aula = await aulaFutura(t, emDias(3));
    await reposicaoMarcada(aula, origem);
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('visita')};;Iniciante;;DEF-040 visita;\r\n`;
    const antes = await contarTudo();

    const { r } = await pelaRota(csv, {
      ganchos: { aoTravar: () => reposicaoMarcada(aula, origem) },
    });
    expect(r.status).toBe(422);
    expect(relatorioDo422(r).erros.map((e) => [e.linha, e.coluna])).toEqual([
      [2, 'turma 2'],
    ]);
    expect(relatorioDo422(r).erros[0].mensagem).toMatch(
      /^A aula de \d\d\/\d\d da turma "DEF-040 visita" ficaria acima da capacidade/,
    );
    expect(await db.turmaAluno.count({ where: { turmaId: t } })).toBe(0);
    // Só o visitante do gancho nasceu; nada da importação ficou.
    expect((await contarTudo()).usuarios).toBe(antes.usuarios + 1);
  });

  it('aula que já passou e aula cancelada não contam, nem cheias de reposição', async () => {
    const t = await turma('DEF-040 passadas', { capacidade: 1 });
    const origem = await turma('DEF-040 passadas origem');
    const passada = await aulaFutura(t, emDias(-1));
    const cancelada = await aulaFutura(t, emDias(6));
    await reposicaoMarcada(passada, origem);
    await reposicaoMarcada(cancelada, origem);
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: cancelada,
      autorId: GESTOR,
    });
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('passadas')};;Iniciante;DEF-040 passadas;;\r\n`;

    const { r } = await pelaRota(csv);
    expect(r.status).toBe(200);
    expect(await db.turmaAluno.count({ where: { turmaId: t } })).toBe(1);
  });

  it('a aula de OUTRA turma não conta para esta, e a matrícula de outra turma não ocupa vaga aqui', async () => {
    const t = await turma('DEF-040 esta', { capacidade: 1 });
    const vizinha = await turma('DEF-040 vizinha', { capacidade: 1 });
    const origem = await turma('DEF-040 esta origem');
    await aulaFutura(t, emDias(3));
    const daVizinha = await aulaFutura(vizinha, emDias(3));
    await reposicaoMarcada(daVizinha, origem);
    await matricular(vizinha, await alunoExistente());
    const csv = `nome;email;telefone;nivel;turma 1;turma 2;turma 3\r\nAna;${email('esta')};;Iniciante;DEF-040 esta;;\r\n`;

    const { r } = await pelaRota(csv);
    expect(r.status).toBe(200);
    expect(await db.turmaAluno.count({ where: { turmaId: t } })).toBe(1);
  });
});

/**
 * DEF-040 — **as formas SQL da leitura única concordam com as do Prisma.** A
 * conferência de fora pergunta pelo Prisma (`filtroDasAulasFuturas`,
 * `primeiroNivel`); a de dentro da transação, pelo SQL ao lado delas
 * (`sqlDasAulasFuturas`, `sqlDoPrimeiroNivel`). Uma divergência faria a
 * importação recusar sob a trava o que o relatório aceitou, ou o contrário —
 * e nos cantos: a aula que termina exatamente agora, a de hoje que já passou,
 * a cancelada, os empates de `ordem` e de `created_at` do primeiro nível.
 */
describe('DEF-040 — as formas SQL concordam com as do Prisma', () => {
  async function aulaEm(
    turmaId: string,
    data: string,
    inicio: string,
    fim: string,
  ): Promise<string> {
    const id = randomUUID();
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
       VALUES ($1::uuid,$2::uuid,$3::uuid,$4::date,$5::time,$6::time,'TURMA',$7::uuid,'pendente_pagamento',now())`,
      id,
      EMPRESA,
      QUADRA,
      data,
      inicio,
      fim,
      turmaId,
    );
    return id;
  }

  it('aulas futuras: as mesmas aulas, na mesma ordem, nos cantos do relógio do clube', async () => {
    const t = await turma('DEF-040 relógio');
    const outra = await turma('DEF-040 relógio outra');
    const dia = emDias(10);
    // Meio-dia no fuso do clube (UTC−3), no dia `dia`.
    const agora = new Date(`${dia}T15:00:00.000Z`);
    const nomes = new Map<string, string>([
      [await aulaEm(t, emDias(9), '18:00', '19:00'), 'véspera'],
      [await aulaEm(t, dia, '08:00', '08:30'), 'hoje, já dada'],
      [await aulaEm(t, dia, '11:00', '12:00'), 'hoje, termina agora'],
      [await aulaEm(t, dia, '12:00', '12:30'), 'hoje, em andamento'],
      [await aulaEm(t, dia, '13:00', '13:30'), 'hoje, depois'],
      [await aulaEm(t, emDias(11), '07:00', '08:00'), 'amanhã cedo'],
      [await aulaEm(t, emDias(12), '07:00', '08:00'), 'cancelada'],
      [await aulaEm(outra, emDias(11), '09:00', '10:00'), 'outra turma'],
      [await aulaEm(t, emDias(13), '07:00', '08:00'), 'depois de amanhã'],
    ]);
    const cancelada = [...nomes].find(([, n]) => n === 'cancelada')?.[0];
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: cancelada as string,
      autorId: GESTOR,
    });

    const peloPrisma = (
      await db.ocupacaoQuadra.findMany({
        where: filtroDasAulasFuturas(EMPRESA, [t], agora),
        orderBy: [{ data: 'asc' }, { horaInicio: 'asc' }, { id: 'asc' }],
        select: { id: true },
      })
    ).map((o) => nomes.get(o.id));
    const peloSql = (
      await db.$queryRaw<{ id: string }[]>`
        SELECT o.id::text AS id FROM ocupacoes_quadra o
         WHERE ${sqlDasAulasFuturas(EMPRESA, [t], agora)}
         ORDER BY o.data, o.hora_inicio, o.id`
    ).map((o) => nomes.get(o.id));

    expect(peloPrisma).toEqual([
      'hoje, em andamento',
      'hoje, depois',
      'amanhã cedo',
      'depois de amanhã',
    ]);
    expect(peloSql).toEqual(peloPrisma);
  });

  it('primeiro nível: o mesmo, com empate de `ordem` e de `created_at`', async () => {
    const sqlEscolhe = async () =>
      (
        await db.$queryRaw<{ p: { id: string; nome: string } | null }[]>`
          SELECT (${sqlDoPrimeiroNivel(EMPRESA)}) AS p`
      )[0].p;
    const mesmoInstante = '2026-01-01 10:00:00';
    // Três níveis de ordem 0, à frente dos da fixture (1 e 2): dois no
    // mesmo instante, e o de id menor criado depois do maior.
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem,created_at) VALUES
         ('${base}f3','${EMPRESA}','Zero tarde',0,'2026-01-02 10:00:00'),
         ('${base}f2','${EMPRESA}','Zero id maior',0,'${mesmoInstante}'),
         ('${base}f1','${EMPRESA}','Zero id menor',0,'${mesmoInstante}')`,
    );
    for (const esperado of [
      'Zero id menor',
      'Zero id maior',
      'Zero tarde',
      'Iniciante',
    ]) {
      const prisma = await primeiroNivel(db, EMPRESA);
      expect(prisma?.nome).toBe(esperado);
      expect(await sqlEscolhe()).toEqual(prisma);
      await q(
        `DELETE FROM niveis WHERE company_id = $1::uuid AND nome = $2`,
        EMPRESA,
        esperado,
      );
    }
  });
});
