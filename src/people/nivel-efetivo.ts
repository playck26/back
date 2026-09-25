import type { Prisma } from '@prisma/client';

/**
 * SPEC-075 — **o nível decide o acesso, e a regra mora aqui, num lugar só.**
 *
 * Toda recusa por nível (os cinco gestos da D3), todo recorte de lista, e toda
 * conferência de edição de nível (D12) usam as peças deste arquivo. **Duas
 * cópias da regra é a cópia a mais que envelhece** — a lição que o próprio
 * `filtro-de-nivel.ts` do Cliente já registrava.
 *
 * **Nenhum import do Nest, e nenhum alias de caminho** (D13): o seed roda por
 * `ts-node prisma/seed.ts`, sem `tsconfig-paths`, e importa este arquivo por
 * caminho relativo.
 *
 * ## ADR-026: toda regra futura que dependa do nível lê o nível EFETIVO
 *
 * Nunca `aluno.nivel_id` direto — ele é nulo para quem ainda não foi
 * classificado, e a decisão 3 do Israel diz que esse aluno **conta como o
 * primeiro nível** do clube.
 */

/** O cliente do Prisma de quem chama — o `tx`, quando houver (SPEC-034: não se
 *  lê por outra conexão enquanto se segura lock). */
export type LeitorDeNivel = Pick<Prisma.TransactionClient, 'nivel'>;

export type NivelEfetivo = {
  id: string;
  nome: string;
  /** `true` quando o aluno não tem nível e o efetivo veio da regra do primeiro
   *  (decisão 3). A mensagem de recusa precisa saber. */
  doPrimeiro: boolean;
};

/**
 * D2 — **nível exato, e turma sem nível é de todos.**
 *
 * `nivelEfetivo` nulo só acontece em empresa sem nível nenhum — e aí nenhuma
 * turma tem nível (a FK composta da D9 exige um nível da própria empresa), então
 * o primeiro `if` já decidiu. A regra fica inerte, que é o estado de antes.
 */
export function podeEntrarPorNivel(
  nivelDaTurma: string | null,
  nivelEfetivo: { id: string } | null,
): boolean {
  if (nivelDaTurma === null) return true;
  return nivelEfetivo !== null && nivelEfetivo.id === nivelDaTurma;
}

/**
 * **O mesmo predicado, escrito para o `where` do Prisma** — para as listas que
 * cortam no banco antes do `take` (D3: cortar depois do `take: 200` devolveria
 * lista vazia a quem tem 200 ocorrências de outro nível antes da sua).
 *
 * É a única segunda forma da regra, e mora ao lado da primeira de propósito: o
 * `nivel-efetivo.spec.ts` prova que as duas concordam nos quatro casos.
 * Sem nível efetivo (empresa sem nível), não corta nada.
 */
export function filtroDeTurmaPorNivel(
  nivelEfetivo: { id: string } | null,
): Prisma.TurmaWhereInput {
  if (nivelEfetivo === null) return {};
  return { OR: [{ nivelId: null }, { nivelId: nivelEfetivo.id }] };
}

/**
 * D1 — **o primeiro nível da empresa**: menor `ordem`, depois menor
 * `created_at`, depois menor `id` (INV-075c). A `ordem` não é única, e níveis
 * criados na mesma transação têm o mesmo `created_at` (o `now()` é o da
 * transação) — sem o `id` no fim, o desempate dependeria do plano da consulta.
 */
export async function primeiroNivel(
  db: LeitorDeNivel,
  companyId: string,
): Promise<{ id: string; nome: string } | null> {
  return db.nivel.findFirst({
    where: { companyId },
    orderBy: [{ ordem: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, nome: true },
  });
}

/**
 * D1 — **o nível efetivo do aluno**: o dele, ou o primeiro da empresa, ou
 * nenhum. Resolvido na hora, e **nunca gravado** no aluno: reordenar os níveis
 * muda quem é o primeiro, e gravar congelaria uma ordem que o gestor já mudou.
 */
export async function nivelEfetivoDoAluno(
  db: LeitorDeNivel,
  companyId: string,
  nivelIdDoAluno: string | null,
): Promise<NivelEfetivo | null> {
  // Verdade, e não `!== null`: um aluno lido sem a coluna (dublê de teste,
  // `select` estreito) chega com `undefined`, e isso é "sem nível".
  if (nivelIdDoAluno) {
    const proprio = await db.nivel.findFirst({
      where: { id: nivelIdDoAluno, companyId },
      select: { id: true, nome: true },
    });
    if (proprio) return { ...proprio, doPrimeiro: false };
  }
  const primeiro = await primeiroNivel(db, companyId);
  return primeiro ? { ...primeiro, doPrimeiro: true } : null;
}

/** Para quem a mensagem é escrita (D4). */
export type LeitorDaRecusa = 'aluno' | 'gestor';

/**
 * D4 — **a mensagem diz os dois níveis, e é escrita para quem a lê.** Ao gestor
 * ela diz também o que fazer: a decisão 5 fechou a exceção, e o caminho que
 * sobra é mudar o nível do aluno.
 */
export function mensagemDeNivelIncompativel(
  para: LeitorDaRecusa,
  nomeDoNivelDaTurma: string,
  efetivo: NivelEfetivo | null,
): string {
  const turma = `Esta turma é do nível ${nomeDoNivelDaTurma}`;
  if (para === 'aluno') {
    if (efetivo === null || efetivo.doPrimeiro) {
      return (
        `${turma}. O clube ainda não definiu o seu nível` +
        (efetivo ? `; por enquanto você conta como ${efetivo.nome}.` : '.')
      );
    }
    return `${turma}. O seu nível é ${efetivo.nome}.`;
  }
  if (efetivo === null || efetivo.doPrimeiro) {
    return (
      `${turma}, e este aluno ainda não tem nível` +
      (efetivo ? ` — ele conta como ${efetivo.nome}` : '') +
      '. Para alocá-lo, defina o nível dele.'
    );
  }
  return `${turma}, e este aluno é ${efetivo.nome}. Para alocá-lo, mude o nível dele.`;
}

/** O corpo da recusa (D4), para o `UnprocessableEntityException` de quem chama.
 *  Fica fora das exceções do Nest de propósito: este arquivo não importa Nest. */
export type RecusaDeNivel = {
  statusCode: 422;
  code: 'NIVEL_INCOMPATIVEL';
  message: string;
};

/**
 * D3 — **a conferência de um gesto**: lê o nível da turma e o efetivo do aluno
 * pelo cliente de quem chama, e devolve a recusa — ou `null`, se pode entrar.
 *
 * Devolve, e não lança: quem chama lança `UnprocessableEntityException` com
 * este corpo, **depois de leituras e antes de qualquer escrita** — é o que faz
 * a confirmação da fila encerrar a linha em vez de abortar a transação (fato 5
 * da spec).
 */
export async function recusaPorNivel(
  db: LeitorDeNivel,
  companyId: string,
  nivelIdDaTurma: string | null,
  nivelIdDoAluno: string | null,
  para: LeitorDaRecusa,
): Promise<RecusaDeNivel | null> {
  if (nivelIdDaTurma === null) return null;
  const efetivo = await nivelEfetivoDoAluno(db, companyId, nivelIdDoAluno);
  if (podeEntrarPorNivel(nivelIdDaTurma, efetivo)) return null;
  const daTurma = await db.nivel.findFirst({
    where: { id: nivelIdDaTurma, companyId },
    select: { nome: true },
  });
  return {
    statusCode: 422,
    code: 'NIVEL_INCOMPATIVEL',
    message: mensagemDeNivelIncompativel(
      para,
      daTurma?.nome ?? 'outro nível',
      efetivo,
    ),
  };
}

/**
 * SPEC-075/D7 (decisões 4 e 7 do Israel) — **os níveis com que toda empresa
 * nova nasce.** O único lugar do código que sabe quais são: o
 * `LevelsService.semearNiveisPadrao` (a criação de empresa) e o seed (a empresa
 * de QA) usam esta constante, e nenhum dos dois tem lista própria.
 *
 * Editáveis depois, como qualquer nível (D8). As empresas que já existiam
 * antes da SPEC-075 não ganham nada (decisão 8).
 */
export const NIVEIS_PADRAO: readonly { nome: string; ordem: number }[] = [
  { nome: 'Iniciante', ordem: 1 },
  { nome: 'Intermediário', ordem: 2 },
  { nome: 'Avançado', ordem: 3 },
];

/**
 * SPEC-075/D7 — grava os níveis padrão, **pelo cliente de quem chama**.
 *
 * **Quem escreve `niveis` é MOD-003** (`TARGET_ARCHITECTURE.md`, seção 5): a
 * criação de empresa (MOD-002) não chama isto direto — chama
 * `LevelsService.semearNiveisPadrao(tx, …)`, o método público, no molde de
 * `StudentsService.criarPerfilDeAluno` (MOD-001 → MOD-003). O seed, que não tem
 * injeção de dependência, chama esta função.
 *
 * Os três nascem na mesma transação, com o mesmo `created_at` — por isso as
 * `ordem` distintas: o desempate da D1 existe para os níveis que o gestor criar
 * depois, não para estes.
 */
export async function criarNiveisPadrao(
  db: Pick<Prisma.TransactionClient, 'nivel'>,
  companyId: string,
): Promise<void> {
  await db.nivel.createMany({
    data: NIVEIS_PADRAO.map((n) => ({
      companyId,
      nome: n.nome,
      ordem: n.ordem,
    })),
  });
}
