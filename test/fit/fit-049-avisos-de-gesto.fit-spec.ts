/**
 * SPEC-063/FIT-049 — **os treze gestos, um a um, contra o banco de verdade.**
 *
 * ## Por que a matriz inteira, e não uma amostra
 *
 * Três rodadas seguidas de validação independente desta spec caíram pelo mesmo
 * motivo: *"a lista não está toda coberta"*. A v3 esqueceu dois tipos na D4, a
 * v4 corrigiu só os citados, e a v5 achou que os ACs cobriam a matriz quando
 * cobriam onze de treze.
 *
 * Aqui a matriz é percorrida por `Object.keys(PUBLICO_POR_TIPO)`, e um caso
 * declara o que espera de cada tipo. **Acrescentar valor ao enum `TipoDeAcao`
 * sem decidir o que ele avisa reprova este arquivo** — não por leitura de
 * alguém, por execução.
 *
 * ## O que só o banco decide, e está aqui por isso
 *
 * - o `ON CONFLICT (origem_id, destinatario_id) WHERE tipo='gesto'` casando
 *   com o índice parcial da TASK-000. Um índice que não casasse daria `42P10`
 *   em produção e em nenhum mock;
 * - o mesmo gesto gravando duas vezes e **atualizando** em vez de duplicar,
 *   com as QUATRO colunas reescritas (D3);
 * - o `CHECK notificacoes_gesto_tem_origem_chk` recusando gesto sem origem;
 * - **o gesto sobrevivendo ao conflito de aviso** (AC-008): um `23505` dentro
 *   da transação abortaria a transação do PRÓPRIO gesto, e nenhum dublê de
 *   `tx` reproduz isso.
 *
 * O `avisos-de-gesto.spec.ts` prova o texto sem banco; aqui prova-se **quem
 * recebe** e **como a linha entra**.
 */
import { PrismaClient } from '@prisma/client';
import type { TipoDeAcao } from '@prisma/client';
import * as bcrypt from 'bcrypt';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { CreditosAdminService } from '../../src/creditos/creditos-admin.service';
import {
  PUBLICO_POR_TIPO,
  TITULOS_DE_GESTO,
  TIPO_GESTO,
} from '../../src/push/avisos-de-gesto';
import { EnfileiradorDeAvisos } from '../../src/push/enfileirador-de-avisos';
import { parseTimeOnly } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';

jest.setTimeout(600_000);
exigirBancoLocal();

const EMPRESA = '063f0490-0000-4000-8000-000000000001';
const QUADRA = '063f0490-0000-4000-8000-000000000002';
const TURMA = '063f0490-0000-4000-8000-000000000003';
/** Quem executa TODOS os gestos. Nunca pode receber aviso deles (AC-006). */
const ADMIN = '063f0490-0000-4000-8000-000000000004';
/** O segundo gestor — é ele quem prova que os avisos de reserva saem. */
const GESTOR2 = '063f0490-0000-4000-8000-000000000005';
const PROF_U = '063f0490-0000-4000-8000-000000000006';
const PROF = '063f0490-0000-4000-8000-000000000007';
const ALUNO1_U = '063f0490-0000-4000-8000-000000000008';
const ALUNO1 = '063f0490-0000-4000-8000-000000000009';
const ALUNO2_U = '063f0490-0000-4000-8000-00000000000a';
const ALUNO2 = '063f0490-0000-4000-8000-00000000000b';
/** Ficha sem login — a LIM-063e existe justamente para ele. */
const PROF_SEM_CONTA = '063f0490-0000-4000-8000-00000000000c';
const TURMA_SEM_CONTA = '063f0490-0000-4000-8000-00000000000d';
/** SPEC-068 — o professor que ENTRA na troca. */
const PROF2_U = '063f0490-0000-4000-8000-00000000000e';
const PROF2 = '063f0490-0000-4000-8000-00000000000f';

const SENHA = 'senha-do-gestor';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function courts(): CourtsService {
  return new CourtsService(
    db as unknown as PrismaService,
    {} as unknown as StudentsService,
    new HorarioFuncionamentoService(db as unknown as PrismaService),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(db as unknown as PrismaService),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}

function classes(): ClassesService {
  return classesCom(db);
}

/**
 * SPEC-068/AC-018 — o mesmo serviço sobre **outra conexão**. A corrida só é
 * corrida com dois clientes: duas `Promise` no mesmo cliente podem serializar
 * sozinhas e ficar verdes sem provar nada.
 */
function classesCom(cliente: PrismaClient): ClassesService {
  const quadras = new CourtsService(
    cliente as unknown as PrismaService,
    {} as unknown as StudentsService,
    new HorarioFuncionamentoService(cliente as unknown as PrismaService),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(cliente as unknown as PrismaService),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
  return new ClassesService(
    cliente as unknown as PrismaService,
    quadras,
    {} as unknown as StudentsService,
    new ConfigOperacaoService(cliente as unknown as PrismaService),
  );
}

/** `AAAA-MM-DD` a `dias` de distância. */
function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const diaDaSemana = (data: string) => new Date(`${data}T00:00:00Z`).getUTCDay();

const FUTURO = emDias(21);

interface Aviso {
  destinatarioId: string;
  titulo: string;
  corpo: string;
  destinoUrl: string | null;
  expiraEm: Date | null;
  origemId: string | null;
}

/** Os avisos de gesto da empresa, em ordem estável. */
async function avisos(): Promise<Aviso[]> {
  const linhas = await db.notificacao.findMany({
    where: { companyId: EMPRESA, tipo: TIPO_GESTO },
    select: {
      destinatarioId: true,
      titulo: true,
      corpo: true,
      destinoUrl: true,
      expiraEm: true,
      origemId: true,
    },
    orderBy: [{ destinatarioId: 'asc' }, { criadaEm: 'asc' }],
  });
  return linhas;
}

const paraQuem = (lista: Aviso[]) => lista.map((a) => a.destinatarioId).sort();

async function montar(): Promise<void> {
  const hash = await bcrypt.hash(SENHA, 10);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-063','spec-063-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Quadra 063',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80)`,
  );
  for (const [id, email, nome, role] of [
    [ADMIN, 'admin063@teste.local', 'Gestor Autor', 'company_admin'],
    [GESTOR2, 'gestor2-063@teste.local', 'Gestor Dois', 'company_admin'],
    [PROF_U, 'prof063@teste.local', 'Professor', 'professor'],
    [PROF2_U, 'prof2-063@teste.local', 'Professor Dois', 'professor'],
    [ALUNO1_U, 'aluno1-063@teste.local', 'Aluno Um', 'aluno'],
    [ALUNO2_U, 'aluno2-063@teste.local', 'Aluno Dois', 'aluno'],
  ]) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${id}','${email}','${hash}','${nome}','${role}','${EMPRESA}',now())`,
    );
  }
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF}','${EMPRESA}','Professor','${PROF_U}')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF2}','${EMPRESA}','Professor Dois','${PROF2_U}')`,
  );
  // LIM-063e — a ficha existe para quem ainda não tem login.
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id) VALUES ('${PROF_SEM_CONTA}','${EMPRESA}','Sem Conta',NULL)`,
  );
  for (const [aluno, usuario] of [
    [ALUNO1, ALUNO1_U],
    [ALUNO2, ALUNO2_U],
  ]) {
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${aluno}','${usuario}','${EMPRESA}','aprovado')`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma da Ana','${QUADRA}','${PROF}',20,'ativa')`,
  );
  await q(
    `INSERT INTO turma_encontros (id,turma_id,dia_semana,hora_inicio,hora_fim,created_at) VALUES (gen_random_uuid(),'${TURMA}',${diaDaSemana(FUTURO)},'19:00','20:00',now())`,
  );
  for (const aluno of [ALUNO1, ALUNO2]) {
    await q(
      `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${aluno}',now())`,
    );
  }
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${FUTURO}','19:00','20:00','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
}

/** A ocorrência futura da turma. */
async function ocorrencia(): Promise<string> {
  const linha = await db.ocupacaoQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA, origemTurmaId: TURMA, data: new Date(FUTURO) },
    select: { id: true },
  });
  return linha.id;
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

/**
 * **Os horários são separados de propósito.** `agruparEmBlocos` funde slots
 * adjacentes: `10-11` + `11-12` viram UM bloco de duas horas, não dois. Três
 * blocos pedem três janelas descoladas — e é essa a contagem que a AC-017
 * exige que o aviso diga.
 */
async function reservar(blocos: number): Promise<string> {
  const slots = Array.from({ length: blocos }, (_, i) => ({
    horaInicio: `${String(10 + i * 2).padStart(2, '0')}:00`,
    horaFim: `${String(11 + i * 2).padStart(2, '0')}:00`,
  }));
  const criadas = await courts().createBooking(
    EMPRESA,
    {
      quadraId: QUADRA,
      data: FUTURO,
      slots,
    },
    ADMIN,
  );
  // **Com `slots`, a resposta é `{ reservas: [...] }`** — o formato antigo
  // (`horaInicio`/`horaFim`) é que devolve a ocupação solta. A primeira
  // versão deste helper lia o `id` do invólucro e mandava `undefined` para
  // o `cancelBooking`, que respondia `NotFoundException`.
  return (criadas as { reservas: { id: string }[] }).reservas[0].id;
}

// ===========================================================================
// A cobertura da matriz — o que reprova quem acrescenta tipo sem decidir
// ===========================================================================

describe('SPEC-063/REQ-001 — a matriz inteira tem caso', () => {
  /**
   * **A lista de tipos exercidos abaixo, nomeada aqui uma vez.** Se o enum
   * crescer e ninguém escrever o caso, este teste reprova — e é a única coisa
   * neste arquivo que não depende de alguém lembrar.
   */
  const EXERCIDOS: TipoDeAcao[] = [
    'turma_criada',
    'turma_horario_editado',
    'turma_inativada',
    'turma_reativada',
    'aula_cancelada',
    'aula_reativada',
    'turma_aluno_removido',
    'reserva_criada',
    'reserva_cancelada',
    'reserva_movida',
    'pagamento_confirmado',
    'credito_lancado',
    'credito_retirado',
    // SPEC-068 — o catorze. Este teste foi quem cobrou o caso: o enum cresceu
    // e a FIT ficou vermelha antes de qualquer caso novo existir.
    'turma_professor_alterado',
  ];

  it('os catorze tipos do enum têm caso nesta FIT', () => {
    const doEnum = (Object.keys(PUBLICO_POR_TIPO) as TipoDeAcao[]).sort();
    expect(doEnum).toHaveLength(14);
    expect([...EXERCIDOS].sort()).toEqual(doEnum);
  });
});

// ===========================================================================
// Os gestos de turma
// ===========================================================================

describe('SPEC-063 — os gestos de turma', () => {
  it('AC-005: turma_criada avisa o professor e NENHUM aluno', async () => {
    const nova = '063f0490-0000-4000-8000-0000000000f1';
    await classes().create(
      EMPRESA,
      {
        nome: 'Turma Nova',
        quadraId: QUADRA,
        professorId: PROF,
        capacidade: 10,
        encontros: [
          {
            diaSemana: diaDaSemana(FUTURO),
            horaInicio: '07:00',
            horaFim: '08:00',
          },
        ],
      },
      ADMIN,
    );
    void nova;

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([PROF_U]);
    expect(lista[0].titulo).toBe('Sua turma');
    expect(lista[0].corpo).toBe('Você tem uma turma nova');
    // Resumo não tem instante (AC-009).
    expect(lista[0].expiraEm).toBeNull();
  });

  it('AC-002: turma_horario_editado avisa alunos E professor, um resumo cada, sem prazo', async () => {
    await classes().update(
      EMPRESA,
      TURMA,
      {
        encontros: [
          {
            diaSemana: diaDaSemana(FUTURO),
            horaInicio: '20:00',
            horaFim: '21:00',
          },
        ],
      },
      ADMIN,
    );

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([ALUNO1_U, ALUNO2_U, PROF_U].sort());
    // **UM resumo cada** — não um aviso por ocorrência cancelada/criada.
    expect(lista).toHaveLength(3);
    for (const a of lista) {
      expect(a.titulo).toBe('Sua turma');
      expect(a.corpo).toBe('A grade de uma das suas turmas mudou');
      expect(a.expiraEm).toBeNull();
    }
  });

  it('AC-014: turma_inativada avisa alunos e professor, sem prazo', async () => {
    await classes().update(EMPRESA, TURMA, { status: 'inativa' }, ADMIN);

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([ALUNO1_U, ALUNO2_U, PROF_U].sort());
    expect(lista[0].titulo).toBe('Sua turma');
    expect(lista[0].corpo).toBe('Uma das suas turmas foi encerrada');
    expect(lista[0].expiraEm).toBeNull();
  });

  it('AC-014: turma_reativada avisa alunos e professor, sem prazo', async () => {
    await q(`UPDATE turmas SET status='inativa' WHERE id='${TURMA}'`);
    await classes().update(EMPRESA, TURMA, { status: 'ativa' }, ADMIN);

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([ALUNO1_U, ALUNO2_U, PROF_U].sort());
    expect(lista[0].titulo).toBe('Sua turma');
    expect(lista[0].corpo).toBe('Uma das suas turmas voltou');
    expect(lista[0].expiraEm).toBeNull();
  });

  it('AC-015: turma_aluno_removido avisa SÓ o aluno removido', async () => {
    await classes().removeStudent(
      EMPRESA,
      TURMA,
      ALUNO1,
      ADMIN,
      'company_admin',
    );

    const lista = await avisos();
    // Nem a turma, nem o professor, nem os gestores.
    expect(paraQuem(lista)).toEqual([ALUNO1_U]);
    expect(lista[0].titulo).toBe('Sua turma');
    expect(lista[0].corpo).toBe('Você saiu de uma turma');
    expect(lista[0].destinoUrl).toBe('/minhas-aulas/turmas');
  });
});

// ===========================================================================
// SPEC-068 — a troca de professor, o gesto que não existia
// ===========================================================================

describe('SPEC-068 — a troca de professor', () => {
  /** As ações do tipo novo, que a AC-009 conta. */
  async function acoesDeTroca(): Promise<{ autorId: string }[]> {
    return db.acaoAdministrativa.findMany({
      where: { companyId: EMPRESA, tipo: 'turma_professor_alterado' },
      select: { autorId: true },
    });
  }

  it('AC-001/AC-003/AC-013: avisa a turma, o professor NOVO e quem SAIU', async () => {
    // Sentinelas: se nome de tabela vazar para o corpo ou para a URL, esta
    // palavra aparece. É a INV-063a virada teste (AC-003).
    await q(`UPDATE turmas SET nome='Sentinela Turma' WHERE id='${TURMA}'`);
    await q(
      `UPDATE professores SET nome='Sentinela Prof' WHERE id IN ('${PROF}','${PROF2}')`,
    );

    await classes().update(EMPRESA, TURMA, { professorId: PROF2 }, ADMIN);

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual(
      [PROF_U, ALUNO1_U, ALUNO2_U, PROF2_U].sort(),
    );
    for (const aviso of lista) {
      expect(aviso.titulo).toBe('Sua turma');
      expect(aviso.corpo).not.toContain('Sentinela');
      expect(aviso.destinoUrl).not.toContain('Sentinela');
      expect(aviso.expiraEm).toBeNull();
    }

    const porUsuario = new Map(lista.map((a) => [a.destinatarioId, a]));
    // AC-013 — quem saiu: texto próprio, e a LISTA em vez da turma.
    expect(porUsuario.get(PROF_U)?.corpo).toBe(
      'Você não é mais o professor de uma turma',
    );
    expect(porUsuario.get(PROF_U)?.destinoUrl).toBe('/minhas-turmas');
    // O professor novo continua na turma, então vai para ela.
    expect(porUsuario.get(PROF2_U)?.corpo).toBe(
      'Uma das suas turmas mudou de professor',
    );
    expect(porUsuario.get(PROF2_U)?.destinoUrl).toBe(`/minhas-turmas/${TURMA}`);
    expect(porUsuario.get(ALUNO1_U)?.destinoUrl).toBe(
      `/minhas-aulas/turma/${TURMA}`,
    );
  });

  it('AC-009/AC-002: UMA ação com o autor — e repetir não produz nada', async () => {
    // **Controle positivo no mesmo cenário**, que foi o que a 1ª rodada
    // cobrou: sem ele, remover o gatilho deixaria a segunda metade verde.
    await classes().update(EMPRESA, TURMA, { professorId: PROF2 }, ADMIN);
    const depois = await acoesDeTroca();
    expect(depois).toHaveLength(1);
    expect(depois[0].autorId).toBe(ADMIN);
    const quantos = (await avisos()).length;
    expect(quantos).toBeGreaterThan(0);

    // AC-002 — o MESMO professor de novo: retentativa não é gesto.
    await classes().update(EMPRESA, TURMA, { professorId: PROF2 }, ADMIN);
    expect(await acoesDeTroca()).toHaveLength(1);
    expect((await avisos()).length).toBe(quantos);
  });

  it('AC-014: professor anterior SEM CONTA não vira linha, e a troca passa', async () => {
    await q(
      `UPDATE turmas SET professor_id='${PROF_SEM_CONTA}' WHERE id='${TURMA}'`,
    );

    await classes().update(EMPRESA, TURMA, { professorId: PROF2 }, ADMIN);

    expect(paraQuem(await avisos())).toEqual(
      [ALUNO1_U, ALUNO2_U, PROF2_U].sort(),
    );
    const turma = await db.turma.findUniqueOrThrow({
      where: { id: TURMA },
      select: { professorId: true },
    });
    expect(turma.professorId).toBe(PROF2);
  });

  it('AC-010: o autor não recebe, mesmo sendo quem saiu da turma', async () => {
    await classes().update(EMPRESA, TURMA, { professorId: PROF2 }, PROF_U);

    expect(paraQuem(await avisos())).toEqual(
      [ALUNO1_U, ALUNO2_U, PROF2_U].sort(),
    );
  });

  it('AC-018: duas trocas simultâneas avisam quem perdeu a turma EM CADA UMA', async () => {
    /**
     * **A barreira é o teste.** Duas `Promise` disparadas juntas podem passar
     * por acaso — o escalonador roda a primeira troca inteira antes de a
     * segunda ler, e aí a sabotagem *sem lock* fica verde também. A 2ª rodada
     * de validação cobrou exatamente isso.
     *
     * Aqui a primeira transação **segura o lock** e só solta depois de
     * confirmar, no `pg_locks`, que a segunda está esperando. Sem o
     * `FOR UPDATE` do serviço, a segunda leria `PROF` (valor velho), concluiria
     * que nada mudou e **não avisaria ninguém**.
     */
    const outro = new PrismaClient();
    try {
      let bloqueou = false;
      const segunda = classesCom(outro).update(
        EMPRESA,
        TURMA,
        { professorId: PROF },
        ADMIN,
      );

      await db.$transaction(
        async (tx) => {
          await tx.$executeRawUnsafe(
            `SELECT professor_id FROM turmas WHERE id='${TURMA}' FOR UPDATE`,
          );
          for (let i = 0; i < 100 && !bloqueou; i++) {
            const esperando = await tx.$queryRawUnsafe<{ n: bigint }[]>(
              `SELECT count(*) AS n FROM pg_locks WHERE NOT granted`,
            );
            bloqueou = Number(esperando[0].n) > 0;
            if (!bloqueou) {
              await new Promise((r) => setTimeout(r, 100));
            }
          }
          await tx.$executeRawUnsafe(
            `UPDATE turmas SET professor_id='${PROF2}' WHERE id='${TURMA}'`,
          );
        },
        { timeout: 30_000 },
      );

      expect(bloqueou).toBe(true);
      await segunda;

      const quemSaiu = (await avisos()).filter((a) =>
        a.corpo.startsWith('Você não é mais'),
      );
      expect(quemSaiu.map((a) => a.destinatarioId)).toEqual([PROF2_U]);
    } finally {
      await outro.$disconnect();
    }
  });
});

// ===========================================================================
// Os gestos de aula, que são os únicos com prazo de ocorrência
// ===========================================================================

describe('SPEC-063 — os gestos de aula', () => {
  it('AC-001/AC-009: aula_cancelada avisa alunos e professor, e expira no FIM', async () => {
    await classes().cancelarOcorrencia(
      EMPRESA,
      TURMA,
      await ocorrencia(),
      'chuva',
      ADMIN,
    );

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([ALUNO1_U, ALUNO2_U, PROF_U].sort());
    for (const a of lista) {
      expect(a.titulo).toBe('Sua aula');
      expect(a.corpo).toMatch(/^Sua aula de \S+ \(19h\) foi cancelada$/);
      // **O FIM da ocorrência (20h), não o início.** Com o início, um
      // cancelamento de última hora seria varrido como `expirada` sem uma
      // única tentativa de envio (AC-012).
      expect(a.expiraEm).not.toBeNull();
      const fim = new Date(`${FUTURO}T20:00:00-03:00`).getTime();
      expect(a.expiraEm!.getTime()).toBe(fim);
    }
  });

  it('AC-013: aula_reativada avisa alunos e professor', async () => {
    const id = await ocorrencia();
    await classes().cancelarOcorrencia(EMPRESA, TURMA, id, 'chuva', ADMIN);
    await limparAvisos();
    await classes().reativarOcorrencia(EMPRESA, TURMA, id, 'voltou', ADMIN);

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([ALUNO1_U, ALUNO2_U, PROF_U].sort());
    expect(lista[0].titulo).toBe('Sua aula');
    expect(lista[0].corpo).toMatch(/^Sua aula de \S+ \(19h\) voltou$/);
  });

  /**
   * LIM-063e — **o gesto acontece; só o aviso não sai.** `Professor.usuario_id`
   * é anulável, e a ficha existe justamente para quem ainda não tem login.
   */
  it('LIM-063e: professor sem conta não gera linha, e o gesto passa', async () => {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${TURMA_SEM_CONTA}','${EMPRESA}','Sem Conta','${QUADRA}','${PROF_SEM_CONTA}',10,'ativa')`,
    );
    await classes().update(
      EMPRESA,
      TURMA_SEM_CONTA,
      {
        encontros: [
          {
            diaSemana: diaDaSemana(FUTURO),
            horaInicio: '08:00',
            horaFim: '09:00',
          },
        ],
      },
      ADMIN,
    );

    // A turma não tem aluno e o professor não tem conta: zero destinatários.
    expect(await avisos()).toHaveLength(0);
    // E o gesto aconteceu: a ação está lá.
    const acoes = await db.acaoAdministrativa.count({
      where: { companyId: EMPRESA, tipo: 'turma_horario_editado' },
    });
    expect(acoes).toBeGreaterThan(0);
  });
});

// ===========================================================================
// Os gestos de reserva — público `gestores`
// ===========================================================================

describe('SPEC-063 — os gestos de reserva', () => {
  it('AC-003/AC-017: reserva de 3 blocos gera UM aviso por gestor, dizendo 3', async () => {
    await reservar(3);

    const lista = await avisos();
    // **UM** aviso, e para o OUTRO gestor: o autor não recebe (AC-006).
    expect(paraQuem(lista)).toEqual([GESTOR2]);
    expect(lista[0].titulo).toBe('Reservas');
    expect(lista[0].corpo).toBe('Nova reserva · 3 horários');
    expect(lista[0].destinoUrl).toBe('/agenda');
    expect(lista[0].expiraEm).toBeNull();
  });

  it('AC-010: reserva_cancelada avisa os gestores, com o prazo do bloco', async () => {
    const id = await reservar(1);
    await limparAvisos();
    await courts().cancelBooking(EMPRESA, id, ADMIN, 'company_admin');

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([GESTOR2]);
    expect(lista[0].titulo).toBe('Reservas');
    expect(lista[0].corpo).toMatch(
      /^Uma reserva de \S+ \(10h\) foi cancelada$/,
    );
    expect(lista[0].expiraEm).not.toBeNull();
  });

  it('AC-010: reserva_movida avisa os gestores', async () => {
    const id = await reservar(1);
    await limparAvisos();
    await courts().moveBooking(
      EMPRESA,
      id,
      {
        quadraId: QUADRA,
        data: FUTURO,
        horaInicio: '15:00',
        horaFim: '16:00',
      },
      ADMIN,
    );

    const lista = await avisos();
    expect(paraQuem(lista)).toEqual([GESTOR2]);
    expect(lista[0].corpo).toBe('Uma reserva mudou de horário');
  });
});

// ===========================================================================
// AC-016 — provar o ZERO dos três tipos de dinheiro
// ===========================================================================

describe('SPEC-063/AC-016 — dinheiro não avisa ninguém', () => {
  /**
   * **Provar o zero é tão importante quanto provar o um** (LIM-063b). Sem
   * estes casos, alguém acrescenta um aviso de pagamento por parecer útil, e
   * ninguém lembra que isso foi decidido fora do escopo do card.
   *
   * `pagamento_confirmado` é o mais forte dos três: ele **passa pelo
   * enfileirador** e ainda assim tem de gravar zero. Os outros dois nem
   * chegam lá — e o caso existe para que continuem não chegando.
   */
  it('pagamento_confirmado passa pelo enfileirador e grava ZERO', async () => {
    const id = await reservar(1);
    await limparAvisos();

    await courts().updatePaymentStatus(EMPRESA, id, 'pago', ADMIN);

    expect(await avisos()).toHaveLength(0);
    // E o gesto aconteceu.
    expect(
      await db.acaoAdministrativa.count({
        where: { companyId: EMPRESA, tipo: 'pagamento_confirmado' },
      }),
    ).toBe(1);
  });

  it.each([
    ['entrada', 'credito_lancado'],
    ['retirada', 'credito_retirado'],
  ] as const)('%s grava a ação e ZERO aviso', async (tipo, acao) => {
    const admin = new CreditosAdminService(
      db as unknown as PrismaService,
      new CreditosService(),
    );
    if (tipo === 'retirada') {
      // Saldo para poder retirar: entra primeiro.
      await admin.lancarOuRetirar(EMPRESA, ALUNO1, ADMIN, {
        tipo: 'entrada',
        valorCentavos: 10_000,
        motivo: 'saldo inicial do teste',
        senha: SENHA,
      });
    }
    await limparAvisos();

    await admin.lancarOuRetirar(EMPRESA, ALUNO1, ADMIN, {
      tipo,
      valorCentavos: 5_000,
      motivo: 'movimento do teste da FIT-049',
      senha: SENHA,
    });

    expect(await avisos()).toHaveLength(0);
    expect(
      await db.acaoAdministrativa.count({
        where: { companyId: EMPRESA, tipo: acao },
      }),
    ).toBe(1);
  });
});

// ===========================================================================
// O que só o banco decide
// ===========================================================================

describe('SPEC-063 — as travas do banco', () => {
  /**
   * **AC-008 — o gesto sobrevive ao conflito de aviso.**
   *
   * Um `23505` dentro da transação aborta a transação INTEIRA, e a transação
   * aqui é a do próprio gesto. Sem o `ON CONFLICT DO UPDATE`, o gestor
   * editaria a grade, um aviso duplicado dispararia o conflito, e a edição
   * voltaria atrás com uma mensagem de erro que culpa notificação.
   *
   * O caso: pré-grava um aviso com o `(origem_id, destinatario_id)` que o
   * gesto vai gravar. Não dá para adivinhar o `origem_id` antes — então o
   * gesto roda **duas vezes** sobre a mesma turma, e a segunda encontra o
   * terreno do primeiro só se o `origem_id` coincidir. Como não coincide
   * (ação nova a cada gesto), a prova real é a de baixo: gravar de novo a
   * MESMA chave, à mão, dentro de uma transação, e ver que ela commita.
   */
  it('AC-008: o mesmo (origem_id, destinatario_id) atualiza e a transação commita', async () => {
    await classes().update(EMPRESA, TURMA, { status: 'inativa' }, ADMIN);
    const antes = await avisos();
    expect(antes.length).toBeGreaterThan(0);
    const origem = antes[0].origemId!;
    const destinatario = antes[0].destinatarioId;

    // A MESMA chave, agora com texto diferente, dentro de uma transação que
    // também escreve outra coisa. Se o `ON CONFLICT` não absorvesse, o
    // `23505` derrubaria a transação toda e a segunda escrita sumiria.
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO notificacoes (id,company_id,destinatario_id,origem_id,tipo,titulo,corpo,destino_url,expira_em)
         VALUES (gen_random_uuid(),'${EMPRESA}','${destinatario}','${origem}','gesto','Sua aula','TEXTO NOVO','/minhas-aulas',NULL)
         ON CONFLICT (origem_id, destinatario_id) WHERE tipo = 'gesto'
         DO UPDATE SET titulo = EXCLUDED.titulo, corpo = EXCLUDED.corpo,
                       destino_url = EXCLUDED.destino_url, expira_em = EXCLUDED.expira_em`,
      );
      await tx.$executeRawUnsafe(
        `UPDATE turmas SET nome='sobreviveu' WHERE id='${TURMA}'`,
      );
    });

    // A transação commitou: a segunda escrita está lá.
    const turma = await db.turma.findUniqueOrThrow({ where: { id: TURMA } });
    expect(turma.nome).toBe('sobreviveu');

    // E o aviso foi ATUALIZADO, não duplicado — com as QUATRO colunas.
    const depois = await avisos();
    expect(depois.filter((a) => a.origemId === origem)).toHaveLength(
      antes.filter((a) => a.origemId === origem).length,
    );
    const alvo = depois.find((a) => a.destinatarioId === destinatario)!;
    expect(alvo.corpo).toBe('TEXTO NOVO');
    expect(alvo.titulo).toBe('Sua aula');
    expect(alvo.destinoUrl).toBe('/minhas-aulas');
  });

  /**
   * **D3/achado R03 — o `DO UPDATE` reescreve as QUATRO colunas.**
   *
   * Este caso existe porque a primeira versão desta FIT **não pegava** a falta
   * delas: o caso acima grava o conflito por SQL cru, então exercita o índice
   * e não o `DO UPDATE` do enfileirador. Sabotei `destino_url` e `expira_em`
   * no `EXCLUDED` e a suíte ficou **verde** — a sabotagem achou a lacuna antes
   * de qualquer validador.
   *
   * Aqui os dois despachos passam pelo código de verdade, com a MESMA ação e
   * tipos diferentes: o primeiro é um aviso de aula (tem prazo, vai para a
   * lista de aulas), o segundo é um resumo de grade (sem prazo, vai para a
   * turma). Se alguma das quatro colunas não for reescrita, a linha fica
   * **misturada** — texto novo com destino e prazo do passado.
   */
  it('D3: o segundo despacho da MESMA ação reescreve as quatro colunas', async () => {
    // **SPEC-069/INV-069a — esta e a acao que o `grep` de SQL cru nao via.**
    // Ela nasce pelo Prisma (`acaoAdministrativa.create`), em autocommit, e
    // commitava sozinha: o `acao_exige_alvo` recusa isso no COMMIT.
    //
    // O conserto preserva o que o caso mede — **os dois despachos da MESMA
    // acao** —, porque o `acaoId` continua sendo um so. O que entra e um
    // efeito legitimo: o evento da ocupacao que o gesto `aula_cancelada`
    // teria produzido de verdade.
    const acao = { id: crypto.randomUUID() };
    await db.$transaction(async (tx) => {
      await tx.$executeRawUnsafe(
        `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id)
         VALUES ('${acao.id}','${EMPRESA}','aula_cancelada','${ADMIN}')`,
      );
      await tx.$executeRawUnsafe(
        `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
         SELECT gen_random_uuid(),'${EMPRESA}','${acao.id}',o.id,'cancelada',gen_random_uuid()
           FROM ocupacoes_quadra o
          WHERE o.company_id='${EMPRESA}' AND o.origem_turma_id='${TURMA}'
          ORDER BY o.data LIMIT 1`,
      );
    });

    await db.$transaction(async (tx) => {
      const primeiro = new EnfileiradorDeAvisos(
        tx,
        EMPRESA,
        ADMIN,
        'aula_cancelada',
      );
      primeiro.comTurma(TURMA);
      primeiro.anotarEfeito({
        data: new Date(FUTURO),
        horaInicio: parseTimeOnly('19:00'),
        horaFim: parseTimeOnly('20:00'),
      });
      await primeiro.despachar(acao.id);
    });

    const antes = await avisos();
    expect(antes).toHaveLength(3);
    expect(antes.every((a) => a.expiraEm !== null)).toBe(true);

    await db.$transaction(async (tx) => {
      const segundo = new EnfileiradorDeAvisos(
        tx,
        EMPRESA,
        ADMIN,
        'turma_horario_editado',
      );
      segundo.comTurma(TURMA);
      await segundo.despachar(acao.id);
    });

    const depois = await avisos();
    // Atualizou, não duplicou (INV-063b).
    expect(depois).toHaveLength(3);
    for (const a of depois) {
      expect(a.titulo).toBe('Sua turma');
      expect(a.corpo).toBe('A grade de uma das suas turmas mudou');
      // `expira_em` — o resumo não tem instante. Se o `DO UPDATE` não a
      // reescrever, sobra o prazo da aula que já não é o assunto.
      expect(a.expiraEm).toBeNull();
    }
    // `destino_url` — o aluno saía para `/minhas-aulas` no primeiro despacho e
    // tem de sair para a turma no segundo. É a coluna que a sabotagem mostrou
    // que ninguém estava conferindo.
    const doAluno = depois.find((a) => a.destinatarioId === ALUNO1_U)!;
    expect(doAluno.destinoUrl).toBe(`/minhas-aulas/turma/${TURMA}`);
  });

  /**
   * AC-011 — sem este `CHECK` a `UNIQUE` parcial seria letra morta: em
   * PostgreSQL **`NULL` não colide com `NULL`**, então a tabela aceitaria
   * quantos gestos sem origem quisessem entrar, e a INV-063b cairia em
   * silêncio.
   */
  it('AC-011: o banco recusa (23514) gesto com origem_id nulo', async () => {
    await expect(
      q(
        `INSERT INTO notificacoes (id,company_id,destinatario_id,tipo,titulo,corpo)
         VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO1_U}','gesto','Reservas','sem origem')`,
      ),
    ).rejects.toThrow(/23514|check constraint/i);
  });
});

// ===========================================================================
// AC-018 — o vocabulário fechado, conferido contra o que ENTROU no banco
// ===========================================================================

describe('SPEC-063/AC-018 — todo título de gesto vem do vocabulário', () => {
  it('nenhum gesto desta FIT gravou título fora da lista', async () => {
    // Um gesto de cada família, para encher a tabela.
    await classes().update(EMPRESA, TURMA, { status: 'inativa' }, ADMIN);
    await courts().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: FUTURO,
        horaInicio: '13:00',
        horaFim: '14:00',
      },
      ADMIN,
    );

    const lista = await avisos();
    expect(lista.length).toBeGreaterThan(0);
    for (const a of lista) {
      expect(TITULOS_DE_GESTO).toContain(a.titulo);
    }
  });

  /**
   * **O recorte por `tipo` não é detalhe** (ressalva N01 da 4ª rodada): o
   * aviso de teste da SPEC-062 usa `titulo = "Avisos do clube"` com
   * `tipo = 'teste'`. Uma regra sobre *toda* linha da tabela reprovaria uma
   * spec que já está no ar — invariante que atropela o vizinho é invariante
   * que alguém desliga.
   */
  it('a regra não atropela o aviso de teste da SPEC-062', async () => {
    await q(
      `INSERT INTO notificacoes (id,company_id,destinatario_id,tipo,titulo,corpo)
       VALUES (gen_random_uuid(),'${EMPRESA}','${ALUNO1_U}','teste','Avisos do clube','funciona')`,
    );
    // Entrou sem `origem_id` e sem reprovar: o `CHECK` só fala de `gesto`.
    const teste = await db.notificacao.count({
      where: { companyId: EMPRESA, tipo: 'teste' },
    });
    expect(teste).toBe(1);
    // E não conta como gesto.
    expect(await avisos()).toHaveLength(0);
  });
});

/** Limpa só os avisos, para isolar o gesto seguinte sem refazer a fixture. */
async function limparAvisos(): Promise<void> {
  await db.notificacao.deleteMany({ where: { companyId: EMPRESA } });
}
