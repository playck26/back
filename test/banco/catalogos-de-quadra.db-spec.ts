/**
 * SPEC-020/TASK-001 — o ensaio das constraints dos catálogos de quadra.
 *
 * **Precisa de Postgres de verdade** (`pnpm test:banco`). Prisma mockado não
 * tem FK composta: uma suíte mockada passaria com a INV-054 inexistente, que
 * é justamente a que impede uma quadra apontar para o esporte de outra
 * empresa.
 *
 * A regra do projeto é "o ensaio de migration tenta violar cada constraint".
 * Cada teste aqui **tenta gravar o estado proibido** e exige recusa do banco.
 *
 * ## A constraint que dá nome a este arquivo
 *
 * A INV-054 não é FK comum. Uma FK simples
 * `quadras.esporte_id → esportes_de_quadra.id` **não** sabe de `company_id`,
 * e deixaria o clube A usar o esporte do clube B. O que resolve é **FK
 * composta**:
 *
 * ```
 * esportes_de_quadra  UNIQUE (company_id, id)
 * quadras             FOREIGN KEY (company_id, esporte_id)
 *                     REFERENCES esportes_de_quadra(company_id, id)
 * ```
 *
 * Como `quadras.company_id` é a mesma coluna do escopo da própria quadra, o
 * banco só fecha o vínculo dentro da empresa. É o mesmo truque de
 * `chamadas_ocupacao_fkey`, que já sustenta a INV-016 desde a SPEC-014.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';

jest.setTimeout(60_000);

// Antes de qualquer conexão: esta suíte escreve.
exigirBancoLocal();

const prisma = new PrismaClient();

const EMPRESA_A = 'a0a0a0a0-0000-4000-8000-000000020001';
const EMPRESA_B = 'b0b0b0b0-0000-4000-8000-000000020002';
const QUADRA_A = 'a1a1a1a1-0000-4000-8000-000000020011';

async function limpar(): Promise<void> {
  await prisma.quadra.deleteMany({
    where: { companyId: { in: [EMPRESA_A, EMPRESA_B] } },
  });
  await prisma.esporteDeQuadra.deleteMany({
    where: { companyId: { in: [EMPRESA_A, EMPRESA_B] } },
  });
  await prisma.categoriaDeQuadra.deleteMany({
    where: { companyId: { in: [EMPRESA_A, EMPRESA_B] } },
  });
  await prisma.empresa.deleteMany({
    where: { id: { in: [EMPRESA_A, EMPRESA_B] } },
  });
}

describe('SPEC-020 — os catálogos contra Postgres real', () => {
  beforeEach(async () => {
    await limpar();
    await prisma.empresa.createMany({
      data: [
        // SPEC-020/TASK-004 — `esportes: []` saiu: a coluna nao existe mais.
        { id: EMPRESA_A, nome: 'A 020', slug: 'a-020' },
        { id: EMPRESA_B, nome: 'B 020', slug: 'b-020' },
      ],
    });
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  const criarEsporte = (companyId: string, nome: string) =>
    prisma.esporteDeQuadra.create({ data: { companyId, nome, ordem: 0 } });

  const criarQuadra = (dados: {
    esporteId: string;
    categoriaId?: string | null;
    companyId?: string;
  }) =>
    prisma.quadra.create({
      data: {
        id: QUADRA_A,
        companyId: dados.companyId ?? EMPRESA_A,
        nome: 'Q',
        // SPEC-020/TASK-004 — `esporte: 'tenis'` saiu (coluna derrubada), e
        // `esporteId` deixou de aceitar `null`: e `NOT NULL` no banco.
        precoHora: 100,
        esporteId: dados.esporteId,
        categoriaId: dados.categoriaId ?? null,
      },
    });

  /**
   * SPEC-020/TASK-004 — inserir SEM esporte, por fora do Prisma.
   *
   * Precisa ser SQL cru: o cliente tipado nem deixa expressar isto depois da
   * contract, e e exatamente por isso que a prova tem valor — ela mostra que
   * quem recusa e o BANCO, nao o TypeScript. Um teste que so provasse o
   * typecheck provaria a nossa disciplina, nao a garantia.
   */
  const inserirQuadraSemEsporte = () =>
    prisma.$executeRawUnsafe(
      `INSERT INTO quadras (id, company_id, nome, preco_hora, status, created_at)
       VALUES ('${QUADRA_A}', '${EMPRESA_A}', 'Sem esporte', 100, 'ativa', now())`,
    );

  describe('INV-054 — a quadra só usa esporte da PRÓPRIA empresa', () => {
    it('aceita o esporte da própria empresa', async () => {
      const meu = await criarEsporte(EMPRESA_A, 'Tênis');
      await expect(criarQuadra({ esporteId: meu.id })).resolves.toBeTruthy();
    });

    it('RECUSA o esporte de outra empresa — e quem recusa é o banco', async () => {
      // O caso que a FK composta existe para pegar, e que uma FK simples
      // deixaria passar: o id existe, só não é desta empresa.
      const alheio = await criarEsporte(EMPRESA_B, 'Padel');

      await expect(criarQuadra({ esporteId: alheio.id })).rejects.toThrow();
    });

    it('RECUSA também a categoria de outra empresa', async () => {
      const alheia = await prisma.categoriaDeQuadra.create({
        data: { companyId: EMPRESA_B, nome: 'Saibro', ordem: 0 },
      });
      // O esporte é da PRÓPRIA empresa de propósito: assim a única razão
      // possível para a recusa é a categoria alheia. Antes da TASK-004 este
      // teste ia sem esporte nenhum, e uma recusa por outro motivo teria
      // passado por prova.
      const meu = await criarEsporte(EMPRESA_A, 'Tênis');

      await expect(
        criarQuadra({ esporteId: meu.id, categoriaId: alheia.id }),
      ).rejects.toThrow();
    });

    // **Este teste trocou de lado na TASK-004.** Enquanto a expand estava
    // no ar ele afirmava o contrário: que `esporte_id` nulo era ACEITO, e
    // que era isso que permitia as quadras antigas conviverem. A contract
    // fechou essa porta, e o teste passou a provar o fechamento.
    it('INV-054/AC-010 — o BANCO recusa quadra sem esporte (prova por violação)', async () => {
      await expect(inserirQuadraSemEsporte()).rejects.toThrow();
    });

    it('e a recusa é por NOT NULL, não por acaso', async () => {
      // Sem conferir a causa, o teste acima passaria também se o INSERT
      // falhasse por erro de sintaxe — provando nada.
      //
      // **O discriminador é o SQLSTATE, não a mensagem.** `23502` é
      // `not_null_violation` no padrão SQL. A primeira versão deste teste
      // procurava o texto `null value in column "esporte_id"`, e falhou: o
      // Prisma repassa o código e a linha ofensora, não a frase do Postgres.
      // Mensagem muda com versão e locale; código não.
      await expect(inserirQuadraSemEsporte()).rejects.toThrow(/23502/);
    });

    it('categoria continua nulável: quadra sem categoria é aceita', async () => {
      // O par não é simétrico, e é decisão de produto (AC-006): nem todo
      // clube classifica piso. Se alguém tornar `categoria_id` obrigatória
      // "por simetria", este teste cai.
      const meu = await criarEsporte(EMPRESA_A, 'Tênis');
      await expect(
        criarQuadra({ esporteId: meu.id, categoriaId: null }),
      ).resolves.toBeTruthy();
    });
  });

  describe('AC-002 — nome único POR EMPRESA', () => {
    it('recusa nome repetido na mesma empresa', async () => {
      await criarEsporte(EMPRESA_A, 'Tênis');
      await expect(criarEsporte(EMPRESA_A, 'Tênis')).rejects.toThrow();
    });

    it('aceita o MESMO nome em empresas diferentes', async () => {
      // A razão de o catálogo ser por empresa (decisão 2): "saibro" de um
      // clube não é o "saibro" de outro, e um não manda no nome do outro.
      await criarEsporte(EMPRESA_A, 'Tênis');
      await expect(criarEsporte(EMPRESA_B, 'Tênis')).resolves.toBeTruthy();
    });

    it('a unicidade é case-SENSITIVE, e isso é o que a TASK-002 vai tratar', async () => {
      // Registrado por honestidade: o banco aceita "Tênis" e "tênis" como
      // duas opções. O backfill da TASK-001 deduplica por `lower()`, mas
      // daqui para a frente quem impede a segunda grafia é a API — e é ela
      // que precisa de teste próprio na TASK-002.
      await criarEsporte(EMPRESA_A, 'Tênis');
      await expect(criarEsporte(EMPRESA_A, 'tênis')).resolves.toBeTruthy();
    });
  });

  describe('INV-055 — opção em uso não é removida', () => {
    it('o banco recusa apagar esporte que uma quadra usa', async () => {
      const meu = await criarEsporte(EMPRESA_A, 'Tênis');
      await criarQuadra({ esporteId: meu.id });

      await expect(
        prisma.esporteDeQuadra.delete({ where: { id: meu.id } }),
      ).rejects.toThrow();
    });

    it('opção sem quadra é removida sem drama', async () => {
      const solto = await criarEsporte(EMPRESA_A, 'Padel');
      await expect(
        prisma.esporteDeQuadra.delete({ where: { id: solto.id } }),
      ).resolves.toBeTruthy();
    });
  });
});
