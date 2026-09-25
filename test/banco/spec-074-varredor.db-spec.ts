/**
 * SPEC-074/TASK-003 — **o varredor, contra o banco de verdade.**
 *
 * ## O que está aqui
 *
 * O comportamento de um ciclo: os **cinco** caminhos que liberam horário
 * (AC-007), avisar TODOS (AC-008), a mesma definição de "livre" da grade
 * (AC-009, AC-012), o que termina sem aviso (AC-011, AC-013, AC-014), o texto
 * do aviso (AC-017), o relógio (AC-023) e o rodízio com orçamento (AC-027).
 *
 * As corridas — duas réplicas, lock, cancelamento no meio do ciclo — e a
 * composição de produção são do FIT-054 (TASK-004).
 *
 * ## O relógio é o do banco
 *
 * O varredor compara `inicio_em` com `now()` no SQL, e `executarCiclo()` não
 * recebe relógio (D7). Então a prova de tempo posiciona `inicio_em` em relação
 * ao `now()` do banco, e não o contrário.
 */
import { PrismaClient } from '@prisma/client';
import type { ConfigService } from '@nestjs/config';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { VarredorDaPreReservaService } from '../../src/pre-reserva/varredor-da-pre-reserva.service';
import { SeletorDoLote } from '../../src/pre-reserva/seletor-do-lote';
import { TIPO_PRE_RESERVA } from '../../src/pre-reserva/aviso-da-pre-reserva';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { CourtsService } from '../../src/courts/courts.service';
import { ClassesService } from '../../src/classes/classes.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import {
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
  parseDateOnly,
  parseTimeOnly,
} from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(240_000);
exigirBancoLocal();

const EMPRESA = '074e0740-0000-4000-8000-00000000000a';
const QUADRA = '074e0740-0000-4000-8000-00000000001a';
const QUADRA_INATIVA = '074e0740-0000-4000-8000-00000000001c';
const GESTOR = '074e0740-0000-4000-8000-00000000002a';
const TURMA = '074e0740-0000-4000-8000-00000000004a';
/** O nome da quadra é uma SENTINELA: o corpo do aviso não pode contê-la
 *  (AC-017, INV-063a). */
const NOME_SENTINELA = 'Quadra Sentinela Zq';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const p = db as unknown as PrismaService;

function configCom(lote: number | undefined): ConfigService {
  return {
    get: (chave: string) =>
      chave === 'PRE_RESERVA_LOTE' && lote !== undefined
        ? String(lote)
        : undefined,
  } as unknown as ConfigService;
}
const varredor = (lote?: number) =>
  new VarredorDaPreReservaService(
    p,
    new SeletorDoLote(p, configCom(lote)),
    new HorarioFuncionamentoService(p),
  );

function courts(): CourtsService {
  return new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
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
  return new ClassesService(
    p,
    courts(),
    {} as unknown as StudentsService,
    new ConfigOperacaoService(p),
  );
}

function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const DIA = emDias(3);

let seq = 0;
async function aluno(
  status: 'ativo' | 'inativo' = 'ativo',
): Promise<{ alunoId: string; usuarioId: string }> {
  seq += 1;
  const s = String(seq).padStart(4, '0');
  const usuarioId = `074e0740-0000-4000-8000-10000000${s}`;
  const alunoId = `074e0740-0000-4000-8000-20000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','v074.${seq}@x.com','h','A','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','${status}')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
/** Uma reserva AVULSA viva. Devolve o id, para os caminhos que a cancelam. */
async function avulsa(opcoes: {
  alunoId: string;
  dia?: string;
  inicio?: string;
  fim?: string;
}): Promise<string> {
  ocSeq += 1;
  const id = `074e0740-0000-4000-8000-30000000${String(ocSeq).padStart(4, '0')}`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${opcoes.dia ?? DIA}','${opcoes.inicio ?? '10:00'}','${opcoes.fim ?? '11:00'}','AVULSO','${opcoes.alunoId}',80,'pendente_pagamento',now())`,
  );
  return id;
}

async function aulaDaTurma(inicio = '10:00', fim = '11:00'): Promise<string> {
  ocSeq += 1;
  const id = `074e0740-0000-4000-8000-30000000${String(ocSeq).padStart(4, '0')}`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${DIA}','${inicio}','${fim}','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
  return id;
}

let pedSeq = 0;
/**
 * Um pedido `aguardando`, por SQL — o serviço de criação é da TASK-002. O
 * `inicio_em` sai do mesmo `instanteNoFusoDoClube` que o serviço usa; os
 * instantes de rodízio são CONTROLADOS (R-01 da 5ª rodada), nunca duas
 * chamadas seguidas ao relógio.
 */
async function pedido(opcoes: {
  alunoId: string;
  quadra?: string;
  dia?: string;
  hora?: string;
  criadaSegundosAtras?: number;
  verificadaSegundosAtras?: number;
  inicioEmSql?: string;
}): Promise<string> {
  pedSeq += 1;
  const id = `074e0740-0000-4000-8000-40000000${String(pedSeq).padStart(4, '0')}`;
  const dia = opcoes.dia ?? DIA;
  const hora = opcoes.hora ?? '10:00';
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  const inicioEm =
    opcoes.inicioEmSql ??
    `'${instanteNoFusoDoClube(parseDateOnly(dia), parseTimeOnly(hora)).toISOString()}'`;
  await q(
    `INSERT INTO pre_reservas (id,company_id,aluno_id,quadra_id,data,hora_inicio,hora_fim,inicio_em,criada_em,verificada_em)
     VALUES ('${id}','${EMPRESA}','${opcoes.alunoId}','${opcoes.quadra ?? QUADRA}','${dia}','${hora}','${fim}',${inicioEm},
             now() - interval '${opcoes.criadaSegundosAtras ?? 0} seconds',
             ${
               opcoes.verificadaSegundosAtras === undefined
                 ? 'NULL'
                 : `now() - interval '${opcoes.verificadaSegundosAtras} seconds'`
             })`,
  );
  return id;
}

const estado = async (id: string) =>
  (await db.preReserva.findUniqueOrThrow({ where: { id } })).estado;
const avisosDe = (origemId: string) =>
  db.notificacao.findMany({
    where: { origemId, tipo: TIPO_PRE_RESERVA },
  });

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-074 varredor','spec-074-v-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  for (const [quadra, status] of [
    [QUADRA, 'ativa'],
    [QUADRA_INATIVA, 'inativa'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${quadra}','${EMPRESA}','${NOME_SENTINELA}',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'${status}')`,
    );
  }
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${GESTOR}','g074@x.com','h','G','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','T','${QUADRA}',4,'ativa')`,
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

describe('SPEC-074/TASK-003 — o varredor', () => {
  // ==========================================================================
  // AC-007 — o horário vaga pelos CINCO caminhos, pelo serviço de verdade
  // ==========================================================================

  describe('AC-007 — os cinco caminhos que liberam horário', () => {
    async function ocupadoPorAvulsa() {
      const dono = await aluno();
      const eu = await aluno();
      const reserva = await avulsa({ alunoId: dono.alunoId });
      const meu = await pedido({ alunoId: eu.alunoId });
      // Ocupado: um ciclo não avisa ninguém.
      await varredor().executarCiclo();
      expect(await estado(meu)).toBe('aguardando');
      return { reserva, meu };
    }

    async function vagouEAvisou(meu: string) {
      await varredor().executarCiclo();
      expect(await estado(meu)).toBe('avisada');
      expect(
        (await db.preReserva.findUniqueOrThrow({ where: { id: meu } }))
          .avisadaEm,
      ).not.toBeNull();
      expect(await avisosDe(meu)).toHaveLength(1);
    }

    it('1 — `cancelBooking`', async () => {
      const { reserva, meu } = await ocupadoPorAvulsa();
      await courts().cancelBooking(EMPRESA, reserva, GESTOR, 'company_admin');
      await vagouEAvisou(meu);
    });

    it('2 — `updatePaymentStatus(…, "cancelado")`', async () => {
      const { reserva, meu } = await ocupadoPorAvulsa();
      await courts().updatePaymentStatus(EMPRESA, reserva, 'cancelado', GESTOR);
      await vagouEAvisou(meu);
    });

    it('3 — `cancelOneClassOccurrence`, pela aula cancelada', async () => {
      const eu = await aluno();
      const aula = await aulaDaTurma();
      const meu = await pedido({ alunoId: eu.alunoId });
      await varredor().executarCiclo();
      expect(await estado(meu)).toBe('aguardando');

      await classes().cancelarOcorrencia(EMPRESA, TURMA, aula, 'chuva', GESTOR);
      await vagouEAvisou(meu);
    });

    it('4 — `cancelFutureClassOccupancies`, pela turma inativada', async () => {
      const eu = await aluno();
      await aulaDaTurma();
      const meu = await pedido({ alunoId: eu.alunoId });
      await varredor().executarCiclo();
      expect(await estado(meu)).toBe('aguardando');

      await classes().update(
        EMPRESA,
        TURMA,
        { status: 'inativa' } as never,
        GESTOR,
      );
      await vagouEAvisou(meu);
    });

    it('5 — `moveBooking`: o slot de ORIGEM vaga sem nada ser cancelado', async () => {
      const { reserva, meu } = await ocupadoPorAvulsa();
      await courts().moveBooking(
        EMPRESA,
        reserva,
        { horaInicio: '14:00', horaFim: '15:00' },
        GESTOR,
      );
      await vagouEAvisou(meu);
    });
  });

  // ==========================================================================
  // AC-008 — avisar TODOS
  // ==========================================================================

  it('AC-008 — três alunos esperando o mesmo slot livre: um ciclo, TRÊS avisos', async () => {
    const pedidos: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      pedidos.push(await pedido({ alunoId: (await aluno()).alunoId }));
    }

    const r = await varredor().executarCiclo();

    expect(r.avisadas).toBe(3);
    for (const id of pedidos) {
      expect(await estado(id)).toBe('avisada');
      expect(await avisosDe(id)).toHaveLength(1);
    }
  });

  // ==========================================================================
  // AC-009 — a mesma definição de "livre" da grade
  // ==========================================================================

  it('AC-009 — vaga PARCIAL não avisa: a reserva das 10h sai, e a turma das 10:30–11:30, criada pelo serviço de turma, entra antes do ciclo', async () => {
    const eu = await aluno();
    const dono = await aluno();
    const reserva = await avulsa({ alunoId: dono.alunoId });
    const meu = await pedido({ alunoId: eu.alunoId });
    // A ORDEM é a do mundo, e não arbitrária: a turma das 10:30 **não pode**
    // nascer com a reserva das 10h viva — a `EXCLUDE` da quadra recusa
    // (INV-001), e foi assim que a primeira versão deste teste caiu. O caso
    // real é o horário vagar e ser meio reocupado entre dois ciclos.
    await courts().cancelBooking(EMPRESA, reserva, GESTOR, 'company_admin');
    await classes().create(
      EMPRESA,
      {
        nome: 'Meia hora depois',
        quadraId: QUADRA,
        capacidade: 4,
        encontros: [
          {
            diaSemana: parseDateOnly(DIA).getUTCDay(),
            horaInicio: '10:30',
            horaFim: '11:30',
          },
        ],
      },
      GESTOR,
    );

    await varredor().executarCiclo();

    expect(await estado(meu)).toBe('aguardando');
    expect(await avisosDe(meu)).toHaveLength(0);
  });

  it('AC-009 — a borda SEMIABERTA avisa: ocupação viva às 11h não segura o slot das 10h', async () => {
    const eu = await aluno();
    const dono = await aluno();
    await avulsa({ alunoId: dono.alunoId, inicio: '11:00', fim: '12:00' });
    const meu = await pedido({ alunoId: eu.alunoId });

    await varredor().executarCiclo();

    expect(await estado(meu)).toBe('avisada');
  });

  // ==========================================================================
  // O que termina SEM aviso
  // ==========================================================================

  it('AC-011 — o horário começou sem vagar: `expirada`, sem aviso', async () => {
    const eu = await aluno();
    const dono = await aluno();
    await avulsa({ alunoId: dono.alunoId, dia: emDias(0) });
    const meu = await pedido({
      alunoId: eu.alunoId,
      dia: emDias(0),
      inicioEmSql: `now() - interval '1 second'`,
    });

    const r = await varredor().executarCiclo();

    expect(await estado(meu)).toBe('expirada');
    expect(r.expiradas).toBeGreaterThanOrEqual(1);
    expect(await avisosDe(meu)).toHaveLength(0);
  });

  it('AC-012 — livre mas QUADRA INATIVA: sem aviso, continua `aguardando`', async () => {
    const eu = await aluno();
    const meu = await pedido({ alunoId: eu.alunoId, quadra: QUADRA_INATIVA });

    await varredor().executarCiclo();

    expect(await estado(meu)).toBe('aguardando');
    expect(await avisosDe(meu)).toHaveLength(0);
  });

  it('AC-012 — livre mas FORA DO EXPEDIENTE: sem aviso, continua `aguardando`, e vai para o fim do rodízio', async () => {
    const eu = await aluno();
    // Sem horário configurado, vale 06h–22h: o slot das 22h está fora.
    const meu = await pedido({ alunoId: eu.alunoId, hora: '22:00' });

    await varredor().executarCiclo();

    const linha = await db.preReserva.findUniqueOrThrow({ where: { id: meu } });
    expect(linha.estado).toBe('aguardando');
    expect(linha.verificadaEm).not.toBeNull();
    expect(await avisosDe(meu)).toHaveLength(0);
  });

  it('AC-013 — quem deixou de operar é `encerrada`, SEM aviso; os outros do slot são avisados', async () => {
    const ativo = await aluno();
    const desligado = await aluno('inativo');
    const doAtivo = await pedido({ alunoId: ativo.alunoId });
    const doDesligado = await pedido({ alunoId: desligado.alunoId });

    const r = await varredor().executarCiclo();

    expect(await estado(doAtivo)).toBe('avisada');
    expect(await estado(doDesligado)).toBe('encerrada');
    expect(await avisosDe(doDesligado)).toHaveLength(0);
    expect(r.avisadas).toBe(1);
  });

  it('AC-014 — o aluno reservou o slot ele mesmo: `encerrada`, `reservou`, sem aviso', async () => {
    const eu = await aluno();
    const meu = await pedido({ alunoId: eu.alunoId });
    await avulsa({ alunoId: eu.alunoId });

    await varredor().executarCiclo();

    const linha = await db.preReserva.findUniqueOrThrow({ where: { id: meu } });
    expect(linha.estado).toBe('encerrada');
    expect(linha.motivoFim).toBe('reservou');
    expect(await avisosDe(meu)).toHaveLength(0);
  });

  // ==========================================================================
  // AC-017 — o aviso, comparado INTEIRO com o molde da D8
  // ==========================================================================

  it('AC-017 — título, corpo, destino e expiração; e o corpo NÃO leva o nome da quadra', async () => {
    const eu = await aluno();
    const meu = await pedido({ alunoId: eu.alunoId, hora: '19:00' });

    await varredor().executarCiclo();

    const [aviso] = await avisosDe(meu);
    const [ano, mes, dia] = DIA.split('-');
    void ano;
    expect({
      destinatarioId: aviso.destinatarioId,
      titulo: aviso.titulo,
      corpo: aviso.corpo,
      destinoUrl: aviso.destinoUrl,
      expiraEm: aviso.expiraEm?.toISOString(),
    }).toEqual({
      destinatarioId: eu.usuarioId,
      titulo: 'Horário livre',
      corpo: `O horário de ${dia}/${mes} às 19:00 que você esperava vagou. Quem reservar primeiro fica com ele.`,
      destinoUrl: `/quadras/${QUADRA}?data=${DIA}`,
      expiraEm: instanteNoFusoDoClube(
        parseDateOnly(DIA),
        parseTimeOnly('19:00'),
      ).toISOString(),
    });
    // A sentinela, sem caixa e sem acento: a igualdade pega qualquer texto a
    // mais; esta pega o dia em que o molde E o teste mudarem juntos para pôr o
    // nome.
    const normalizar = (s: string) =>
      s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    expect(normalizar(aviso.corpo)).not.toContain(normalizar(NOME_SENTINELA));
  });

  // ==========================================================================
  // AC-023 — o relógio é o do banco
  // ==========================================================================

  it('AC-023 (expiração) — um minuto antes do início, continua; um segundo depois, expira', async () => {
    const eu = await aluno();
    const dono = await aluno();
    // Ocupado nos dois casos: o que está em julgamento é SÓ o relógio.
    await avulsa({
      alunoId: dono.alunoId,
      dia: emDias(0),
      inicio: '06:00',
      fim: '22:00',
    });
    const antes = await pedido({
      alunoId: eu.alunoId,
      dia: emDias(0),
      hora: '10:00',
      inicioEmSql: `now() + interval '1 minute'`,
    });
    const depois = await pedido({
      alunoId: eu.alunoId,
      dia: emDias(0),
      hora: '11:00',
      inicioEmSql: `now() - interval '1 second'`,
    });

    await varredor().executarCiclo();

    expect(await estado(antes)).toBe('aguardando');
    expect(await estado(depois)).toBe('expirada');
  });

  // ==========================================================================
  // AC-027 — o rodízio, com orçamento, em três metades
  // ==========================================================================

  it('AC-027/1 — o REPROVADO vai para trás: lote 2, dois slots fora do expediente na frente, o terceiro é avisado no 2º ciclo', async () => {
    const eu = await aluno();
    const fora1 = await pedido({
      alunoId: eu.alunoId,
      dia: emDias(3),
      hora: '22:00',
      criadaSegundosAtras: 30,
    });
    const fora2 = await pedido({
      alunoId: eu.alunoId,
      dia: emDias(4),
      hora: '22:00',
      criadaSegundosAtras: 20,
    });
    const terceiro = await pedido({
      alunoId: eu.alunoId,
      dia: emDias(5),
      hora: '10:00',
      criadaSegundosAtras: 10,
    });

    const primeiro = await varredor(2).executarCiclo();
    expect(primeiro.examinados).toBe(2);
    expect(await estado(terceiro)).toBe('aguardando');

    await varredor(2).executarCiclo();
    expect(await estado(terceiro)).toBe('avisada');
    for (const id of [fora1, fora2]) {
      const linha = await db.preReserva.findUniqueOrThrow({ where: { id } });
      expect(linha.estado).toBe('aguardando');
      expect(linha.verificadaEm).not.toBeNull();
    }
  });

  it('AC-027/2 — o pedido NOVO não empurra o slot antigo: lote 1, S (verificado em t0 + novo em t2) antes de T (criado em t1)', async () => {
    const a = await aluno();
    const b = await aluno();
    const c = await aluno();
    // S: o pedido de A foi criado há 60 s e verificado há 30 s (t0); o de B foi
    // criado há 10 s (t2). T: o de C foi criado há 20 s (t1). t0 < t1 < t2.
    // E o `inicio_em` de T vem ANTES do de S.
    const sA = await pedido({
      alunoId: a.alunoId,
      dia: emDias(5),
      hora: '10:00',
      criadaSegundosAtras: 60,
      verificadaSegundosAtras: 30,
    });
    const sB = await pedido({
      alunoId: b.alunoId,
      dia: emDias(5),
      hora: '10:00',
      criadaSegundosAtras: 10,
    });
    const tC = await pedido({
      alunoId: c.alunoId,
      dia: emDias(4),
      hora: '10:00',
      criadaSegundosAtras: 20,
    });

    await varredor(1).executarCiclo();
    expect(await estado(sA)).toBe('avisada');
    expect(await estado(sB)).toBe('avisada');
    expect(await estado(tC)).toBe('aguardando');

    await varredor(1).executarCiclo();
    expect(await estado(tC)).toBe('avisada');
  });

  it('AC-027/3 — a profundidade é OBSERVÁVEL, na unidade certa: slots, e não pedidos', async () => {
    const [a1, a2, b1, c1, c2, dono] = [
      await aluno(),
      await aluno(),
      await aluno(),
      await aluno(),
      await aluno(),
      await aluno(),
    ];
    // A: candidato, no expediente, 2 pedidos, a chave mais antiga.
    await pedido({
      alunoId: a1.alunoId,
      dia: emDias(3),
      hora: '10:00',
      criadaSegundosAtras: 50,
    });
    await pedido({
      alunoId: a2.alunoId,
      dia: emDias(3),
      hora: '10:00',
      criadaSegundosAtras: 40,
    });
    // B: candidato, FORA do expediente, 1 pedido.
    await pedido({
      alunoId: b1.alunoId,
      dia: emDias(3),
      hora: '22:00',
      criadaSegundosAtras: 30,
    });
    // C: pedido vivo, mas OCUPADO, 2 pedidos.
    await avulsa({
      alunoId: dono.alunoId,
      dia: emDias(4),
      inicio: '10:00',
      fim: '11:00',
    });
    await pedido({
      alunoId: c1.alunoId,
      dia: emDias(4),
      hora: '10:00',
      criadaSegundosAtras: 20,
    });
    await pedido({
      alunoId: c2.alunoId,
      dia: emDias(4),
      hora: '10:00',
      criadaSegundosAtras: 10,
    });

    const r = await varredor(1).executarCiclo();

    const { duracaoMs, ...numeros } = r;
    expect(numeros).toEqual({
      expiradas: 0,
      encerradas: 0,
      candidatos: 2,
      slotsPendentes: 3,
      examinados: 1,
      avisadas: 2,
    });
    expect(typeof duracaoMs).toBe('number');
    // Nenhum id no que vai para o log: só números.
    expect(Object.values(r).every((v) => typeof v === 'number')).toBe(true);
  });
});
