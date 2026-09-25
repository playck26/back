/**
 * SPEC-075/TASK-006 — **nenhuma edição de nível cria par incompatível NOVO**
 * (D12, decisão 6, INV-075g), pelos serviços de verdade, contra o banco.
 *
 * As quatro edições: o nível do aluno, o nível da turma, e quem é o primeiro
 * (criar nível, reordenar). O que está em julgamento além da recusa em si:
 *
 * - **"nova" é nova** — um par que já era incompatível (de antes da regra,
 *   gravado por SQL aqui) não impede edição (AC-025(a));
 * - **a comparação é por IDENTIDADE de par** — a matriz de 9 células da D12:
 *   três comparações erradas (contagem, conjunto de alunos, conjunto de
 *   turmas) × três tipos de edição, cada célula com a metade que a mata;
 * - **os atalhos fechados** — mudar o nível, alocar, voltar o nível.
 *
 * Cada recusa confere o CÓDIGO e que a escrita **não ficou** (o rollback).
 */
import { HttpException } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import type { UpdateClassDto } from '../../src/classes/dto/update-class.dto';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { UpdateStudentDto } from '../../src/people/dto/update-student.dto';
import { LevelsService } from '../../src/people/levels.service';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(300_000);
exigirBancoLocal();

const EMPRESA = '07560000-0000-4000-8000-000000000001';
const QUADRA = '07560000-0000-4000-8000-000000000011';
const GESTOR = '07560000-0000-4000-8000-000000000012';
const INI = '07560000-0000-4000-8000-000000000021';
const INT = '07560000-0000-4000-8000-000000000022';
const AVA = '07560000-0000-4000-8000-000000000023';
const T_INI = '07560000-0000-4000-8000-000000000031';
const T_INT = '07560000-0000-4000-8000-000000000032';
const T_AVA = '07560000-0000-4000-8000-000000000033';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

const alunos = () => new StudentsService(p);
const niveis = () => new LevelsService(p);
function turmas(): ClassesService {
  const operacao = new ConfigOperacaoService(p);
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    operacao,
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(p, courts, new StudentsService(p), operacao);
}

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

const RECUSA = 'NIVEL_INCOMPATIVEL_COM_MATRICULAS';

let seq = 0;
async function aluno(nome: string, nivelId: string | null): Promise<string> {
  seq += 1;
  const s = String(seq).padStart(3, '0');
  const usuarioId = `07560000-0000-4000-8000-100000000${s}`;
  const alunoId = `07560000-0000-4000-8000-200000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s075e.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,nivel_id) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo',${nivelId ? `'${nivelId}'` : 'NULL'})`,
  );
  return alunoId;
}

/** Matrícula por SQL — inclusive a incompatível, "de antes da regra". */
const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );
const desmatricular = (turmaId: string, alunoId: string) =>
  q(
    `DELETE FROM turma_alunos WHERE turma_id='${turmaId}' AND aluno_id='${alunoId}'`,
  );

const nivelDoAluno = async (id: string) =>
  (await db.aluno.findUniqueOrThrow({ where: { id } })).nivelId;
const nivelDaTurma = async (id: string) =>
  (await db.turma.findUniqueOrThrow({ where: { id } })).nivelId;
const ordemDe = async (id: string) =>
  (await db.nivel.findUniqueOrThrow({ where: { id } })).ordem;

const mudarAluno = (id: string, nivelId: string | null) =>
  alunos().update(EMPRESA, id, { nivelId } as UpdateStudentDto);
const mudarTurma = (id: string, nivelId: string | null) =>
  turmas().update(EMPRESA, id, { nivelId } as UpdateClassDto, GESTOR);
/** Põe o Intermediário em primeiro (ordem 0). */
const intermediarioPrimeiro = () => niveis().update(EMPRESA, INT, { ordem: 0 });

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-075 edicoes','spec-075-e-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','s075e.gestor@x.com','h','Gestor','company_admin','${EMPRESA}',now())`,
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
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${id}','${EMPRESA}','${nome}','${QUADRA}',8,'ativa','${nivel}')`,
    );
  }
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

// ==========================================================================
// AC-022 — o nível do aluno
// ==========================================================================

describe('AC-022 — o nível do aluno', () => {
  it('aluno numa turma do nível dele: mudar o nível → recusa, nível NÃO gravado, a mensagem nomeia a turma', async () => {
    const a = await aluno('Ana', INT);
    await matricular(T_INT, a);
    const r = await desfecho(mudarAluno(a, AVA));
    expect(r).toEqual({
      code: RECUSA,
      message:
        'Este aluno está na turma Turma Intermediário, que é do nível Intermediário. Tire-o dessa turma antes de mudar o nível dele.',
    });
    expect(await nivelDoAluno(a)).toBe(INT);
  });

  it('tirado da turma antes → a mudança passa', async () => {
    const a = await aluno('Ana', INT);
    await matricular(T_INT, a);
    await desmatricular(T_INT, a);
    expect((await desfecho(mudarAluno(a, AVA))).code).toBe('OK');
    expect(await nivelDoAluno(a)).toBe(AVA);
  });

  it('TIRAR o nível (null) com o primeiro sendo Iniciante → recusa: ele passaria a contar como Iniciante', async () => {
    const a = await aluno('Ana', INT);
    await matricular(T_INT, a);
    expect((await desfecho(mudarAluno(a, null))).code).toBe(RECUSA);
    expect(await nivelDoAluno(a)).toBe(INT);
  });

  it('o ATALHO: mudar para o nível da turma → alocar → voltar o nível — a volta é recusada', async () => {
    const b = await aluno('Bruno', INT);
    expect((await desfecho(mudarAluno(b, AVA))).code).toBe('OK');
    expect(
      (await desfecho(turmas().allocateStudent(EMPRESA, T_AVA, b))).code,
    ).toBe('OK');
    expect((await desfecho(mudarAluno(b, INT))).code).toBe(RECUSA);
    expect(await nivelDoAluno(b)).toBe(AVA);
  });
});

// ==========================================================================
// AC-023 — o nível da turma
// ==========================================================================

describe('AC-023 — o nível da turma', () => {
  it('turma com aluno do nível dela: mudar o nível → recusa, NÃO gravado, a mensagem nomeia o aluno', async () => {
    const a = await aluno('Carla', AVA);
    await matricular(T_AVA, a);
    const r = await desfecho(mudarTurma(T_AVA, INT));
    expect(r).toEqual({
      code: RECUSA,
      message:
        'Esta turma tem 1 aluno que não é do nível Intermediário: Carla. Tire-o da turma ou mude o nível dele antes.',
    });
    expect(await nivelDaTurma(T_AVA)).toBe(AVA);
  });

  it('TIRAR o nível da turma → passa (turma sem nível é de todos)', async () => {
    const a = await aluno('Carla', AVA);
    await matricular(T_AVA, a);
    expect((await desfecho(mudarTurma(T_AVA, null))).code).toBe('OK');
    expect(await nivelDaTurma(T_AVA)).toBeNull();
  });

  it('o ATALHO: tirar o nível → alocar um Intermediário → pôr Avançado de volta — a volta é recusada', async () => {
    const a = await aluno('Carla', AVA);
    await matricular(T_AVA, a);
    const d = await aluno('Davi', INT);
    expect((await desfecho(mudarTurma(T_AVA, null))).code).toBe('OK');
    expect(
      (await desfecho(turmas().allocateStudent(EMPRESA, T_AVA, d))).code,
    ).toBe('OK');
    expect((await desfecho(mudarTurma(T_AVA, AVA))).code).toBe(RECUSA);
    expect(await nivelDaTurma(T_AVA)).toBeNull();
  });
});

// ==========================================================================
// AC-024 — quem é o primeiro
// ==========================================================================

describe('AC-024 — quem é o primeiro (criar nível, reordenar)', () => {
  it('(a) aluno sem nível numa turma Iniciante: reordenar recusa (ordem NÃO gravada); criar um nível antes do Iniciante recusa (NÃO criado)', async () => {
    const n = await aluno('Nina', null);
    await matricular(T_INI, n);
    expect((await desfecho(intermediarioPrimeiro())).code).toBe(RECUSA);
    expect(await ordemDe(INT)).toBe(2);
    const r = await desfecho(
      niveis().create(EMPRESA, { nome: 'Iniciação', ordem: 0 }),
    );
    expect(r.code).toBe(RECUSA);
    expect(
      await db.nivel.count({
        where: { companyId: EMPRESA, nome: 'Iniciação' },
      }),
    ).toBe(0);
  });

  it('(a) sem aluno sem nível em turma do primeiro → as duas passam', async () => {
    expect((await desfecho(intermediarioPrimeiro())).code).toBe('OK');
    expect(
      (
        await desfecho(
          niveis().create(EMPRESA, { nome: 'Iniciação', ordem: -1 }),
        )
      ).code,
    ).toBe('OK');
  });

  it('(b) um conserta, outro quebra — pela reordenação: recusa, e a mensagem conta B', async () => {
    const a = await aluno('Alice', null);
    await matricular(T_INT, a); // incompatível, de antes: ela conta como Iniciante
    const b = await aluno('Beto', null);
    await matricular(T_INI, b); // compatível
    const r = await desfecho(intermediarioPrimeiro());
    expect(r).toEqual({
      code: RECUSA,
      message:
        'Isso faria o primeiro nível deixar de ser Iniciante, e 1 aluno sem nível está em turma de Iniciante. Defina o nível dele antes.',
    });
    expect(await ordemDe(INT)).toBe(2);
  });

  it('(c) o MESMO aluno sem nível trocando de turma incompatível: recusa (mata o conjunto de alunos)', async () => {
    const n = await aluno('Nina', null);
    await matricular(T_INI, n); // compatível
    await matricular(T_INT, n); // incompatível, de antes
    expect((await desfecho(intermediarioPrimeiro())).code).toBe(RECUSA);
  });

  it('(d) a MESMA turma ganhando par: recusa (mata o conjunto de turmas)', async () => {
    const a = await aluno('Alex', AVA);
    await matricular(T_INI, a); // incompatível, de antes
    const n = await aluno('Nina', null);
    await matricular(T_INI, n); // compatível
    expect((await desfecho(intermediarioPrimeiro())).code).toBe(RECUSA);
  });
});

// ==========================================================================
// AC-025 — "nova" é nova, e é por identidade de par
// ==========================================================================

describe('AC-025 — "nova" é nova, e é por identidade de par', () => {
  it('(a) o par que JÁ era incompatível não impede: mudar para Iniciante passa; para Avançado (conserta) passa', async () => {
    const i = await aluno('Igor', INT);
    await matricular(T_AVA, i); // de antes
    expect((await desfecho(mudarAluno(i, INI))).code).toBe('OK');
    expect((await desfecho(mudarAluno(i, AVA))).code).toBe('OK');
  });

  it('(b) um conserta, outro quebra — pelo aluno: recusa, e a mensagem nomeia a turma Intermediário', async () => {
    const i = await aluno('Igor', INT);
    await matricular(T_INT, i); // compatível
    await matricular(T_AVA, i); // incompatível, de antes
    const r = await desfecho(mudarAluno(i, AVA));
    expect(r.code).toBe(RECUSA);
    expect(r.message).toContain('Turma Intermediário');
    expect(r.message).not.toContain('Turma Avançado');
  });

  it('(c) um conserta, outro quebra — pela turma: recusa, e a mensagem nomeia I, e não A', async () => {
    const i = await aluno('Igor', INT);
    await matricular(T_INT, i); // compatível
    const a = await aluno('Amanda', AVA);
    await matricular(T_INT, a); // incompatível, de antes
    const r = await desfecho(mudarTurma(T_INT, AVA));
    expect(r.code).toBe(RECUSA);
    expect(r.message).toContain('Igor');
    expect(r.message).not.toContain('Amanda');
    expect(await nivelDaTurma(T_INT)).toBe(INT);
  });

  it('(d) nível do aluno numa turma que JÁ tinha problema: recusa (mata o conjunto de turmas da empresa)', async () => {
    const x = await aluno('Xavier', AVA);
    await matricular(T_INT, x); // incompatível, de antes
    const i = await aluno('Igor', INT);
    await matricular(T_INT, i); // compatível
    expect((await desfecho(mudarAluno(i, AVA))).code).toBe(RECUSA);
  });

  it('(e) nível da turma com aluno que JÁ tinha problema em outra: recusa (mata o conjunto de alunos da empresa)', async () => {
    const i = await aluno('Igor', INT);
    await matricular(T_INT, i); // compatível
    await matricular(T_AVA, i); // incompatível, de antes
    expect((await desfecho(mudarTurma(T_INT, AVA))).code).toBe(RECUSA);
  });
});
