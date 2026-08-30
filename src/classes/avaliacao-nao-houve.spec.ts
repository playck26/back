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

  describe('a lista MOSTRA, e não esconde', () => {
    // **A 1ª e a 2ª validação cruzada se contradizem aqui, em aparência.**
    //
    // A 1ª: o aluno recebia convite para avaliar aula que não aconteceu. Eu
    // resolvi EXCLUINDO-A da lista. A 2ª mostrou o custo: `GET /me/classes`
    // só devolve o futuro, então a aula de ontem marcada `nao_houve` sumia
    // das DUAS listas do aluno — que pode ter ido até o clube.
    //
    // A conclusão é uma terceira coisa: a aula **fica**, marcada, e o que sai
    // é a possibilidade de avaliá-la. Esconder informação para impedir uma
    // ação é sempre o desenho errado.
    it('NÃO filtra a aula não realizada — ela continua na lista', async () => {
      const { service, prisma } = servicoCom([]);

      await service.aulasAnteriores(EMPRESA, 'u-aluno');

      type ComWhere = { where: Record<string, unknown> };
      type MockComWhere = jest.Mock<unknown, [ComWhere]>;
      const doCount = (prisma.ocupacaoQuadra.count as unknown as MockComWhere)
        .mock.calls[0][0];
      const daPagina = (
        prisma.ocupacaoQuadra.findMany as unknown as MockComWhere
      ).mock.calls[0][0];

      expect(doCount.where).not.toHaveProperty('chamadas');
      // O MESMO `where` alimenta a página e a contagem — filtro diferente faz
      // o total mentir sobre a lista.
      expect(daPagina.where).toEqual(doCount.where);
    });

    it('e marca a que não aconteceu, para a tela não montar o formulário', async () => {
      const { service, prisma } = servicoCom([]);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: OCUPACAO,
          origemTurmaId: 'turma-1',
          origemTurma: { id: 'turma-1', nome: 'Turma A' },
          quadra: { nome: 'Quadra 1' },
          chamadas: [{ completude: 'nao_houve' }],
          avaliacoes: [],
          data: ontem(),
          horaInicio: new Date('1970-01-01T18:00:00.000Z'),
          horaFim: new Date('1970-01-01T19:00:00.000Z'),
        },
      ]);

      const r = await service.aulasAnteriores(EMPRESA, 'u-aluno');

      expect(r.data[0].naoRealizada).toBe(true);
    });

    it('a aula normal não vem marcada', async () => {
      const { service, prisma } = servicoCom([]);
      (prisma.ocupacaoQuadra.findMany as jest.Mock).mockResolvedValue([
        {
          id: OCUPACAO,
          origemTurmaId: 'turma-1',
          origemTurma: { id: 'turma-1', nome: 'Turma A' },
          quadra: { nome: 'Quadra 1' },
          chamadas: [{ completude: 'completa' }],
          avaliacoes: [],
          data: ontem(),
          horaInicio: new Date('1970-01-01T18:00:00.000Z'),
          horaFim: new Date('1970-01-01T19:00:00.000Z'),
        },
      ]);

      const r = await service.aulasAnteriores(EMPRESA, 'u-aluno');

      expect(r.data[0].naoRealizada).toBe(false);
    });
  });
});

/**
 * **ACHADO 2 DA 2ª VALIDAÇÃO CRUZADA (ALTA) — a ordem inversa.**
 *
 * O portão `AULA_NAO_REALIZADA` barra avaliar uma aula **já marcada**, e eu
 * tinha escrito no comentário dele que isso impedia a nota de entrar na média
 * *"para sempre"*. **Não impedia.** A sequência inversa passava inteira:
 *
 * 1. aula de ontem, sem cabeçalho;
 * 2. o aluno avalia — permitido, e gravado;
 * 3. o gestor registra `nao_houve` — permitido, porque a única barreira do
 *    registro é `count(presencas) > 0`, e **avaliação não é presença**;
 * 4. a nota continuava na média da turma e na lista do gestor.
 *
 * Há ainda a versão concorrente, que nenhum lock fecharia: a avaliação lê
 * antes do `upsert` e grava depois. O caminho de avaliação não participa do
 * lock da turma, e não deveria participar.
 *
 * **Por isso a correção é na LEITURA, não na escrita.** Filtrar ao agregar
 * resolve as duas ordens e a corrida de uma vez, e sem apagar dado do aluno:
 * quem avaliou continua tendo avaliado; a nota apenas deixa de falar sobre
 * uma aula que não aconteceu.
 */
describe('SPEC-030 — a nota de uma aula `nao_houve` sai da média', () => {
  function servicoParaAgregacao() {
    const aggregate = jest.fn().mockResolvedValue({
      _avg: { nota: 4 },
      _count: { _all: 2 },
    });
    const findMany = jest.fn().mockResolvedValue([]);
    const prisma = {
      turma: { findFirst: jest.fn().mockResolvedValue({ id: 'turma-1' }) },
      avaliacaoDeAula: { aggregate, findMany },
    } as unknown as PrismaService;
    return { service: new AvaliacaoDeAulaService(prisma), aggregate, findMany };
  }

  const FILTRO = {
    ocupacao: expect.objectContaining({
      chamadas: { none: { completude: 'nao_houve' } },
    }),
  };

  it('a MÉDIA da turma exclui as aulas não realizadas', async () => {
    const { service, aggregate } = servicoParaAgregacao();

    await service.mediaDaTurma(EMPRESA, 'turma-1');

    expect(aggregate).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(FILTRO) }),
    );
  });

  it('a LISTA do gestor exclui as mesmas', async () => {
    // As duas leituras, e não só a média: o gestor caça detrator por esta
    // lista, e uma nota de aula que não houve o mandaria conversar com o
    // professor sobre uma terça-feira que não existiu.
    const { service, findMany } = servicoParaAgregacao();

    await service.listarParaOGestor(EMPRESA, 'turma-1');

    expect(findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining(FILTRO) }),
    );
  });
});
