import { PrismaService } from '../prisma/prisma.service';
import { AvaliacaoDeAulaService } from './avaliacao-de-aula.service';

/**
 * SPEC-025 — a prova da **INV-025a**, e ela é a razão deste arquivo existir.
 *
 * A decisão do Israel é que só o painel Admin vê quem avaliou e o que
 * escreveu. Isso é do tipo que se perde num campo acrescentado sem querer —
 * por isso a prova olha o **JSON serializado**, e não os campos que eu
 * lembrei de conferir.
 *
 * O comportamento (quem pode, o que a UNIQUE garante, a agregação da turma,
 * a ordem por pior nota) é provado no `fit-012`, contra Postgres real, porque
 * dublê não tem constraint nenhuma.
 */

const EMPRESA = 'a0000000-0000-4000-8000-000000000001';
const TURMA = 'a0000000-0000-4000-8000-000000000002';

function servicoCom(media: number | null, quantidade: number) {
  const prisma = {
    turma: { findFirst: jest.fn().mockResolvedValue({ id: TURMA }) },
    avaliacaoDeAula: {
      aggregate: jest.fn().mockResolvedValue({
        _avg: { nota: media },
        _count: { _all: quantidade },
      }),
    },
  } as unknown as PrismaService;
  return new AvaliacaoDeAulaService(prisma);
}

describe('INV-025a — a média não conta quem disse o quê', () => {
  it('o JSON da média NÃO contém autoria nem comentário', async () => {
    // Sobre o serializado de propósito: conferir campo a campo provaria
    // apenas que eu lembrei de conferir os campos que eu mesmo escrevi.
    const resposta = await servicoCom(4.28, 7).mediaDaTurma(EMPRESA, TURMA);
    const serializado = JSON.stringify(resposta).toLowerCase();

    for (const proibido of ['nome', 'aluno', 'comentario', 'usuario']) {
      expect(serializado).not.toContain(proibido);
    }
  });

  it('a média agrega pelas AULAS da turma, E escopada por empresa', async () => {
    // Duas coisas numa assertiva só, e as duas custaram caro:
    //
    // 1. o caminho é `avaliacao -> ocupacao -> turma`. Trocá-lo por um
    //    filtro direto faria a média deixar de refletir as notas das aulas,
    //    que é o pedido inteiro;
    // 2. o `companyId` explícito é o **achado 1 da validação cruzada**. A FK
    //    composta passou a impedir ocupação de outra empresa apontando para
    //    esta turma; este filtro é a segunda tranca, no caminho de leitura.
    //    Isolamento entre empresas é caro demais para depender de uma camada
    //    só — e esta prova caiu quando o filtro foi acrescentado, que é
    //    exatamente o que ela deve fazer.
    const prisma = {
      turma: { findFirst: jest.fn().mockResolvedValue({ id: TURMA }) },
      avaliacaoDeAula: {
        aggregate: jest
          .fn()
          .mockResolvedValue({ _avg: { nota: 4 }, _count: { _all: 3 } }),
      },
    } as unknown as PrismaService;

    await new AvaliacaoDeAulaService(prisma).mediaDaTurma(EMPRESA, TURMA);

    const chamadas = (
      prisma as unknown as { avaliacaoDeAula: { aggregate: jest.Mock } }
    ).avaliacaoDeAula.aggregate.mock.calls as unknown[][];
    const args = chamadas[0][0] as { where: object };
    expect(args.where).toEqual({
      companyId: EMPRESA,
      ocupacao: { companyId: EMPRESA, origemTurmaId: TURMA },
    });
  });
});

/**
 * **SPEC-028 — o mínimo de 3 foi REMOVIDO, e estas provas mudaram de lado.**
 *
 * O Israel viu a tela mostrando "2 de 3 avaliações" e disse: *"o que seria 2
 * de 3 aval? Precisa apresentar a média de nota e não essa quantidade
 * atual"*. A média sai desde a primeira nota.
 *
 * A prova que exigia `null` com 2 avaliações **passou a exigir o contrário**.
 * Ela não foi apagada: inverter e explicar deixa o `git log` legível para
 * quem, daqui a seis meses, se perguntar por que a média de uma nota só
 * aparece.
 *
 * **O que se perdeu:** o mínimo era privacidade, não estatística. Com uma
 * nota, a média É aquela nota — e numa turma de dois alunos o professor sabe
 * quem disse o quê. Sinalizado a ele antes; decisão dele.
 */
describe('a média sai desde a primeira avaliação', () => {
  it('com 2, a média aparece — antes era `null`', async () => {
    const r = await servicoCom(4.5, 2).mediaDaTurma(EMPRESA, TURMA);

    expect(r.media).toBe(4.5);
    expect(r.quantidade).toBe(2);
  });

  it('com UMA só, também', async () => {
    // O caso extremo, e o que custa a privacidade: a média é a nota daquela
    // pessoa. Está aqui explícito para ninguém achar que foi descuido.
    const r = await servicoCom(2, 1).mediaDaTurma(EMPRESA, TURMA);

    expect(r.media).toBe(2);
    expect(r.quantidade).toBe(1);
  });

  it('com 3, continua aparecendo', async () => {
    expect((await servicoCom(4, 3).mediaDaTurma(EMPRESA, TURMA)).media).toBe(4);
  });

  it('arredonda a uma casa — cinco notas não distinguem 4,26 de 4,3', async () => {
    expect((await servicoCom(4.26, 9).mediaDaTurma(EMPRESA, TURMA)).media).toBe(
      4.3,
    );
  });

  it('turma sem avaliação nenhuma não quebra', async () => {
    const r = await servicoCom(null, 0).mediaDaTurma(EMPRESA, TURMA);

    expect(r.media).toBeNull();
    expect(r.quantidade).toBe(0);
  });
});

describe('as réguas ficam num lugar só', () => {
  it('detrator é quem deu 1 ou 2 — decisão sinalizada ao Israel', () => {
    // Escala 1–5 na leitura clássica: 1–2 detrator, 3 neutro, 4–5 promotor.
    // É a régua mais provável de ele querer mexer, e mora numa constante.
    expect(AvaliacaoDeAulaService.NOTA_MAXIMA_DE_DETRATOR).toBe(2);
  });

  it('o histórico de aulas anteriores olha 90 dias para trás', () => {
    expect(AvaliacaoDeAulaService.DIAS_DE_HISTORICO).toBe(90);
  });
});
