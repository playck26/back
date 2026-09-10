/**
 * DEF-027 — **o aluno desligado nao estava fora de operacao: so estava fora
 * do app.**
 *
 * ## O achado, medido contra a instancia local em 2026-09-10
 *
 * Seguindo o mesmo padrao que produziu a SPEC-035 (`turmas.status`) e o
 * DEF-026 (`quadras.status`) — *campo de estado que a LEITURA respeita e a
 * ESCRITA ignora* — sobrou `alunos.status`. Um aluno desligado recebe `401` no
 * login e `403 CONTA_INATIVA` em toda rota. E mesmo assim:
 *
 * ```
 * matricular no plano                    201   <<< PASSOU
 * gestor reserva quadra para ele         201   <<< PASSOU   (credito debitado)
 * gestor o poe numa turma                201   <<< PASSOU
 * ```
 *
 * Medido com saldo de verdade: 50000 -> reserva -> **44000**. Oito mil
 * centavos consumidos de quem nao consegue entrar para usar a quadra.
 *
 * ## O produto MANDAVA o gestor usar a porta que nao guardava nada
 *
 * `POST /students/:id/recusar`, num aluno ja aprovado, responde:
 *
 * ```
 * 409  "Aluno ja aprovado nao e recusado por este fluxo — use inativacao (status)."
 * ```
 *
 * E `PATCH { status: 'inativo' }` respondia `200` sem uma palavra, deixando a
 * reserva paga viva na agenda.
 *
 * ## E ele ja tinha sido consertado pela METADE
 *
 * O comentario de `StudentsService.update` e de agosto (SPEC-013/**DEF-001**):
 * *"Enquanto os dois nao andaram juntos, inativar mudava o badge e nao tirava
 * ninguem de dentro: a pessoa continuava entrando e **continuava ocupando
 * quadra**"*. O DEF-001 fechou a porta do ALUNO. As portas do GESTOR ficaram
 * abertas mais tres semanas, e `exigirVinculoAprovado` — a trava chamada pelos
 * tres caminhos de escrita — selecionava **so `vinculo`**, nunca `status`.
 *
 * ## O que este arquivo prova
 *
 * Os quatro portoes novos e, principalmente, os **controles**: desligar
 * continua possivel, reativar nunca e recusado, remover da turma continua
 * funcionando, e o vinculo continua respondendo primeiro.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { MatriculasService } from '../../src/matriculas/matriculas.service';
import { StudentsService } from '../../src/people/students.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'd0270000-0000-4000-8000-000000000001';
const QUADRA = 'd0270000-0000-4000-8000-000000000002';
const ADMIN = 'd0270000-0000-4000-8000-000000000003';
const USUARIO = 'd0270000-0000-4000-8000-000000000004';
const ALUNO = 'd0270000-0000-4000-8000-000000000005';
const PLANO = 'd0270000-0000-4000-8000-000000000006';
const TURMA = 'd0270000-0000-4000-8000-000000000007';
const PROFESSOR = 'd0270000-0000-4000-8000-000000000008';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const FUTURO = emDias(12);
const PASSADO = emDias(-12);

/**
 * **O `StudentsService` aqui e o de VERDADE, e e o ponto do arquivo.**
 *
 * Os outros db-specs passam `{} as unknown as StudentsService` porque nao
 * exercitam a trava. Um duble devolveria "pode" sempre, e os casos abaixo
 * ficariam verdes com o defeito intacto.
 */
function students(): StudentsService {
  return new StudentsService(db as unknown as PrismaService);
}
function courts(): CourtsService {
  const p = db as unknown as PrismaService;
  return new CourtsService(
    p,
    students(),
    new HorarioFuncionamentoService(p),
    {
      resolver: () => ({ imagemUrl: null }),
    } as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(p),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}
function classes(): ClassesService {
  const p = db as unknown as PrismaService;
  return new ClassesService(
    p,
    courts(),
    students(),
    new ConfigOperacaoService(p),
  );
}
function matriculas(): MatriculasService {
  return new MatriculasService(db as unknown as PrismaService, students());
}

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,contrato_versao_vigente,updated_at) VALUES ('${EMPRESA}','DEF-027','def-027-${EMPRESA}',1,now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.def027@x.com','h','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno.def027@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,saldo_creditos) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo',0)`,
  );
  // O aceite do contrato vigente: sem ele, `matricular` para em
  // `CONTRATO_NAO_ACEITO` (INV-114) e os casos de status nunca seriam
  // alcancados — passariam pelo motivo errado.
  await q(
    `INSERT INTO aceites (id,usuario_id,tipo,versao,aceito_em) VALUES (gen_random_uuid(),'${USUARIO}','contrato',1,now())`,
  );
  await q(
    `INSERT INTO planos (id,company_id,nome,valor_centavos,prazo_meses,ativo,updated_at) VALUES ('${PLANO}','${EMPRESA}','Plano DEF-027',10000,3,true,now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra DEF-027',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'ativa')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROFESSOR}','${EMPRESA}','Prof DEF-027','ativo')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma DEF-027','${QUADRA}',10,'ativa')`,
  );
}

async function desligar(): Promise<void> {
  await q(`UPDATE alunos SET status='inativo' WHERE id='${ALUNO}'`);
  await q(`UPDATE usuarios SET status='inativo' WHERE id='${USUARIO}'`);
}

/** Uma ocupacao dele, no dia e no estado pedidos. */
async function ocuparPara(
  data: string,
  hora: string,
  statusPagamento: 'pago' | 'cancelado' = 'pago',
): Promise<void> {
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,aluno_id,data,hora_inicio,hora_fim,origem_tipo,status_pagamento,valor,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${ALUNO}','${data}','${hora}','${fim}','AVULSO','${statusPagamento}',80,now())`,
  );
}

/**
 * Saldo **pela porta do ledger**, e nao por `UPDATE alunos SET saldo_creditos`.
 *
 * A primeira versao deste arquivo tentou o atalho e o banco recusou:
 * `23514 — saldo so muda por movimento (INV-071)`. **O teste nao conseguiu
 * trapacear porque a invariante e real** — e a segunda vez neste ciclo que uma
 * fixture minha foi corrigida pelo proprio banco (a primeira foi a linha
 * cancelada da SPEC-035).
 */
async function creditar(centavos: number): Promise<void> {
  const [acao] = await db.$queryRawUnsafe<{ id: string }[]>(
    `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
     VALUES (gen_random_uuid(),'${EMPRESA}','credito_lancado','${ADMIN}') RETURNING id`,
  );
  await db.$transaction((tx) =>
    new CreditosService().lancar(tx, {
      companyId: EMPRESA,
      alunoId: ALUNO,
      valorCentavos: centavos,
      motivo: 'saldo para medir o DEF-027',
      autorId: ADMIN,
      acaoId: acao.id,
    }),
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('DEF-027 — o aluno desligado', () => {
  it('o estado do defeito existe: desligado, com vinculo APROVADO', async () => {
    await desligar();
    const aluno = await db.aluno.findUniqueOrThrow({
      where: { id: ALUNO },
      select: { status: true, vinculo: true },
    });
    // Sem esta assercao os casos abaixo poderiam estar medindo um aluno
    // `pendente` e passando pela trava ANTIGA — que sempre funcionou.
    expect(aluno).toEqual({ status: 'inativo', vinculo: 'aprovado' });
  });

  // =====================================================================
  // PORTAO 1 — matricular
  // =====================================================================

  it('CONTROLE: o aluno ATIVO matricula normalmente', async () => {
    const m = await matriculas().criar(
      EMPRESA,
      ALUNO,
      { planoId: PLANO },
      ADMIN,
    );
    expect(m.planoId).toBe(PLANO);
  });

  it('**matricular o DESLIGADO recusa com 422 ALUNO_INATIVO**', async () => {
    await desligar();
    await expect(
      matriculas().criar(EMPRESA, ALUNO, { planoId: PLANO }, ADMIN),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'ALUNO_INATIVO' },
    });
  });

  it('e nao grava matricula nenhuma', async () => {
    await desligar();
    await matriculas()
      .criar(EMPRESA, ALUNO, { planoId: PLANO }, ADMIN)
      .catch(() => undefined);
    // A recusa antes da escrita e o que importa: um servico que gravasse e
    // depois reclamasse deixaria a matricula viva com o erro na tela.
    expect(await db.matricula.count({ where: { alunoId: ALUNO } })).toBe(0);
  });

  // =====================================================================
  // PORTAO 2 — alocar em turma
  // =====================================================================

  it('CONTROLE: o aluno ATIVO entra na turma', async () => {
    await classes().allocateStudent(EMPRESA, TURMA, ALUNO);
    expect(await db.turmaAluno.count({ where: { turmaId: TURMA } })).toBe(1);
  });

  it('**alocar o DESLIGADO em turma recusa**', async () => {
    await desligar();
    await expect(
      classes().allocateStudent(EMPRESA, TURMA, ALUNO),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'ALUNO_INATIVO' },
    });
    expect(await db.turmaAluno.count({ where: { turmaId: TURMA } })).toBe(0);
  });

  it('CONTROLE: **remover da turma continua funcionando** depois de desligado', async () => {
    // Sem isto, desligar prenderia o aluno dentro da turma para sempre — o
    // gestor nao teria caminho de limpeza. E a mesma licao do "reativar nunca
    // e recusado" do DEF-026.
    await classes().allocateStudent(EMPRESA, TURMA, ALUNO);
    await desligar();
    await classes().removeStudent(
      EMPRESA,
      TURMA,
      ALUNO,
      ADMIN,
      'company_admin',
    );
    expect(await db.turmaAluno.count({ where: { turmaId: TURMA } })).toBe(0);
  });

  // =====================================================================
  // PORTAO 3 — reservar quadra para ele
  // =====================================================================

  it('**reservar para o DESLIGADO recusa, e nao debita credito**', async () => {
    await creditar(50000);
    await desligar();

    await expect(
      courts().createBooking(EMPRESA, {
        quadraId: QUADRA,
        data: FUTURO,
        slots: [{ horaInicio: '09:00', horaFim: '10:00' }],
        alunoId: ALUNO,
      }),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'ALUNO_INATIVO' },
    });

    // **O saldo e a metade que importa.** Medido na instancia viva antes do
    // conserto: 50000 -> 44000, oito mil consumidos de quem nao consegue
    // entrar. Sem esta linha, o caso passaria com uma recusa que ja tivesse
    // gasto o credito.
    const aluno = await db.aluno.findUniqueOrThrow({
      where: { id: ALUNO },
      select: { saldoCreditos: true },
    });
    expect(aluno.saldoCreditos).toBe(50000);
    expect(await db.ocupacaoQuadra.count({ where: { alunoId: ALUNO } })).toBe(
      0,
    );
  });

  // =====================================================================
  // PORTAO 4 — desligar com compromisso marcado
  // =====================================================================

  it('**desligar com horario FUTURO marcado e recusado com 409**', async () => {
    await ocuparPara(FUTURO, '09:00');
    await expect(
      students().update(EMPRESA, ALUNO, { status: 'inativo' }),
    ).rejects.toMatchObject({
      response: {
        statusCode: 409,
        code: 'ALUNO_COM_COMPROMISSOS',
        total: 1,
      },
    });
  });

  it('e o aluno continua ATIVO — a recusa nao deixa meia inativacao', async () => {
    await ocuparPara(FUTURO, '09:00');
    await students()
      .update(EMPRESA, ALUNO, { status: 'inativo' })
      .catch(() => undefined);
    const aluno = await db.aluno.findUniqueOrThrow({
      where: { id: ALUNO },
      select: { status: true },
    });
    const usuario = await db.usuario.findUniqueOrThrow({
      where: { id: USUARIO },
      select: { status: true },
    });
    // Os DOIS. `alunos.status` e a ficha, `usuarios.status` e o acesso, e o
    // comentario de INV-013 diz que meia inativacao e pior que nenhuma —
    // vale igual para meia recusa.
    expect(aluno.status).toBe('ativo');
    expect(usuario.status).toBe('ativo');
  });

  it('a amostra nomeia o horario que impede', async () => {
    await ocuparPara(FUTURO, '09:00');
    await expect(
      students().update(EMPRESA, ALUNO, { status: 'inativo' }),
    ).rejects.toMatchObject({
      response: {
        amostra: [
          {
            data: FUTURO,
            horaInicio: '09:00',
            horaFim: '10:00',
            origemTipo: 'AVULSO',
          },
        ],
      },
    });
  });

  it('CONTROLE: compromisso PASSADO nao impede', async () => {
    // A aula da semana passada ja aconteceu; exigir cancelamento dela para
    // desligar alguem seria pedir para reescrever o historico.
    await ocuparPara(PASSADO, '09:00');
    const r = await students().update(EMPRESA, ALUNO, { status: 'inativo' });
    expect(r.status).toBe('inativo');
  });

  it('CONTROLE: compromisso CANCELADO nao impede', async () => {
    await ocuparPara(FUTURO, '09:00', 'cancelado');
    const r = await students().update(EMPRESA, ALUNO, { status: 'inativo' });
    expect(r.status).toBe('inativo');
  });

  it('CONTROLE: sem compromisso nenhum, desligar funciona e propaga (INV-013)', async () => {
    const r = await students().update(EMPRESA, ALUNO, { status: 'inativo' });
    expect(r.status).toBe('inativo');
    const usuario = await db.usuario.findUniqueOrThrow({
      where: { id: USUARIO },
      select: { status: true },
    });
    expect(usuario.status).toBe('inativo');
  });

  it('CONTROLE: **REATIVAR nunca e recusado**, mesmo com ocupacao viva', async () => {
    await ocuparPara(FUTURO, '09:00');
    await desligar();
    const r = await students().update(EMPRESA, ALUNO, { status: 'ativo' });
    // Sem isto, um desligado com ocupacao legada ficaria preso fora do clube:
    // a unica rota que o traria de volta seria a que a checagem recusa.
    expect(r.status).toBe('ativo');
  });

  // =====================================================================
  // PORTAO 5 — professor inativo nao assume turma
  // =====================================================================

  it('CONTROLE: o professor ATIVO assume a turma', async () => {
    const t = await classes().update(
      EMPRESA,
      TURMA,
      { professorId: PROFESSOR },
      ADMIN,
    );
    expect(t.professorId).toBe(PROFESSOR);
  });

  it('**professor INATIVO nao assume turma — o mesmo codigo da SPEC-039**', async () => {
    await q(`UPDATE professores SET status='inativo' WHERE id='${PROFESSOR}'`);
    await expect(
      classes().update(EMPRESA, TURMA, { professorId: PROFESSOR }, ADMIN),
    ).rejects.toMatchObject({
      response: { statusCode: 422, code: 'PROFESSOR_INATIVO' },
    });
  });

  // =====================================================================
  // A ordem entre as duas metades da trava
  // =====================================================================

  it('com vinculo PENDENTE e status inativo, o vinculo responde primeiro', async () => {
    // Quem esta `pendente` nunca chegou a operar: "ainda em analise" descreve
    // o estado melhor do que "esta desligado". Sem este caso, inverter a
    // ordem das duas checagens passaria despercebido.
    await q(
      `UPDATE alunos SET vinculo='pendente', status='inativo' WHERE id='${ALUNO}'`,
    );
    await expect(
      classes().allocateStudent(EMPRESA, TURMA, ALUNO),
    ).rejects.toMatchObject({
      response: { statusCode: 403, code: 'VINCULO_PENDENTE' },
    });
  });
});
