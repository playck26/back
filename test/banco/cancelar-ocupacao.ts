import { randomUUID } from 'node:crypto';
import type { ClienteSql } from './limpar-empresa';

/**
 * SPEC-032 — **como uma fixture cancela uma ocupação legitimamente.**
 *
 * ## Por que este arquivo existe
 *
 * A trigger `ocupacao_cancelada_exige_evento` (INV-064) recusa toda transição
 * para `cancelado` que não venha acompanhada de um evento **da mesma
 * transição**. Isso vale para qualquer caminho, inclusive `UPDATE` cru numa
 * fixture — e é exatamente o ponto da invariante: ela não protege só o
 * serviço, protege a tabela.
 *
 * **O CI demonstrou isso antes de produção.** Duas suítes de banco
 * (`fit-013` e `matriz-raiz`) cancelavam por SQL direto e ficaram vermelhas
 * com `ERROR: ocupacao ... cancelada sem transicao_id`. Foi a prévia barata do
 * cenário caro: se a migration tivesse chegado em produção antes do código
 * que grava eventos, todo cancelamento de cliente teria quebrado do mesmo
 * jeito.
 *
 * ## Por que um helper, e não trinta `UPDATE`s corrigidos
 *
 * Mesmo espírito de `limparEmpresa`: **um lugar que sabe fazer certo**, em vez
 * de N lugares que podem errar. A lista de tabelas daquele arquivo já custou
 * caro duas vezes por depender de alguém lembrar.
 *
 * E **não** se resolveu estendendo a válvula da limpeza para cobrir
 * cancelamento: isso enfraqueceria a invariante justamente onde ela protege.
 * A fixture não precisa de exceção — precisa fazer o que o produto faz.
 */
/**
 * O cliente que sabe abrir transação. O `tx` que o Prisma entrega **não** tem
 * `$transaction` — é essa a diferença que distingue os dois casos abaixo.
 */
interface ComTransacao {
  $transaction<T>(fn: (tx: ClienteSql) => Promise<T>): Promise<T>;
}

export async function cancelarOcupacaoNaFixture(
  cliente: ClienteSql,
  params: {
    companyId: string;
    ocupacaoId: string;
    /** Quem cancelou. Toda ação administrativa tem autor (INV-062). */
    autorId: string;
  },
): Promise<void> {
  // **As três escritas TÊM de estar na mesma transação**, e o CI ensinou isso
  // do jeito difícil.
  //
  // A trigger é `DEFERRABLE INITIALLY DEFERRED`: ela julga no `COMMIT`. Fora
  // de uma transação explícita, o Postgres dá um commit por statement — então
  // o `UPDATE` da ocupação **commita sozinho**, a trigger roda ali, e o evento
  // ainda não existe. O erro é `cancelada sem evento desta transicao`, e ele
  // não descreve um defeito do produto: descreve uma fixture em autocommit.
  //
  // Quem já veio dentro de um `tx` (o caso do `matriz-raiz`) não pode abrir
  // outra: aninhar transação no Prisma não é suportado, e o `tx` não expõe
  // `$transaction` — é isso que o teste abaixo detecta.
  if ('$transaction' in cliente) {
    await (cliente as unknown as ComTransacao).$transaction((tx) =>
      escrever(tx, params),
    );
    return;
  }
  await escrever(cliente, params);
}

async function escrever(
  cliente: ClienteSql,
  params: { companyId: string; ocupacaoId: string; autorId: string },
): Promise<void> {
  const transicaoId = randomUUID();
  const acaoId = randomUUID();

  await cliente.$executeRawUnsafe(
    `INSERT INTO acoes_administrativas (id, company_id, tipo, autor_id)
     VALUES ($1::uuid, $2::uuid, 'reserva_cancelada', $3::uuid)`,
    acaoId,
    params.companyId,
    params.autorId,
  );

  await cliente.$executeRawUnsafe(
    `UPDATE ocupacoes_quadra
        SET status_pagamento = 'cancelado', transicao_id = $2::uuid
      WHERE id = $1::uuid`,
    params.ocupacaoId,
    transicaoId,
  );

  // A ordem entre este INSERT e o UPDATE acima não importa — a trigger é
  // `DEFERRABLE INITIALLY DEFERRED` e só julga no COMMIT. O que importa é que
  // os dois carreguem a MESMA `transicao_id`.
  await cliente.$executeRawUnsafe(
    `INSERT INTO eventos_de_ocupacao
       (id, company_id, acao_id, ocupacao_id, tipo, transicao_id)
     VALUES (gen_random_uuid(), $1::uuid, $2::uuid, $3::uuid, 'cancelada', $4::uuid)`,
    params.companyId,
    acaoId,
    params.ocupacaoId,
    transicaoId,
  );
}
