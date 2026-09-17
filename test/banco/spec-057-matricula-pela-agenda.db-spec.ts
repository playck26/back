/**
 * SPEC-057/TASK-005/D18 — **alocar e remover aluno pelo diálogo da agenda.**
 *
 * A task não cria rota de escrita: o diálogo reusa `POST` e `DELETE
 * /classes/:id/students/:alunoId`. O que este arquivo prova é que esses dois
 * caminhos, **no banco**, fazem o que a D18 promete a quem os chama da agenda —
 * até aqui só havia unitário com Prisma mockado:
 *
 * 1. aula já iniciada recusa a remoção com `409 PRAZO_DE_CANCELAMENTO`, e o
 *    vínculo fica (o gestor não herda o prazo do aluno, mas herda o
 *    "já começou");
 * 2. falha ao gravar a auditoria desfaz a remoção inteira — remoção sem rastro
 *    não existe;
 * 3. sucesso grava autor, ação e evento de matrícula na mesma transação;
 * 4. duas alocações na última vaga, ao mesmo tempo: uma entra, a outra recebe
 *    `409`, e a turma não passa da capacidade de MATRÍCULA (`|M|`). Vaga de
 *    reposição não é vaga de matrícula.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { HOJE_NO_CLUBE_SQL } from './hoje-no-clube-sql';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '05790000-0000-4000-8000-000000000001';
const QUADRA = '05790000-0000-4000-8000-000000000002';
const TURMA = '05790000-0000-4000-8000-00000000000a';
const GESTOR = '05790000-0000-4000-8000-00000000000c';
const NINGUEM = '05790000-0000-4000-8000-0000000000ff';

/** Três conexões: com um cliente só, o Prisma serializa e a corrida vira sequência. */
const db = new PrismaClient();
const dbA = new PrismaClient();
const dbB = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function classes(cliente: PrismaClient): ClassesService {
  const p = cliente as unknown as PrismaService;
  return new ClassesService(
    p,
    new CourtsService(
      p,
      new StudentsService(p),
      new HorarioFuncionamentoService(p),
      {
        resolver: () => ({ imagemUrl: null }),
      } as unknown as ImagemDaQuadraService,
      new ConfigOperacaoService(p),
      new CreditosService(),
      {
        carregarSemana: jest.fn(),
      } as unknown as DisponibilidadeProfessorService,
    ),
    new StudentsService(p),
    new ConfigOperacaoService(p),
  );
}

let seq = 0;
async function aluno(nome: string): Promise<string> {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `05790000-0000-4000-8000-1000000000${s}`;
  const alunoId = `05790000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s057mat.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return alunoId;
}

const matricular = (alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${alunoId}',now())`,
  );

async function vinculos(): Promise<number> {
  return db.turmaAluno.count({ where: { turmaId: TURMA } });
}

async function trilha() {
  const acoes = await db.acaoAdministrativa.findMany({
    where: { companyId: EMPRESA, tipo: 'turma_aluno_removido' },
    select: { id: true, autorId: true },
  });
  const eventos = await db.eventoDeMatricula.findMany({
    where: { companyId: EMPRESA },
    select: { acaoId: true, turmaId: true, alunoId: true },
  });
  return { acoes, eventos };
}

async function recusa(promessa: Promise<unknown>): Promise<{
  status: number;
  corpo: Record<string, unknown>;
}> {
  try {
    await promessa;
  } catch (erro) {
    const e = erro as { status?: number; response?: Record<string, unknown> };
    return { status: e.status ?? 0, corpo: e.response ?? {} };
  }
  throw new Error('o pedido PASSOU, e deveria ter sido recusado');
}

async function montar(capacidade: number): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-057 matricula','spec-057-mat-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','gestor.s057mat@x.com','h','Gestora','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma','${QUADRA}',${capacidade},'ativa')`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  await montar(3);
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await Promise.all([db.$disconnect(), dbA.$disconnect(), dbB.$disconnect()]);
});

describe('SPEC-057/D18 — matrícula pelo diálogo da agenda (AC-029)', () => {
  it('aula JÁ INICIADA: 409 PRAZO_DE_CANCELAMENTO, vínculo intacto, nenhum rastro', async () => {
    const a = await aluno('Em Aula');
    await matricular(a);
    // A aula cobre o dia inteiro de hoje no fuso do clube: em andamento a
    // qualquer hora em que a suíte rode (exceto o último segundo do dia).
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',${HOJE_NO_CLUBE_SQL},TIME '00:00',TIME '23:59:59','TURMA','${TURMA}','pendente_pagamento',now())`,
    );

    const r = await recusa(
      classes(db).removeStudent(EMPRESA, TURMA, a, GESTOR, 'company_admin'),
    );

    expect(r.status).toBe(409);
    expect(r.corpo.code).toBe('PRAZO_DE_CANCELAMENTO');
    expect(await vinculos()).toBe(1);
    expect(await trilha()).toEqual({ acoes: [], eventos: [] });
  });

  it('auditoria FALHA (autor inexistente): a remoção é desfeita junto', async () => {
    const a = await aluno('Fica');
    await matricular(a);

    await expect(
      classes(db).removeStudent(EMPRESA, TURMA, a, NINGUEM, 'company_admin'),
    ).rejects.toBeDefined();

    expect(await vinculos()).toBe(1);
    expect(await trilha()).toEqual({ acoes: [], eventos: [] });
  });

  it('sucesso: vínculo sai, com ação do autor e evento da matrícula, na mesma transação', async () => {
    const a = await aluno('Sai');
    await matricular(a);

    await classes(db).removeStudent(EMPRESA, TURMA, a, GESTOR, 'company_admin');

    expect(await vinculos()).toBe(0);
    const { acoes, eventos } = await trilha();
    expect(acoes.map((acao) => acao.autorId)).toEqual([GESTOR]);
    expect(eventos).toEqual([
      { acaoId: acoes[0].id, turmaId: TURMA, alunoId: a },
    ]);
  });

  it('última vaga de MATRÍCULA disputada por duas alocações simultâneas: uma entra, a outra 409', async () => {
    await limparEmpresa(db, EMPRESA);
    seq = 0;
    await montar(2);
    await matricular(await aluno('Já Está'));
    const x = await aluno('Candidato X');
    const y = await aluno('Candidato Y');

    const resultados = await Promise.allSettled([
      classes(dbA).allocateStudent(EMPRESA, TURMA, x),
      classes(dbB).allocateStudent(EMPRESA, TURMA, y),
    ]);

    const ok = resultados.filter((r) => r.status === 'fulfilled');
    const recusadas = resultados.filter(
      (r): r is PromiseRejectedResult => r.status === 'rejected',
    );
    expect(ok).toHaveLength(1);
    expect(recusadas).toHaveLength(1);
    expect((recusadas[0].reason as { status?: number }).status).toBe(409);
    expect(await vinculos()).toBe(2);
  });

  it('vaga de REPOSIÇÃO não vira vaga de matrícula: turma cheia com falta avisada ainda recusa alocar', async () => {
    await limparEmpresa(db, EMPRESA);
    seq = 0;
    await montar(1);
    const membro = await aluno('Membro');
    await matricular(membro);
    const aula = '05790000-0000-4000-8000-3000000000a1';
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
       VALUES ('${aula}','${EMPRESA}','${QUADRA}',${HOJE_NO_CLUBE_SQL} + 5,TIME '20:00',TIME '21:00','TURMA','${TURMA}','pendente_pagamento',now())`,
    );
    await q(
      `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${aula}','${membro}',now())`,
    );

    const r = await recusa(
      classes(db).allocateStudent(EMPRESA, TURMA, await aluno('Novo')),
    );

    expect(r.status).toBe(409);
    expect(await vinculos()).toBe(1);
  });
});
