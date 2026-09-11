/**
 * DEF-026 — **quadra fora de operação continuava sendo vendida, e o gestor
 * não via o que foi vendido.**
 *
 * ## O defeito, medido contra a instância local em 2026-09-10
 *
 * Um aluno de verdade, com saldo de verdade, reservando uma quadra que o
 * gestor tinha acabado de desativar:
 *
 * ```
 * RESERVA em quadra FORA DE OPERACAO    201
 *   status do pagamento                 pago      <- credito debitado
 *   o gestor VE na agenda?              NAO       <- invisivel
 * ```
 *
 * Dinheiro cobrado por uma quadra que não pode ser usada, e **invisível para
 * quem poderia desfazer** — os três filtros de `agenda.service.ts` excluem
 * quadra inativa.
 *
 * ## A frase já estava escrita, no arquivo ao lado
 *
 * `moveBooking` filtra `status: 'ativa'` no destino desde a SPEC-034, com o
 * comentário: *"mover para uma quadra inativa respondia 200 e sumia com a
 * reserva da agenda, que não mostra quadra inativa"*.
 *
 * **A mesma frase valia para CRIAR, e ninguém tinha olhado.** O caminho de
 * escrita foi corrigido num lugar e não no outro.
 *
 * ## E a assimetria que fazia o aluno chegar até lá
 *
 * | Caminho | Filtrava inativa? |
 * |---|---|
 * | `moveBooking` (destino) | **sim** |
 * | `agenda.service` (3 lugares) | **sim** — escondia |
 * | `availability` | **não** — oferecia 13 slots |
 * | `createBooking` | **não** — respondia `201` |
 * | criar turma | **não** — gerava as 8 ocorrências |
 * | lista de quadras | **não** — o aluno via |
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { CourtsService } from '../../src/courts/courts.service';
import { ClassesService } from '../../src/classes/classes.service';
import { HorarioFuncionamentoService } from '../../src/courts/horario-funcionamento.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { CreditosService } from '../../src/creditos/creditos.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import type { StudentsService } from '../../src/people/students.service';
import type { ImagemDaQuadraService } from '../../src/courts/imagem-da-quadra.service';
import type { DisponibilidadeProfessorService } from '../../src/people/disponibilidade-professor.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = 'd0260000-0000-4000-8000-000000000001';
const QUADRA = 'd0260000-0000-4000-8000-000000000002';
const ADMIN = 'd0260000-0000-4000-8000-000000000003';
const USUARIO = 'd0260000-0000-4000-8000-000000000004';
const ALUNO = 'd0260000-0000-4000-8000-000000000005';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function emDias(dias: number): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const FUTURO = emDias(12);

function courts(): CourtsService {
  const p = db as unknown as PrismaService;
  return new CourtsService(
    p,
    { exigirAlunoOperante: () => undefined } as unknown as StudentsService,
    new HorarioFuncionamentoService(p),
    // `toQuadraResponse` chama `resolver()` em toda leitura de quadra; um
    // duble vazio explode com "is not a function", e a mensagem nao diz que a
    // culpa e do teste.
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
    {} as unknown as StudentsService,
    new ConfigOperacaoService(p),
  );
}

async function montar(status: 'ativa' | 'inativa' = 'ativa'): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','DEF-026','def-026-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra DEF-026',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' LIMIT 1),80,'${status}')`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${ADMIN}','admin026@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${USUARIO}','aluno026@teste.local','x','Ana','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${ALUNO}','${USUARIO}','${EMPRESA}','aprovado')`,
  );
}

/** Falha se o pedido PASSAR — `promessa.catch(...)` fica verde no silêncio. */
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

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('DEF-026 — quadra fora de operação não é vendida', () => {
  it('**`availability` não oferece horário nenhum**', async () => {
    await montar('inativa');
    const r = await courts().availability(EMPRESA, QUADRA, FUTURO);

    // Media 13 slots livres antes do conserto.
    expect(r.estado).toBe('fechado');
    expect(r.slots).toEqual([]);
  });

  it('**criar reserva é recusado com `422 QUADRA_INATIVA`**', async () => {
    await montar('inativa');
    const { status, corpo } = await recusa(
      courts().createBooking(
        EMPRESA,
        {
          quadraId: QUADRA,
          data: FUTURO,
          slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
          alunoId: ALUNO,
        },
        ADMIN,
      ),
    );
    // `422` e não `404`: a quadra existe, e o gestor sabe — ele mesmo a
    // desativou. Um `404` o mandaria procurar um id errado.
    expect(status).toBe(422);
    expect(corpo.code).toBe('QUADRA_INATIVA');
  });

  it('e NADA é gravado — a prova é a contagem', async () => {
    await montar('inativa');
    await recusa(
      courts().createBooking(
        EMPRESA,
        {
          quadraId: QUADRA,
          data: FUTURO,
          slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
          alunoId: ALUNO,
        },
        ADMIN,
      ),
    );
    expect(
      await db.ocupacaoQuadra.count({ where: { companyId: EMPRESA } }),
    ).toBe(0);
  });

  it('criar TURMA é recusado pelo mesmo código', async () => {
    await montar('inativa');
    const { status, corpo } = await recusa(
      classes().create(
        EMPRESA,
        {
          nome: 'Turma DEF-026',
          quadraId: QUADRA,
          capacidade: 10,
          encontros: [{ diaSemana: 3, horaInicio: '10:00', horaFim: '11:00' }],
        },
        ADMIN,
      ),
    );
    expect(status).toBe(422);
    expect(corpo.code).toBe('QUADRA_INATIVA');
    // A aula existiria e ninguém a veria: a agenda não mostra quadra inativa.
    expect(await db.turma.count({ where: { companyId: EMPRESA } })).toBe(0);
  });

  it('a quadra ATIVA continua funcionando — o portão não pegou o inocente', async () => {
    await montar('ativa');
    const r = await courts().availability(EMPRESA, QUADRA, FUTURO);
    expect(r.estado).toBe('aberto');
    expect(r.slots.length).toBeGreaterThan(0);

    const reserva = await courts().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: FUTURO,
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ALUNO,
      },
      ADMIN,
    );
    // `createBooking` devolve uma UNIAO (formato antigo x novo, SPEC-011); o
    // caminho com `slots` cai no ramo com `reservas`, e o `tsc` precisa que
    // isso esteja dito.
    expect((reserva as { reservas: unknown[] }).reservas).toHaveLength(1);
  });
});

describe('DEF-026 — a lista respeita o papel', () => {
  it('**o gestor VÊ a quadra inativa** — é por ela que ele reativa', async () => {
    await montar('inativa');
    const r = await courts().list(EMPRESA, 1, 20, true);
    expect(r.data.map((x) => x.id)).toContain(QUADRA);
  });

  it('**o aluno NÃO vê**', async () => {
    await montar('inativa');
    const r = await courts().list(EMPRESA, 1, 20, false);
    // Ele via, e com 13 horários livres. Com saldo, a reserva ia até o fim.
    expect(r.data.map((x) => x.id)).not.toContain(QUADRA);
    // E o `total` acompanha: uma contagem que ignorasse o filtro faria a
    // paginação prometer uma página que não existe.
    expect(r.total).toBe(0);
  });

  it('quadra ATIVA aparece para os dois', async () => {
    await montar('ativa');
    expect((await courts().list(EMPRESA, 1, 20, true)).data).toHaveLength(1);
    expect((await courts().list(EMPRESA, 1, 20, false)).data).toHaveLength(1);
  });
});

describe('DEF-026 — desativar com compromisso é recusado', () => {
  it('**recusa com `409 QUADRA_COM_COMPROMISSOS`, e diz QUANTOS**', async () => {
    await montar('ativa');
    await courts().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: FUTURO,
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ALUNO,
      },
      ADMIN,
    );

    const { status, corpo } = await recusa(
      courts().update(EMPRESA, QUADRA, { status: 'inativa' } as never),
    );
    expect(status).toBe(409);
    expect(corpo.code).toBe('QUADRA_COM_COMPROMISSOS');
    expect(corpo.total).toBe(1);
    // A amostra diz QUAIS: sem ela o gestor sabe que há um problema e não sabe
    // onde. É a mesma decisão da contagem de conflitos da SPEC-035.
    expect(Array.isArray(corpo.amostra)).toBe(true);
    expect((corpo.amostra as unknown[])[0]).toMatchObject({
      data: FUTURO,
      horaInicio: '10:00',
      origemTipo: 'AVULSO',
    });
  });

  it('e a quadra continua ATIVA — a recusa não deixa meio-caminho', async () => {
    await montar('ativa');
    await courts().createBooking(
      EMPRESA,
      {
        quadraId: QUADRA,
        data: FUTURO,
        slots: [{ horaInicio: '10:00', horaFim: '11:00' }],
        alunoId: ALUNO,
      },
      ADMIN,
    );
    await recusa(
      courts().update(EMPRESA, QUADRA, { status: 'inativa' } as never),
    );
    const quadra = await db.quadra.findUniqueOrThrow({ where: { id: QUADRA } });
    expect(quadra.status).toBe('ativa');
  });

  it('**sem compromisso futuro, desativa normalmente**', async () => {
    await montar('ativa');
    const r = await courts().update(EMPRESA, QUADRA, {
      status: 'inativa',
    } as never);
    expect(r.status).toBe('inativa');
  });

  it('compromisso PASSADO não impede — ele já aconteceu', async () => {
    await montar('ativa');
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${emDias(-20)}','10:00','11:00','AVULSO','${ALUNO}',80,'pago',now())`,
    );
    const r = await courts().update(EMPRESA, QUADRA, {
      status: 'inativa',
    } as never);
    // O corte é `hojeNoFusoDoClube`, e não `now()`: reserva de hoje às 8h com
    // o gestor desativando às 14h já aconteceu, e não é impedimento.
    expect(r.status).toBe('inativa');
  });

  it('compromisso CANCELADO não impede', async () => {
    await montar('ativa');
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,aluno_id,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}','${FUTURO}','10:00','11:00','AVULSO','${ALUNO}',80,'cancelado',now())`,
    );
    const r = await courts().update(EMPRESA, QUADRA, {
      status: 'inativa',
    } as never);
    expect(r.status).toBe('inativa');
  });

  it('REATIVAR nunca é recusado — só desativar é que exige a quadra limpa', async () => {
    await montar('inativa');
    const r = await courts().update(EMPRESA, QUADRA, {
      status: 'ativa',
    } as never);
    // Sem esta linha, uma quadra inativa com ocupação legada ficaria presa:
    // não recebe reserva nova e não consegue voltar.
    expect(r.status).toBe('ativa');
  });
});
