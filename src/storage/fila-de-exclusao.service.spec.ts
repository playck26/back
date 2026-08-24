import { Logger } from '@nestjs/common';
import { FilaDeExclusao } from './fila-de-exclusao.service';
import type { PrismaService } from '../prisma/prisma.service';

// SPEC-017/TASK-005 — AC-012/013 e INV-038. O comportamento contra Postgres
// real está em `test/banco/fila-worker.db-spec.ts`; aqui fica a regra.

const EMPRESA = 'a1b2c3d4-11ef-4111-8111-1f1e1d1c1b1a';
const RECURSO = 'c3d4e5f6-33ef-4333-8333-3f3e3d3c3b3a';
const chave = (sha = 'a') =>
  `empresas/${EMPRESA}/quadra/${RECURSO}/${sha.repeat(64)}.webp`;

describe('FilaDeExclusao.enfileirar', () => {
  let sqls: unknown[][];
  let fila: FilaDeExclusao;

  beforeEach(() => {
    sqls = [];
    const prisma = {
      $executeRaw: (_q: TemplateStringsArray, ...valores: unknown[]) => {
        sqls.push(valores);
        return Promise.resolve(1);
      },
    } as unknown as PrismaService;
    fila = new FilaDeExclusao(prisma);
  });

  it('enfileira a chave anterior com motivo e company_id', async () => {
    await expect(
      fila.enfileirar({ chaveAnterior: chave(), motivo: 'quadra trocou' }),
    ).resolves.toBe('enfileirada');

    expect(sqls).toHaveLength(1);
    expect(sqls[0]).toEqual([chave(), EMPRESA, 'quadra trocou']);
  });

  it('AC-013: chave nova IGUAL à anterior não enfileira nada', async () => {
    // A defesa que parece boba e não é. A chave é o conteúdo, então reenviar
    // a mesma foto produz a mesma chave — e a lógica ingênua "troquei,
    // enfileiro a anterior" apagaria o objeto que ACABOU de virar o atual.
    await expect(
      fila.enfileirar({
        chaveAnterior: chave(),
        chaveNova: chave(),
        motivo: 'reenvio',
      }),
    ).resolves.toBe('chave_igual');

    expect(sqls).toHaveLength(0);
  });

  it('chave nova DIFERENTE enfileira a anterior', async () => {
    await expect(
      fila.enfileirar({
        chaveAnterior: chave('a'),
        chaveNova: chave('b'),
        motivo: 'troca',
      }),
    ).resolves.toBe('enfileirada');
    expect(sqls).toHaveLength(1);
  });

  it.each([[null], [undefined], ['']])(
    'sem chave anterior (%p) não faz nada',
    async (chaveAnterior) => {
      await expect(
        fila.enfileirar({ chaveAnterior, motivo: 'x' }),
      ).resolves.toBe('sem_chave');
      expect(sqls).toHaveLength(0);
    },
  );

  it('chave inválida NÃO vai para o banco, e é registrada', async () => {
    // O CHECK da tabela a recusaria, e a exceção apareceria dentro da
    // transação de quem estava só trocando uma foto. Mas chave inválida no
    // banco é a AC-018 acontecendo, então não pode passar em silêncio.
    const erro = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => undefined);

    await expect(
      fila.enfileirar({ chaveAnterior: 'lixo/sem/forma', motivo: 'x' }),
    ).resolves.toBe('chave_invalida');
    expect(sqls).toHaveLength(0);
    expect(erro).toHaveBeenCalledWith(
      expect.objectContaining({ evento: 'chave_invalida_nao_enfileirada' }),
    );
    erro.mockRestore();
  });

  it('usa o cliente da transação quando recebe um (INV-038)', async () => {
    // Enfileirar fora da transação que apagou a referência abre a janela em
    // que o processo morre no meio e o objeto fica órfão para sempre.
    const daTransacao: unknown[][] = [];
    await fila.enfileirar(
      { chaveAnterior: chave(), motivo: 'x' },
      {
        $executeRaw: (_q: TemplateStringsArray, ...v: unknown[]) => {
          daTransacao.push(v);
          return Promise.resolve(1);
        },
      },
    );
    expect(daTransacao).toHaveLength(1);
    expect(sqls).toHaveLength(0);
  });
});
