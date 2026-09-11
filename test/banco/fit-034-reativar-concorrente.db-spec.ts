/**
 * SPEC-035/TASK-005 — **FIT-034: reativar uma aula × reservar a quadra, ao
 * mesmo tempo, no mesmo horário.**
 *
 * ## Por que sequencial não prova nada
 *
 * Em sequência, quem chega depois é recusado pela **pré-checagem**: o
 * `reativarOcorrencia` consulta se alguém tomou o horário, e o `createBooking`
 * consulta o `findConflito`. As duas consultas são boas e **nenhuma é a
 * garantia** — entre ler "livre" e escrever existe uma janela, e nela os dois
 * caminhos veem o mesmo "livre".
 *
 * **Quem fecha a janela é a `EXCLUDE no_overlap_por_quadra`**, e é aqui que
 * ela é exercitada num arranjo novo: até esta spec, ela só via `INSERT`.
 * Descancelar é um `UPDATE` que **entra** no índice parcial (`WHERE
 * status_pagamento <> 'cancelado'`), e um índice parcial que ninguém viu
 * recusar um `UPDATE` é uma promessa, não uma prova.
 *
 * ## O que se afirma, e o que não
 *
 * Afirma-se o **efeito**: exatamente uma ocupação viva naquele horário, e o
 * perdedor recebendo `409` — nunca `500`, nunca duas. **Não** se afirma qual
 * dos dois vence: isso depende de quem chega primeiro ao índice, e um teste
 * que exigisse um vencedor fixo estaria medindo o escalonador do Postgres.
 *
 * Também não se afirma que a recusa veio da constraint e não da pré-checagem
 * — as duas são desfechos legítimos da mesma corrida. O que a corrida elimina
 * é o desfecho **ilegítimo**: duas ocupações vivas no mesmo slot.
 */
import { PrismaClient } from '@prisma/client';
import { ClassesService } from '../../src/classes/classes.service';
import { CourtsService } from '../../src/courts/courts.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';
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

const EMPRESA = 'f0340000-0000-4000-8000-000000000001';
const UADMIN = 'f0340000-0000-4000-8000-000000000002';
const UALUNO = 'f0340000-0000-4000-8000-000000000003';
const ALUNO = 'f0340000-0000-4000-8000-000000000004';
const QUADRA = 'f0340000-0000-4000-8000-000000000005';
const TURMA = 'f0340000-0000-4000-8000-000000000006';

function courts(c: PrismaClient): CourtsService {
  const p = c as unknown as PrismaService;
  return new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    {} as unknown as ImagemDaQuadraService,
    new ConfigOperacaoService(p),
    new CreditosService(),
    { carregarSemana: jest.fn() } as unknown as DisponibilidadeProfessorService,
  );
}
function classes(c: PrismaClient): ClassesService {
  const p = c as unknown as PrismaService;
  return new ClassesService(
    p,
    courts(c),
    {} as unknown as StudentsService,
    new ConfigOperacaoService(p),
  );
}

const servicoReativa = classes(dbA);
const servicoReserva = courts(dbB);

const q = (sql: string) => semear.$executeRawUnsafe(sql);

/**
 * Uma quinta-feira por iteração, **e uma ocupação nova a cada uma**. Datas
 * próprias evitam que a iteração `n` herde o vencedor da `n-1` — o que faria
 * a segunda corrida ser decidida pela pré-checagem, e a janela nunca se
 * abriria.
 */
function dataDaIteracao(i: number): string {
  const base = Date.UTC(2035, 5, 7); // 2035-06-07 é quinta
  return new Date(base + i * 7 * 86_400_000).toISOString().slice(0, 10);
}

/** `{ status, code }` sem deixar exceção nenhuma escapar — inclusive `500`. */
function desfecho(promessa: Promise<unknown>): Promise<{
  status: number;
  code?: string;
}> {
  return promessa
    .then(() => ({ status: 200 }))
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
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','Clube FIT-034','clube-fit-034',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UADMIN}','fit034-admin@t.local','x','Admin','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${UALUNO}','fit034-aluno@t.local','x','Aluno','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id) VALUES ('${ALUNO}','${UALUNO}','${EMPRESA}')`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES ('${QUADRA}','${EMPRESA}','Quadra FIT-034',
             (SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),100)`,
  );
  // Expediente largo: o que tem de recusar é a sobreposição, não o horário.
  for (let dia = 0; dia < 7; dia++) {
    await q(
      `INSERT INTO horarios_funcionamento (id,company_id,quadra_id,dia_semana,fechado,hora_inicio,hora_fim,updated_at)
       VALUES (gen_random_uuid(),'${EMPRESA}',NULL,${dia},false,'06:00','23:00',now())`,
    );
  }
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status)
     VALUES ('${TURMA}','${EMPRESA}','Turma FIT-034','${QUADRA}',20,'ativa')`,
  );
  await q(
    `INSERT INTO turma_encontros (id,turma_id,dia_semana,hora_inicio,hora_fim,created_at)
     VALUES (gen_random_uuid(),'${TURMA}',4,'10:00','11:00',now())`,
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

describe('FIT-034 — reativar e reservar não podem vencer os dois', () => {
  it(`${ITERACOES} pares concorrentes: exatamente UMA ocupação viva, e nunca 500`, async () => {
    const falhas: string[] = [];

    for (let i = 0; i < ITERACOES; i++) {
      const data = dataDaIteracao(i);
      const ocupacaoId = `f0340000-0000-4000-8000-1000000000${String(i).padStart(2, '0')}`;

      // A aula da turma, **cancelada**. Nasce assim no `INSERT`: a trigger
      // `ocupacao_cancelada_exige_evento` é `AFTER UPDATE` e exigiria o evento
      // no mesmo COMMIT — cancelar por `UPDATE` aqui daria `23514`, e o
      // contorno não é fraqueza da fixture, é a INV-064 funcionando.
      await q(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
         VALUES ('${ocupacaoId}','${EMPRESA}','${QUADRA}','${data}','10:00','11:00','TURMA','${TURMA}','cancelado',now())`,
      );

      const [a, b] = await Promise.all([
        desfecho(
          servicoReativa.reativarOcorrencia(
            EMPRESA,
            TURMA,
            ocupacaoId,
            'Foi engano',
            UADMIN,
          ),
        ),
        desfecho(
          servicoReserva.createBooking(
            EMPRESA,
            {
              quadraId: QUADRA,
              data,
              slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
              alunoId: ALUNO,
            },
            UADMIN,
          ),
        ),
      ]);

      const [{ n }] = await semear.$queryRawUnsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ocupacoes_quadra
          WHERE company_id = '${EMPRESA}' AND quadra_id = '${QUADRA}'
            AND data = '${data}'::date AND status_pagamento <> 'cancelado'`,
      );

      // **A afirmação central.** Duas aqui significaria overbooking: a turma
      // de volta e a quadra vendida, no mesmo horário.
      if (n !== 1) {
        falhas.push(
          `i=${i}: ocupacoes vivas=${n} (a=${a.status}, b=${b.status})`,
        );
      }
      const vencedores = [a, b].filter((r) => r.status < 400).length;
      if (vencedores !== 1) {
        falhas.push(
          `i=${i}: vencedores=${vencedores} (a=${a.status}/${a.code}, b=${b.status}/${b.code})`,
        );
      }
      // `500` é o desfecho que existiria se a violação da `EXCLUDE` no
      // `UPDATE` não fosse traduzida — erro cru vazando como falha do
      // servidor, quando o que houve foi uma corrida perdida.
      for (const r of [a, b]) {
        if (r.status === 500) {
          falhas.push(`i=${i}: 500 -> ${r.code}`);
        }
      }
    }

    expect(falhas).toEqual([]);
  });
});
