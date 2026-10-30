/**
 * SPEC-089/TASK-001 — **o clube escolhe se o nível restringe o acesso**, pelos
 * serviços de verdade, contra o banco de verdade.
 *
 * O mundo: o mesmo da `spec-075-acesso` — Iniciante (1), Intermediário (2) e
 * Avançado (3), uma turma de cada, e a turma de origem das faltas. O aluno de
 * nível é Intermediário; a turma "de outro nível" é a de Avançado.
 *
 * Cada caso com a chave **desligada** tem o seu par com a chave **ligada** já
 * provado na `spec-075-acesso`/`spec-075-edicoes` (AC-001b): aqui só se prova
 * o que muda. As exceções são o AC-009 a AC-009c e o AC-010, que precisam dos
 * dois valores no mesmo caso para distinguir as sabotagens S11, S12 e S15.
 *
 * O AC-007 (importação) mora em `spec-083-importacao.db-spec.ts`, ao lado do
 * caso de nível da importação, que monta o que ela precisa.
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { cheiaAntesDaFila } from '../../src/classes/cheia-antes-da-fila';
import { ClassesService } from '../../src/classes/classes.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import type { AccessTokenPayload } from '../../src/common/types/jwt-payload.type';
import { CompaniesService } from '../../src/companies/companies.service';
import type { LogoDaEmpresaService } from '../../src/companies/logo-da-empresa.service';
import { MeCompanyController } from '../../src/companies/me-company.controller';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CourtsService } from '../../src/courts/courts.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { UpdateStudentDto } from '../../src/people/dto/update-student.dto';
import { LevelsService } from '../../src/people/levels.service';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = '08900000-0000-4000-8000-000000000001';
/** Só para o AC-001 (e o par de clube alheio da SPEC-093): nasce sem informar a coluna. */
const EMPRESA_NOVA = '08900000-0000-4000-8000-000000000002';
const GESTOR = '08900000-0000-4000-8000-000000000003';
const QUADRA = '08900000-0000-4000-8000-000000000011';
const INI = '08900000-0000-4000-8000-000000000021';
const INT = '08900000-0000-4000-8000-000000000022';
const AVA = '08900000-0000-4000-8000-000000000023';
const T_INI = '08900000-0000-4000-8000-000000000031';
const T_INT = '08900000-0000-4000-8000-000000000032';
const T_AVA = '08900000-0000-4000-8000-000000000033';
const T_ORIGEM = '08900000-0000-4000-8000-000000000034';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const operacao = () => new ConfigOperacaoService(p);
const matricula = () => new MatriculaDoAlunoService(p, operacao());
const reposicao = () => new ReposicaoService(p, operacao());
const fila = () =>
  new FilaDeEsperaService(p, operacao(), matricula(), reposicao());
const alunos = () => new StudentsService(p);
const niveis = () => new LevelsService(p);
function classes(): ClassesService {
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    operacao(),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(p, courts, new StudentsService(p), operacao());
}

const desligar = () =>
  q(
    `UPDATE empresas SET nivel_restringe_acesso = false WHERE id = '${EMPRESA}'`,
  );
const ligar = () =>
  q(
    `UPDATE empresas SET nivel_restringe_acesso = true WHERE id = '${EMPRESA}'`,
  );

async function desfecho(
  promessa: Promise<unknown>,
): Promise<{ code: string; message?: string }> {
  try {
    await promessa;
    return { code: 'OK' };
  } catch (erro) {
    if (!(erro instanceof HttpException)) throw erro;
    const corpo = erro.getResponse() as { code?: string; message?: string };
    return { code: corpo.code ?? 'SEM_CODIGO', message: corpo.message };
  }
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
async function aluno(
  nivelId: string | null,
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const usuarioId = `08900000-0000-4000-8000-100000000${s}`;
  const alunoId = `08900000-0000-4000-8000-200000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s089.${seq}@x.com','h','Aluno ${seq}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,nivel_id) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo',${nivelId ? `'${nivelId}'` : 'NULL'})`,
  );
  return { alunoId, usuarioId };
}

/** Matrícula por SQL, sem passar pela regra (a "de antes"). */
const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );
const matriculas = (alunoId: string, turmaId: string) =>
  db.turmaAluno.count({ where: { alunoId, turmaId } });

let ocSeq = 0;
async function ocorrencia(
  turmaId: string,
  data: string,
  hora = '09:00',
): Promise<string> {
  ocSeq += 1;
  const id = `08900000-0000-4000-8000-3000000${String(ocSeq).padStart(5, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

let faltaSeq = 0;
async function credito(alunoId: string): Promise<string> {
  await matricular(T_ORIGEM, alunoId);
  const perdida = await ocorrencia(T_ORIGEM, emDias(-2), '08:00');
  faltaSeq += 1;
  const id = `08900000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${perdida}','${alunoId}',now())`,
  );
  return id;
}

let filaSeq = 0;
async function chamada(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
}): Promise<string> {
  filaSeq += 1;
  const id = `08900000-0000-4000-8000-5000000000${String(filaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}',
             ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
             ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
             ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
             'chamado', now(), now() + interval '6 hours')`,
  );
  return id;
}

const mudarAluno = (id: string, dto: Partial<UpdateStudentDto>) =>
  alunos().update(EMPRESA, id, dto);
const mudarTurma = (id: string, nivelId: string) =>
  classes().update(EMPRESA, id, { nivelId }, GESTOR);

async function montar(): Promise<void> {
  await q(
    // SPEC-093/D4 — a chave LIGADA de propósito: desde a SPEC-093 o clube
    // nasce liberado, e os casos sem `desligar()` contam com a regra ligada.
    `INSERT INTO empresas (id,nome,slug,updated_at,nivel_restringe_acesso) VALUES ('${EMPRESA}','SPEC-089','spec-089-${EMPRESA}',now(),true)`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','s089.gestor@x.com','h','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  for (const [id, nome, ordem] of [
    [INI, 'Iniciante', 1],
    [INT, 'Intermediário', 2],
    [AVA, 'Avançado', 3],
  ] as const) {
    await q(
      `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${id}','${EMPRESA}','${nome}',${ordem})`,
    );
  }
  for (const [id, nivel, nome] of [
    [T_INI, INI, 'Turma Iniciante'],
    [T_INT, INT, 'Turma Intermediário'],
    [T_AVA, AVA, 'Turma Avançado'],
    [T_ORIGEM, INI, 'Turma de origem'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}',4,'ativa','${nivel}')`,
    );
  }
}

beforeEach(async () => {
  for (const emp of [EMPRESA, EMPRESA_NOVA]) await limparEmpresa(db, emp);
  await montar();
});

afterAll(async () => {
  for (const emp of [EMPRESA, EMPRESA_NOVA]) await limparEmpresa(db, emp);
  await db.$disconnect();
});

// ==========================================================================
// REQ-001 — a coluna e o padrão
// ==========================================================================

// SPEC-093/D1 e AC-001 — o padrão mudou para `false`: clube novo nasce
// liberado. Era `true` na SPEC-089/AC-001; os três caminhos de criação são os
// mesmos, e o valor esperado é o novo.
describe('SPEC-093/AC-001 — o padrão é `false`, observado sem gravar a coluna', () => {
  const ler = async (id: string) =>
    (
      await db.$queryRawUnsafe<{ v: boolean }[]>(
        `SELECT nivel_restringe_acesso AS v FROM empresas WHERE id = '${id}'`,
      )
    )[0]?.v;

  it('INSERT sem a coluna (o DEFAULT do banco)', async () => {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA_NOVA}','SPEC-093 nova','spec-093-${EMPRESA_NOVA}',now())`,
    );
    expect(await ler(EMPRESA_NOVA)).toBe(false);
  });

  it('pelo Prisma, sem informar o campo', async () => {
    await db.empresa.create({
      data: {
        id: EMPRESA_NOVA,
        nome: 'SPEC-089 nova',
        slug: `spec-089-${EMPRESA_NOVA}`,
      },
    });
    expect(await ler(EMPRESA_NOVA)).toBe(false);
  });

  it('pelo serviço de criação de empresa (`CompaniesService.create`), o valor persistido', async () => {
    // IMPL-089-02 — o serviço de verdade, e a coluna lida do banco depois:
    // um `nivelRestringeAcesso: true` no `data` da criação fica vermelho
    // aqui (SPEC-093/D1).
    const servico = new CompaniesService(
      p,
      // `create` não usa o AuthService (gera o hash com bcrypt direto).
      {} as ConstructorParameters<typeof CompaniesService>[1],
      {
        resolver: (e: { logoUrl: string | null }) => ({ logoUrl: e.logoUrl }),
      } as unknown as ConstructorParameters<typeof CompaniesService>[2],
      new LevelsService(p),
    );
    const criada = await servico.create({
      nome: 'SPEC-089 pelo servico',
      esportes: ['Tênis'],
      adminInicial: {
        nome: 'Admin',
        email: 'spec089.servico@teste.local',
        senha: 'senha-de-teste-089',
      },
    });
    try {
      expect(await ler(criada.empresa.id)).toBe(false);
    } finally {
      await limparEmpresa(db, criada.empresa.id);
    }
  });

  // A empresa que já existia ANTES da migration: a sequência literal mora em
  // `spec-089-migracao.db-spec.ts` (a da 089) e em
  // `spec-093-migracao.db-spec.ts` (a da 093), cada uma num banco descartável.
});

// ==========================================================================
// REQ-002 — com a chave desligada, P1 a P8 não recusam nem recortam
// ==========================================================================

describe('chave DESLIGADA — o aluno de Intermediário na turma de Avançado', () => {
  beforeEach(desligar);

  it('AC-002 — o aluno se matricula (P3)', async () => {
    const a = await aluno(INT);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA))).code,
    ).toBe('OK');
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
  });

  it('AC-003 — o gestor matricula (P1)', async () => {
    const a = await aluno(INT);
    expect(
      (await desfecho(classes().allocateStudent(EMPRESA, T_AVA, a.alunoId)))
        .code,
    ).toBe('OK');
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
  });

  it('AC-004 — `/me/classes/disponiveis` traz a turma de Avançado (P2)', async () => {
    const a = await aluno(INT);
    const ids = (await matricula().disponiveis(EMPRESA, a.usuarioId)).map(
      (t) => t.id,
    );
    expect(ids).toEqual(expect.arrayContaining([T_INI, T_INT, T_AVA]));
  });

  it('AC-005 — a oportunidade de reposição aparece (P4) e marca (P5)', async () => {
    const a = await aluno(INT);
    const falta = await credito(a.alunoId);
    const alvo = await ocorrencia(T_AVA, emDias(3), '13:00');
    const ids = (
      await reposicao().oportunidades(EMPRESA, a.usuarioId, true)
    ).map((o) => o.ocupacaoId);
    expect(ids).toContain(alvo);
    expect(
      (await desfecho(reposicao().marcar(EMPRESA, a.usuarioId, falta, alvo)))
        .code,
    ).toBe('OK');
    expect(await db.reposicaoDeAula.count({ where: { faltaId: falta } })).toBe(
      1,
    );
  });

  it('AC-006 — entra na fila de turma e de aula (P6), e confirma a vaga (P7)', async () => {
    const a = await aluno(INT);
    expect(
      (await desfecho(fila().entrarNaTurma(EMPRESA, a.usuarioId, T_AVA))).code,
    ).toBe('OK');
    const falta = await credito(a.alunoId);
    const alvo = await ocorrencia(T_AVA, emDias(3), '13:00');
    expect(
      (await desfecho(fila().entrarNaAula(EMPRESA, a.usuarioId, alvo))).code,
    ).toBe('OK');
    expect(falta).toBeDefined();

    const b = await aluno(INT);
    const linha = await chamada({ alunoId: b.alunoId, turmaId: T_AVA });
    const r = await fila().confirmar(EMPRESA, b.usuarioId, linha);
    expect(r).toMatchObject({ ok: true });
    expect(await matriculas(b.alunoId, T_AVA)).toBe(1);
  });

  it('AC-008 — o gestor muda o aluno (P10) e a turma (P9) de nível, com matrícula que fica fora', async () => {
    const a = await aluno(INT);
    await matricular(T_INT, a.alunoId);
    expect((await desfecho(mudarAluno(a.alunoId, { nivelId: AVA }))).code).toBe(
      'OK',
    );

    const b = await aluno(INI);
    await matricular(T_INI, b.alunoId);
    expect((await desfecho(mudarTurma(T_INI, AVA))).code).toBe('OK');
  });

  it('AC-008b — criar um nível antes do primeiro, e reordenar um para antes dele (P11)', async () => {
    const semNivel = await aluno(null);
    await matricular(T_INI, semNivel.alunoId);
    expect(
      (
        await desfecho(
          niveis().create(EMPRESA, { nome: 'Iniciação', ordem: 0 }),
        )
      ).code,
    ).toBe('OK');
    expect(
      (await desfecho(niveis().update(EMPRESA, AVA, { ordem: -1 }))).code,
    ).toBe('OK');
  });

  it('AC-008c — turma de Avançado cheia: `cheiaAntesDaFila` responde "cheia" (P12)', async () => {
    await q(`UPDATE turmas SET capacidade = 1 WHERE id = '${T_AVA}'`);
    const ocupante = await aluno(AVA);
    await matricular(T_AVA, ocupante.alunoId);
    const a = await aluno(INT);
    for (const quem of ['aluno', 'gestor'] as const) {
      expect(await cheiaAntesDaFila(p, EMPRESA, T_AVA, a.alunoId, quem)).toBe(
        true,
      );
    }
    // E pelos dois caminhos de verdade, o código da capacidade.
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA))).code,
    ).toBe('TURMA_CHEIA');
  });
});

describe('controle — chave LIGADA, os mesmos dados de P12 e P11', () => {
  it('AC-008c (par) — `cheiaAntesDaFila` NÃO responde "cheia" a quem é de outro nível', async () => {
    await q(`UPDATE turmas SET capacidade = 1 WHERE id = '${T_AVA}'`);
    const ocupante = await aluno(AVA);
    await matricular(T_AVA, ocupante.alunoId);
    const a = await aluno(INT);
    expect(await cheiaAntesDaFila(p, EMPRESA, T_AVA, a.alunoId, 'aluno')).toBe(
      false,
    );
  });

  it('AC-008b (par) — criar e reordenar continuam recusando', async () => {
    const semNivel = await aluno(null);
    await matricular(T_INI, semNivel.alunoId);
    expect(
      (
        await desfecho(
          niveis().create(EMPRESA, { nome: 'Iniciação', ordem: 0 }),
        )
      ).code,
    ).toBe('NIVEL_INCOMPATIVEL_COM_MATRICULAS');
    expect(
      (await desfecho(niveis().update(EMPRESA, AVA, { ordem: -1 }))).code,
    ).toBe('NIVEL_INCOMPATIVEL_COM_MATRICULAS');
  });
});

// ==========================================================================
// D2 — religar não expulsa, e o par que já existia é ANTIGO
// ==========================================================================

describe('AC-009 a AC-009c — religar a chave', () => {
  it('AC-009 — ninguém sai; matrícula nova fora do nível é recusada; mudar o aluno recusa citando o par que NASCE', async () => {
    const a = await aluno(INT);
    await desligar();
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA))).code,
    ).toBe('OK');
    await matricular(T_INT, a.alunoId);
    await ligar();

    // Ninguém sai.
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
    expect(await matriculas(a.alunoId, T_INT)).toBe(1);

    // (1) Outro aluno de Intermediário, matrícula nova em Avançado: recusa.
    const b = await aluno(INT);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, b.usuarioId, T_AVA))).code,
    ).toBe('NIVEL_INCOMPATIVEL');

    // (2) Mudar o aluno para Iniciante: o par com Avançado já existia; o par
    // com Intermediário NASCE — e é ele que a mensagem cita.
    const r = await desfecho(mudarAluno(a.alunoId, { nivelId: INI }));
    expect(r.code).toBe('NIVEL_INCOMPATIVEL_COM_MATRICULAS');
    expect(r.message).toContain('Turma Intermediário');
    expect(r.message).not.toContain('Turma Avançado');
  });

  it('AC-009b — só o par legado: mudar o nível do aluno é aceito', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId);
    expect((await desfecho(mudarAluno(a.alunoId, { nivelId: INI }))).code).toBe(
      'OK',
    );
  });

  it('AC-009c — troca de par com a contagem igual (1→1): recusa, citando o par que nasce', async () => {
    const a = await aluno(INT);
    await matricular(T_AVA, a.alunoId); // legado, incompatível
    await matricular(T_INT, a.alunoId); // compatível
    // Para Avançado: o par com Avançado se conserta, o com Intermediário nasce.
    const r = await desfecho(mudarAluno(a.alunoId, { nivelId: AVA }));
    expect(r.code).toBe('NIVEL_INCOMPATIVEL_COM_MATRICULAS');
    expect(r.message).toContain('Turma Intermediário');
  });
});

// ==========================================================================
// REQ-003 — o campo de `GET /me/company`
// ==========================================================================

describe('AC-010 — `GET /me/company` devolve a coluna, nos dois valores', () => {
  const ler = () =>
    new MeCompanyController(
      p,
      {
        resolver: () => ({ logoUrl: null }),
      } as unknown as LogoDaEmpresaService,
      operacao(),
    ).minhaEmpresa({
      sub: GESTOR,
      role: 'aluno',
      companyId: EMPRESA,
    } as unknown as AccessTokenPayload);

  it('`true`, e depois `false`', async () => {
    expect((await ler()).nivelRestringeAcesso).toBe(true);
    await desligar();
    expect((await ler()).nivelRestringeAcesso).toBe(false);
  });
});

// ==========================================================================
// SPEC-093 — o gestor troca a chave pelo `PATCH /me/company`
// ==========================================================================

describe('SPEC-093 — a chave trocada pelo `PATCH /me/company` do gestor', () => {
  const controller = () =>
    new MeCompanyController(
      p,
      {
        resolver: () => ({ logoUrl: null }),
      } as unknown as LogoDaEmpresaService,
      operacao(),
    );
  const gestor = {
    sub: GESTOR,
    role: 'company_admin',
    companyId: EMPRESA,
  } as unknown as AccessTokenPayload;
  const trocar = (nivelRestringeAcesso: boolean) =>
    controller().atualizarMinhaEmpresa(gestor, { nivelRestringeAcesso });

  it('AC-002 e AC-004 — desligar libera a próxima matrícula; religar recusa a próxima e não tira ninguém', async () => {
    const a = await aluno(INT);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA))).code,
    ).toBe('NIVEL_INCOMPATIVEL');

    expect((await trocar(false)).nivelRestringeAcesso).toBe(false);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, a.usuarioId, T_AVA))).code,
    ).toBe('OK');

    expect((await trocar(true)).nivelRestringeAcesso).toBe(true);
    // AC-004 — ligar não tira ninguém de turma (SPEC-089/D2).
    expect(await matriculas(a.alunoId, T_AVA)).toBe(1);
    const b = await aluno(INT);
    expect(
      (await desfecho(matricula().entrar(EMPRESA, b.usuarioId, T_AVA))).code,
    ).toBe('NIVEL_INCOMPATIVEL');
  });

  it('AC-003 — o clube sai do token: o `PATCH` do gestor não toca outro clube', async () => {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at,nivel_restringe_acesso) VALUES ('${EMPRESA_NOVA}','SPEC-093 alheia','spec-093-${EMPRESA_NOVA}',now(),true)`,
    );
    await trocar(false);
    const linhas = await db.$queryRawUnsafe<{ id: string; v: boolean }[]>(
      `SELECT id::text AS id, nivel_restringe_acesso AS v FROM empresas WHERE id IN ('${EMPRESA}','${EMPRESA_NOVA}') ORDER BY id`,
    );
    expect(linhas).toEqual([
      { id: EMPRESA, v: false },
      { id: EMPRESA_NOVA, v: true },
    ]);
  });
});
