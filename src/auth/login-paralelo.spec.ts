import type { ConfigService } from '@nestjs/config';
import type { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import type { LogoDaEmpresaService } from '../companies/logo-da-empresa.service';
import type { StudentsService } from '../people/students.service';
import type { PrismaService } from '../prisma/prisma.service';
import { AuthService } from './auth.service';

/**
 * SPEC-086/AC-013 — **a senha é conferida em todas as contas ao mesmo tempo
 * (I7), provado sem relógio.**
 *
 * O `bcrypt.compare` dublado só resolve quando o teste manda. Se o login
 * disparar as quatro comparações de uma vez, as quatro chamadas estão
 * registradas ANTES de o teste resolver a primeira. Em série (`for … await`),
 * ou com um `Promise.all` sobre promessas criadas num laço com `await`, só a
 * primeira existe nesse momento — e o caso fica vermelho (S11).
 *
 * O ganho de TEMPO depende da CPU (LIM-086-01) e não é gate: a medição vai
 * para o `CLI_AUDIT.md` (AC-022). Aqui se prova o que a spec garante.
 */
jest.mock('bcrypt', () => {
  const real = jest.requireActual<typeof import('bcrypt')>('bcrypt');
  return { ...real, compare: jest.fn() };
});

const compare = bcrypt.compare as unknown as jest.Mock;

function contas(n: number) {
  return Array.from({ length: n }, (_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    email: 'mesmo@teste.local',
    senhaHash: `$2b$12$hash-${i}`,
    nome: `Conta ${i}`,
    role: 'aluno' as const,
    companyId: `10000000-0000-4000-8000-00000000000${i}`,
    status: 'ativo',
    senhaTemporaria: false,
    senhaTemporariaExpiraEm: null,
  }));
}

function servico(n: number) {
  const prisma = {
    usuario: { findMany: jest.fn().mockResolvedValue(contas(n)) },
    empresa: { findMany: jest.fn().mockResolvedValue([]) },
    refreshToken: { updateMany: jest.fn() },
  };
  return new AuthService(
    prisma as unknown as PrismaService,
    {} as StudentsService,
    {} as JwtService,
    {} as ConfigService,
    {} as LogoDaEmpresaService,
  );
}

describe('SPEC-086/AC-013 — a conferência das senhas é paralela', () => {
  beforeEach(() => compare.mockReset());

  it('com 4 contas, as 4 comparações existem antes de a primeira terminar', async () => {
    const pendentes: ((v: boolean) => void)[] = [];
    compare.mockImplementation(
      () => new Promise<boolean>((resolve) => pendentes.push(resolve)),
    );

    const login = servico(4)
      .login({ email: 'mesmo@teste.local', senha: 'errada-qualquer' })
      .catch((e: unknown) => e);

    // Deixa o `findMany` resolver e o login chegar às comparações.
    for (let i = 0; i < 10 && compare.mock.calls.length === 0; i++) {
      await new Promise((r) => setImmediate(r));
    }
    // Mais alguns giros: uma implementação em série NÃO criaria as outras
    // enquanto a primeira não terminar, por mais que se espere.
    for (let i = 0; i < 10; i++) await new Promise((r) => setImmediate(r));

    expect(compare).toHaveBeenCalledTimes(4);
    expect(compare.mock.calls.map((c: unknown[]) => c[1])).toEqual([
      '$2b$12$hash-0',
      '$2b$12$hash-1',
      '$2b$12$hash-2',
      '$2b$12$hash-3',
    ]);

    pendentes.forEach((resolve) => resolve(false));
    expect(await login).toBeInstanceOf(Error);
  });

  it('controle: com 1 conta, uma comparação só', async () => {
    compare.mockResolvedValue(false);
    await servico(1)
      .login({ email: 'mesmo@teste.local', senha: 'errada-qualquer' })
      .catch(() => undefined);
    expect(compare).toHaveBeenCalledTimes(1);
  });
});
