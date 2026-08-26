import { StudentsService } from '../people/students.service';
import { TeachersService } from '../people/teachers.service';
import { CourtsService } from '../courts/courts.service';
import { CompaniesService } from '../companies/companies.service';
import { COLUNAS_DE_MIDIA } from './colunas-de-midia';

/**
 * SPEC-018/TASK-008 — **INV-041: `inativo` nunca enfileira exclusão de
 * arquivo** (AC-012).
 *
 * ## Por que este arquivo é transversal, e não um teste em cada serviço
 *
 * A invariante é **uma**, e o que a ameaça é sempre o mesmo movimento:
 * alguém trata inativação como exclusão "porque é quase igual". Espalhada em
 * quatro arquivos, ela vira quatro testes que ninguém lê junto, e o quinto
 * serviço nasce sem nenhum.
 *
 * ## Por que ela é frágil hoje
 *
 * **Ela está sendo cumprida por ausência.** Nenhum dos quatro serviços de
 * status conhece a fila — não há linha nenhuma a apagar, nem a chamar. Um
 * teste que só afirmasse "a fila não foi chamada" passaria mesmo se alguém
 * tivesse apagado o código todo, porque não há fila injetada para chamar.
 *
 * Por isso o que se afirma aqui é o que um violador **teria de escrever**:
 * pôr a coluna de mídia no `data` do `update`, para zerá-la junto com o
 * status. É o caminho mais curto e mais provável, e é o que estes testes
 * fecham.
 *
 * ## O custo de errar
 *
 * Inativação é **reversível** — o aluno que sai em dezembro volta em março e
 * reencontra a própria ficha. Exclusão não é. Tratar as duas igual faz a
 * operação mais comum do produto (desligar aluno no fim do ano) destruir o
 * dado que a operação seguinte (recontratar) precisa. E, depois da TASK-007,
 * o worker **apaga de verdade**: o arquivo não estaria só desreferenciado,
 * estaria fora do bucket.
 */

/**
 * Uma linha que satisfaz os mappers dos quatro servicos. Ela e generosa de
 * proposito: o que este arquivo prova nao e o formato da resposta, e sim o
 * que vai no `data` do `update` — e um duble pobre demais faria os testes
 * caírem por motivo que nao tem nada a ver com a INV-041.
 */
const linhaFalsa = () => ({
  id: 'x',
  companyId: 'c1',
  usuarioId: 'u1',
  nome: 'Alguém',
  email: 'a@b.c',
  telefone: null,
  esporte: 'tenis',
  slug: 'alguem',
  status: 'inativo',
  nivelId: null,
  precoHora: { toNumber: () => 100 },
  createdAt: new Date(),
  usuario: {
    id: 'u1',
    nome: 'Alguém',
    email: 'a@b.c',
    telefone: null,
    status: 'inativo',
    fotoKey: null,
  },
});

/** Captura o `data` de cada `update` que o serviço fizer. */
function capturador() {
  const updates: { modelo: string; data: Record<string, unknown> }[] = [];

  const update = (modelo: string) =>
    jest.fn((args: { data: Record<string, unknown> }) => {
      updates.push({ modelo, data: args.data });
      return Promise.resolve(linhaFalsa());
    });

  const delegate = (modelo: string) => ({
    update: update(modelo),
    findFirst: jest.fn(() => Promise.resolve(linhaFalsa())),
    findUnique: jest.fn(() => Promise.resolve(linhaFalsa())),
  });

  const prisma = {
    aluno: delegate('Aluno'),
    professor: delegate('Professor'),
    quadra: delegate('Quadra'),
    empresa: delegate('Empresa'),
    usuario: delegate('Usuario'),
    refreshToken: { updateMany: jest.fn(() => Promise.resolve({ count: 0 })) },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => fn(prisma),
  };

  return { prisma, updates };
}

/** As colunas de mídia, pelo nome do campo — vindas da lista central. */
const CAMPOS_DE_MIDIA = COLUNAS_DE_MIDIA.map((c) => c.campo);

/**
 * A asserção que importa: **nenhum `update` disparado por uma mudança de
 * status pode carregar campo de mídia no `data`.**
 *
 * Ela lê os campos da lista central (`COLUNAS_DE_MIDIA`), e não de uma lista
 * própria: quando a quinta coluna de mídia aparecer, este teste passa a
 * cobri-la sem que ninguém precise lembrar — a mesma costura que a AC-017
 * usa para o checker.
 */
function nenhumUpdateTocaEmMidia(
  updates: { modelo: string; data: Record<string, unknown> }[],
): void {
  expect(updates.length).toBeGreaterThan(0); // o serviço de fato atualizou
  for (const u of updates) {
    for (const campo of CAMPOS_DE_MIDIA) {
      expect(Object.keys(u.data)).not.toContain(campo);
    }
  }
}

describe('INV-041 — inativar preserva a mídia (AC-012)', () => {
  it('a lista de campos de mídia não está vazia', () => {
    // Controle positivo. Sem ele, uma lista vazia faria todos os testes
    // abaixo passarem por não terem o que procurar — e o arquivo inteiro
    // viraria decoração. A lição de 2026-08-26, aplicada de novo.
    expect(CAMPOS_DE_MIDIA.length).toBeGreaterThanOrEqual(4);
    expect(CAMPOS_DE_MIDIA).toContain('fotoKey');
    expect(CAMPOS_DE_MIDIA).toContain('imagemKey');
    expect(CAMPOS_DE_MIDIA).toContain('logoKey');
  });

  it('inativar ALUNO não zera a foto', async () => {
    const { prisma, updates } = capturador();
    const service = new StudentsService(prisma as never);

    await service.update('c1', 'a1', { status: 'inativo' } as never);

    nenhumUpdateTocaEmMidia(updates);
    // E o serviço fez o que devia: mexeu no status, na ficha e na conta.
    expect(updates.some((u) => u.data.status === 'inativo')).toBe(true);
  });

  it('inativar PROFESSOR não zera a foto', async () => {
    const { prisma, updates } = capturador();
    const fotos = {
      resolver: jest.fn(() => Promise.resolve({ fotoUrl: null })),
    };
    const service = new TeachersService(prisma as never, fotos as never);

    await service.update('c1', 'p1', { status: 'inativo' } as never);

    nenhumUpdateTocaEmMidia(updates);
  });

  it('inativar QUADRA não zera a imagem nem a confirmação', async () => {
    const { prisma, updates } = capturador();
    const imagens = { resolver: jest.fn(() => ({ imagemUrl: null })) };
    const service = new CourtsService(
      prisma as never,
      {} as never,
      {} as never,
      imagens as never,
    );

    await service.update('c1', 'q1', { status: 'inativa' } as never);

    nenhumUpdateTocaEmMidia(updates);
    // A confirmação também fica: ela é o registro de quem afirmou o quê, e
    // apagá-la na inativação faria a quadra voltar sem afirmação nenhuma —
    // e a constraint recusaria a linha.
    for (const u of updates) {
      expect(Object.keys(u.data)).not.toContain('imagemConfirmadaPor');
      expect(Object.keys(u.data)).not.toContain('imagemConfirmadaEm');
    }
  });

  it('inativar EMPRESA não zera a logo', async () => {
    const { prisma, updates } = capturador();
    const logos = { resolver: jest.fn(() => ({ logoUrl: null })) };
    // O 2o argumento e o AuthService, que esta rota nao usa.
    const service = new CompaniesService(
      prisma as never,
      {} as never,
      logos as never,
    );

    await service.updateStatus('e1', { status: 'inativa' } as never);

    nenhumUpdateTocaEmMidia(updates);
  });

  it('reativar também não mexe em mídia', async () => {
    // O caminho de volta importa tanto quanto: um serviço que "restaurasse"
    // a foto na reativação estaria admitindo que a apagou na ida.
    const { prisma, updates } = capturador();
    const service = new StudentsService(prisma as never);

    await service.update('c1', 'a1', { status: 'ativo' } as never);

    nenhumUpdateTocaEmMidia(updates);
  });
});
