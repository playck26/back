/**
 * SPEC-064/TASK-002 — **entrar e sair da fila, contra o banco de verdade.**
 *
 * ## Por que banco, e não um teste de serviço com mock
 *
 * A AC-001 diz *"entrar duas vezes → `23505` → `409 JA_NA_FILA`"*. **Não há
 * pré-checagem no serviço**: o índice único parcial é o mecanismo, e o `catch`
 * é só o tradutor. Um mock devolveria o que eu mandasse ele devolver — provaria
 * que o `catch` traduz, que é a metade que não está em dúvida.
 *
 * A outra metade em julgamento é a **elegibilidade por crédito** (AC-002), e
 * crédito neste sistema é **derivado**: não existe coluna de saldo, é
 * `faltas válidas − reposições`. Montar isso com dublê seria reescrever a
 * SPEC-046 dentro do teste.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { FilaDeEsperaService } from '../../src/fila-de-espera/fila-de-espera.service';
import { ConfigOperacaoService } from '../../src/company-settings/config-operacao.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '06400000-0000-4000-8000-000000000001';
const QUADRA = '06400000-0000-4000-8000-000000000002';
const TURMA_A = '06400000-0000-4000-8000-00000000000a';
const TURMA_B = '06400000-0000-4000-8000-00000000000b';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);

function servico(): FilaDeEsperaService {
  const p = db as unknown as PrismaService;
  return new FilaDeEsperaService(p, new ConfigOperacaoService(p));
}

/** Data relativa a HOJE **no fuso do clube**, não em UTC.
 *  O `spec-046` pagou esta lição com um CI vermelho às 22h locais. */
function emDias(dias: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

/** O código de erro que o serviço devolveu, ou `null` se ele não recusou. */
async function codigoDaRecusa(acao: Promise<unknown>): Promise<string | null> {
  const erro: unknown = await acao.then(
    () => null,
    (e: unknown) => e,
  );
  if (!erro) return null;
  const resposta = (erro as { response?: { code?: string } }).response;
  return resposta?.code ?? (erro as { name?: string }).name ?? 'SEM_CODIGO';
}

let seq = 0;
async function aluno(nome: string) {
  seq += 1;
  const s = String(seq).padStart(2, '0');
  const usuarioId = `06400000-0000-4000-8000-1000000000${s}`;
  const alunoId = `06400000-0000-4000-8000-2000000000${s}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','s064.${seq}@x.com','h','${nome}','aluno','${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status) VALUES ('${alunoId}','${usuarioId}','${EMPRESA}','aprovado','ativo')`,
  );
  return { alunoId, usuarioId };
}

let ocSeq = 0;
async function ocorrencia(
  turmaId: string,
  data: string,
  hora = '09:00',
  statusPagamento: 'pendente_pagamento' | 'cancelado' = 'pendente_pagamento',
): Promise<string> {
  ocSeq += 1;
  const id = `06400000-0000-4000-8000-3000000000${String(ocSeq).padStart(2, '0')}`;
  const fim = `${String(Number(hora.slice(0, 2)) + 1).padStart(2, '0')}:00`;
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at)
     VALUES ('${id}','${EMPRESA}','${QUADRA}','${data}','${hora}','${fim}','TURMA','${turmaId}','${statusPagamento}',now())`,
  );
  return id;
}

let faltaSeq = 0;
async function falta(alunoId: string, ocupacaoId: string): Promise<string> {
  faltaSeq += 1;
  const id = `06400000-0000-4000-8000-4000000000${String(faltaSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO faltas_avisadas (id,company_id,ocupacao_id,aluno_id,updated_at) VALUES ('${id}','${EMPRESA}','${ocupacaoId}','${alunoId}',now())`,
  );
  return id;
}

let repSeq = 0;
/** Uma reposição já marcada daquela falta, na ocorrência dada. */
async function reposicao(
  faltaId: string,
  alunoId: string,
  ocupacaoId: string,
): Promise<string> {
  repSeq += 1;
  const id = `06400000-0000-4000-8000-5000000000${String(repSeq).padStart(2, '0')}`;
  await q(
    `INSERT INTO reposicoes_de_aula (id,company_id,falta_id,aluno_id,ocupacao_id,origem_tipo)
     VALUES ('${id}','${EMPRESA}','${faltaId}','${alunoId}','${ocupacaoId}','TURMA')`,
  );
  return id;
}

const matricular = (turmaId: string, alunoId: string) =>
  q(
    `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${turmaId}','${alunoId}',now())`,
  );

async function montar(): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','SPEC-064','spec-064-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  const esporte = await db.esporteDeQuadra.findFirstOrThrow({
    where: { companyId: EMPRESA },
    select: { id: true },
  });
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora,status) VALUES ('${QUADRA}','${EMPRESA}','Quadra','${esporte.id}',80,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_A}','${EMPRESA}','Turma A','${QUADRA}',10,'ativa')`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA_B}','${EMPRESA}','Turma B','${QUADRA}',10,'ativa')`,
  );
}

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  seq = 0;
  ocSeq = 0;
  faltaSeq = 0;
  repSeq = 0;
  await montar();
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('SPEC-064/TASK-002 — a fila de TURMA', () => {
  it('entrar cria a linha `aguardando`, sem crédito nenhum', async () => {
    const a = await aluno('Quer vaga');
    const linha = await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);

    expect(linha.estado).toBe('aguardando');
    expect(linha.turmaId).toBe(TURMA_A);
    expect(linha.ocupacaoId).toBeNull();
    // Fila de turma **nunca** precisa de crédito: é vaga de matrícula, e quem
    // se matricula não está repondo nada.
    expect(linha.faltaId).toBeNull();
  });

  it('AC-001 — entrar duas vezes dá `JA_NA_FILA`, e quem impede é o índice', async () => {
    const a = await aluno('Insistente');
    await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);

    expect(
      await codigoDaRecusa(
        servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A),
      ),
    ).toBe('JA_NA_FILA');
  });

  it('duas pessoas na mesma turma convivem — o único é por (aluno, alvo)', async () => {
    const a = await aluno('Primeiro');
    const b = await aluno('Segundo');
    await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);
    await servico().entrarNaTurma(EMPRESA, b.usuarioId, TURMA_A);

    expect(await db.listaDeEspera.count({ where: { turmaId: TURMA_A } })).toBe(
      2,
    );
  });

  it('depois de SAIR dá para entrar de novo — é o `WHERE` do índice', async () => {
    const a = await aluno('Voltou atrás');
    const primeira = await servico().entrarNaTurma(
      EMPRESA,
      a.usuarioId,
      TURMA_A,
    );
    await servico().sair(EMPRESA, a.usuarioId, primeira.id);

    // Sem o `WHERE estado IN ('aguardando','chamado')` no índice, uma única
    // passagem pela fila valeria como proibição permanente.
    const segunda = await servico().entrarNaTurma(
      EMPRESA,
      a.usuarioId,
      TURMA_A,
    );
    expect(segunda.id).not.toBe(primeira.id);
    expect(segunda.estado).toBe('aguardando');
  });

  it('turma fora de operação recusa com `TURMA_INATIVA`', async () => {
    const a = await aluno('Turma morta');
    await q(`UPDATE turmas SET status='inativa' WHERE id='${TURMA_A}'`);

    expect(
      await codigoDaRecusa(
        servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A),
      ),
    ).toBe('TURMA_INATIVA');
  });

  it('quem já está na turma não entra na fila dela', async () => {
    const a = await aluno('Já dentro');
    await matricular(TURMA_A, a.alunoId);

    expect(
      await codigoDaRecusa(
        servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A),
      ),
    ).toBe('JA_MATRICULADO_NA_TURMA');
  });
});

describe('SPEC-064/TASK-002 — a fila de AULA, e o crédito (LIM-064e)', () => {
  it('AC-002 — sem crédito nenhum: `SEM_CREDITO`', async () => {
    const a = await aluno('Sem crédito');
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('SEM_CREDITO');
  });

  it('com crédito, entra E a linha guarda QUAL falta o sustenta', async () => {
    const a = await aluno('Tem crédito');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2));
    const faltaId = await falta(a.alunoId, perdida);
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    const linha = await servico().entrarNaAula(EMPRESA, a.usuarioId, alvo);
    expect(linha.ocupacaoId).toBe(alvo);
    expect(linha.turmaId).toBeNull();
    // D1 — "a linha guarda **qual** `falta_id`".
    expect(linha.faltaId).toBe(faltaId);
  });

  it('escolhe o crédito que VENCE PRIMEIRO — crédito guardado é crédito perdido', async () => {
    const a = await aluno('Dois créditos');
    await matricular(TURMA_A, a.alunoId);
    // A validade padrão é 30 dias a partir da data da falta, então a falta
    // mais ANTIGA é a que vence antes.
    const antiga = await ocorrencia(TURMA_A, emDias(-20), '08:00');
    const recente = await ocorrencia(TURMA_A, emDias(-2), '09:00');
    const faltaAntiga = await falta(a.alunoId, antiga);
    await falta(a.alunoId, recente);
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    const linha = await servico().entrarNaAula(EMPRESA, a.usuarioId, alvo);
    expect(linha.faltaId).toBe(faltaAntiga);
  });

  it('crédito EXPIRADO não serve', async () => {
    const a = await aluno('Tarde demais');
    await matricular(TURMA_A, a.alunoId);
    // 40 dias atrás, com validade padrão de 30.
    const perdida = await ocorrencia(TURMA_A, emDias(-40));
    await falta(a.alunoId, perdida);
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('SEM_CREDITO');
  });

  it('falta de aula que o CLUBE cancelou não é crédito: ele não perdeu nada', async () => {
    const a = await aluno('Clube cancelou');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2), '08:00', 'cancelado');
    await falta(a.alunoId, perdida);
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('SEM_CREDITO');
  });

  it('crédito JÁ REPOSTO não serve', async () => {
    const a = await aluno('Já repôs');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2), '08:00');
    const faltaId = await falta(a.alunoId, perdida);
    const ondeRepos = await ocorrencia(TURMA_B, emDias(1), '10:00');
    await reposicao(faltaId, a.alunoId, ondeRepos);
    const alvo = await ocorrencia(TURMA_B, emDias(3), '11:00');

    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('SEM_CREDITO');
  });

  /**
   * **O caso que justifica a regra estrita**, provado contra o banco.
   *
   * A reposição foi marcada numa aula que o clube depois cancelou. Pela
   * SPEC-046/D7 o crédito "volta sozinho" — e volta **na tela**. Mas a linha de
   * `reposicoes_de_aula` continua lá, e o `marcar` recusa com
   * `FALTA_JA_REPOSTA`.
   *
   * Se a fila usasse o número da tela, esta pessoa entraria, seria chamada e
   * levaria `409` ao confirmar. **Convite que não se pode cumprir é pior que
   * convite nenhum** — é o mesmo raciocínio da LIM-064e.
   */
  it('reposta em aula CANCELADA: o saldo devolve o crédito, a fila não aceita', async () => {
    const a = await aluno('Crédito fantasma');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2), '08:00');
    const faltaId = await falta(a.alunoId, perdida);
    const ondeRepos = await ocorrencia(
      TURMA_B,
      emDias(1),
      '10:00',
      'cancelado',
    );
    await reposicao(faltaId, a.alunoId, ondeRepos);
    const alvo = await ocorrencia(TURMA_B, emDias(3), '11:00');

    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('SEM_CREDITO');
  });

  it('AC-001 — entrar duas vezes na mesma aula dá `JA_NA_FILA`', async () => {
    const a = await aluno('Insistente 2');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2), '08:00');
    await falta(a.alunoId, perdida);
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    await servico().entrarNaAula(EMPRESA, a.usuarioId, alvo);
    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('JA_NA_FILA');
  });

  it('aula CANCELADA e aula no PASSADO são recusadas antes do crédito', async () => {
    const a = await aluno('Alvo morto');
    await matricular(TURMA_A, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2), '08:00');
    await falta(a.alunoId, perdida);

    const cancelada = await ocorrencia(
      TURMA_B,
      emDias(3),
      '10:00',
      'cancelado',
    );
    expect(
      await codigoDaRecusa(
        servico().entrarNaAula(EMPRESA, a.usuarioId, cancelada),
      ),
    ).toBe('OCUPACAO_CANCELADA');

    const passada = await ocorrencia(TURMA_B, emDias(-1), '11:00');
    expect(
      await codigoDaRecusa(
        servico().entrarNaAula(EMPRESA, a.usuarioId, passada),
      ),
    ).toBe('PRAZO_DE_CANCELAMENTO');
  });

  it('quem já está na turma da aula não entra na fila dela', async () => {
    const a = await aluno('Já na turma B');
    await matricular(TURMA_A, a.alunoId);
    await matricular(TURMA_B, a.alunoId);
    const perdida = await ocorrencia(TURMA_A, emDias(-2), '08:00');
    await falta(a.alunoId, perdida);
    const alvo = await ocorrencia(TURMA_B, emDias(3));

    expect(
      await codigoDaRecusa(servico().entrarNaAula(EMPRESA, a.usuarioId, alvo)),
    ).toBe('JA_MATRICULADO_NA_TURMA');
  });
});

describe('SPEC-064/TASK-002 — sair', () => {
  it('sair marca `desistiu`, com data e motivo', async () => {
    const a = await aluno('Desistiu');
    const linha = await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);
    await servico().sair(EMPRESA, a.usuarioId, linha.id);

    const depois = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: linha.id },
      select: { estado: true, concluidaEm: true, motivoFim: true },
    });
    expect(depois.estado).toBe('desistiu');
    // Fila que termina sem data e sem motivo é fila que ninguém audita depois.
    expect(depois.concluidaEm).not.toBeNull();
    expect(depois.motivoFim).toBe('saiu da fila');
  });

  it('sair de linha de OUTRA PESSOA não tira ninguém da fila', async () => {
    const a = await aluno('Dono');
    const b = await aluno('Intruso');
    const linha = await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);

    // O id na URL não pode bastar: o recorte por (empresa, aluno) está no
    // `WHERE` do `updateMany`, não numa checagem antes dele.
    expect(
      await codigoDaRecusa(servico().sair(EMPRESA, b.usuarioId, linha.id)),
    ).toBe('NotFoundException');
    expect(
      (await db.listaDeEspera.findUniqueOrThrow({ where: { id: linha.id } }))
        .estado,
    ).toBe('aguardando');
  });

  it('sair duas vezes: a segunda é 404, não um 204 mentiroso', async () => {
    const a = await aluno('Duas vezes');
    const linha = await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);
    await servico().sair(EMPRESA, a.usuarioId, linha.id);

    expect(
      await codigoDaRecusa(servico().sair(EMPRESA, a.usuarioId, linha.id)),
    ).toBe('NotFoundException');
  });

  it('sair de quem já foi CHAMADO é legítimo, e libera o alvo', async () => {
    const a = await aluno('Desistiu da vez');
    const linha = await servico().entrarNaTurma(EMPRESA, a.usuarioId, TURMA_A);
    await q(
      `UPDATE lista_de_espera SET estado='chamado', chamado_em=now(), chamado_ate=now() + interval '2 hours' WHERE id='${linha.id}'`,
    );

    await servico().sair(EMPRESA, a.usuarioId, linha.id);

    // Sem `chamado` vivo, o índice `fila_chamado_turma_key` deixa o próximo
    // ciclo do varredor chamar o seguinte.
    expect(
      await db.listaDeEspera.count({
        where: { turmaId: TURMA_A, estado: 'chamado' },
      }),
    ).toBe(0);
  });
});
