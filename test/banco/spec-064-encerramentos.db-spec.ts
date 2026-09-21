/**
 * SPEC-064/TASK-004 — **os sete caminhos de encerramento, pelos SERVIÇOS.**
 *
 * ## Por que pelos serviços, e não por SQL
 *
 * A TASK-001 já provou, com `INSERT` cru, que o banco aceita a sequência certa
 * e recusa a errada. O que **este** arquivo julga é outra coisa: que os seis
 * gestos de domínio **chamam** o encerramento, na ordem certa, dentro da
 * transação deles.
 *
 * O caso mais caro é a **AC-009**: `FaltaAvisadaService.retirar` tem de passar
 * com fila viva. A ordem — encerrar **antes** do `deleteMany` — é normativa e
 * custou duas rodadas de validação independente; invertê-la produz `23514`, e
 * a mensagem do Postgres não diria `lista_de_espera`.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { FaltaAvisadaService } from '../../src/classes/falta-avisada.service';
import { ReposicaoService } from '../../src/classes/reposicao.service';
import { MatriculaDoAlunoService } from '../../src/classes/matricula-do-aluno.service';
import { StudentsService } from '../../src/people/students.service';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { TIPO_LISTA_ESPERA } from '../../src/fila-de-espera/aviso-do-chamado';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '06450000-0000-4000-8000-000000000001';
const QUADRA = '06450000-0000-4000-8000-000000000002';
const TURMA = '06450000-0000-4000-8000-00000000000a';
const TURMA_ALVO = '06450000-0000-4000-8000-00000000000b';
/** O gestor autor do gesto. **Nao pode ser `null`:** cancelar ocorrencia
 *  grava `acoes_administrativas`, e `autor_id` e obrigatorio. O primeiro
 *  caso deste arquivo passou com `null` so porque nao havia ocorrencia
 *  nenhuma para cancelar -- verde pelo motivo errado, se eu nao tivesse
 *  escrito o segundo. */
const ADMIN = '06450000-0000-4000-8000-00000000000c';

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

let seq = 0;
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `06450000-0000-4000-8000-1000000000${s}`;
  const alunoId = `06450000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','e064.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function ocorrencia(turmaId: string, data: string, hora = '09:00') {
  ocSeq += 1;
  const id = `06450000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  return id;
}

let faltaSeq = 0;
async function falta(alunoId: string, ocupacaoId: string) {
  faltaSeq += 1;
  const id = `06450000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

let filaSeq = 0;
async function naFila(opcoes: {
  alunoId: string;
  turmaId?: string;
  ocupacaoId?: string;
  faltaId?: string;
  chamado?: boolean;
}): Promise<string> {
  filaSeq += 1;
  const id = `06450000-0000-4000-8000-5000000000${String(filaSeq).padStart(2, '0')}`;
  const chamado = opcoes.chamado
    ? `'chamado', now(), now() + interval '6 hours'`
    : `'aguardando', NULL, NULL`;
  await q(
    `INSERT INTO lista_de_espera (id,company_id,aluno_id,turma_id,ocupacao_id,falta_id,estado,chamado_em,chamado_ate)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}',
             ${opcoes.turmaId ? `'${opcoes.turmaId}'` : 'NULL'},
             ${opcoes.ocupacaoId ? `'${opcoes.ocupacaoId}'` : 'NULL'},
             ${opcoes.faltaId ? `'${opcoes.faltaId}'` : 'NULL'},
             ${chamado})`,
  );
  return id;
}

/** O mesmo molde que `fit-034` e `def-027` usam para montar o serviço. */
function classes(): ClassesService {
  const courts = new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(p),
    new CreditosService(),
    {
      carregarSemana: jest.fn(),
    } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(
    p,
    courts,
    {} as unknown as StudentsService,
    new ConfigOperacaoService(p),
  );
}

const linha = (id: string) =>
  db.listaDeEspera.findUniqueOrThrow({ where: { id } });

const avisosDaFila = (usuarioId: string) =>
  db.notificacao.count({
    where: {
      companyId: EMPRESA,
      destinatarioId: usuarioId,
      tipo: TIPO_LISTA_ESPERA,
    },
  });

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-064 enc','spec-064-e-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Q','${esporte.id}',80,'ativa')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin.e064@x.com','h','Gestor','company_admin','${EMPRESA}',now())`,
  );
  for (const t of [TURMA, TURMA_ALVO]) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${t}','${EMPRESA}','T','${QUADRA}',10,'ativa')`,
    );
  }
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  ocSeq = 0;
  faltaSeq = 0;
  filaSeq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-064/TASK-004 — a falta retirada (AC-009, AC-012)', () => {
  /**
   * **O caminho que custou duas rodadas de validação.**
   *
   * A FK faz `ON DELETE SET NULL ("falta_id")`, e o `fila_credito_chk` exige
   * crédito enquanto a linha está ativa — avaliado **no ato do SET NULL**.
   * Encerrar depois de apagar dá `23514`; encerrar antes passa.
   */
  it('AC-009 — retirar a falta NÃO é bloqueada pela fila, e a linha encerra', async () => {
    const a = await aluno('Mudou de ideia');
    await matricular(TURMA, a.alunoId);
    const perdida = await ocorrencia(TURMA, emDias(2), '08:00');
    const credito = await falta(a.alunoId, perdida);

    // Ele entrou na fila de OUTRA aula usando esse crédito.
    const alvo = await ocorrencia(TURMA_ALVO, emDias(3));
    const fila = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
    });

    const servico = new FaltaAvisadaService(p, new ConfigOperacaoService(p));
    // **Não pode lançar.** Um recurso novo derrubando um que já funcionava é
    // exatamente o que a INV-064g existe para impedir.
    await expect(
      servico.retirar(EMPRESA, a.usuarioId, TURMA, perdida),
    ).resolves.toBeUndefined();

    // AC-012 — as QUATRO colunas: empresa e aluno sobrevivem, o crédito some,
    // e o estado é terminal.
    const depois = await linha(fila);
    expect(depois.companyId).toBe(EMPRESA);
    expect(depois.alunoId).toBe(a.alunoId);
    expect(depois.faltaId).toBeNull();
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('falta retirada');

    expect(await db.faltaAvisada.count({ where: { id: credito } })).toBe(0);
  });

  it('retirar a falta sem fila nenhuma continua funcionando', async () => {
    const a = await aluno('Sem fila');
    await matricular(TURMA, a.alunoId);
    const perdida = await ocorrencia(TURMA, emDias(2), '08:00');
    await falta(a.alunoId, perdida);

    const servico = new FaltaAvisadaService(p, new ConfigOperacaoService(p));
    await expect(
      servico.retirar(EMPRESA, a.usuarioId, TURMA, perdida),
    ).resolves.toBeUndefined();
  });
});

describe('SPEC-064/TASK-004 — o aluno perde o vínculo (AC-010)', () => {
  it('inativar o aluno encerra as filas dele, e NÃO avisa', async () => {
    const a = await aluno('Desligado');
    const f1 = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });
    const f2 = await naFila({
      alunoId: a.alunoId,
      turmaId: TURMA,
      chamado: true,
    });

    const students = new StudentsService(p);
    await students.update(EMPRESA, a.alunoId, { status: 'inativo' } as never);

    expect((await linha(f1)).estado).toBe('encerrada');
    expect((await linha(f2)).estado).toBe('encerrada');
    expect((await linha(f2)).motivoFim).toBe('sem vinculo');
    // **AC-010 — sem aviso.** A conta está saindo do ar: a sessão acabou de
    // ser revogada, e um aviso que ninguém lê é ruído no relatório de entrega.
    expect(await avisosDaFila(a.usuarioId)).toBe(0);
  });
});

describe('SPEC-064/TASK-004 — o aluno sai da turma', () => {
  it('sair por conta própria encerra a fila DAQUELA turma, e só dela', async () => {
    const a = await aluno('Saiu');
    await matricular(TURMA_ALVO, a.alunoId);
    const daTurma = await naFila({ alunoId: a.alunoId, turmaId: TURMA_ALVO });
    const deOutra = await naFila({ alunoId: a.alunoId, turmaId: TURMA });

    const servico = new MatriculaDoAlunoService(
      p,
      new ConfigOperacaoService(p),
    );
    await servico.sair(EMPRESA, a.usuarioId, TURMA_ALVO);

    expect((await linha(daTurma)).estado).toBe('encerrada');
    expect((await linha(daTurma)).motivoFim).toBe('saiu da turma');
    // A outra fila não é da conta deste gesto.
    expect((await linha(deOutra)).estado).toBe('aguardando');
    // Sem aviso: foi ele quem pediu.
    expect(await avisosDaFila(a.usuarioId)).toBe(0);
  });
});

describe('SPEC-064/TASK-004 — o crédito consumido por outro caminho', () => {
  it('marcar reposição pela tela normal encerra as filas que usavam o crédito', async () => {
    const a = await aluno('Repôs direto');
    await matricular(TURMA, a.alunoId);
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    const credito = await falta(a.alunoId, perdida);

    // Ele está na fila de DUAS aulas com o mesmo crédito — o que a spec
    // permite de propósito (LIM-064a: a fila não reserva a vaga).
    const alvoA = await ocorrencia(TURMA_ALVO, emDias(3), '09:00');
    const alvoB = await ocorrencia(TURMA_ALVO, emDias(4), '10:00');
    const f1 = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvoA,
      faltaId: credito,
    });
    const f2 = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvoB,
      faltaId: credito,
    });

    // E marcou reposição numa TERCEIRA aula, pela tela normal.
    const escolhida = await ocorrencia(TURMA_ALVO, emDias(5), '11:00');
    const reposicoes = new ReposicaoService(p, new ConfigOperacaoService(p));
    await reposicoes.marcar(EMPRESA, a.usuarioId, credito, escolhida);

    // **As duas filas morrem**: o crédito que as sustentava acabou. Sem isso,
    // ele seria chamado e a confirmação recusaria com `FALTA_JA_REPOSTA` —
    // convite que não se pode cumprir.
    for (const f of [f1, f2]) {
      const depois = await linha(f);
      expect(depois.estado).toBe('encerrada');
      expect(depois.motivoFim).toBe('credito consumido');
    }
  });
});

describe('SPEC-064/TASK-004 — o alvo morre (AC-008)', () => {
  /**
   * **AC-008 — e o aviso é a metade que importa.**
   *
   * Encerrar em silêncio deixaria a pessoa esperando um chamado que nunca vem,
   * e o silêncio parece "ainda não é a sua vez". Só quem estava **chamado** é
   * avisado: quem apenas aguardava nunca soube que havia vaga.
   */
  it('inativar a turma encerra a fila dela E avisa quem estava chamado', async () => {
    const chamado = await aluno('Estava chamado');
    const esperando = await aluno('So aguardava');
    const fChamado = await naFila({
      alunoId: chamado.alunoId,
      turmaId: TURMA_ALVO,
      chamado: true,
    });
    const fEsperando = await naFila({
      alunoId: esperando.alunoId,
      turmaId: TURMA_ALVO,
    });

    await classes().update(
      EMPRESA,
      TURMA_ALVO,
      { status: 'inativa' } as never,
      ADMIN,
    );

    for (const f of [fChamado, fEsperando]) {
      const depois = await linha(f);
      expect(depois.estado).toBe('encerrada');
      expect(depois.motivoFim).toBe('turma inativada');
    }

    // Só o chamado recebe.
    expect(await avisosDaFila(chamado.usuarioId)).toBe(1);
    expect(await avisosDaFila(esperando.usuarioId)).toBe(0);

    const aviso = await db.notificacao.findFirstOrThrow({
      where: { destinatarioId: chamado.usuarioId, tipo: TIPO_LISTA_ESPERA },
    });
    expect(aviso.titulo).toBe('Sua vez');
    expect(aviso.corpo).toContain('turma');
    // `origem_id` aponta para a linha da fila que morreu.
    expect(aviso.origemId).toBe(fChamado);
    // Sem prazo: não há nada a fazer com este aviso, e um aviso que vence
    // antes de ser lido faz a pessoa nunca entender por que o convite sumiu.
    expect(aviso.expiraEm).toBeNull();
  });

  it('inativar a turma também mata a fila das AULAS dela', async () => {
    const a = await aluno('Queria repor');
    await matricular(TURMA, a.alunoId);
    const perdida = await ocorrencia(TURMA, emDias(-2), '08:00');
    const credito = await falta(a.alunoId, perdida);
    const alvo = await ocorrencia(TURMA_ALVO, emDias(3));
    const fila = await naFila({
      alunoId: a.alunoId,
      ocupacaoId: alvo,
      faltaId: credito,
      chamado: true,
    });

    await classes().update(
      EMPRESA,
      TURMA_ALVO,
      { status: 'inativa' } as never,
      ADMIN,
    );

    // Esta morre pelo cancelamento em massa das ocorrências, não pela regra
    // da turma — são os dois lados da mesma inativação.
    const depois = await linha(fila);
    expect(depois.estado).toBe('encerrada');
    expect(depois.motivoFim).toBe('aula cancelada');
    expect(await avisosDaFila(a.usuarioId)).toBe(1);
  });
});
