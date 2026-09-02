/**
 * SPEC-026 — **FIT-013: o calendário do professor, contra Postgres real.**
 *
 * O que está em julgamento é o **escopo** (INV-026a), e escopo não se prova
 * com dublê: um mock devolve o que se mandar devolver, então provaria apenas
 * que eu escrevi o `where` que eu escrevi. Aqui existem dois professores na
 * mesma empresa e uma segunda empresa — e o teste exige que nenhum veja o
 * dia do outro.
 *
 * A segunda coisa em julgamento é o **estado da chamada**, que depende de
 * uma linha existir ou não existir. "Não existir" é o caso mais importante —
 * é o dia que o professor esqueceu — e é justamente o que um dublê não sabe
 * simular sem que alguém pense nele.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { AgendaDoProfessorService } from '../../src/classes/agenda-do-professor.service';
import { PresencaService } from '../../src/classes/presenca.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { limparEmpresa } from './limpar-empresa';
import { cancelarOcupacaoNaFixture } from './cancelar-ocupacao';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0130000-0000-4000-8000-000000000001';
const OUTRA_EMPRESA = 'f0130000-0000-4000-8000-0000000000f1';
const QUADRA = 'f0130000-0000-4000-8000-000000000002';
const OUTRA_QUADRA = 'f0130000-0000-4000-8000-0000000000f2';

/** Professor A e professor B, na MESMA empresa. */
const UPROF_A = 'f0130000-0000-4000-8000-00000000000a';
const PROF_A = 'f0130000-0000-4000-8000-00000000001a';
const UPROF_B = 'f0130000-0000-4000-8000-00000000000b';
const PROF_B = 'f0130000-0000-4000-8000-00000000001b';
/** E um professor da OUTRA empresa. */
const UPROF_C = 'f0130000-0000-4000-8000-00000000000c';
const PROF_C = 'f0130000-0000-4000-8000-00000000001c';

const TURMA_A = 'f0130000-0000-4000-8000-000000000021';
const TURMA_B = 'f0130000-0000-4000-8000-000000000022';
const TURMA_C = 'f0130000-0000-4000-8000-000000000023';

/**
 * SPEC-027 — **as datas destas provas passaram a ser do PASSADO, e o motivo
 * é a regra nova.**
 *
 * Eram `2026-09-01` e `2026-09-02`, escritas quando "pendente" significava
 * apenas "não há linha em `chamadas`". Agora significa *"a aula já terminou e
 * não há linha"* — e uma aula de setembro, num ciclo que roda em agosto, é
 * `futura`: não conta pendência e não abre chamada.
 *
 * Datas fixas no passado, e não relativas a hoje, porque as provas de borda
 * de mês logo abaixo dependem de meses concretos (fevereiro bissexto, mês de
 * 31 dias). Duas convenções de data no mesmo arquivo seriam pior.
 */
const DIA_1 = '2026-08-03';
const DIA_2 = '2026-08-04';
const MES = '2026-08';

const db = new PrismaClient();
const service = new AgendaDoProfessorService(db as unknown as PrismaService);
/**
 * O serviço da chamada entra aqui na validação cruzada (achado 5): a INV-026b
 * afirma que o `ocupacaoId` da agenda é o mesmo que a chamada aceita, e essa
 * afirmação só é verificável chamando **as duas**.
 */
const presenca = new PresencaService(db as unknown as PrismaService);

const q = (sql: string) => db.$executeRawUnsafe(sql);

async function empresaCom(
  empresaId: string,
  quadraId: string,
  slug: string,
): Promise<void> {
  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${empresaId}','FIT-013 ${slug}','fit-013-${slug}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${empresaId}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${quadraId}','${empresaId}','Q ${slug}',(SELECT id FROM esportes_de_quadra WHERE company_id='${empresaId}'),100)`,
  );
}

async function professorCom(
  usuarioId: string,
  professorId: string,
  empresaId: string,
  n: string,
): Promise<void> {
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId}','fit013-${n}@teste.local','x','Prof ${n}','professor','${empresaId}',now())`,
  );
  await q(
    `INSERT INTO professores (id,company_id,nome,usuario_id,created_at) VALUES ('${professorId}','${empresaId}','Prof ${n}','${usuarioId}',now())`,
  );
}

/** Uma aula (ocupação de turma). `comChamada` decide o estado esperado. */
async function aula(
  id: string,
  empresaId: string,
  quadraId: string,
  turmaId: string,
  data: string,
  hora: string,
  chamada?: 'completa' | 'desconhecida',
): Promise<void> {
  await q(
    `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES ('${id}','${empresaId}','${quadraId}',DATE '${data}',TIME '${hora}',TIME '${hora}','TURMA','${turmaId}','pendente_pagamento',now())`,
  );
  if (chamada) {
    // O CHECK `chamadas_completude_esperados_check` exige `esperados > 0`
    // quando a completude é `completa`, e `NULL` quando é `desconhecida` —
    // "quem afirma completude diz sobre quantos" (SPEC-015). A primeira
    // versão desta fixture passou `0` e o banco recusou, que é o
    // comportamento certo dele.
    const esperados = chamada === 'completa' ? '3' : 'NULL';
    await q(
      `INSERT INTO chamadas (ocupacao_id,origem_tipo,company_id,registrada_em,registrada_por,updated_at,completude,esperados) VALUES ('${id}','TURMA','${empresaId}',now(),'${UPROF_A}',now(),'${chamada}',${esperados})`,
    );
  }
}

async function montar(): Promise<void> {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA_EMPRESA);

  await empresaCom(EMPRESA, QUADRA, 'a');
  await empresaCom(OUTRA_EMPRESA, OUTRA_QUADRA, 'z');

  await professorCom(UPROF_A, PROF_A, EMPRESA, 'A');
  await professorCom(UPROF_B, PROF_B, EMPRESA, 'B');
  await professorCom(UPROF_C, PROF_C, OUTRA_EMPRESA, 'C');

  for (const [turma, prof, emp, quadra, nome] of [
    [TURMA_A, PROF_A, EMPRESA, QUADRA, 'Turma do A'],
    [TURMA_B, PROF_B, EMPRESA, QUADRA, 'Turma do B'],
    [TURMA_C, PROF_C, OUTRA_EMPRESA, OUTRA_QUADRA, 'Turma do C'],
  ] as const) {
    await q(
      `INSERT INTO turmas (id,company_id,nome,quadra_id,professor_id,capacidade,status) VALUES ('${turma}','${emp}','${nome}','${quadra}','${prof}',10,'ativa')`,
    );
  }
}

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, OUTRA_EMPRESA);
  await db.$disconnect();
});

describe('FIT-013 — INV-026a: o calendário só mostra o que é dele', () => {
  it('não mostra a aula de OUTRO professor da mesma empresa', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000101',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000102',
      EMPRESA,
      QUADRA,
      TURMA_B,
      DIA_1,
      '19:00',
    );

    const mesDoA = await service.resumoDoMes(EMPRESA, UPROF_A, MES);

    expect(mesDoA).toHaveLength(1);
    expect(mesDoA[0]).toEqual({ data: DIA_1, aulas: 1, pendentes: 1 });
  });

  it('e o professor B vê a dele, não a do A — o outro lado', async () => {
    // Sem esta, um filtro que devolvesse SEMPRE vazio passaria na de cima.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000101',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000102',
      EMPRESA,
      QUADRA,
      TURMA_B,
      DIA_1,
      '19:00',
    );

    const diaDoB = await service.detalheDoDia(EMPRESA, UPROF_B, DIA_1);

    expect(diaDoB).toHaveLength(1);
    expect(diaDoB[0].turmaNome).toBe('Turma do B');
  });

  it('não mostra a aula de OUTRA empresa', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000103',
      OUTRA_EMPRESA,
      OUTRA_QUADRA,
      TURMA_C,
      DIA_1,
      '18:00',
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });

  it('professor sem turma: mês e dia vazios, sem erro', async () => {
    await montar();

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
    expect(await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1)).toEqual([]);
  });
});

describe('FIT-013 — o estado da chamada, que é a razão da tela', () => {
  it('sem linha em `chamadas` é PENDENTE — o dia que ele esqueceu', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000111',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('pendente');
  });

  it('`completa` é FEITA', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000112',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
      'completa',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('feita');
  });

  it('`desconhecida` é LEGADA — chamada de antes da SPEC-015', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000113',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
      'desconhecida',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('legada');
  });

  it('o mês conta as pendentes separadamente das aulas', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000121',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
      'completa',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000122',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '19:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000123',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_2,
      '18:00',
    );

    const mes = await service.resumoDoMes(EMPRESA, UPROF_A, MES);

    expect(mes).toEqual([
      { data: DIA_1, aulas: 2, pendentes: 1 },
      { data: DIA_2, aulas: 1, pendentes: 1 },
    ]);
  });
});

describe('FIT-013 — o que NÃO é aula dele', () => {
  it('aula cancelada não entra', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000131',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    // SPEC-032/INV-064 — cancelar exige evento da mesma transicao, e isso
    // vale para fixture tambem. Ver `cancelar-ocupacao.ts`.
    await cancelarOcupacaoNaFixture(db, {
      companyId: EMPRESA,
      ocupacaoId: 'f0130000-0000-4000-8000-000000000131',
      autorId: UPROF_A,
    });

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });

  it('reserva AVULSA não entra — não é aula', async () => {
    await montar();
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',DATE '${DIA_1}',TIME '07:00',TIME '08:00','AVULSO',100,'pendente_pagamento',now())`,
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([]);
  });

  /**
   * **Aqui havia uma prova que dizia o contrário, e ela caiu de propósito.**
   *
   * Chamava-se *"quadra inativa não é agenda de ninguém"* e exigia mês vazio.
   * A validação cruzada da SPEC-026 (achado 2) mostrou que aquilo
   * contradizia a decisão que a própria spec tinha tomado na dúvida 3 —
   * turma inativa continua aparecendo, porque quem deu a aula precisa
   * registrar a presença. Desativar uma quadra em setembro não desfaz a aula
   * que aconteceu nela em agosto.
   *
   * Fica o registro em vez do apagamento: quem ler o `git log` daqui a seis
   * meses vai encontrar uma prova invertida, e o motivo tem que estar junto.
   * A prova nova está em "quadra desativada não apaga a aula que aconteceu".
   */
});

describe('FIT-013 — INV-026b: o id do calendário é o id da chamada', () => {
  it('o `ocupacaoId` devolvido existe em `ocupacoes_quadra` como aula dele', async () => {
    // Se os dois divergirem, o caminho do pedido — dia → aula → chamada —
    // quebra no último passo. E quebraria em silêncio, porque cada metade
    // funciona sozinha.
    await montar();
    const ID = 'f0130000-0000-4000-8000-000000000151';
    await aula(ID, EMPRESA, QUADRA, TURMA_A, DIA_1, '18:00');

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.ocupacaoId).toBe(ID);
    // A chamada é gravada por `ocupacao_id` + `origem_tipo`: o par tem de
    // existir, senão o `PUT` da chamada não acha o que atualizar.
    const ocupacao = await db.ocupacaoQuadra.findUnique({
      where: { id: aulaDoDia.ocupacaoId },
      select: { origemTipo: true, origemTurmaId: true },
    });
    expect(ocupacao?.origemTipo).toBe('TURMA');
    expect(ocupacao?.origemTurmaId).toBe(TURMA_A);
  });

  it('as aulas do dia saem ordenadas por horário', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000161',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '20:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000162',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '07:00',
    );

    const dia = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(dia.map((a) => a.horaInicio)).toEqual(['07:00', '20:00']);
  });
});

/**
 * **INV-026b, agora com prova que cai** — achado 5 da validação cruzada.
 *
 * O relatório apontou o buraco com precisão: as provas anteriores conferiam
 * que o `ocupacaoId` existia e apontava para turma, mas **nunca chamavam a
 * chamada**. Se o escopo de `PresencaService` ficasse mais frouxo ou mais
 * rígido que o da agenda, o `fit-013` continuaria verde e o professor
 * descobriria em produção, no último toque do caminho.
 *
 * Aqui as duas pontas se encontram de verdade: o id sai de `detalheDoDia` e
 * entra em `PresencaService.chamada`.
 */
describe('FIT-013 — INV-026b: o id do calendário é o que a chamada aceita', () => {
  it('o id que a agenda devolve abre a chamada', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000201',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );

    const [naAgenda] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);
    const chamada = await presenca.chamada(
      EMPRESA,
      UPROF_A,
      naAgenda.ocupacaoId,
    );

    expect(chamada.ocupacaoId).toBe(naAgenda.ocupacaoId);
    expect(chamada.data).toBe(DIA_1);
  });

  it('e o id da aula do COLEGA é recusado pela chamada', async () => {
    // O outro lado: sem esta, um `PresencaService` que aceitasse qualquer
    // ocupação passaria na prova acima.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000202',
      EMPRESA,
      QUADRA,
      TURMA_B,
      DIA_1,
      '19:00',
    );

    await expect(
      presenca.chamada(
        EMPRESA,
        UPROF_A,
        'f0130000-0000-4000-8000-000000000202',
      ),
    ).rejects.toThrow();
  });
});

/**
 * **Achado 2 — a agenda escondia aula de quadra desativada.**
 *
 * O relatório leu isso como "a chamada está frouxa". Era o contrário: a
 * chamada aceitava e a agenda não mostrava, então o professor ficava **sem
 * caminho** para lançar uma chamada que o sistema aceitaria. E o filtro
 * contradizia a decisão que a própria SPEC-026 tinha tomado na dúvida 3 —
 * turma inativa continua aparecendo, porque quem deu a aula precisa
 * registrar a presença.
 */
describe('FIT-013 — quadra desativada não apaga a aula que aconteceu', () => {
  it('a aula continua no calendário e na lista do dia', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000211',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await q(`UPDATE quadras SET status='inativa' WHERE id='${QUADRA}'`);

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES)).toEqual([
      { data: DIA_1, aulas: 1, pendentes: 1 },
    ]);
    expect(await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1)).toHaveLength(1);
  });

  it('e as duas pontas concordam: a chamada aceita o mesmo id', async () => {
    // É esta que fecha o achado. Antes, agenda e chamada divergiam
    // exatamente aqui.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000212',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );
    await q(`UPDATE quadras SET status='inativa' WHERE id='${QUADRA}'`);

    const [naAgenda] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);
    await expect(
      presenca.chamada(EMPRESA, UPROF_A, naAgenda.ocupacaoId),
    ).resolves.toBeDefined();
  });
});

/**
 * **As bordas do mês** — o relatório notou que o código parecia certo e que
 * faltava prova. Faltava mesmo: `lte` no último dia é o tipo de coisa que
 * funciona em 30 de setembro e falha em 31 de outubro.
 */
describe('FIT-013 — as bordas do mês', () => {
  it('o dia 1 e o último dia aparecem — inclusive em mês de 31', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000221',
      EMPRESA,
      QUADRA,
      TURMA_A,
      '2026-10-01',
      '18:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000222',
      EMPRESA,
      QUADRA,
      TURMA_A,
      '2026-10-31',
      '18:00',
    );

    const outubro = await service.resumoDoMes(EMPRESA, UPROF_A, '2026-10');

    expect(outubro.map((d) => d.data)).toEqual(['2026-10-01', '2026-10-31']);
  });

  it('fevereiro de ano NÃO bissexto termina no 28', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000223',
      EMPRESA,
      QUADRA,
      TURMA_A,
      '2026-02-28',
      '18:00',
    );

    expect(
      (await service.resumoDoMes(EMPRESA, UPROF_A, '2026-02')).map(
        (d) => d.data,
      ),
    ).toEqual(['2026-02-28']);
  });

  it('fevereiro BISSEXTO inclui o dia 29', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000224',
      EMPRESA,
      QUADRA,
      TURMA_A,
      '2028-02-29',
      '18:00',
    );

    expect(
      (await service.resumoDoMes(EMPRESA, UPROF_A, '2028-02')).map(
        (d) => d.data,
      ),
    ).toEqual(['2028-02-29']);
  });

  it('e o mês NÃO invade o vizinho', async () => {
    // Sem esta, um `lte` frouxo (ou um `lt` no mês seguinte) passaria nas
    // três acima.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000225',
      EMPRESA,
      QUADRA,
      TURMA_A,
      '2026-09-30',
      '18:00',
    );
    await aula(
      'f0130000-0000-4000-8000-000000000226',
      EMPRESA,
      QUADRA,
      TURMA_A,
      '2026-11-01',
      '18:00',
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, '2026-10')).toEqual([]);
  });
});

/**
 * **SPEC-027 — a aula que ainda não aconteceu não cobra chamada.**
 *
 * O Israel viu o app marcando *"Chamada pendente"* numa aula de **31 de
 * agosto**, com o calendário aberto no dia 29. A regra antiga estava
 * cumprindo o que dizia — "sem linha em `chamadas` é pendente" — e o produto
 * estava errado: o professor não esqueceu nada, a aula não aconteceu.
 */
describe('FIT-013 — SPEC-027: futura não é pendente', () => {
  /** Bem no futuro, para não depender de quando a suíte roda. */
  const DIA_FUTURO = '2099-06-15';
  const MES_FUTURO = '2099-06';

  /**
   * **Prova COMPANHEIRA — ela não cai sozinha, e fica registrada como tal.**
   *
   * Rodei a sabotagem (removi o ramo `futura` de `estadoDaChamada`): esta
   * continua verde, porque sem `futura` o estado vira `em_andamento`, que
   * também não conta como pendência. Ela guarda a **contagem**, não o estado.
   *
   * Quem discrimina o estado é a prova seguinte. Mantida porque a contagem é
   * o que o Israel viu na tela — o ponto vermelho — e uma regressão nela
   * merece um vermelho próprio.
   */
  it('a aula de um mês futuro aparece, e com ZERO pendências', async () => {
    // As duas metades importam: sumir com ela seria outro defeito — o
    // professor precisa ver a grade que vem.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000301',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_FUTURO,
      '18:00',
    );

    expect(await service.resumoDoMes(EMPRESA, UPROF_A, MES_FUTURO)).toEqual([
      { data: DIA_FUTURO, aulas: 1, pendentes: 0 },
    ]);
  });

  it('e o estado dela é `futura`, não `pendente`', async () => {
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000302',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_FUTURO,
      '18:00',
    );

    const [aulaDoDia] = await service.detalheDoDia(
      EMPRESA,
      UPROF_A,
      DIA_FUTURO,
    );

    expect(aulaDoDia.chamada).toBe('futura');
  });

  it('a aula que JÁ terminou continua pendente — o outro lado', async () => {
    // Sem esta, um `estadoDaChamada` que devolvesse SEMPRE `futura` passaria
    // nas duas de cima, e o ponto vermelho sumiria do produto inteiro.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000303',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_1,
      '18:00',
    );

    const [aulaDoDia] = await service.detalheDoDia(EMPRESA, UPROF_A, DIA_1);

    expect(aulaDoDia.chamada).toBe('pendente');
  });

  /**
   * **Também COMPANHEIRA**, e por um motivo bom: a rede de segurança pega.
   *
   * Sabotei `aulaJaComecou` no `PUT` e esta continuou verde — porque a
   * comparação por dia (`dia > hoje`), que ficou de propósito logo abaixo,
   * barra a aula de 2099 sozinha. Ou seja, ela prova a rede, não a regra
   * nova.
   *
   * Quem discrimina a regra nova é a prova unitária *"recusa a aula de HOJE
   * que ainda não começou"* (`presenca.service.spec.ts`), que usa 23:58 — o
   * único caso que só o portão por hora alcança. Essa cai na sabotagem.
   */
  it('e a chamada RECUSA a aula futura — a tela não é o portão', async () => {
    // Esconder o botão resolve o engano honesto; só o servidor resolve o
    // pedido montado à mão. A chamada é o retrato de quem estava lá.
    await montar();
    await aula(
      'f0130000-0000-4000-8000-000000000304',
      EMPRESA,
      QUADRA,
      TURMA_A,
      DIA_FUTURO,
      '18:00',
    );

    await expect(
      presenca.salvarChamada(
        EMPRESA,
        UPROF_A,
        'f0130000-0000-4000-8000-000000000304',
        '0',
        [],
      ),
    ).rejects.toMatchObject({ response: { code: 'AULA_FUTURA' } });
  });
});
