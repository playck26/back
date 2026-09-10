/**
 * SPEC-039/TASK-005 — **FIT-033: dois pedidos de aula para o MESMO professor,
 * no mesmo horário, em quadras DIFERENTES.**
 *
 * ## Por que sequencial não prova nada
 *
 * Em sequência, o segundo pedido é recusado pela **pré-checagem** — a consulta
 * que o gate da TASK-002 faz antes de abrir a transação. Isso é bom, mas não é
 * a garantia: entre ler "não há compromisso" e gravar a ocupação existe uma
 * janela, e nessa janela os dois pedidos veem o mesmo "livre".
 *
 * **Quem fecha essa janela é a `EXCLUDE no_overlap_por_professor`**, e ela só
 * é exercitada com duas conexões. Sem este arquivo, a INV-105 é uma linha de
 * SQL que ninguém viu falhar.
 *
 * ## As quadras são DIFERENTES de propósito
 *
 * Na mesma quadra, quem recusa é a `no_overlap_por_quadra`, que existe desde a
 * SPEC-004 — o teste ficaria verde pela trava ERRADA, provando algo que a
 * SPEC-039 não construiu. **É o único arranjo que distingue as duas travas**, e
 * a mesma razão pela qual o db-spec da TASK-001 usa quadras diferentes.
 *
 * ## O que se afirma, e o que não
 *
 * Afirma-se o **efeito**: exatamente uma aula ativa para o professor naquele
 * horário, e o perdedor recebendo `409 PROFESSOR_INDISPONIVEL` — nunca `500`.
 * O `500` é o desfecho que existia antes da tradução do `23P01`: o erro caía no
 * `findConflito`, que só olha a quadra, e as duas aulas estão em quadras
 * diferentes por definição do caso.
 */
import { PrismaClient } from '@prisma/client';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(180_000);

exigirBancoLocal();

/** Três conexões: duas que disputam, uma que semeia e confere. */
const semear = new PrismaClient();
const dbA = new PrismaClient();
const dbB = new PrismaClient();

const ITERACOES = 10;

const EMPRESA = 'f0390000-0000-4000-8000-000000000001';
const UADMIN = 'f0390000-0000-4000-8000-000000000002';
const UALUNO = 'f0390000-0000-4000-8000-000000000003';
const ALUNO = 'f0390000-0000-4000-8000-000000000004';
const QUADRA_1 = 'f0390000-0000-4000-8000-000000000005';
const QUADRA_2 = 'f0390000-0000-4000-8000-000000000006';
const PROF = 'f0390000-0000-4000-8000-000000000007';

function servico(c: PrismaClient): CourtsService {
  const p = c as unknown as PrismaService;
  return new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(p),
    new CreditosService(),
    // **Serviço de verdade, e na conexão de quem disputa.** Um dublê aqui
    // pularia a leitura da janela dentro da corrida — que é parte do caminho
    // que está sendo medido.
    new DisponibilidadeProfessorService(p),
  );
}
const servicoA = servico(dbA);
const servicoB = servico(dbB);

const q = (sql: string) => semear.$executeRawUnsafe(sql);

/**
 * Uma quinta-feira por iteração. Datas próprias evitam que a iteração `n`
 * herde a aula da `n-1` — o que faria o segundo pedido ser recusado pela
 * pré-checagem, e a corrida nunca aconteceria.
 */
const DIA_SEMANA = 4;
function dataDaIteracao(i: number): string {
  // 2035-06-07 é quinta; +7 dias por iteração mantém o dia da semana.
  const base = Date.UTC(2035, 5, 7);
  const d = new Date(base + i * 7 * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function pedir(
  s: CourtsService,
  quadraId: string,
  data: string,
): Promise<{ status: number; code?: string }> {
  return s
    .createBooking(
      EMPRESA,
      {
        quadraId,
        data,
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ALUNO,
        professorId: PROF,
        valor: 100,
      },
      UADMIN,
    )
    .then(() => ({ status: 201 }))
    .catch((erro: unknown) => {
      const e = erro as {
        getStatus?: () => number;
        getResponse?: () => { code?: string };
        message?: string;
      };
      return {
        status: e.getStatus?.() ?? 500,
        code: e.getResponse?.()?.code ?? e.message,
      };
    });
}

beforeAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube FIT-033','clube-fit-033',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UADMIN}','fit033-admin@t.local','x','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','fit033-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,status) VALUES ('${PROF}','${EMPRESA}','Prof FIT','ativo')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  for (const [id, nome] of [
    [QUADRA_1, 'Q1'],
    [QUADRA_2, 'Q2'],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
       VALUES ('${id}','${EMPRESA}','${nome}',
               (SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
    );
  }
  // Expediente largo: o que tem de recusar é o professor, não a quadra.
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
  await q(
    `INSERT INTO disponibilidades_professor (id,company_id,professor_id,dia_semana,hora_inicio,hora_fim,updated_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','${PROF}',${DIA_SEMANA},'08:00','20:00',now())`,
  );
});

afterAll(async () => {
  await limparEmpresa(semear, EMPRESA);
  await Promise.all([
    semear.$disconnect(),
    dbA.$disconnect(),
    dbB.$disconnect(),
  ]);
});

describe('FIT-033 — o professor não fica em duas quadras ao mesmo tempo', () => {
  it(`${ITERACOES} pares concorrentes: exatamente um 201, um 409 PROFESSOR_INDISPONIVEL, nunca 500`, async () => {
    const falhas: string[] = [];

    for (let i = 0; i < ITERACOES; i++) {
      const data = dataDaIteracao(i);

      // As duas conexões pedem ao mesmo tempo, em quadras DIFERENTES: a trava
      // da quadra não tem o que dizer aqui.
      const [a, b] = await Promise.all([
        pedir(servicoA, QUADRA_1, data),
        pedir(servicoB, QUADRA_2, data),
      ]);

      const [{ n }] = await semear.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ocupacoes_quadra
          WHERE company_id = '${EMPRESA}' AND professor_id = '${PROF}'
            AND data = '${data}'::date AND status_pagamento <> 'cancelado'`,
      );

      const codigos = [a.status, b.status].sort((x, y) => x - y);
      const problemas: string[] = [];
      if (codigos[0] !== 201 || codigos[1] !== 409) {
        problemas.push(`status=${a.status}/${b.status}`);
      }
      // **O `500` é o desfecho que existia antes da tradução do `23P01`.**
      // Nomeá-lo separado importa: `status=500/201` já falharia acima, mas a
      // mensagem não diria que o erro subiu cru.
      if (a.status === 500 || b.status === 500) {
        problemas.push(`erro cru: ${a.code ?? ''} ${b.code ?? ''}`);
      }
      const perdedor = a.status === 409 ? a : b.status === 409 ? b : null;
      if (perdedor && perdedor.code !== 'PROFESSOR_INDISPONIVEL') {
        problemas.push(`perdedor com code=${String(perdedor.code)}`);
      }
      // O EFEITO, e não só os códigos: uma aula ativa, nunca duas.
      if (n !== 1) problemas.push(`aulas ativas=${n}`);

      if (problemas.length) {
        falhas.push(`iteração ${i + 1}: ${problemas.join(', ')}`);
      }
    }

    expect(falhas).toEqual([]);
  });

  it('a trava da QUADRA continua valendo — o arranjo não a desligou', async () => {
    // Controle. Se este caso ficasse verde por acidente, o de cima poderia
    // estar medindo a trava errada sem ninguém notar.
    const data = dataDaIteracao(ITERACOES + 1);
    const [a, b] = await Promise.all([
      pedir(servicoA, QUADRA_1, data),
      // MESMA quadra: aqui quem recusa é `no_overlap_por_quadra`.
      pedir(servicoB, QUADRA_1, data),
    ]);
    const codigos = [a.status, b.status].sort((x, y) => x - y);
    expect(codigos).toEqual([201, 409]);
  });
});
