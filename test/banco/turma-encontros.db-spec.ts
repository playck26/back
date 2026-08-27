/**
 * SPEC-019/TASK-001 — o ensaio das constraints de `turma_encontros`.
 *
 * **Precisa de Postgres de verdade** (`pnpm test:banco`). Prisma mockado não
 * tem `CHECK` nem `ON DELETE CASCADE`: uma suíte mockada passaria com as duas
 * garantias inexistentes, e elas são o motivo desta tabela ter migration
 * escrita à mão em vez de gerada.
 *
 * A regra do projeto é **o ensaio de migration tenta violar cada
 * constraint**. Cada teste aqui grava o estado proibido e exige recusa do
 * banco.
 *
 * ## O que este arquivo NÃO prova, e está declarado
 *
 * A **INV-051** ("turma tem pelo menos um encontro") não aparece aqui, e não
 * é esquecimento: Postgres não expressa "pai com ≥1 filho" sem trigger, e
 * este projeto tem **zero** (`pg_trigger` = 0). Ela fica com a API e a
 * transação — a 1ª rodada de dúvida da SPEC-019 derrubou a versão que
 * prometia garantia de banco.
 *
 * Invariante que promete constraint sem nomear a constraint é a que vira
 * "não deu, fizemos em código", e ninguém volta para corrigir o texto.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';

jest.setTimeout(60_000);

// Antes de qualquer conexão: esta suíte escreve.
exigirBancoLocal();

const prisma = new PrismaClient();

const EMPRESA = 'e1e1e1e1-0000-4000-8000-000000019001';
const QUADRA = 'e2e2e2e2-0000-4000-8000-000000019002';
const ESPORTE = 'e3e3e3e3-0000-4000-8000-000000019003';
const TURMA = 'e4e4e4e4-0000-4000-8000-000000019004';

/** `TIME` puro: o Prisma exige `Date`, e a data é ignorada na coluna. */
const hora = (hhmm: string) => new Date(`1970-01-01T${hhmm}:00.000Z`);

async function limpar(): Promise<void> {
  // `turma_encontros` NÃO aparece aqui de propósito: ela cai por cascata de
  // `turmas`, e um teste abaixo prova isso. Apagá-la à mão esconderia a
  // cascata quebrada.
  await prisma.turma.deleteMany({ where: { companyId: EMPRESA } });
  await prisma.quadra.deleteMany({ where: { companyId: EMPRESA } });
  await prisma.esporteDeQuadra.deleteMany({ where: { companyId: EMPRESA } });
  await prisma.empresa.deleteMany({ where: { id: EMPRESA } });
}

async function semear(): Promise<void> {
  await prisma.empresa.create({
    data: { id: EMPRESA, nome: 'Clube 019', slug: 'clube-019' },
  });
  await prisma.esporteDeQuadra.create({
    data: { id: ESPORTE, companyId: EMPRESA, nome: 'Tênis', ordem: 0 },
  });
  await prisma.quadra.create({
    data: {
      id: QUADRA,
      companyId: EMPRESA,
      nome: 'Q',
      esporteId: ESPORTE,
      precoHora: 100,
    },
  });
  await prisma.turma.create({
    data: {
      id: TURMA,
      companyId: EMPRESA,
      nome: 'T',
      quadraId: QUADRA,
      // SPEC-019/TASK-003 — as três colunas antigas saíram. A turma nasce
      // aqui **sem encontro nenhum**, de propósito: cada teste cria os que
      // precisa, e "turma sem encontro" é exatamente o estado que a INV-051
      // proíbe e que o banco NÃO impede — ver o cabeçalho deste arquivo.
      capacidade: 10,
    },
  });
}

const encontro = (dados: {
  diaSemana?: number;
  inicio?: string;
  fim?: string;
}) =>
  prisma.turmaEncontro.create({
    data: {
      turmaId: TURMA,
      diaSemana: dados.diaSemana ?? 2,
      horaInicio: hora(dados.inicio ?? '18:00'),
      horaFim: hora(dados.fim ?? '19:00'),
    },
  });

describe('SPEC-019/TASK-001 — `turma_encontros` contra Postgres real', () => {
  beforeEach(async () => {
    await limpar();
    await semear();
  });

  afterAll(async () => {
    await limpar();
    await prisma.$disconnect();
  });

  describe('o CHECK de horário', () => {
    it('aceita fim depois do início', async () => {
      await expect(
        encontro({ inicio: '18:00', fim: '19:00' }),
      ).resolves.toBeTruthy();
    });

    it('RECUSA fim ANTES do início — e quem recusa é o banco', async () => {
      await expect(
        encontro({ inicio: '19:00', fim: '18:00' }),
      ).rejects.toThrow();
    });

    it('RECUSA duração zero', async () => {
      // A desigualdade é estrita de propósito: um encontro de duração zero
      // geraria ocupação de duração zero, que o `EXCLUDE` de
      // `ocupacoes_quadra` não pega — `tsrange` vazio não colide com nada.
      await expect(
        encontro({ inicio: '18:00', fim: '18:00' }),
      ).rejects.toThrow();
    });

    it('e a recusa é pelo CHECK, não por acaso', async () => {
      // Sem conferir a causa, os dois testes acima passariam também se o
      // INSERT falhasse por qualquer outro motivo — provando nada.
      // `23514` é `check_violation` no padrão SQL. O código é o
      // discriminador estável; a mensagem varia com versão e locale.
      await expect(encontro({ inicio: '19:00', fim: '18:00' })).rejects.toThrow(
        /23514/,
      );
    });
  });

  describe('o CHECK de dia da semana', () => {
    it.each([0, 6])('aceita o dia %i', async (dia) => {
      await expect(encontro({ diaSemana: dia })).resolves.toBeTruthy();
    });

    it.each([7, -1])('RECUSA o dia %i', async (dia) => {
      // Sem este CHECK, um `7` entraria e a turma geraria **zero** ocupações
      // em silêncio: uma turma que existe e nunca acontece. O sintoma
      // apareceria como "a aula não aparece na agenda", semanas depois.
      await expect(encontro({ diaSemana: dia })).rejects.toThrow(/23514/);
    });
  });

  describe('AC-007 — dois encontros no MESMO dia', () => {
    it('são aceitos quando não se sobrepõem', async () => {
      // Turma que treina terça de manhã e terça à noite é caso real, e é por
      // isso que NÃO existe `UNIQUE(turma_id, dia_semana)`. Se alguém
      // acrescentar essa UNIQUE "por simetria", este teste cai.
      await encontro({ diaSemana: 2, inicio: '07:00', fim: '08:00' });
      await expect(
        encontro({ diaSemana: 2, inicio: '18:00', fim: '19:00' }),
      ).resolves.toBeTruthy();
    });

    it('e o banco NÃO recusa os sobrepostos — quem recusa é a AC-006 e o EXCLUDE', async () => {
      // Registro honesto de uma lacuna deliberada: nesta tabela não há nada
      // que impeça dois encontros sobrepostos. A defesa está em outro lugar
      // — a validação da AC-006 (mensagem honesta) e o `EXCLUDE`
      // `no_overlap_por_quadra` de `ocupacoes_quadra`, que colide de verdade
      // porque não sabe de qual turma vem cada ocupação.
      //
      // Este teste existe para que a lacuna seja uma decisão registrada, e
      // não uma descoberta futura.
      await encontro({ diaSemana: 3, inicio: '18:00', fim: '19:00' });
      await expect(
        encontro({ diaSemana: 3, inicio: '18:30', fim: '19:30' }),
      ).resolves.toBeTruthy();
    });
  });

  describe('a exclusão em cascata', () => {
    it('apagar a turma leva os encontros junto', async () => {
      await encontro({ diaSemana: 1 });
      await encontro({ diaSemana: 4 });

      await prisma.turma.delete({ where: { id: TURMA } });

      const sobraram = await prisma.turmaEncontro.count({
        where: { turmaId: TURMA },
      });
      expect(sobraram).toBe(0);
    });

    it('apagar a EMPRESA continua funcionando — a cascata atravessa', async () => {
      // **Este é o teste que a SPEC-020 me ensinou a escrever.** Lá, tabela
      // nova por empresa com FK `RESTRICT` derrubou a limpeza escrita à mão
      // três vezes, e o sintoma chegou como suíte inteira vermelha com erro
      // de constraint sem relação com o teste.
      //
      // Aqui a cascata é `turma_encontros → turmas`, e `turmas` é apagada por
      // `limparEmpresa`. Se alguém trocar para `RESTRICT`, ou der um
      // `company_id` a esta tabela sem pô-la em `TABELAS_DA_EMPRESA`, é aqui
      // que aparece.
      await encontro({ diaSemana: 1 });

      await expect(limpar()).resolves.not.toThrow();
      expect(
        await prisma.turmaEncontro.count({ where: { turmaId: TURMA } }),
      ).toBe(0);
    });
  });

  /**
   * **Os dois testes de backfill que viviam aqui saíram na TASK-003, e não
   * por descuido.**
   *
   * Eles liam as três colunas antigas de `turmas` para conferir a cópia —
   * colunas que a contract derrubou. Reescrevê-los sem elas seria escrever
   * um teste que não testa o backfill.
   *
   * **A prova não sumiu: mudou de lugar, e para um lugar melhor.** A própria
   * migration de expand termina com um bloco `DO $$` que ABORTA se alguma
   * turma ficar sem encontro, e ele roda em TODO `migrate deploy` sobre banco
   * novo — incluindo o do CI. Um teste depois provaria o mesmo, um passo mais
   * tarde e com menos consequência.
   */
  describe(`a contract, e o que ela deixou para trás`, () => {
    it(`as três colunas antigas não existem mais em turmas`, async () => {
      const linhas = await prisma.$queryRawUnsafe<{ column_name: string }[]>(
        `SELECT column_name FROM information_schema.columns
         WHERE table_name = 'turmas'
           AND column_name IN ('dia_semana', 'hora_inicio', 'hora_fim')`,
      );

      expect(linhas).toHaveLength(0);
    });

    it(`a recorrência agora é a filha, com N linhas por turma`, async () => {
      await encontro({ diaSemana: 2, inicio: '18:00', fim: '19:00' });
      await encontro({ diaSemana: 6, inicio: '07:00', fim: '08:30' });

      expect(
        await prisma.turmaEncontro.count({ where: { turmaId: TURMA } }),
      ).toBe(2);
    });
  });
});
