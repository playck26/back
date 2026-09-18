import {
  VARIAVEL_DA_CREDENCIAL,
  executarCli,
  type ClienteDeAcesso,
} from './acesso-super-admin';

/**
 * TEST — **os portões da CLI de acesso do super admin.**
 *
 * O que se prova aqui é o que o banco não pode provar: que o comando recusa
 * **antes de conectar** quando falta credencial, e-mail ou confirmação. O
 * efeito da escrita (hash novo, senha temporária, sessão encerrada) tem prova
 * própria em banco real, em `test/banco/acesso-super-admin.db-spec.ts` —
 * mock não tem constraint e não prova transação.
 */
const URL_FALSA = 'postgresql://ninguem@127.0.0.1:1/x';

function ambiente(
  env: Record<string, string | undefined>,
  cliente?: Partial<ClienteDeAcesso>,
) {
  const saida: string[] = [];
  const conectar = jest.fn(() => ({
    $queryRawUnsafe: jest.fn().mockResolvedValue([]),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $transaction: jest.fn(),
    $disconnect: jest.fn().mockResolvedValue(undefined),
    ...cliente,
  })) as unknown as (url: string) => ClienteDeAcesso;
  return {
    saida,
    conectar,
    ambiente: { env, conectar, escrever: (l: string) => saida.push(l) },
  };
}

describe('CLI acesso:sadmin — recusas que acontecem ANTES de conectar', () => {
  it.each([
    ['sem credencial', ['listar'], {}],
    [
      'sem --email',
      ['redefinir', '--confirmar'],
      { [VARIAVEL_DA_CREDENCIAL]: URL_FALSA },
    ],
    [
      'sem --confirmar',
      ['redefinir', '--email', 'a@b.com'],
      { [VARIAVEL_DA_CREDENCIAL]: URL_FALSA },
    ],
    [
      'comando desconhecido',
      ['apagar'],
      { [VARIAVEL_DA_CREDENCIAL]: URL_FALSA },
    ],
  ])('%s: exit 1 e nenhuma conexão', async (_caso, argv, env) => {
    const a = ambiente(env);

    await expect(executarCli(argv, a.ambiente)).resolves.toBe(1);

    expect(a.conectar).not.toHaveBeenCalled();
  });

  /**
   * A credencial deste comando é escolha de quem opera. Herdar a do ambiente
   * faria a CLI escrever em produção porque o terminal calhava de ter a
   * variável do app — foi essa a regra que a SPEC-057/D3 já tinha fixado para
   * a CLI da presença automática.
   */
  it('não cai para DATABASE_URL nem para MIGRATION_DATABASE_URL', async () => {
    const a = ambiente({
      DATABASE_URL: URL_FALSA,
      MIGRATION_DATABASE_URL: URL_FALSA,
    });

    await expect(executarCli(['listar'], a.ambiente)).resolves.toBe(1);

    expect(a.conectar).not.toHaveBeenCalled();
    expect(a.saida.join('\n')).toContain(VARIAVEL_DA_CREDENCIAL);
  });
});

describe('CLI acesso:sadmin — quem ela recusa depois de ler', () => {
  const env = { [VARIAVEL_DA_CREDENCIAL]: URL_FALSA };
  const SUPERS = [
    {
      id: '11111111-1111-4111-8111-111111111111',
      nome: 'Super',
      email: 'super@playck.local',
      status: 'ativo',
      senhaTemporaria: false,
      expiraEm: null,
    },
    {
      id: '22222222-2222-4222-8222-222222222222',
      nome: 'Desligado',
      email: 'antigo@playck.local',
      status: 'inativo',
      senhaTemporaria: false,
      expiraEm: null,
    },
  ];

  it('e-mail que não é de super admin: recusa sem tocar em ninguém', async () => {
    const transacao = jest.fn();
    const a = ambiente(env, {
      $queryRawUnsafe: jest.fn().mockResolvedValue(SUPERS),
      $transaction: transacao,
    });

    const codigo = await executarCli(
      ['redefinir', '--email', 'gestor@clube.com', '--confirmar'],
      a.ambiente,
    );

    expect(codigo).toBe(1);
    expect(a.saida.join('\n')).toContain('SUPER_ADMIN_NAO_ENCONTRADO');
    expect(transacao).not.toHaveBeenCalled();
  });

  // Mesma escolha da rota do gestor: reativar conta é outra decisão, e ela
  // não pode acontecer de carona numa recuperação de senha.
  it('conta inativa: recusa em vez de reativar em silêncio', async () => {
    const transacao = jest.fn();
    const a = ambiente(env, {
      $queryRawUnsafe: jest.fn().mockResolvedValue(SUPERS),
      $transaction: transacao,
    });

    const codigo = await executarCli(
      ['redefinir', '--email', 'antigo@playck.local', '--confirmar'],
      a.ambiente,
    );

    expect(codigo).toBe(1);
    expect(a.saida.join('\n')).toContain('CONTA_INATIVA');
    expect(transacao).not.toHaveBeenCalled();
  });

  it('listar não escreve nada e não mostra hash', async () => {
    const executar = jest.fn();
    const a = ambiente(env, {
      $queryRawUnsafe: jest.fn().mockResolvedValue(SUPERS),
      $executeRawUnsafe: executar,
      $transaction: jest.fn(),
    });

    await expect(executarCli(['listar'], a.ambiente)).resolves.toBe(0);

    expect(executar).not.toHaveBeenCalled();
    const texto = a.saida.join('\n');
    expect(texto).toContain('super@playck.local');
    expect(texto).toContain('conta inativo');
    expect(texto).not.toMatch(/\$2[aby]\$/);
  });

  it('falha de conexão não vaza host nem usuário', async () => {
    class PrismaClientInitializationError extends Error {}
    const a = ambiente(env, {
      $queryRawUnsafe: jest
        .fn()
        .mockRejectedValue(
          new PrismaClientInitializationError(
            "Can't reach database server at `ep-secreto.aws.neon.tech:5432`",
          ),
        ),
    });

    const codigo = await executarCli(['listar'], a.ambiente);

    expect(codigo).toBe(1);
    expect(a.saida.join('\n')).toContain('CONEXAO_FALHOU');
    expect(a.saida.join('\n')).not.toContain('neon.tech');
  });
});
