/**
 * SPEC-049/REQ-001 — **a busca por nome, contra o banco real.**
 *
 * ## Por que db-spec e não unitário
 *
 * O que se afere aqui é o comportamento do `ILIKE` e do `AND` no Postgres — um
 * dublê do Prisma responderia o que eu programasse nele, e a pergunta é
 * justamente se o banco casa `silva` com `Silva` e `joao` com `João` (**não
 * casa**, e há caso para isso: é a LIM-049a, medida em vez de suposta).
 *
 * ## E o `total` é metade do que a paginação promete
 *
 * Se o `total` não acompanhar o filtro, a tela mostra "Página 1 de 17" sobre
 * três resultados. Por isso há caso próprio para ele.
 */
import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';
import { StudentsService } from '../../src/people/students.service';
import type { PrismaService } from '../../src/prisma/prisma.service';

jest.setTimeout(180_000);
exigirBancoLocal();

const EMPRESA = '04900000-0000-4000-8000-000000000001';
const VIZINHA = '04900000-0000-4000-8000-000000000002';

const db = new PrismaClient();
const q = (sql: string) => db.$executeRawUnsafe(sql);
const servico = () => new StudentsService(db as unknown as PrismaService);

/** Cria um aluno com nome e vínculo. */
async function aluno(
  empresa: string,
  n: number,
  nome: string,
  vinculo = 'aprovado',
): Promise<void> {
  const u = `04900000-0000-4000-8000-1${String(n).padStart(11, '0')}`;
  const a = `04900000-0000-4000-8000-2${String(n).padStart(11, '0')}`;
  await q(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${u}','a${n}.s049@x.com','h','${nome}','aluno','${empresa}',now())`,
  );
  await q(
    `INSERT INTO alunos (id,usuario_id,company_id,vinculo,status,saldo_creditos)
     VALUES ('${a}','${u}','${empresa}','${vinculo}','ativo',0)`,
  );
}

const nomes = (r: { data: { nome: string }[] }) =>
  r.data.map((x) => x.nome).sort();

beforeEach(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, VIZINHA);
  for (const [id, nome] of [
    [EMPRESA, 'SPEC-049'],
    [VIZINHA, 'Vizinha 049'],
  ] as const) {
    await q(
      `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${id}','${nome}','s049-${id}',now())`,
    );
  }
  await aluno(EMPRESA, 1, 'João da Silva');
  await aluno(EMPRESA, 2, 'Maria Silva Souza');
  await aluno(EMPRESA, 3, 'Carlos Pereira');
  await aluno(EMPRESA, 4, 'Ana Beatriz', 'pendente');
  await aluno(EMPRESA, 5, 'Silvana Ramos', 'pendente');
  await aluno(VIZINHA, 9, 'João da Silva');
});
afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await limparEmpresa(db, VIZINHA);
  await db.$disconnect();
});

describe('SPEC-049 — buscar aluno pelo nome', () => {
  it('AC-001: acha sem distinguir maiúsculas', async () => {
    const r = await servico().list(EMPRESA, { busca: 'silva' });
    expect(nomes(r)).toEqual([
      'João da Silva',
      'Maria Silva Souza',
      'Silvana Ramos',
    ]);
    // `Silvana` entra porque `contains` é substring, não palavra inteira — e é
    // o que se quer: quem digita 3 letras está procurando, não filtrando.
  });

  it('**AC-002: dois termos, em qualquer ordem, combinam com AND**', async () => {
    const direta = await servico().list(EMPRESA, { busca: 'joao silva' });
    const trocada = await servico().list(EMPRESA, { busca: 'silva joão' });

    // `joao` sem acento NÃO acha `João` (LIM-049a), então a busca direta some.
    expect(nomes(direta)).toEqual([]);
    // Com acento, acha — e a ordem dos termos não importa.
    expect(nomes(trocada)).toEqual(['João da Silva']);
  });

  it('**LIM-049a: sem acento NÃO acha — e o contorno funciona**', async () => {
    // Medido, não suposto: é o caso que `unaccent` fecharia, e ele não está
    // disponível no Postgres que roda esta suíte (`0A000`).
    expect(nomes(await servico().list(EMPRESA, { busca: 'joao' }))).toEqual([]);
    // O contorno que a tela ensina: digite o trecho SEM a letra acentuada.
    expect(nomes(await servico().list(EMPRESA, { busca: 'jo' }))).toEqual([
      'João da Silva',
    ]);
  });

  it('AC-003: a empresa vizinha não entra, mesmo com o nome idêntico', async () => {
    const r = await servico().list(EMPRESA, { busca: 'João da Silva' });
    expect(r.data).toHaveLength(1);
    expect(r.total).toBe(1);
  });

  it('AC-003: combina com `?vinculo=`', async () => {
    const r = await servico().list(EMPRESA, {
      busca: 'silv',
      vinculo: 'pendente',
    });
    // `João da Silva` e `Maria Silva Souza` são aprovados: o vínculo recorta.
    expect(nomes(r)).toEqual(['Silvana Ramos']);
  });

  it('**AC-004: o `total` acompanha a busca, não a empresa**', async () => {
    const tudo = await servico().list(EMPRESA, {});
    const busca = await servico().list(EMPRESA, { busca: 'silva' });

    expect(tudo.total).toBe(5);
    // Se o `total` ficasse em 5 aqui, a tela mostraria "Página 1 de 1" sobre 3
    // resultados — ou pior, prometeria páginas que não existem.
    expect(busca.total).toBe(3);
  });

  it('AC-005: busca vazia ou só espaços NÃO filtra', async () => {
    expect((await servico().list(EMPRESA, { busca: '' })).total).toBe(5);
    expect((await servico().list(EMPRESA, { busca: '   ' })).total).toBe(5);
    // É o estado inicial do campo, não um pedido de "nenhum resultado".
    // Tratar como filtro faria a tela abrir vazia e parecer clube sem aluno.
  });

  it('a paginação continua valendo junto com a busca', async () => {
    const p1 = await servico().list(EMPRESA, {
      busca: 'silva',
      page: 1,
      pageSize: 2,
    });
    const p2 = await servico().list(EMPRESA, {
      busca: 'silva',
      page: 2,
      pageSize: 2,
    });

    expect(p1.data).toHaveLength(2);
    expect(p2.data).toHaveLength(1);
    expect(p1.total).toBe(3);
    // Nenhum nome se repete entre as páginas — `skip` e `take` sobre o mesmo
    // `where` da contagem.
    const juntos = [...nomes(p1), ...nomes(p2)].sort();
    expect(new Set(juntos).size).toBe(3);
  });
});
