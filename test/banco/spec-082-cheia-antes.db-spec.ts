/**
 * SPEC-082/REQ-004 — **cheia antes da fila** (AC-009, AC-010, AC-016).
 *
 * - **AC-009** — `entrar` e `allocateStudent` leem a lotação SEM trava antes
 *   de abrir a transação: turma cheia ⇒ 409 `TURMA_CHEIA`, e a conexão da rota
 *   **nunca aparece esperando** — nem com a trava do clube segura em modo
 *   exclusivo. Prova por caminho.
 * - **AC-010** — a leitura de fora nunca aceita sozinha: vaga lá fora e cheia
 *   dentro da transação ⇒ 409 `TURMA_CHEIA`, sem matrícula além da capacidade.
 * - **AC-016** — `confirmar` continua encerrando a linha: turma cheia ⇒ 409
 *   `TURMA_CHEIA` **e** a linha termina `encerrada`, na mesma transação.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import {
  type AlunoDaFixtura,
  type Clube,
  cliente,
  criarAluno,
  criarTurma,
  desconectarTodos,
  esperouEnquanto,
  limparClube,
  linhaChamada,
  matriculasDaTurma,
  matricularDireto,
  montarClube,
  resposta,
  rotas,
  segurar,
  travaDoClube,
  urlDoCaminho,
  vistoEsperando,
  PRAZO_MS,
} from './spec-082-fixture';

jest.setTimeout(120_000);
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

/** Uma turma de capacidade 1, já ocupada por outro aluno. */
async function turmaCheia(c: Clube): Promise<string> {
  const turma = await criarTurma(db, c, 1);
  await matricularDireto(db, turma, (await criarAluno(db, c)).alunoId);
  return turma;
}

describe('SPEC-082/AC-009 — turma cheia é recusada antes de entrar na fila da trava', () => {
  const caminhos: [
    string,
    (
      r: ReturnType<typeof rotas>,
      c: Clube,
      a: AlunoDaFixtura,
      t: string,
    ) => Promise<unknown>,
  ][] = [
    ['entrar', (r, c, a, t) => r.entrar(c, a, t)],
    ['allocateStudent', (r, c, a, t) => r.alocar(c, a, t)],
  ];

  it.each(caminhos)(
    '%s: 409 TURMA_CHEIA com a do clube segura em modo exclusivo, e a conexão nunca espera',
    async (nome, chamar) => {
      clube = await montarClube(db);
      const turma = await turmaCheia(clube);
      const a = await criarAluno(db, clube);
      const app = `spec082-cheia-${nome.toLowerCase()}`;

      const soltar = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
      let r;
      let esperou;
      try {
        const pedido = resposta(
          chamar(rotas(cliente(urlDoCaminho(app))), clube, a, turma),
        );
        esperou = await esperouEnquanto(db, app, pedido);
        r = await pedido;
      } finally {
        await soltar();
      }
      expect(esperou).toBe(false);
      expect(r).toMatchObject({ status: 409, code: 'TURMA_CHEIA' });
      expect(await matriculasDaTurma(db, turma)).toBe(1);
    },
  );
});

describe('SPEC-082/AC-010 — a leitura de fora nunca aceita sozinha', () => {
  it.each(['entrar', 'allocateStudent'] as const)(
    '%s: vaga na leitura de fora, cheia dentro da transação ⇒ 409 TURMA_CHEIA, sem passar da capacidade',
    async (caminho) => {
      clube = await montarClube(db);
      const turma = await criarTurma(db, clube, 1);
      const a = await criarAluno(db, clube);
      const outro = await criarAluno(db, clube);
      const app = `spec082-dentro-${caminho.toLowerCase()}`;

      // A trava do clube segura deixa o caminho parado DEPOIS da leitura de
      // fora (que viu a vaga) e ANTES da contagem de dentro.
      const soltar = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
      let r;
      try {
        const rr = rotas(cliente(urlDoCaminho(app)));
        const pedido = resposta(
          caminho === 'entrar'
            ? rr.entrar(clube, a, turma)
            : rr.alocar(clube, a, turma),
        );
        await vistoEsperando(db, app, 'advisory', PRAZO_MS);
        await matricularDireto(db, turma, outro.alunoId); // a vaga some
        await soltar();
        r = await pedido;
      } finally {
        await soltar();
      }
      expect(r).toMatchObject({ status: 409, code: 'TURMA_CHEIA' });
      expect(await matriculasDaTurma(db, turma)).toBe(1);
    },
  );
});

describe('SPEC-082/AC-016 — confirmar continua encerrando a linha', () => {
  it('turma cheia na confirmação ⇒ 409 TURMA_CHEIA e a linha termina encerrada', async () => {
    clube = await montarClube(db);
    const turma = await turmaCheia(clube);
    const a = await criarAluno(db, clube);
    const linha = await linhaChamada(db, clube, a.alunoId, turma);

    const r = await resposta(
      rotas(cliente(urlDoCaminho('spec082-ac016'))).confirmar(clube, a, linha),
    );

    expect(r).toMatchObject({ status: 409, code: 'TURMA_CHEIA' });
    const depois = await db.listaDeEspera.findUniqueOrThrow({
      where: { id: linha },
    });
    expect(depois.estado).toBe('encerrada');
    expect(await matriculasDaTurma(db, turma)).toBe(1);
  });
});
