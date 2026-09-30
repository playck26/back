import {
  ConflictException,
  HttpException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CODIGOS_DE_INFRA,
  comTraducaoDaMatricula,
  MENSAGEM_ALTERACAO_EM_ANDAMENTO,
  MENSAGEM_OUTRA_PESSOA_NA_TURMA,
  MENSAGEM_SERVIDOR_OCUPADO,
  naEtapa,
  traduzirErroDaMatricula,
} from './erro-transitorio';
import {
  clienteContado,
  RAMO_MAIS_CARO,
} from '../../../test/utils/cliente-contado-da-matricula';

/**
 * SPEC-082/D4 (AC-008 e a parte de unidade do AC-006) — **a tradução das rotas
 * leitoras**: `P2028`/`P2024` ⇒ 503 `SERVIDOR_OCUPADO` com a I5; `55P03` ⇒ 409
 * `MATRICULA_EM_ANDAMENTO` com a mensagem da ETAPA (I4 na turma, I6 no resto).
 *
 * Os textos são conferidos **exatos**, contra a tabela de decisões da spec — e
 * não contra as constantes, que é o que uma troca de texto mudaria junto.
 */

const I4 =
  'Outra pessoa está entrando nesta turma agora. Tente de novo em alguns segundos.';
const I5 =
  'O sistema está com muita procura agora. Tente de novo em alguns segundos.';
const I6 =
  'Já existe uma alteração em andamento na sua matrícula ou no clube. Tente de novo em alguns segundos.';

function erroDoPrisma(code: string, meta?: Record<string, unknown>) {
  return new Prisma.PrismaClientKnownRequestError(`erro ${code}`, {
    code,
    clientVersion: '6.19.3',
    meta,
  });
}

/** O `55P03` como o `$queryRaw` o entrega: `P2010` com o SQLSTATE no `meta`. */
const esperaEstourada = () =>
  erroDoPrisma('P2010', {
    code: '55P03',
    message: 'canceling statement due to lock timeout',
  });

function corpo(erro: unknown) {
  return (erro as HttpException).getResponse();
}

function traduzido(erro: unknown): unknown {
  try {
    traduzirErroDaMatricula(erro);
  } catch (e) {
    return e;
  }
  throw new Error('traduzirErroDaMatricula não lançou');
}

describe('SPEC-082/AC-008 — P2028 e P2024 viram 503 SERVIDOR_OCUPADO', () => {
  it.each(['P2028', 'P2024'])('%s ⇒ 503 com o texto exato da I5', (code) => {
    const original = erroDoPrisma(code);
    const e = traduzido(original);

    expect(e).toBeInstanceOf(ServiceUnavailableException);
    expect((e as HttpException).getStatus()).toBe(503);
    expect(corpo(e)).toEqual({
      statusCode: 503,
      code: 'SERVIDOR_OCUPADO',
      message: I5,
    });
    // A causa vai junto, para o log.
    expect((e as Error).cause).toBe(original);
  });

  it('a lista de códigos de infraestrutura mora num lugar só, e tem os dois', () => {
    expect([...CODIGOS_DE_INFRA].sort()).toEqual([
      'P1001',
      'P1002',
      'P1008',
      'P1017',
      'P2024',
      'P2028',
    ]);
  });

  it('outro erro do Prisma sobe como veio (não vira 503 nem 409)', () => {
    const original = erroDoPrisma('P2002');
    expect(traduzido(original)).toBe(original);
  });

  it('erro de regra (HttpException) sobe como veio', () => {
    const regra = new ConflictException({ code: 'TURMA_CHEIA' });
    expect(traduzido(regra)).toBe(regra);
  });

  it('a mensagem da I5 é a constante publicada', () => {
    expect(MENSAGEM_SERVIDOR_OCUPADO).toBe(I5);
  });
});

describe('SPEC-082/AC-006 (unidade) — 55P03 vira 409 com a mensagem da etapa', () => {
  async function naEtapaQueFalha(
    etapa: 'travas' | 'turma' | 'fila' | null,
  ): Promise<unknown> {
    const erro = esperaEstourada();
    try {
      if (etapa) await naEtapa(etapa, Promise.reject(erro));
      else throw erro;
    } catch (e) {
      return traduzido(e);
    }
    throw new Error('não falhou');
  }

  it.each([
    ['travas', I6],
    ['turma', I4],
    ['fila', I6],
    [null, I6],
  ] as const)(
    'etapa %s ⇒ 409 MATRICULA_EM_ANDAMENTO com o texto exato',
    async (etapa, texto) => {
      const e = await naEtapaQueFalha(etapa);
      expect(e).toBeInstanceOf(ConflictException);
      expect(corpo(e)).toEqual({
        statusCode: 409,
        code: 'MATRICULA_EM_ANDAMENTO',
        message: texto,
      });
    },
  );

  it('o 55P03 também é reconhecido no erro sem código conhecido (texto do Postgres)', () => {
    const e = traduzido(
      new Prisma.PrismaClientUnknownRequestError(
        'Error occurred during query execution: ConnectorError(... PostgresError { code: "55P03", message: "canceling statement due to lock timeout" ...',
        { clientVersion: '6.19.3' },
      ),
    );
    expect(corpo(e)).toMatchObject({ code: 'MATRICULA_EM_ANDAMENTO' });
  });

  it('a primeira etapa carimbada vence (o erro de dentro não é reetiquetado por quem o envolve)', async () => {
    const erro = esperaEstourada();
    const e = await naEtapa(
      'fila',
      naEtapa('turma', Promise.reject(erro)),
    ).catch((x: unknown) => traduzido(x));
    expect(corpo(e)).toMatchObject({ message: I4 });
  });

  it('as mensagens I4 e I6 são as constantes publicadas', () => {
    expect(MENSAGEM_OUTRA_PESSOA_NA_TURMA).toBe(I4);
    expect(MENSAGEM_ALTERACAO_EM_ANDAMENTO).toBe(I6);
  });
});

describe('SPEC-082/AC-008 — P2028 dentro da transação de verdade vira 503, sem gravar', () => {
  it.each(['entrar', 'allocateStudent', 'confirmar'] as const)(
    '%s: o P2028 no INSERT da matrícula ⇒ 503 SERVIDOR_OCUPADO, e a transação termina em ROLLBACK',
    async (caminho) => {
      const cliente = clienteContado(RAMO_MAIS_CARO, {
        falha: (ida) =>
          ida.sql?.trimStart().startsWith('/* matricula-com-prazo */')
            ? erroDoPrisma('P2028')
            : undefined,
      });
      const e = await comTraducaoDaMatricula<unknown>(() =>
        cliente[caminho](),
      ).then(
        () => null,
        (x: unknown) => x,
      );
      expect(e).toBeInstanceOf(ServiceUnavailableException);
      expect(corpo(e)).toEqual({
        statusCode: 503,
        code: 'SERVIDOR_OCUPADO',
        message: I5,
      });
      const rotulos = cliente.idas.map((i) => i.rotulo);
      expect(rotulos[rotulos.length - 1]).toBe('ROLLBACK');
      expect(rotulos).not.toContain('COMMIT');
    },
  );
});
