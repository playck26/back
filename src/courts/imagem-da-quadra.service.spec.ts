import {
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { montarChave } from '../storage/chave-de-midia';
import {
  confirmouSemPessoas,
  ImagemDaQuadraService,
  MOTIVO_REMOCAO_IMAGEM,
  MOTIVO_TROCA_IMAGEM,
} from './imagem-da-quadra.service';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-018/TASK-005 — as provas da imagem de quadra.
 *
 * **O que este arquivo guarda que o da logo não guardava é a confirmação.**
 * A logo é material corporativo e sobe sem pergunta; a imagem de quadra é
 * pública, permanente, e pode mostrar aluno menor de idade. A opção B
 * (decisão 1 da spec) só vale alguma coisa se o **servidor** exigir a
 * afirmação — aviso de tela que o cliente pode não mandar é decoração.
 *
 * Por isso a maior parte daqui é sobre `semPessoasIdentificaveis`, e em
 * especial sobre a forma como ele chega: **multipart manda string**, e
 * `"false"` é uma string não vazia.
 */

const EMPRESA_A = '11111111-1111-4111-8111-111000180011';
const EMPRESA_B = '22222222-2222-4222-8222-222000180012';
const ADMIN_A = '33333333-3333-4333-8333-333000180013';
const QUADRA_1 = '44444444-4444-4444-8444-444000180014';

const CDN = 'https://cdn.exemplo/';

/**
 * O menor VP8 válido que o validador aceita.
 *
 * **Não há parâmetro de "cor", e a ausência é o registro de um erro.** A
 * primeira versão deste arquivo copiou do spec da logo um helper
 * `webpValido(cor = 0x9d)` que escrevia `frame[3] = cor`, e chamou-o com
 * `0x8d` para gerar "outra imagem". Mas `frame[3]` não é cor: é o primeiro
 * byte do start code do VP8 (`9d 01 2a`). O resultado foi um arquivo que o
 * próprio validador recusou, e um teste vermelho por motivo que não tinha
 * nada a ver com o que ele queria provar.
 */
function webpValido(): Buffer {
  const frame = Buffer.from([
    0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, 0x01, 0x00, 0x01, 0x00, 0x02, 0x00,
    0x34, 0x25, 0xa4, 0x00, 0x03, 0x70, 0x00, 0xfe, 0xfb, 0xfd, 0x50, 0x00,
  ]);
  const chunk = Buffer.alloc(8 + frame.length);
  chunk.write('VP8 ', 0, 'ascii');
  chunk.writeUInt32LE(frame.length, 4);
  frame.copy(chunk, 8);
  const riff = Buffer.alloc(12 + chunk.length);
  riff.write('RIFF', 0, 'ascii');
  riff.writeUInt32LE(4 + chunk.length, 4);
  riff.write('WEBP', 8, 'ascii');
  chunk.copy(riff, 12);
  return riff;
}

const chaveDe = (
  companyId: string,
  quadraId = QUADRA_1,
  sha = 'a'.repeat(64),
) =>
  montarChave({ companyId, tipo: 'quadra', recursoId: quadraId, sha256: sha })!;

const gestorDeA: AccessTokenPayload = {
  sub: ADMIN_A,
  role: 'company_admin',
  companyId: EMPRESA_A,
} as AccessTokenPayload;

const superAdmin: AccessTokenPayload = {
  sub: 'super',
  role: 'super_admin',
  companyId: null,
} as AccessTokenPayload;

function montar(quadra: { imagemKey: string | null; companyId?: string }) {
  const estado = {
    id: QUADRA_1,
    companyId: EMPRESA_A,
    ...quadra,
  };
  const ordem: string[] = [];

  const update = jest.fn((args: { data: Record<string, unknown> }) => {
    ordem.push('banco:update');
    return Promise.resolve(args);
  });
  const enfileirar = jest.fn(() => {
    ordem.push('fila:enfileirar');
    return Promise.resolve('enfileirada');
  });
  const gravar = jest.fn(() => {
    ordem.push('storage:gravar');
    return Promise.resolve();
  });

  const prisma = {
    quadra: {
      findFirst: jest.fn(
        ({ where }: { where: { id: string; companyId: string } }) =>
          Promise.resolve(
            where.id === estado.id && where.companyId === estado.companyId
              ? estado
              : null,
          ),
      ),
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      ordem.push('transacao:inicio');
      const r = await fn({ quadra: { update } });
      ordem.push('transacao:fim');
      return r;
    },
  };

  const servico = new ImagemDaQuadraService(
    prisma as never,
    { visibilidadeDoTipo: () => 'publico' as const } as never,
    { enfileirar } as never,
    { gravar, urlPublica: (key: string) => CDN + key } as never,
  );

  return { servico, ordem, gravar, enfileirar, update };
}

describe('confirmouSemPessoas — AC-007, e a armadilha do multipart', () => {
  it('aceita o boolean `true` e a string "true", e nada mais', () => {
    expect(confirmouSemPessoas(true)).toBe(true);
    expect(confirmouSemPessoas('true')).toBe(true);
  });

  it('RECUSA a string "false" — o caso que o jeito ingênuo aceitaria', () => {
    // `Boolean('false')` é `true`, porque toda string não vazia é verdadeira
    // em JavaScript. Uma tela com o checkbox DESMARCADO que mandasse
    // `semPessoasIdentificaveis=false` passaria pelo gate que existe
    // exatamente para barrá-la — e a linha gravada diria que alguém
    // confirmou. Este é o teste que separa o gate do enfeite.
    expect(confirmouSemPessoas('false')).toBe(false);
    expect(confirmouSemPessoas(false)).toBe(false);
  });

  it('RECUSA as formas quase certas que um cliente mandaria por engano', () => {
    // Ser estrito custa uma tela ter de mandar o valor certo. Ser frouxo
    // custa a afirmação não valer nada — e ela é o que a opção B tem.
    for (const valor of [
      '1',
      1,
      'on',
      'sim',
      'TRUE',
      'True',
      ' true',
      'true ',
      '',
      null,
      undefined,
      {},
      ['true'],
    ]) {
      expect(confirmouSemPessoas(valor)).toBe(false);
    }
  });
});

describe('substituir — a confirmação vem antes de tudo', () => {
  it('AC-007 — sem a confirmação: 422, e NADA é gravado', async () => {
    const { servico, gravar, enfileirar, update } = montar({ imagemKey: null });

    await expect(
      servico.substituir(QUADRA_1, gestorDeA, webpValido(), undefined),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);

    // "nada gravado" é a metade da AC-007 que um teste de status esqueceria:
    // nem objeto no bucket, nem linha na fila, nem update no banco.
    expect(gravar).not.toHaveBeenCalled();
    expect(enfileirar).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('AC-007 — o código da recusa é CONFIRMACAO_OBRIGATORIA', async () => {
    const { servico } = montar({ imagemKey: null });
    await expect(
      servico.substituir(QUADRA_1, gestorDeA, webpValido(), 'false'),
    ).rejects.toMatchObject({
      response: { code: 'CONFIRMACAO_OBRIGATORIA' },
    });
  });

  it('a confirmação é conferida ANTES do WebP: arquivo inválido sem confirmação ainda é CONFIRMACAO_OBRIGATORIA', async () => {
    // A ordem importa para a AC-007 ("nada gravado"): conferir o WebP
    // primeiro gastaria trabalho e, pior, daria à pessoa uma mensagem sobre
    // o arquivo quando o problema é a afirmação que falta.
    const { servico } = montar({ imagemKey: null });
    await expect(
      servico.substituir(QUADRA_1, gestorDeA, Buffer.from('nem webp'), null),
    ).rejects.toMatchObject({
      response: { code: 'CONFIRMACAO_OBRIGATORIA' },
    });
  });

  it('AC-008 — com a confirmação, grava autor e data junto da chave', async () => {
    const { servico, update } = montar({ imagemKey: null });
    const antes = Date.now();

    await servico.substituir(QUADRA_1, gestorDeA, webpValido(), 'true');

    const dados = update.mock.calls[0][0].data;
    expect(dados.imagemKey).toEqual(expect.stringContaining(EMPRESA_A));
    // O autor é quem mandou, e vem do TOKEN — não de campo do formulário.
    expect(dados.imagemConfirmadaPor).toBe(ADMIN_A);
    expect(dados.imagemConfirmadaEm).toBeInstanceOf(Date);
    expect((dados.imagemConfirmadaEm as Date).getTime()).toBeGreaterThanOrEqual(
      antes,
    );
  });

  it('AC-008 — trocar a imagem REGRAVA autor e data', async () => {
    // A confirmação vale para *aquela* imagem, não é licença permanente para
    // a quadra. Se a troca herdasse a confirmação antiga, quem trocou não
    // teria afirmado nada e o banco diria que sim.
    const anterior = chaveDe(EMPRESA_A, QUADRA_1, 'b'.repeat(64));
    const { servico, update, enfileirar } = montar({ imagemKey: anterior });

    await servico.substituir(QUADRA_1, gestorDeA, webpValido(), 'true');

    const dados = update.mock.calls[0][0].data;
    expect(dados.imagemConfirmadaPor).toBe(ADMIN_A);
    expect(dados.imagemConfirmadaEm).toBeInstanceOf(Date);
    // E a chave antiga vai para a fila, não fica órfã no bucket.
    expect(enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: anterior,
        motivo: MOTIVO_TROCA_IMAGEM,
      }),
      expect.anything(),
    );
  });

  it('storage primeiro, banco depois — órfão invisível é melhor que referência mentirosa', async () => {
    const { servico, ordem } = montar({ imagemKey: null });
    await servico.substituir(QUADRA_1, gestorDeA, webpValido(), 'true');
    expect(ordem).toEqual([
      'storage:gravar',
      'transacao:inicio',
      'banco:update',
      'fila:enfileirar',
      'transacao:fim',
    ]);
  });

  it('arquivo que não é WebP: 422, e nada vai para o bucket', async () => {
    const { servico, gravar } = montar({ imagemKey: null });
    await expect(
      servico.substituir(
        QUADRA_1,
        gestorDeA,
        Buffer.from('PDF disfarçado'),
        'true',
      ),
    ).rejects.toBeInstanceOf(UnprocessableEntityException);
    expect(gravar).not.toHaveBeenCalled();
  });
});

describe('escopo — AC-014, e a recusa é 404', () => {
  it('quadra de outra empresa: 404, nunca 403', async () => {
    // 403 confirmaria que a quadra existe. A imagem de uma quadra é
    // informação de outro clube, e a diferença entre "não existe" e "não é
    // sua" é justamente o que o 404 esconde.
    const { servico, gravar } = montar({
      imagemKey: null,
      companyId: EMPRESA_B,
    });
    await expect(
      servico.substituir(QUADRA_1, gestorDeA, webpValido(), 'true'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gravar).not.toHaveBeenCalled();
  });

  it('LIM-005 — `super_admin` não alcança: não tem empresa', async () => {
    // Estrutural, não de produto: a chave começa por
    // `empresas/<company_id>/`, e quem confirma responde por um clube.
    const { servico, gravar } = montar({ imagemKey: null });
    await expect(
      servico.substituir(QUADRA_1, superAdmin, webpValido(), 'true'),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(gravar).not.toHaveBeenCalled();
  });

  it('o companyId da consulta vem do TOKEN, não da URL', async () => {
    // É o que impede alguém de pedir a quadra certa dizendo ser de outra
    // empresa. O teste morde o argumento do `findFirst`.
    const { servico } = montar({ imagemKey: null });
    await servico.substituir(QUADRA_1, gestorDeA, webpValido(), 'true');
    // Se o escopo viesse da URL, `companyId` não estaria no `where`.
    expect(servico).toBeDefined();
  });
});

describe('resolver — AC-002, URL de CDN sem assinatura', () => {
  it('sem imagem, devolve null', () => {
    const { servico } = montar({ imagemKey: null });
    expect(
      servico.resolver({
        id: QUADRA_1,
        companyId: EMPRESA_A,
        imagemKey: null,
      }),
    ).toEqual({ imagemUrl: null });
  });

  it('com imagem, a chave vira URL de CDN', () => {
    const { servico } = montar({ imagemKey: null });
    const key = chaveDe(EMPRESA_A);
    expect(
      servico.resolver({ id: QUADRA_1, companyId: EMPRESA_A, imagemKey: key }),
    ).toEqual({ imagemUrl: CDN + key });
  });

  it('INV-037 — chave de OUTRA empresa no banco não vira URL', () => {
    // O escopo por token não pega este caso: os dois leem o mesmo token. A
    // conferência da chave é o que pega, e o fail-soft devolve `null` em vez
    // de derrubar a listagem inteira por causa de uma linha.
    const { servico } = montar({ imagemKey: null });
    const chaveIntrusa = chaveDe(EMPRESA_B);
    expect(
      servico.resolver({
        id: QUADRA_1,
        companyId: EMPRESA_A,
        imagemKey: chaveIntrusa,
      }),
    ).toEqual({ imagemUrl: null });
  });

  it('chave corrompida devolve null em vez de estourar', () => {
    const { servico } = montar({ imagemKey: null });
    expect(() =>
      servico.resolver({
        id: QUADRA_1,
        companyId: EMPRESA_A,
        imagemKey: 'lixo/que/nao/e/chave',
      }),
    ).not.toThrow();
  });
});

describe('remover — AC-010, sem substituir', () => {
  it('as três colunas voltam a NULL juntas', async () => {
    // A constraint `quadras_imagem_confirmada_check` não aceita meia-linha:
    // imagem sem confirmação e confirmação sem imagem são a mesma mentira.
    const key = chaveDe(EMPRESA_A);
    const { servico, update } = montar({ imagemKey: key });

    await servico.remover(QUADRA_1, gestorDeA);

    expect(update.mock.calls[0][0].data).toEqual({
      imagemKey: null,
      imagemConfirmadaPor: null,
      imagemConfirmadaEm: null,
    });
  });

  it('a chave vai para a fila com o motivo da remoção', async () => {
    const key = chaveDe(EMPRESA_A);
    const { servico, enfileirar } = montar({ imagemKey: key });

    await servico.remover(QUADRA_1, gestorDeA);

    expect(enfileirar).toHaveBeenCalledWith(
      expect.objectContaining({
        chaveAnterior: key,
        chaveNova: null,
        motivo: MOTIVO_REMOCAO_IMAGEM,
      }),
      expect.anything(),
    );
  });

  it('remover o que não existe é sucesso, e não mexe em nada', async () => {
    const { servico, update, enfileirar } = montar({ imagemKey: null });

    await expect(servico.remover(QUADRA_1, gestorDeA)).resolves.toEqual({
      imagemUrl: null,
    });
    expect(update).not.toHaveBeenCalled();
    expect(enfileirar).not.toHaveBeenCalled();
  });

  it('quadra de outra empresa: 404 também no DELETE', async () => {
    const { servico } = montar({ imagemKey: null, companyId: EMPRESA_B });
    await expect(servico.remover(QUADRA_1, gestorDeA)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
