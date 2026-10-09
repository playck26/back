/**
 * SPEC-086 (AC-003, AC-004, AC-017) — **um dublê de `usuarios` que AVALIA o
 * filtro**, em vez de devolver uma resposta pronta.
 *
 * Os unitários das entradas E1 a E8 provam a regra pelo filtro que cada uma
 * passa ao Prisma. Conferir só o formato do `where` não basta para o S1 da
 * spec: um `findFirst({ where: { email } })` sem empresa é um filtro "válido",
 * e o defeito dele só aparece quando existe, para o mesmo e-mail, uma conta
 * em OUTRA empresa **antes** da conta da empresa alvo. Por isso o dublê guarda
 * uma lista de contas, na ordem em que foram "criadas", e devolve a primeira
 * que o filtro casa — como o banco faria sem `ORDER BY`. Com a fixture certa,
 * o filtro sem empresa acha a conta de fora e a entrada recusa um e-mail que a
 * regra nova manda aceitar: o caso positivo fica vermelho.
 *
 * O avaliador entende só o que as entradas usam (`email` exato ou `in`,
 * `companyId`, `role` exato ou `in`, `OR`). Qualquer outra chave **estoura**:
 * um filtro que o dublê não entende não pode passar por "não casou".
 */
type Papel = 'super_admin' | 'company_admin' | 'aluno' | 'professor';

export interface ContaNoDuble {
  id: string;
  email: string;
  companyId: string | null;
  role: Papel;
}

type Filtro = Record<string, unknown>;

/** Os papéis de gestão, únicos na plataforma (I5). */
export const PAPEIS_DE_GESTAO = ['super_admin', 'company_admin'];

function casaValor(valor: unknown, filtro: unknown, chave: string): boolean {
  if (typeof filtro === 'string' || filtro === null) return valor === filtro;
  if (
    typeof filtro === 'object' &&
    filtro !== null &&
    Object.keys(filtro).length === 1 &&
    Array.isArray((filtro as { in?: unknown }).in)
  ) {
    return (filtro as { in: unknown[] }).in.includes(valor);
  }
  throw new Error(
    `dublê da SPEC-086: filtro de "${chave}" que ele não entende: ${JSON.stringify(filtro)}`,
  );
}

export function contaCasaComFiltro(
  conta: ContaNoDuble,
  where: Filtro,
): boolean {
  for (const [chave, filtro] of Object.entries(where)) {
    switch (chave) {
      case 'email':
        if (!casaValor(conta.email, filtro, chave)) return false;
        break;
      case 'companyId':
        if (!casaValor(conta.companyId, filtro, chave)) return false;
        break;
      case 'role':
        if (!casaValor(conta.role, filtro, chave)) return false;
        break;
      case 'OR':
        if (!(filtro as Filtro[]).some((f) => contaCasaComFiltro(conta, f))) {
          return false;
        }
        break;
      default:
        throw new Error(
          `dublê da SPEC-086: chave de filtro desconhecida "${chave}"`,
        );
    }
  }
  return true;
}

/** `findFirst` sobre as contas: a PRIMEIRA (na ordem de criação) que casa. */
export function findFirstSobre(contas: readonly ContaNoDuble[]) {
  return jest.fn(({ where }: { where: Filtro }) =>
    Promise.resolve(contas.find((c) => contaCasaComFiltro(c, where)) ?? null),
  );
}

/** `findMany` sobre as contas: todas as que casam, na ordem de criação. */
export function findManySobre(contas: readonly ContaNoDuble[]) {
  return jest.fn(({ where }: { where: Filtro }) =>
    Promise.resolve(contas.filter((c) => contaCasaComFiltro(c, where))),
  );
}

/** O filtro que a spec exige com a chave ligada (aluno/professor). */
export function filtroDaEmpresa(email: unknown, companyId: string): Filtro {
  return {
    email,
    OR: [{ companyId }, { role: { in: PAPEIS_DE_GESTAO } }],
  };
}

/**
 * Guarda e devolve `EMAIL_EM_VARIAS_EMPRESAS` em volta de cada teste do
 * `describe` que a chama: a chave é lida a cada chamada, e um teste que a
 * deixasse ligada mudaria o resultado dos vizinhos.
 */
export function restaurarChaveDoEmailACadaTeste(): {
  ligar(): void;
  desligar(): void;
} {
  let antes: string | undefined;
  beforeEach(() => {
    antes = process.env.EMAIL_EM_VARIAS_EMPRESAS;
  });
  afterEach(() => {
    if (antes === undefined) delete process.env.EMAIL_EM_VARIAS_EMPRESAS;
    else process.env.EMAIL_EM_VARIAS_EMPRESAS = antes;
  });
  return {
    ligar: () => {
      process.env.EMAIL_EM_VARIAS_EMPRESAS = 'true';
    },
    // Desligada é a variável AUSENTE — o padrão de produção (REQ-005).
    desligar: () => {
      delete process.env.EMAIL_EM_VARIAS_EMPRESAS;
    },
  };
}

export interface CenarioDaEntrada {
  nome: string;
  chave: 'ligada' | 'desligada';
  contas: ContaNoDuble[];
  aceita: boolean;
}

/**
 * Os cenários de AC-003 (chave ligada) e AC-017 (desligada) para uma entrada
 * de aluno/professor que cria conta na empresa `alvo`. A conta de fora vem
 * SEMPRE primeiro: um filtro sem empresa a acharia antes da conta da alvo.
 */
export function cenariosDeAlunoOuProfessor(
  email: string,
  alvo: string,
): CenarioDaEntrada[] {
  const OUTRA = 'empresa-de-fora';
  const deFora = (role: Papel): ContaNoDuble => ({
    id: `fora-${role}`,
    email,
    companyId: role === 'super_admin' ? null : OUTRA,
    role,
  });
  const naAlvo = (role: Papel): ContaNoDuble => ({
    id: `alvo-${role}`,
    email,
    companyId: alvo,
    role,
  });
  return [
    {
      nome: 'AC-003: aluno em OUTRA empresa → aceita',
      chave: 'ligada',
      contas: [deFora('aluno')],
      aceita: true,
    },
    {
      nome: 'AC-003: professor em OUTRA empresa → aceita',
      chave: 'ligada',
      contas: [deFora('professor')],
      aceita: true,
    },
    {
      nome: 'AC-003: aluno de fora (primeiro) + aluno na alvo (depois) → recusa',
      chave: 'ligada',
      contas: [deFora('aluno'), naAlvo('aluno')],
      aceita: false,
    },
    {
      nome: 'AC-003: aluno de fora (primeiro) + professor na alvo (depois) → recusa',
      chave: 'ligada',
      contas: [deFora('aluno'), naAlvo('professor')],
      aceita: false,
    },
    {
      nome: 'AC-003: gestor de OUTRA empresa → recusa',
      chave: 'ligada',
      contas: [deFora('aluno'), deFora('company_admin')],
      aceita: false,
    },
    {
      nome: 'AC-003: super admin → recusa',
      chave: 'ligada',
      contas: [deFora('aluno'), deFora('super_admin')],
      aceita: false,
    },
    {
      nome: 'AC-017: chave desligada, aluno em OUTRA empresa → recusa',
      chave: 'desligada',
      contas: [deFora('aluno')],
      aceita: false,
    },
    {
      nome: 'AC-017: chave desligada, nenhuma conta → aceita',
      chave: 'desligada',
      contas: [],
      aceita: true,
    },
  ];
}

/**
 * Confere o `where` de cada chamada de conferência de e-mail: com a chave
 * ligada, o filtro da empresa alvo; desligada, só o e-mail.
 */
export function wheresDasChamadas(...mocks: jest.Mock[]): Filtro[] {
  return mocks.flatMap((m) =>
    (m.mock.calls as [{ where: Filtro }][]).map(([a]) => a.where),
  );
}
