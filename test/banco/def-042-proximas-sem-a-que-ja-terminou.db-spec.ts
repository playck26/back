/**
 * DEF-042 — **"próximas aulas" mostrava a aula de hoje que já terminou.**
 *
 * Teste do Israel em produção (2026-11-13): às 10h30 a aula das 9h às 10h
 * seguia na aba Lista com "Vou faltar", e o toque dava "Avisar ou retirar o
 * aviso exige 1h de antecedência". A rota paginada filtrava `data >= hoje`.
 *
 * Decisão do Israel: **só sai a que já terminou** — corte pelo FIM, a aula
 * em andamento fica — e "Aulas que já passaram" não muda (a de hoje aparece
 * lá no dia seguinte, LIM-025d). A janela por datas (Home e Semana) também
 * não muda: ela pede um intervalo de dias e recebe o intervalo inteiro.
 *
 * Só o `Date` é falso (10h30 de hoje no fuso do clube); timers reais, para o
 * Prisma funcionar.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { StudentsService } from '../../src/people/students.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import {
  formatDateOnly,
  hojeNoFusoDoClube,
  instanteNoFusoDoClube,
  parseTimeOnly,
} from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { comNivelDaFixture, primeiroNivelSql } from './nivel-da-fixture';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04200000-0000-4000-8000-000000000001';
const TURMA = '04200000-0000-4000-8000-00000000000a';
const USUARIO = '04200000-0000-4000-8000-100000000001';
const ALUNO = '04200000-0000-4000-8000-200000000001';
const quadra = (n: number) =>
  `04200000-0000-4000-8000-0000000000${String(n).padStart(2, '0')}`;

// Lido ANTES de o relógio ser trocado: o dia real, no fuso do clube.
const DIA = hojeNoFusoDoClube();
const HOJE = formatDateOnly(DIA);
const emDias = (n: number) =>
  formatDateOnly(new Date(DIA.getTime() + n * 86_400_000));
const AGORA = instanteNoFusoDoClube(DIA, parseTimeOnly('10:30'));

const db = new PrismaClient();
const p = db as unknown as PrismaService;
const q = (sql: string) => db.$executeRawUnsafe(sql);

function classes(): ClassesService {
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

let ocSeq = 0;
/** Uma aula da turma dele; cada uma na sua quadra, para não colidirem. */
async function aula(data: string, inicio: string, fim: string) {
  ocSeq += 1;
  const id = `04200000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${quadra(ocSeq)}','${data}','${inicio}','${fim}','TURMA','${TURMA}','pendente_pagamento',now())`,
  );
  return id;
}

beforeAll(async () => {
  jest.useFakeTimers({
    now: AGORA,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
  await limparEmpresa(db, EMPRESA);
  await q(
    comNivelDaFixture(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','DEF-042','def-042-${EMPRESA}',now())`,
    ),
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  for (let n = 1; n <= 6; n += 1) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${quadra(n)}','${EMPRESA}','Q${n}','${esporte.id}',80,'ativa')`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status,nivel_id) VALUES ('${TURMA}','${EMPRESA}','Turma','${quadra(1)}',30,'ativa',${primeiroNivelSql(`'${EMPRESA}'`)})`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','def042@x.com','h','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado','ativo')`,
  );
  await q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${ALUNO}',now())`,
  );

  await aula(emDias(-1), '09:00', '10:00'); // ontem
  await aula(HOJE, '09:00', '10:00'); // terminou às 10h
  await aula(HOJE, '09:30', '10:30'); // termina EXATAMENTE agora
  await aula(HOJE, '10:00', '11:00'); // em andamento
  await aula(HOJE, '11:00', '12:00'); // dentro do prazo de 1h, mas fica
  await aula(emDias(1), '08:00', '09:00'); // amanhã
});

afterAll(async () => {
  jest.useRealTimers();
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

const rotulo = (a: { data: string; horaInicio: string; horaFim: string }) =>
  `${a.data === HOJE ? 'hoje' : a.data} ${a.horaInicio}-${a.horaFim}`;

describe('DEF-042 — próximas aulas sem a de hoje que já terminou', () => {
  it('o relógio do serviço está às 10h30 do clube', () => {
    expect(new Date().getTime()).toBe(AGORA.getTime());
  });

  it('a aba Lista: sai a que terminou (e a que termina agora); fica a em andamento e as seguintes', async () => {
    const r = await classes().listProximasAulasPaginadas(EMPRESA, USUARIO);
    expect(r.data.map(rotulo)).toEqual([
      'hoje 10:00-11:00',
      'hoje 11:00-12:00',
      `${emDias(1)} 08:00-09:00`,
    ]);
    // O total do cabeçalho ("10 próximas") conta o mesmo recorte.
    expect(r.total).toBe(3);
  });

  it('a janela por datas (Home e Semana) NÃO muda: o dia de hoje vem inteiro', async () => {
    const janela = await classes().myUpcomingClasses(EMPRESA, USUARIO, {
      de: HOJE,
      ate: HOJE,
    });
    expect(janela.map(rotulo)).toEqual([
      'hoje 09:00-10:00',
      'hoje 09:30-10:30',
      'hoje 10:00-11:00',
      'hoje 11:00-12:00',
    ]);
  });
});
