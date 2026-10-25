/**
 * SPEC-089/AC-008c (IMPL-089-03) — **com a chave desligada, a turma cheia de
 * outro nível é recusada ANTES da trava**, pelos dois serviços, como a SPEC-082
 * prova para o nível do aluno (`spec-082-cheia-antes`, AC-009).
 *
 * O molde é o da 082: a trava do clube segura em modo exclusivo por outra
 * conexão, o pedido pela rota, e a conexão da rota **nunca aparece esperando**.
 * Uma recusa de capacidade vinda de DENTRO da transação teria de esperar a
 * trava — e é isso que distingue "antes da trava" de "o mesmo código depois".
 *
 * O controle, com a chave ligada: o mesmo aluno, a mesma turma, e a rota
 * ESPERA (o `cheiaAntesDaFila` não responde "cheia" a quem é de outro nível, e
 * a transação decide, com `NIVEL_INCOMPATIVEL`). Sem ele, um `esperou === false`
 * podia ser um medidor que nunca vê espera.
 */
import { randomUUID } from 'node:crypto';
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

/** Uma turma de OUTRO nível (não o do aluno da fixtura), capacidade 1, cheia. */
async function turmaCheiaDeOutroNivel(c: Clube): Promise<string> {
  const outro = randomUUID();
  await db.$executeRawUnsafe(
    `INSERT INTO niveis (id,company_id,nome,ordem) VALUES ('${outro}','${c.id}','Avançado',2)`,
  );
  const turma = await criarTurma(db, c, 1);
  await db.$executeRawUnsafe(
    `UPDATE turmas SET nivel_id = '${outro}' WHERE id = '${turma}'`,
  );
  await matricularDireto(db, turma, (await criarAluno(db, c)).alunoId);
  return turma;
}

const chave = (c: Clube, valor: boolean) =>
  db.$executeRawUnsafe(
    `UPDATE empresas SET nivel_restringe_acesso = ${valor} WHERE id = '${c.id}'`,
  );

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

const pedido = (
  app: string,
  chamar: (typeof caminhos)[number][1],
  c: Clube,
  a: AlunoDaFixtura,
  turma: string,
) => resposta(chamar(rotas(cliente(urlDoCaminho(app))), c, a, turma));

describe('SPEC-089/AC-008c — chave desligada: TURMA_CHEIA antes da trava, para quem é de outro nível', () => {
  it.each(caminhos)(
    '%s: 409 TURMA_CHEIA, e a conexão nunca espera',
    async (nome, chamar) => {
      clube = await montarClube(db);
      const turma = await turmaCheiaDeOutroNivel(clube);
      const a = await criarAluno(db, clube);
      await chave(clube, false);

      const app = `spec089-cheia-${nome.toLowerCase()}`;
      const soltar = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
      let r;
      let esperou;
      try {
        const p = pedido(app, chamar, clube, a, turma);
        esperou = await esperouEnquanto(db, app, p);
        r = await p;
      } finally {
        await soltar();
      }

      expect(esperou).toBe(false);
      expect(r).toMatchObject({ status: 409, code: 'TURMA_CHEIA' });
      expect(await matriculasDaTurma(db, turma)).toBe(1);
    },
  );
});

describe('controle — chave ligada: a mesma turma ESPERA a trava, e a recusa é de nível', () => {
  it.each(caminhos)(
    '%s: a conexão espera, e depois 422 NIVEL_INCOMPATIVEL',
    async (nome, chamar) => {
      clube = await montarClube(db);
      const turma = await turmaCheiaDeOutroNivel(clube);
      const a = await criarAluno(db, clube);

      const app = `spec089-controle-${nome.toLowerCase()}`;
      const soltar = await segurar(db, travaDoClube(clube.id, 'exclusiva'));
      let r;
      try {
        const p = pedido(app, chamar, clube, a, turma);
        // A rota é VISTA esperando a trava (lança se não for, em PRAZO_MS).
        await vistoEsperando(db, app, 'advisory', PRAZO_MS);
        await soltar();
        r = await p;
      } finally {
        await soltar();
      }

      expect(r).toMatchObject({ status: 422, code: 'NIVEL_INCOMPATIVEL' });
      expect(await matriculasDaTurma(db, turma)).toBe(1);
    },
  );
});
