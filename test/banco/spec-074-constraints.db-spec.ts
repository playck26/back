/**
 * SPEC-074/TASK-001 — **a pré-reserva contra o banco de verdade.**
 *
 * Nada do que está em julgamento aqui existe em TypeScript: três CHECK, um
 * índice único parcial, duas FKs compostas, um trigger, e o par índice + CHECK
 * do aviso em `notificacoes`. Um mock não tem constraint — por isso cada prova
 * é SQL direto, escrito por alguém que ignorou todos os serviços. Mesmo molde
 * do `spec-064-lista-de-espera.db-spec.ts`.
 *
 * **Recusado com o SQLSTATE certo E pela constraint certa**, as duas coisas: um
 * `INSERT` que morresse num enum passaria verde por qualquer `rejects`. Para
 * `23505` o Prisma traz a LISTA DE COLUNAS da chave, e não o nome do índice —
 * medido na SPEC-064 —, então ali o identificador é a lista.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA_A = '074c0740-0000-4000-8000-00000000000a';
const EMPRESA_B = '074c0740-0000-4000-8000-00000000000b';
const QUADRA_A = '074c0740-0000-4000-8000-00000000001a';
/** Segunda quadra da MESMA empresa: é com ela que a troca de `quadra_id` na
 *  AC-028 chega ao trigger, e não à FK. */
const QUADRA_A2 = '074c0740-0000-4000-8000-00000000001c';
const QUADRA_B = '074c0740-0000-4000-8000-00000000001b';
const USUARIO_A = '074c0740-0000-4000-8000-00000000002a';
const USUARIO_A2 = '074c0740-0000-4000-8000-00000000002c';
const USUARIO_B = '074c0740-0000-4000-8000-00000000002b';
const ALUNO_A = '074c0740-0000-4000-8000-00000000003a';
const ALUNO_A2 = '074c0740-0000-4000-8000-00000000003c';
const ALUNO_B = '074c0740-0000-4000-8000-00000000003b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const ler = <T>(sql: string) => db.$queryRawUnsafe<T[]>(sql);

function textoDoErro(erro: unknown): string {
  const e = erro as { message?: string; meta?: unknown };
  return `${e.message ?? ''} ${JSON.stringify(e.meta ?? {})}`;
}

async function recusa(
  sql: string,
  sqlstate: string,
  identificador: string,
): Promise<void> {
  const erro: unknown = await q(sql).then(
    () => null,
    (e: unknown) => e,
  );
  expect(erro).not.toBeNull();
  const texto = textoDoErro(erro);
  expect(texto).toContain(sqlstate);
  expect(texto).toContain(identificador);
}

let seq = 0;
function novoId(): string {
  seq += 1;
  return `074c0740-0000-4000-8000-1${String(seq).padStart(11, '0')}`;
}

/** Um pedido, por padrão `aguardando` no slot das 10h daqui a três dias. */
function pedido(opcoes: {
  id?: string;
  empresa?: string;
  aluno?: string;
  quadra?: string;
  hora?: string;
  horaFim?: string;
  estado?: string;
  concluida?: boolean;
  avisada?: boolean;
}): { id: string; sql: string } {
  const id = opcoes.id ?? novoId();
  const hora = opcoes.hora ?? '10:00';
  const horaFim = opcoes.horaFim ?? '11:00';
  const sql = `INSERT INTO pre_reservas
      (id,company_id,aluno_id,quadra_id,data,hora_inicio,hora_fim,inicio_em,estado,concluida_em,avisada_em)
    VALUES ('${id}','${opcoes.empresa ?? EMPRESA_A}','${opcoes.aluno ?? ALUNO_A}',
            '${opcoes.quadra ?? QUADRA_A}',CURRENT_DATE + 3,'${hora}','${horaFim}',
            now() + interval '3 days','${opcoes.estado ?? 'aguardando'}',
            ${opcoes.concluida ? 'now()' : 'NULL'},${opcoes.avisada ? 'now()' : 'NULL'})`;
  return { id, sql };
}

function aviso(opcoes: {
  origem: string | null;
  destinatario?: string;
  tipo?: string;
  sufixo?: string;
}): string {
  return `INSERT INTO notificacoes (id,company_id,destinatario_id,origem_id,tipo,titulo,corpo)
    VALUES (gen_random_uuid(),'${EMPRESA_A}','${opcoes.destinatario ?? USUARIO_A}',
            ${opcoes.origem ? `'${opcoes.origem}'` : 'NULL'},
            '${opcoes.tipo ?? 'pre_reserva'}','Horário livre','corpo')${opcoes.sufixo ?? ''}`;
}

async function montar(): Promise<void> {
  for (const [emp, nome] of [
    [EMPRESA_A, 'A'],
    [EMPRESA_B, 'B'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${emp}','SPEC-074 ${nome}','spec-074-${nome.toLowerCase()}-${emp}',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${emp}','Tenis',0,now())`,
    );
  }
  for (const [quadra, emp] of [
    [QUADRA_A, EMPRESA_A],
    [QUADRA_A2, EMPRESA_A],
    [QUADRA_B, EMPRESA_B],
  ] as const) {
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadra}','${emp}','Q',(SELECT id FROM esportes_de_quadra WHERE company_id='${emp}' LIMIT 1),80)`,
    );
  }
  for (const [usuario, aluno, emp, sufixo] of [
    [USUARIO_A, ALUNO_A, EMPRESA_A, 'a'],
    [USUARIO_A2, ALUNO_A2, EMPRESA_A, 'a2'],
    [USUARIO_B, ALUNO_B, EMPRESA_B, 'b'],
  ] as const) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuario}','spec074-${sufixo}@teste.local','x','U','aluno','${emp}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${aluno}','${usuario}','${emp}','aprovado')`,
    );
  }
}

async function limparPedidos(): Promise<void> {
  await q(
    `DELETE FROM notificacoes WHERE company_id IN ('${EMPRESA_A}','${EMPRESA_B}')`,
  );
  await q(
    `DELETE FROM pre_reservas WHERE company_id IN ('${EMPRESA_A}','${EMPRESA_B}')`,
  );
}

beforeAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await montar();
});

beforeEach(limparPedidos);

afterAll(async () => {
  for (const emp of [EMPRESA_A, EMPRESA_B]) await limparEmpresa(db, emp);
  await db.$disconnect();
});

describe('SPEC-074/TASK-001 — a pré-reserva, como o banco a garante', () => {
  // ========================================================================
  // INV-074a — um pedido VIVO por aluno e slot, e o índice é PARCIAL
  // ========================================================================

  it('INV-074a — o mesmo aluno, o mesmo slot, dois pedidos vivos → 23505', async () => {
    await q(pedido({}).sql);
    await recusa(
      pedido({}).sql,
      '23505',
      '(company_id, aluno_id, quadra_id, data, hora_inicio)',
    );
  });

  it('AC-003 (banco) — cancelado e avisado NÃO impedem o próximo pedido: o índice é parcial', async () => {
    await q(pedido({ estado: 'cancelada', concluida: true }).sql);
    await q(pedido({ estado: 'avisada', concluida: true, avisada: true }).sql);
    await q(pedido({}).sql);

    const [linha] = await ler<{ n: bigint }>(
      `SELECT count(*) AS n FROM pre_reservas WHERE aluno_id = '${ALUNO_A}'`,
    );
    expect(Number(linha.n)).toBe(3);
  });

  it('INV-074a é por ALUNO — outro aluno no mesmo slot passa (é o que deixa avisar todos)', async () => {
    await q(pedido({}).sql);
    await q(pedido({ aluno: ALUNO_A2 }).sql);

    const [linha] = await ler<{ n: bigint }>(
      `SELECT count(*) AS n FROM pre_reservas WHERE quadra_id = '${QUADRA_A}' AND estado = 'aguardando'`,
    );
    expect(Number(linha.n)).toBe(2);
  });

  // ========================================================================
  // INV-074b, INV-074c, INV-074f — os três CHECK
  // ========================================================================

  it('INV-074b — `aguardando` com `concluida_em` → 23514', async () => {
    await recusa(
      pedido({ concluida: true }).sql,
      '23514',
      'pre_reserva_conclusao_chk',
    );
  });

  it('INV-074b — terminal SEM `concluida_em` → 23514', async () => {
    await recusa(
      pedido({ estado: 'cancelada' }).sql,
      '23514',
      'pre_reserva_conclusao_chk',
    );
  });

  it('INV-074c — `avisada` sem `avisada_em` → 23514', async () => {
    await recusa(
      pedido({ estado: 'avisada', concluida: true }).sql,
      '23514',
      'pre_reserva_aviso_chk',
    );
  });

  it('INV-074f — o fim não vem antes do início, nem junto com ele', async () => {
    await recusa(
      pedido({ hora: '11:00', horaFim: '10:00' }).sql,
      '23514',
      'pre_reserva_faixa_chk',
    );
    await recusa(
      pedido({ hora: '10:00', horaFim: '10:00' }).sql,
      '23514',
      'pre_reserva_faixa_chk',
    );
  });

  // ========================================================================
  // INV-074e — a pré-reserva não cruza empresa
  // ========================================================================

  it('INV-074e — aluno de OUTRA empresa → 23503', async () => {
    await recusa(
      pedido({ aluno: ALUNO_B }).sql,
      '23503',
      'pre_reserva_aluno_fkey',
    );
  });

  it('INV-074e — quadra de OUTRA empresa → 23503', async () => {
    await recusa(
      pedido({ quadra: QUADRA_B }).sql,
      '23503',
      'pre_reserva_quadra_fkey',
    );
  });

  // ========================================================================
  // AC-028 / INV-074h — o slot e o instante não mudam depois da criação
  // ========================================================================

  it.each([
    ['inicio_em', `inicio_em = inicio_em + interval '3 hours'`],
    ['data', `data = data + 1`],
    ['hora_inicio', `hora_inicio = '09:00'`],
    ['hora_fim', `hora_fim = '12:00'`],
    ['quadra_id', `quadra_id = '${QUADRA_A2}'`],
    ['aluno_id', `aluno_id = '${ALUNO_A2}'`],
  ])(
    'AC-028 — trocar `%s` numa pré-reserva → 23514, pelo trigger',
    async (_coluna, atribuicao) => {
      const { id, sql } = pedido({});
      await q(sql);
      await recusa(
        `UPDATE pre_reservas SET ${atribuicao} WHERE id = '${id}'`,
        '23514',
        'o slot de uma pre-reserva nao muda depois de criado',
      );
    },
  );

  it('AC-028 — o que o produto muda passa: estado, conclusão e `verificada_em`', async () => {
    const { id, sql } = pedido({});
    await q(sql);
    await q(`UPDATE pre_reservas SET verificada_em = now() WHERE id = '${id}'`);
    await q(
      `UPDATE pre_reservas SET estado = 'cancelada', concluida_em = now(), motivo_fim = 'x' WHERE id = '${id}'`,
    );

    const [linha] = await ler<{ estado: string; verificada: boolean }>(
      `SELECT estado::text AS estado, verificada_em IS NOT NULL AS verificada FROM pre_reservas WHERE id = '${id}'`,
    );
    expect(linha).toEqual({ estado: 'cancelada', verificada: true });
  });

  // ========================================================================
  // AC-026 (banco) / INV-074d — um aviso por pré-reserva, nas duas pontas
  // ========================================================================

  it('INV-074d — um segundo aviso da mesma pré-reserva, por escrita DIRETA → 23505', async () => {
    const { id, sql } = pedido({});
    await q(sql);
    await q(aviso({ origem: id }));
    await recusa(
      aviso({ origem: id }),
      '23505',
      '(origem_id, destinatario_id)',
    );
  });

  it('AC-026 — pelo comando do VARREDOR (`ON CONFLICT … DO NOTHING`): zero linhas, sem erro, e a transação continua', async () => {
    const { id, sql } = pedido({});
    await q(sql);
    await q(aviso({ origem: id }));

    const inseridas = await db.$transaction(async (tx) => {
      const n = await tx.$executeRawUnsafe(
        aviso({
          origem: id,
          sufixo: ` ON CONFLICT (origem_id, destinatario_id) WHERE tipo = 'pre_reserva' DO NOTHING`,
        }),
      );
      // A prova de que a transação continua viva: uma escrita DEPOIS do
      // conflito, na mesma transação, que tem de comitar.
      await tx.$executeRawUnsafe(
        `UPDATE pre_reservas SET verificada_em = now() WHERE id = '${id}'`,
      );
      return n;
    });

    expect(inseridas).toBe(0);
    const [linha] = await ler<{ verificada: boolean; avisos: bigint }>(
      `SELECT p.verificada_em IS NOT NULL AS verificada,
              (SELECT count(*) FROM notificacoes n WHERE n.origem_id = p.id) AS avisos
         FROM pre_reservas p WHERE p.id = '${id}'`,
    );
    expect(linha.verificada).toBe(true);
    expect(Number(linha.avisos)).toBe(1);
  });

  it('INV-074d — `tipo = pre_reserva` sem origem → 23514 (sem ele, NULL não colidiria com NULL)', async () => {
    await recusa(
      aviso({ origem: null }),
      '23514',
      'notificacoes_pre_reserva_tem_origem_chk',
    );
  });

  it('INV-074d é PARCIAL — outro tipo, com a mesma origem e o mesmo destinatário, passa', async () => {
    const { id, sql } = pedido({});
    await q(sql);
    await q(aviso({ origem: id }));
    await q(aviso({ origem: id, tipo: 'lista_espera' }));

    const [linha] = await ler<{ n: bigint }>(
      `SELECT count(*) AS n FROM notificacoes WHERE origem_id = '${id}'`,
    );
    expect(Number(linha.n)).toBe(2);
  });
});
