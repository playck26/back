/**
 * SPEC-025 — **FIT-012: a avaliação das aulas contra Postgres real.**
 *
 * As provas do serviço usam dublê, e dublê não tem constraint nenhuma:
 * provariam apenas que o meu código concorda comigo. Quatro coisas desta
 * spec são do banco, não do serviço:
 *
 * - a **UNIQUE** `(ocupacao_id, aluno_id)`, que torna "avaliar de novo" uma
 *   correção em vez de uma segunda linha (INV-025b);
 * - o **CHECK** de 1..5 (INV-025c) e o do tamanho do comentário;
 * - a **agregação da média da turma**, que atravessa
 *   `avaliacao -> ocupacao -> turma` e só existe com dados reais;
 * - a **ordenação por pior nota**, que é a funcionalidade do pedido
 *   ("identificar com facilidade os detratores"), não um detalhe de lista.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { AvaliacaoDeAulaService } from '../../src/classes/avaliacao-de-aula.service';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { hojeNoFusoDoClube } from '../../src/courts/date-time.util';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

const EMPRESA = 'f0120000-0000-4000-8000-000000000001';
const QUADRA = 'f0120000-0000-4000-8000-000000000002';
const TURMA = 'f0120000-0000-4000-8000-000000000003';
/** Ontem e anteontem: as duas já terminaram. */
const AULA_ONTEM = 'f0120000-0000-4000-8000-000000000010';
const AULA_ANTEONTEM = 'f0120000-0000-4000-8000-000000000011';
/** Amanhã: ainda não terminou. */
const AULA_AMANHA = 'f0120000-0000-4000-8000-000000000012';

const db = new PrismaClient();
const service = new AvaliacaoDeAulaService(db as unknown as PrismaService);

const usuarioId = (n: number) =>
  `f0120000-0000-4000-8000-1000000000${String(n).padStart(2, '0')}`;
const alunoId = (n: number) =>
  `f0120000-0000-4000-8000-2000000000${String(n).padStart(2, '0')}`;

/**
 * Data em `YYYY-MM-DD`, deslocada a partir de **hoje no fuso do clube**.
 *
 * **A primeira versao deste helper usava `new Date()` em UTC, e as provas
 * cairam.** Rodando a 00h UTC, ainda e ontem em Sao Paulo: `dia(-1)` dava a
 * data que o servico considera HOJE, e "avaliar a aula de ontem" respondia
 * `AULA_NAO_TERMINOU`.
 *
 * E a mesma armadilha que `date-time.util.ts` documenta, e ela pegou o
 * proprio teste que existe para vigia-la. A licao vale escrita: **prova que
 * calcula data por conta propria mede outro relogio que o codigo** — o
 * helper tem de beber da mesma fonte.
 */
function dia(offset: number): string {
  const d = hojeNoFusoDoClube();
  d.setUTCDate(d.getUTCDate() + offset);
  return d.toISOString().slice(0, 10);
}

async function montar(quantosAlunos: number, matricular = true) {
  await limparEmpresa(db, EMPRESA);
  const q = (sql: string) => db.$executeRawUnsafe(sql);

  await q(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','FIT-012','fit-012-${EMPRESA}',now())`,
  );
  await q(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${EMPRESA}','Tenis',0,now())`,
  );
  await q(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${QUADRA}','${EMPRESA}','Q FIT-012',(SELECT id FROM esportes_de_quadra WHERE company_id='${EMPRESA}' AND nome='Tenis'),100)`,
  );
  await q(
    `INSERT INTO turmas (id,company_id,nome,quadra_id,capacidade,status) VALUES ('${TURMA}','${EMPRESA}','Turma FIT-012','${QUADRA}',20,'ativa')`,
  );

  for (const [id, offset] of [
    [AULA_ANTEONTEM, -2],
    [AULA_ONTEM, -1],
    [AULA_AMANHA, 1],
  ] as const) {
    await q(
      `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES ('${id}','${EMPRESA}','${QUADRA}',DATE '${dia(offset)}',TIME '18:00',TIME '19:00','TURMA','${TURMA}','pendente_pagamento',now())`,
    );
  }

  for (let n = 1; n <= quantosAlunos; n++) {
    await q(
      `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${usuarioId(n)}','fit012-${n}@teste.local','x','Aluno FIT-012 ${n}','aluno','${EMPRESA}',now())`,
    );
    await q(
      `INSERT INTO alunos (id,usuario_id,company_id,vinculo) VALUES ('${alunoId(n)}','${usuarioId(n)}','${EMPRESA}','aprovado')`,
    );
    if (matricular) {
      await q(
        `INSERT INTO turma_alunos (id,turma_id,aluno_id,created_at) VALUES (gen_random_uuid(),'${TURMA}','${alunoId(n)}',now())`,
      );
    }
  }
}

function codigoDe(erro: unknown): string {
  const r = (erro as { getResponse?: () => unknown }).getResponse?.();
  return (r as { code?: string })?.code ?? String(erro);
}

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

describe('FIT-012 — quem pode avaliar', () => {
  it('matriculado avalia aula que já passou', async () => {
    await montar(1);

    const salva = await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, {
      nota: 5,
      comentario: 'Ótima aula',
    });

    expect(salva.nota).toBe(5);
    expect(salva.comentario).toBe('Ótima aula');
  });

  it('aula de amanhã ainda não pode ser avaliada', async () => {
    await montar(1);

    expect(
      codigoDe(
        await service
          .avaliar(EMPRESA, usuarioId(1), AULA_AMANHA, { nota: 5 })
          .catch((e: unknown) => e),
      ),
    ).toBe('AULA_NAO_TERMINOU');
  });

  it('quem não está na turma não avalia', async () => {
    await montar(1, false);

    expect(
      codigoDe(
        await service
          .avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 5 })
          .catch((e: unknown) => e),
      ),
    ).toBe('NAO_MATRICULADO');
  });
});

describe('FIT-012 — o que a UNIQUE garante (INV-025b)', () => {
  it('avaliar a mesma aula duas vezes deixa UMA linha', async () => {
    await montar(1);

    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 2 });
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, {
      nota: 5,
      comentario: 'Mudei de ideia',
    });

    const linhas = await db.avaliacaoDeAula.findMany({
      where: { ocupacaoId: AULA_ONTEM },
    });
    expect(linhas).toHaveLength(1);
    expect(linhas[0].nota).toBe(5);
  });

  it('a UNIQUE existe — INSERT direto duplicado é recusado', async () => {
    // Sem esta prova, a de cima passaria mesmo que a chave não existisse: o
    // `upsert` do Prisma faria a coisa certa sozinho, e o dia em que outro
    // caminho escrevesse na tabela criaria a segunda linha.
    await montar(1);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 4 });

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${AULA_ONTEM}','${alunoId(1)}',3,now())`,
      ),
    ).rejects.toThrow();
  });

  it('o MESMO aluno pode avaliar DUAS aulas diferentes', async () => {
    // O outro lado da unicidade: ela é por aula, não por aluno. Sem esta
    // prova, uma chave errada em `(aluno_id)` passaria despercebida.
    await montar(1);

    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 5 });
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ANTEONTEM, { nota: 3 });

    expect(
      await db.avaliacaoDeAula.count({ where: { companyId: EMPRESA } }),
    ).toBe(2);
  });
});

describe('FIT-012 — o que os CHECK garantem (INV-025c)', () => {
  it('nota 0 é recusada pelo BANCO', async () => {
    await montar(1);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${AULA_ONTEM}','${alunoId(1)}',0,now())`,
      ),
    ).rejects.toThrow();
  });

  it('nota 6 também', async () => {
    await montar(1);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${AULA_ONTEM}','${alunoId(1)}',6,now())`,
      ),
    ).rejects.toThrow();
  });

  it('1 e 5 passam — o CHECK não é rígido demais', async () => {
    // Um CHECK que recusasse tudo também passaria nas duas provas acima.
    await montar(2);

    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 1 });
    await service.avaliar(EMPRESA, usuarioId(2), AULA_ONTEM, { nota: 5 });

    expect(
      await db.avaliacaoDeAula.count({ where: { ocupacaoId: AULA_ONTEM } }),
    ).toBe(2);
  });

  it('comentário acima de 500 é recusado pelo banco', async () => {
    await montar(1);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO avaliacoes_de_aula (id,company_id,ocupacao_id,aluno_id,nota,comentario,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${AULA_ONTEM}','${alunoId(1)}',4,'${'a'.repeat(501)}',now())`,
      ),
    ).rejects.toThrow();
  });
});

describe('FIT-012 — as notas das aulas alimentam a média da TURMA', () => {
  it('notas de aulas DIFERENTES entram na mesma média', async () => {
    // É o coração do pedido: a aula não tem média própria, a turma tem.
    await montar(2);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 5 });
    await service.avaliar(EMPRESA, usuarioId(2), AULA_ONTEM, { nota: 4 });
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ANTEONTEM, { nota: 3 });

    const r = await service.mediaDaTurma(EMPRESA, TURMA);

    expect(r.quantidade).toBe(3);
    expect(r.media).toBe(4); // (5+4+3)/3
  });

  it('com 2 notas a média é null, e a contagem aparece', async () => {
    await montar(2);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 5 });
    await service.avaliar(EMPRESA, usuarioId(2), AULA_ONTEM, { nota: 1 });

    const r = await service.mediaDaTurma(EMPRESA, TURMA);

    expect(r.media).toBeNull();
    expect(r.quantidade).toBe(2);
  });
});

describe('FIT-012 — o gestor acha o detrator', () => {
  it('a lista vem com a PIOR nota primeiro', async () => {
    // A ordem é a funcionalidade. Ordenar por data — o reflexo — enterraria
    // o 1 da semana passada embaixo dos 5 de ontem.
    await montar(3);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 5 });
    await service.avaliar(EMPRESA, usuarioId(2), AULA_ONTEM, { nota: 1 });
    await service.avaliar(EMPRESA, usuarioId(3), AULA_ONTEM, { nota: 4 });

    const { itens } = await service.listarParaOGestor(EMPRESA, TURMA);

    expect(itens.map((i) => i.nota)).toEqual([1, 4, 5]);
    expect(itens[0].alunoNome).toBe('Aluno FIT-012 2');
  });

  it('conta os detratores e diz qual é a régua', async () => {
    await montar(3);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, { nota: 1 });
    await service.avaliar(EMPRESA, usuarioId(2), AULA_ONTEM, { nota: 2 });
    await service.avaliar(EMPRESA, usuarioId(3), AULA_ONTEM, { nota: 3 });

    const r = await service.listarParaOGestor(EMPRESA, TURMA);

    expect(r.detratores).toBe(2);
    expect(r.notaMaximaDeDetrator).toBe(2);
    expect(r.itens.filter((i) => i.detrator)).toHaveLength(2);
  });

  it('cada item aponta a DATA DA AULA, não a do registro', async () => {
    // É ela que diz ao gestor qual terça-feira investigar.
    await montar(1);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ANTEONTEM, { nota: 2 });

    const { itens } = await service.listarParaOGestor(EMPRESA, TURMA);

    expect(itens[0].dataDaAula).toBe(dia(-2));
    expect(itens[0].horaInicio).toBe('18:00');
  });
});

/**
 * Achado 1 da validação cruzada (ALTA), fechado no banco.
 *
 * O validador descreveu o cenário exato: uma `ocupacoes_quadra` de EMPRESA_B
 * apontando `origem_turma_id` para uma turma de EMPRESA_A. As FKs antigas
 * aceitavam, e a média da turma agrega **por relação** — então a EMPRESA_A
 * veria nota de aluno da EMPRESA_B, e na tela do gestor veria **nome e
 * comentário**.
 *
 * Estas provas tentam criar a linha. Se um dia passarem a conseguir, o
 * vazamento voltou.
 */
describe('FIT-012 — o isolamento entre empresas é do BANCO', () => {
  const OUTRA_EMPRESA = 'f0120000-0000-4000-8000-000000000099';
  const OUTRA_QUADRA = 'f0120000-0000-4000-8000-000000000098';

  it('o banco RECUSA ocupação de uma empresa apontando para turma de outra', async () => {
    await montar(1);
    const q = (sql: string) => db.$executeRawUnsafe(sql);

    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${OUTRA_EMPRESA}','FIT-012 Outra','fit-012-outra',now())`,
    );
    await q(
      `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at) VALUES (gen_random_uuid(),'${OUTRA_EMPRESA}','Tenis',0,now())`,
    );
    await q(
      `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora) VALUES ('${OUTRA_QUADRA}','${OUTRA_EMPRESA}','Q outra',(SELECT id FROM esportes_de_quadra WHERE company_id='${OUTRA_EMPRESA}'),100)`,
    );

    // A linha do ataque: empresa B, turma de A.
    await expect(
      q(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,origem_turma_id,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${OUTRA_EMPRESA}','${OUTRA_QUADRA}',DATE '${dia(-1)}',TIME '18:00',TIME '19:00','TURMA','${TURMA}','pendente_pagamento',now())`,
      ),
    ).rejects.toThrow();

    await limparEmpresa(db, OUTRA_EMPRESA);
  });

  it('e continua aceitando reserva AVULSA, que não tem turma', async () => {
    // O outro lado: uma FK composta mal feita quebraria a reserva avulsa,
    // porque `origem_turma_id` é NULL nela. MATCH SIMPLE não exige nada
    // quando a coluna é nula — esta prova guarda isso.
    //
    // O `valor` não é enfeite da fixture: o CHECK `ocupacoes_valor_por_origem`
    // exige valor na avulsa e proíbe na de turma (CON-006 — aula recorrente
    // não tem cobrança própria). A primeira versão desta prova o esqueceu e o
    // banco recusou, o que é o comportamento certo dele.
    await montar(1);

    await expect(
      db.$executeRawUnsafe(
        `INSERT INTO ocupacoes_quadra (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,valor,status_pagamento,updated_at) VALUES (gen_random_uuid(),'${EMPRESA}','${QUADRA}',DATE '${dia(-3)}',TIME '07:00',TIME '08:00','AVULSO',100,'pendente_pagamento',now())`,
      ),
    ).resolves.toBeDefined();
  });
});

describe('FIT-012 — as aulas anteriores, para poder avaliar', () => {
  it('lista só as que já passaram, da mais recente para a mais antiga', async () => {
    await montar(1);

    const aulas = await service.aulasAnteriores(EMPRESA, usuarioId(1));

    expect(aulas.map((a) => a.data)).toEqual([dia(-1), dia(-2)]);
    expect(aulas.some((a) => a.data === dia(1))).toBe(false);
  });

  it('cada aula já traz a nota que a pessoa deu', async () => {
    // Sem isso a tela precisaria de uma requisição por linha da lista para
    // distinguir "não avaliei" de "dei 4".
    await montar(1);
    await service.avaliar(EMPRESA, usuarioId(1), AULA_ONTEM, {
      nota: 4,
      comentario: 'Boa',
    });

    const aulas = await service.aulasAnteriores(EMPRESA, usuarioId(1));

    expect(aulas.find((a) => a.ocupacaoId === AULA_ONTEM)?.minhaNota).toBe(4);
    expect(
      aulas.find((a) => a.ocupacaoId === AULA_ANTEONTEM)?.minhaNota,
    ).toBeNull();
  });

  it('NÃO mostra a nota de outro aluno na mesma aula', async () => {
    // A lista é do aluno logado. Vazar a nota do colega aqui seria o mesmo
    // furo da INV-025a, por outra porta.
    await montar(2);
    await service.avaliar(EMPRESA, usuarioId(2), AULA_ONTEM, { nota: 1 });

    const aulas = await service.aulasAnteriores(EMPRESA, usuarioId(1));

    expect(
      aulas.find((a) => a.ocupacaoId === AULA_ONTEM)?.minhaNota,
    ).toBeNull();
  });

  it('aluno sem turma recebe lista vazia, sem erro', async () => {
    await montar(1, false);

    expect(await service.aulasAnteriores(EMPRESA, usuarioId(1))).toEqual([]);
  });
});
