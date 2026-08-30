import { ConflictException } from '@nestjs/common';
import { hojeNoFusoDoClube } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { AvaliacaoDeAulaService } from './avaliacao-de-aula.service';

/**
 * TEST (SPEC-030) — **não se avalia aula que não aconteceu.**
 *
 * Este é o achado que apareceu ao escrever a TASK-006, e não estava na spec:
 * a aula marcada `nao_houve` **não é cancelada** — a quadra esteve ocupada —,
 * então o filtro existente de `aulasAnteriores` não a pegava. O aluno
 * receberia um convite para avaliar uma aula que ninguém deu, e a nota
 * entraria na média da turma para sempre.
 *
 * As duas metades são provadas aqui porque **uma sem a outra é a armadilha do
 * DEF-011**: lista que oferece o que o servidor recusa. Esconder o botão
 * resolve o engano honesto; só o servidor resolve o pedido montado à mão.
 */

const EMPRESA = 'a0000000-0000-4000-8000-000000000001';
const ALUNO = 'a0000000-0000-4000-8000-000000000003';
const OCUPACAO = 'a0000000-0000-4000-8000-000000000004';

function ontem(): Date {
  return new Date(hojeNoFusoDoClube().getTime() - 24 * 60 * 60 * 1000);
}

/**
 * `chamadas` é a relação do cabeçalho — lista de zero ou um, pela FK
 * composta. `[]` = sem chamada; `[{ completude }]` = com.
 */
function servicoCom(chamadas: { completude: string }[]) {
  const prisma = {
    aluno: { findFirst: jest.fn().mockResolvedValue({ id: ALUNO }) },
    turmaAluno: {
      findMany: jest.fn().mockResolvedValue([{ turmaId: 'turma-1' }]),
      findFirst: jest.fn().mockResolvedValue({ id: 'matricula-1' }),
    },
    ocupacaoQuadra: {
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue({
        id: OCUPACAO,
        data: ontem(),
        origemTurmaId: 'turma-1',
        chamadas,
      }),
    },
  } as unknown as PrismaService;
  return { service: new AvaliacaoDeAulaService(prisma), prisma };
}

describe('SPEC-030 — a aula que não aconteceu sai da avaliação', () => {
  describe('o servidor recusa (o portão de verdade)', () => {
    it('aula `nao_houve` devolve 409 `AULA_NAO_REALIZADA`', async () => {
      const { service } = servicoCom([{ completude: 'nao_houve' }]);

      await expect(
        service.avaliar(EMPRESA, 'u-aluno', OCUPACAO, {
          nota: 5,
          comentario: null,
        }),
      ).rejects.toMatchObject({ response: { code: 'AULA_NAO_REALIZADA' } });
    });

    it('a recusa é 409, não 404 — a aula existe, e o aluno tem direito a saber por quê', async () => {
      const { service } = servicoCom([{ completude: 'nao_houve' }]);

      await expect(
        service.avaliar(EMPRESA, 'u-aluno', OCUPACAO, {
          nota: 5,
          comentario: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([
      [[]],
      [[{ completude: 'completa' }]],
      [[{ completude: 'desconhecida' }]],
    ])('aula normal (%j) NÃO é barrada por este portão', async (chamadas) => {
      const { service } = servicoCom(chamadas);

      // Não afirma que a avaliação foi gravada (o mock não tem `upsert`):
      // afirma que ela **não parou aqui**. É o par negativo da prova acima,
      // e sem ele um portão que barrasse tudo passaria despercebido.
      await expect(
        service.avaliar(EMPRESA, 'u-aluno', OCUPACAO, {
          nota: 5,
          comentario: null,
        }),
      ).rejects.not.toMatchObject({
        response: { code: 'AULA_NAO_REALIZADA' },
      });
    });
  });

  describe('a lista não oferece', () => {
    it('`aulasAnteriores` filtra por `chamadas: { none: { completude: nao_houve } }`', async () => {
      const { service, prisma } = servicoCom([]);

      await service.aulasAnteriores(EMPRESA, 'u-aluno');

      // O MESMO `where` alimenta a página e a contagem — filtro diferente faz
      // o total mentir sobre a lista.
      // `as unknown as` e não `as` direto: o tipo do Prisma Client e o de um
      // `jest.Mock` não se sobrepõem, e o `tsc` recusa a conversão curta. O
      // `lint` sozinho deixava passar — as duas checagens não são a mesma.
      type ComWhere = { where: Record<string, unknown> };
      type MockComWhere = jest.Mock<unknown, [ComWhere]>;
      const doCount = (prisma.ocupacaoQuadra.count as unknown as MockComWhere)
        .mock.calls[0][0];
      const daPagina = (
        prisma.ocupacaoQuadra.findMany as unknown as MockComWhere
      ).mock.calls[0][0];

      expect(doCount.where).toMatchObject({
        chamadas: { none: { completude: 'nao_houve' } },
      });
      expect(daPagina.where).toEqual(doCount.where);
    });
  });
});
