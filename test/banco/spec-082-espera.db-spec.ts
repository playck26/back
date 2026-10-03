/**
 * SPEC-082/REQ-002 — **a espera estourada vira 409 com a mensagem da causa**
 * (AC-006), e **o lock de tabela termina com código pelo valor herdado**
 * (AC-019, a exceção do deploy da I9).
 *
 * Cada prova passa pelo CONTROLLER: a tradução mora lá (D4), e sem ela o
 * `55P03` sairia como 500.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  type Clube,
  I4,
  I6,
  PRAZO_MS,
  TOLERANCIA_MS,
  agoraNoServidor,
  ateOInstante,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  dormir,
  inicioDaTransacao,
  limparClube,
  linhaChamada,
  linhaEmForUpdate,
  matriculasDaTurma,
  montarClube,
  resposta,
  rotas,
  segurar,
  travaDoAluno,
  travaDoClube,
  urlDoCaminho,
  vistoEsperando,
} from './spec-082-fixture';

jest.setTimeout(300_000);
exigirBancoLocal();

const db = new PrismaClient();
let clube: Clube | null = null;

afterEach(async () => {
  await limparClube(db, clube);
  clube = null;
  await desconectarTodos();
});

afterAll(async () => {
  await db.$disconnect();
});

async function notificacoesDoClube(companyId: string): Promise<number> {
  return db.notificacao.count({ where: { companyId } });
}

describe('SPEC-082/AC-006 — 55P03 numa rota leitora ⇒ 409 MATRICULA_EM_ANDAMENTO com a mensagem da causa', () => {
  it('espera na instrução das travas (clube) ⇒ I6, nada gravado', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltar = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
    let r;
    try {
      r = await resposta(
        rotas(cliente(urlDoCaminho('spec082-c1'))).entrar(clube, a, turma),
      );
    } finally {
      await soltar();
    }
    expect(r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(await matriculasDaTurma(db, turma)).toBe(0);
  });

  it('espera na instrução das travas (aluno) ⇒ I6, nada gravado', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltar = await segurar(db, travaDoAluno(a.alunoId));
    let r;
    try {
      r = await resposta(
        rotas(cliente(urlDoCaminho('spec082-c1b'))).alocar(clube, a, turma),
      );
    } finally {
      await soltar();
    }
    expect(r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(await matriculasDaTurma(db, turma)).toBe(0);
  });

  it('espera no FOR UPDATE de turmas ⇒ I4, nada gravado', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltar = await segurar(db, linhaEmForUpdate('turmas', turma));
    let r;
    try {
      r = await resposta(
        rotas(cliente(urlDoCaminho('spec082-c2'))).entrar(clube, a, turma),
      );
    } finally {
      await soltar();
    }
    expect(r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I4,
    });
    expect(await matriculasDaTurma(db, turma)).toBe(0);
  });

  it('espera no FOR UPDATE de lista_de_espera (confirmar) ⇒ I6 (I8), nada gravado e a linha continua chamada', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const linha = await linhaChamada(db, clube, a.alunoId, turma);
    const soltar = await segurar(
      db,
      linhaEmForUpdate('lista_de_espera', linha),
    );
    let r;
    try {
      r = await resposta(
        rotas(cliente(urlDoCaminho('spec082-c3'))).confirmar(clube, a, linha),
      );
    } finally {
      await soltar();
    }
    expect(r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(await matriculasDaTurma(db, turma)).toBe(0);
    expect(
      (await db.listaDeEspera.findUniqueOrThrow({ where: { id: linha } }))
        .estado,
    ).toBe('chamado');
  });

  it('espera em outra etapa (o lock de FK do INSERT, na linha do aluno) ⇒ I6, nada gravado', async () => {
    clube = await montarClube(db);
    const turma = await criarTurma(db, clube);
    const a = await criarAluno(db, clube);
    const soltar = await segurar(db, linhaEmForUpdate('alunos', a.alunoId));
    let r;
    try {
      r = await resposta(
        rotas(cliente(urlDoCaminho('spec082-c4'))).entrar(clube, a, turma),
      );
    } finally {
      await soltar();
    }
    expect(r).toMatchObject({
      status: 409,
      code: 'MATRICULA_EM_ANDAMENTO',
      message: I6,
    });
    expect(await matriculasDaTurma(db, turma)).toBe(0);
    expect(await notificacoesDoClube(clube.id)).toBe(0);
  });
});

/**
 * **AC-019 — a exceção do deploy (I9).** A transação consome 1,5 s do prazo na
 * trava do aluno; então o teste segura a TABELA-alvo em `ACCESS EXCLUSIVE`
 * (simulando uma migração) e solta o aluno. O lock implícito de tabela é
 * pedido ANTES do corpo da instrução — antes do `WITH` que recalcula —, e
 * espera com o `lock_timeout` herdado (~500 ms): termina em `55P03`, e é
 * "qualquer outra etapa" do D4 ⇒ I6.
 *
 * **O que este AC não afirma:** que a espera atrás de lock de tabela respeita
 * os 2 s — a I9 a excluiu (LIM-082f). A parede é prazo + 2 s + 50 ms.
 */
describe('SPEC-082/AC-019 — lock de tabela termina com código, pelo valor herdado', () => {
  const casos: [
    string,
    'turma_alunos' | 'notificacoes' | 'lista_de_espera',
    'entrar' | 'confirmar',
  ][] = [
    ['turma_alunos (entrar)', 'turma_alunos', 'entrar'],
    ['notificacoes (entrar, o aviso ao gestor)', 'notificacoes', 'entrar'],
    ['lista_de_espera (confirmar)', 'lista_de_espera', 'confirmar'],
  ];

  it.each(casos)(
    '%s: 409 MATRICULA_EM_ANDAMENTO com a I6, nada gravado, parede ≤ prazo + 2 s + 50 ms',
    async (_nome, tabela, caminho) => {
      clube = await montarClube(db);
      const turma = await criarTurma(db, clube);
      const a = await criarAluno(db, clube);
      const linha = await linhaChamada(db, clube, a.alunoId, turma);
      const app = `spec082-tabela-${tabela.replace(/_/g, '')}`;
      const r = rotas(cliente(urlDoCaminho(app)));

      const soltarAluno = await segurar(db, travaDoAluno(a.alunoId));
      let soltarTabela: (() => Promise<void>) | null = null;
      let fim = 0;
      let inicio = 0;
      let res;
      try {
        const pedido = resposta(
          caminho === 'entrar'
            ? r.entrar(clube, a, turma)
            : r.confirmar(clube, a, linha),
        ).then(async (x) => {
          fim = await agoraNoServidor(db);
          return x;
        });
        await vistoEsperando(db, app, 'advisory', PRAZO_MS);
        inicio = await inicioDaTransacao(db, app);
        await ateOInstante(db, inicio + 1_500);
        soltarTabela = await segurar(db, (t) =>
          t.$executeRawUnsafe(`LOCK TABLE ${tabela} IN ACCESS EXCLUSIVE MODE`),
        );
        await soltarAluno();
        // Teto de segurança: uma espera sem valor herdado (a sabotagem 2)
        // ficaria presa na tabela para sempre. Passado o tempo-limite da
        // transação com folga, o teste solta a tabela e olha o que veio.
        await Promise.race([pedido, dormir(10_000)]);
        if (soltarTabela) await soltarTabela();
        res = await pedido;
      } finally {
        await soltarAluno();
        if (soltarTabela) await soltarTabela();
      }
      expect(res).toMatchObject({
        status: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message: I6,
      });
      expect(await matriculasDaTurma(db, turma)).toBe(0);
      expect(await notificacoesDoClube(clube.id)).toBe(0);
      expect(
        (await db.listaDeEspera.findUniqueOrThrow({ where: { id: linha } }))
          .estado,
      ).toBe('chamado');
      const parede = fim - inicio;
      console.log(`AC-019 ${tabela}: PAREDE_MS=${Math.round(parede)}`);
      expect(parede).toBeLessThanOrEqual(PRAZO_MS + 2_000 + TOLERANCIA_MS);
    },
  );
});
