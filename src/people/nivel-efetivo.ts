import type { Prisma } from '@prisma/client';
import { ChaveDeLock } from '../common/lock/chave-de-lock';

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

// ==========================================================================
// SPEC-075/D12 — a edição de nível não cria par incompatível NOVO
// ==========================================================================

/** Um par (aluno, turma) de uma matrícula, com o que as mensagens precisam. */
export type ParDeMatricula = {
  alunoId: string;
  alunoNome: string;
  turmaId: string;
  turmaNome: string;
  nivelDaTurmaNome: string;
};

/** Quais pares a edição afeta: os do aluno editado, os da turma editada, ou
 *  — quando muda quem é o primeiro — os dos alunos sem nível. */
export type ParesAfetados =
  { alunoId: string } | { turmaId: string } | { alunosSemNivel: true };

/**
 * D12 — **os pares incompatíveis de agora**, entre os afetados: matrícula numa
 * turma COM nível cujo nível não é o efetivo do aluno. Pelo MESMO predicado da
 * D3 (`podeEntrarPorNivel`), e pelo cliente de quem chama — o `tx` da edição.
 */
export async function paresIncompativeis(
  db: Pick<Prisma.TransactionClient, 'nivel' | 'turmaAluno'>,
  companyId: string,
  afetados: ParesAfetados,
): Promise<ParDeMatricula[]> {
  const primeiro = await primeiroNivel(db, companyId);
  const where: Prisma.TurmaAlunoWhereInput = {
    turma: { companyId, nivelId: { not: null } },
  };
  if ('alunoId' in afetados) where.alunoId = afetados.alunoId;
  if ('turmaId' in afetados) where.turmaId = afetados.turmaId;
  if ('alunosSemNivel' in afetados) where.aluno = { nivelId: null };

  const linhas = await db.turmaAluno.findMany({
    where,
    select: {
      alunoId: true,
      turmaId: true,
      aluno: { select: { nivelId: true, usuario: { select: { nome: true } } } },
      turma: {
        select: {
          nome: true,
          nivelId: true,
          nivel: { select: { nome: true } },
        },
      },
    },
  });

  return linhas
    .filter((l) => {
      const efetivo = l.aluno.nivelId ? { id: l.aluno.nivelId } : primeiro;
      return !podeEntrarPorNivel(l.turma.nivelId, efetivo);
    })
    .map((l) => ({
      alunoId: l.alunoId,
      alunoNome: l.aluno.usuario.nome,
      turmaId: l.turmaId,
      turmaNome: l.turma.nome,
      nivelDaTurmaNome: l.turma.nivel?.nome ?? '',
    }));
}

/**
 * D12 — **por identidade de par, nunca por contagem nem por projeção.** A
 * chave é (aluno, turma), os dois: uma edição que conserta um par e quebra
 * outro deixa a contagem igual e o conjunto de alunos (ou de turmas) igual — e
 * aparece aqui, porque o par que nasceu não estava em `antes`.
 */
export function paresNovos(
  antes: readonly ParDeMatricula[],
  depois: readonly ParDeMatricula[],
): ParDeMatricula[] {
  const chave = (p: ParDeMatricula) => `${p.alunoId}|${p.turmaId}`;
  const existiam = new Set(antes.map(chave));
  return depois.filter((p) => !existiam.has(chave(p)));
}

function juntar(itens: string[]): string {
  if (itens.length <= 1) return itens.join('');
  return `${itens.slice(0, -1).join(', ')} e ${itens[itens.length - 1]}`;
}

/** Até 5 nomes, e "e mais N" — a mensagem não vira lista de chamada. */
function nomesComTeto(nomes: string[]): string {
  const TETO = 5;
  if (nomes.length <= TETO) return nomes.join(', ');
  return `${nomes.slice(0, TETO).join(', ')} e mais ${nomes.length - TETO}`;
}

export type EdicaoDeNivel =
  | { tipo: 'aluno' }
  | { tipo: 'turma' }
  | { tipo: 'primeiro'; primeiroAntigo: string };

/** D12 — a mensagem diz **o que impede e o que fazer**. */
export function mensagemDeEdicaoRecusada(
  edicao: EdicaoDeNivel,
  novos: readonly ParDeMatricula[],
): string {
  if (edicao.tipo === 'aluno') {
    const turmas = [...new Map(novos.map((p) => [p.turmaId, p])).values()];
    if (turmas.length === 1) {
      return (
        `Este aluno está na turma ${turmas[0].turmaNome}, que é do nível ` +
        `${turmas[0].nivelDaTurmaNome}. Tire-o dessa turma antes de mudar o nível dele.`
      );
    }
    return (
      `Este aluno está nas turmas ${juntar(turmas.map((p) => `${p.turmaNome} (nível ${p.nivelDaTurmaNome})`))}. ` +
      'Tire-o dessas turmas antes de mudar o nível dele.'
    );
  }
  const alunos = [...new Map(novos.map((p) => [p.alunoId, p])).values()];
  const n = alunos.length;
  if (edicao.tipo === 'turma') {
    const nivel = novos[0]?.nivelDaTurmaNome ?? '';
    const nomes = nomesComTeto(alunos.map((p) => p.alunoNome));
    return n === 1
      ? `Esta turma tem 1 aluno que não é do nível ${nivel}: ${nomes}. Tire-o da turma ou mude o nível dele antes.`
      : `Esta turma tem ${n} alunos que não são do nível ${nivel}: ${nomes}. Tire-os da turma ou mude o nível deles antes.`;
  }
  const antigo = edicao.primeiroAntigo;
  return n === 1
    ? `Isso faria o primeiro nível deixar de ser ${antigo}, e 1 aluno sem nível está em turma de ${antigo}. Defina o nível dele antes.`
    : `Isso faria o primeiro nível deixar de ser ${antigo}, e ${n} alunos sem nível estão em turmas de ${antigo}. Defina o nível deles antes.`;
}

/** O corpo da recusa das edições (D12). */
export type RecusaDeEdicao = {
  statusCode: 422;
  code: 'NIVEL_INCOMPATIVEL_COM_MATRICULAS';
  message: string;
};

/**
 * D12 — **a conferência de uma edição, dentro da transação dela**: lê os pares
 * incompatíveis afetados, ESCREVE, lê de novo, e devolve a recusa se nasceu um
 * par que não existia. Quem chama lança `UnprocessableEntityException` com o
 * corpo — e o rollback desfaz a escrita. Comparar depois de escrever, e não
 * simular antes, é o que faz as quatro edições usarem a mesma leitura do nível
 * efetivo, sem uma segunda cópia da regra para "como ficaria".
 */
export async function conferirEdicaoDeNivel<T>(
  db: Pick<Prisma.TransactionClient, 'nivel' | 'turmaAluno'>,
  companyId: string,
  afetados: ParesAfetados,
  edicao: EdicaoDeNivel,
  escrever: () => Promise<T>,
): Promise<{ resultado: T; recusa: RecusaDeEdicao | null }> {
  const antes = await paresIncompativeis(db, companyId, afetados);
  const resultado = await escrever();
  const depois = await paresIncompativeis(db, companyId, afetados);
  const novos = paresNovos(antes, depois);
  if (novos.length === 0) return { resultado, recusa: null };
  return {
    resultado,
    recusa: {
      statusCode: 422,
      code: 'NIVEL_INCOMPATIVEL_COM_MATRICULAS',
      message: mensagemDeEdicaoRecusada(edicao, novos),
    },
  };
}

// ==========================================================================
// SPEC-075/D13 — a trava de nível da empresa
// ==========================================================================

/**
 * D13 (INV-075h) — **edição de nível e criação de matrícula de uma empresa
 * nunca correm juntas.**
 *
 * O furo que ela fecha (3ª rodada, N3-02): a edição lê que o aluno não está na
 * turma; a alocação lê o nível antigo e valida; as duas gravam; as duas comitam
 * — e nasce o par que a decisão 6 proíbe. Um gestor só, com duas requisições,
 * chega lá; e os locks de linha de hoje não impedem (o `UPDATE` do nível toma
 * `FOR NO KEY UPDATE`, o `INSERT` da matrícula toma `FOR KEY SHARE` pela FK).
 *
 * **Bloqueante, e a PRIMEIRA instrução da transação** de quem a toma — ao
 * contrário da INV-042 (`advisory-lock.ts`), que manda o advisory vir DEPOIS dos
 * locks de linha. Aquela regra é para `pg_try_…`, que não espera. Esta espera:
 * tomada depois de um lock de linha, ela fecharia ciclo (o `confirmar` segurando
 * a turma e esperando a trava; o `allocateStudent` segurando a trava e
 * esperando a turma). Tomada sempre primeiro, por todos, não há ciclo que passe
 * por ela — e ela entra como o **nível 0** da ordem de locks da SPEC-064.
 *
 * **A chave é a EMPRESA**: mudar quem é o primeiro nível mexe no nível efetivo
 * de todo aluno sem nível dela. **E vem de `ChaveDeLock.deTexto`** (INV-043),
 * nunca de outro cálculo — duas contas diferentes para a mesma empresa seriam
 * duas travas que não se veem.
 *
 * Os oito caminhos que a tomam estão na tabela da D13 da spec; a AC-029
 * (`escritores-de-matricula.spec.ts`) falha com um escritor novo fora dela.
 */
export async function travarNivelDaEmpresa(
  db: Pick<Prisma.TransactionClient, '$executeRaw'>,
  companyId: string,
): Promise<void> {
  const chave = ChaveDeLock.deTexto(`nivel-da-empresa:${companyId}`);
  // `$executeRaw`, e não `$queryRaw`: a função devolve `void`, que o Prisma
  // não desserializa (medido na 4ª rodada, com `pg_sleep`).
  await db.$executeRaw`SELECT pg_advisory_xact_lock(${chave}::bigint)`;
}
