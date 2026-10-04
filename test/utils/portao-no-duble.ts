import { MARCADOR_DO_PORTAO } from '../../src/common/guards/portao-do-usuario';

/**
 * SPEC-081/D2 — **o portão do guard, nos dublês.**
 *
 * O `JwtAuthGuard` passou a ler usuário e empresa com UM `$queryRaw`. Os
 * testes continuam armando `usuario.findUnique`, como sempre armaram — são
 * 65 armações em 23 arquivos, e reescrevê-las seria a chance de enfraquecer
 * uma expectativa sem ninguém ver. Este helper faz a ponte: a consulta do
 * portão chega ao `findUnique` do próprio dublê, com os mesmos argumentos que
 * o guard passava antes.
 *
 * **Roteia pelo marcador, nunca pelo predicado** (DEF-VC031-02): a consulta
 * que abre com `MARCADOR_DO_PORTAO` vai para o `findUnique`; qualquer outra
 * vai para o `$queryRaw` que o dublê já tinha — ou devolve `[]`, como o do
 * dublê compartilhado faz por padrão.
 *
 * **O `$queryRaw` novo é o antigo, com a chamada interceptada** (um `Proxy`
 * sobre o mesmo `jest.fn`): `mock.calls`, `mockClear`, `mockResolvedValue` e
 * `expect(…).not.toHaveBeenCalled()` continuam valendo para as consultas do
 * domínio, como antes da SPEC-081 — quando o guard não passava por ali. Um
 * teste que arma `prisma.$queryRaw.mockResolvedValue(x)` para a sua consulta
 * não muda o que o guard lê.
 */

// O `select` que o guard passava ao `findUnique` antes da SPEC-081.
const SELECT_DO_PORTAO = {
  senhaTemporaria: true,
  status: true,
  role: true,
  termoVersaoAceita: true,
  contratoVersaoAceita: true,
  empresa: { select: { contratoVersaoVigente: true, status: true } },
} as const;

interface ConsultaCrua {
  strings?: readonly string[];
  values?: readonly unknown[];
}

interface DubleComUsuario {
  // Sintaxe de método de propósito: cada dublê tipa o argumento do seu jeito.
  usuario: {
    findUnique(args: {
      where: { id: string };
      select: typeof SELECT_DO_PORTAO;
    }): unknown;
  };
  $queryRaw?: unknown;
}

function textoDaConsulta(primeiro: unknown): string {
  // `$queryRaw(Prisma.sql`…`)` entrega um objeto com `strings`; a forma de
  // template (`$queryRaw`…``) entrega o próprio array de strings.
  if (Array.isArray(primeiro)) return (primeiro as string[]).join('');
  const strings = (primeiro as ConsultaCrua | undefined)?.strings;
  return Array.isArray(strings) ? strings.join('') : '';
}

function valoresDaConsulta(args: unknown[]): readonly unknown[] {
  const [primeiro, ...resto] = args;
  if (Array.isArray(primeiro)) return resto;
  return (primeiro as ConsultaCrua | undefined)?.values ?? [];
}

export function comPortaoDoUsuario<T extends DubleComUsuario>(
  duble: T,
): T & { $queryRaw: jest.Mock } {
  const anterior =
    typeof duble.$queryRaw === 'function'
      ? (duble.$queryRaw as jest.Mock)
      : jest.fn().mockResolvedValue([]);

  const $queryRaw = new Proxy(anterior, {
    apply(alvo, esse, args: unknown[]) {
      if (!textoDaConsulta(args[0]).startsWith(MARCADOR_DO_PORTAO)) {
        return Reflect.apply(alvo, esse, args) as unknown;
      }
      const [usuarioId] = valoresDaConsulta(args);
      return Promise.resolve(
        duble.usuario.findUnique({
          where: { id: usuarioId as string },
          select: SELECT_DO_PORTAO,
        }),
      ).then((linha) => (linha ? [linha] : []));
    },
  });

  return Object.assign(duble, { $queryRaw });
}
