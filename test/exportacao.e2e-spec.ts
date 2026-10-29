import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  COMPANY_ID,
  buildUsuarioAtivo,
  loginAndGetTokens,
} from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';
import { analisarCsv } from '../src/people/importacao/csv';

/**
 * SPEC-092 — a exportação na camada HTTP: quem entra (AC-005), os cabeçalhos
 * da resposta e o nome do arquivo (D6).
 *
 * O que a consulta devolve, com dois clubes de verdade, é do arquivo de banco
 * (`test/banco/spec-092-exportar-alunos.db-spec.ts`). Aqui o banco é dublê, e
 * o que se mede é a borda: a rota existe ANTES do `:id` (senão seria 400 do
 * pipe de UUID), o clube sai do token, e o navegador recebe um anexo CSV.
 */
const ROTA = '/api/v1/students/exportar';

const LINHA = {
  nome: 'Ana',
  email: 'ana@clube.local',
  telefone: null,
  nivel: 'Iniciante',
  aluno_inativo: false,
  conta_inativa: false,
  vinculo: 'aprovado',
  senha_temporaria: false,
  turmas: ['Terça 19h'],
};

describe('Exportar alunos (e2e) — SPEC-092', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  async function tokenDe(role: 'company_admin' | 'professor' | 'aluno') {
    const usuario = await buildUsuarioAtivo({
      id: `u-${role}`,
      email: `${role}@empresa.demo`,
      role,
    });
    const { accessToken } = await loginAndGetTokens(app, prisma, usuario);
    prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: false });
    return accessToken;
  }

  it('o gestor baixa o CSV como anexo, com o nome da D6', async () => {
    const accessToken = await tokenDe('company_admin');
    prisma.$queryRaw.mockResolvedValue([LINHA]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .set('Authorization', `Bearer ${accessToken}`)
      .buffer(true)
      .parse((res, fim) => {
        const partes: Buffer[] = [];
        res.on('data', (p: Buffer) => partes.push(p));
        res.on('end', () => fim(null, Buffer.concat(partes)));
      });

    expect(resposta.status).toBe(200);
    expect(resposta.headers['content-type']).toBe('text/csv; charset=utf-8');
    expect(resposta.headers['content-disposition']).toMatch(
      /^attachment; filename="alunos-\d{4}-\d{2}-\d{2}\.csv"$/,
    );
    expect(resposta.headers['access-control-expose-headers']).toBe(
      'Content-Disposition',
    );
    expect(resposta.headers['cache-control']).toBe('no-store');

    // Os bytes: BOM UTF-8 de verdade na frente, e não o caractere em latin-1.
    const bytes = resposta.body as Buffer;
    expect([...bytes.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const linhas = analisarCsv(bytes.toString('utf8'), ';');
    expect(linhas).toEqual([
      [
        'Nome',
        'E-mail',
        'Telefone',
        'Nível',
        'Turma 1',
        'Turma 2',
        'Turma 3',
        'Status',
      ],
      ['Ana', 'ana@clube.local', '', 'Iniciante', 'Terça 19h', '', '', 'ativo'],
    ]);

    // D6 — o clube é o do token, e a consulta não recebe outro valor.
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    const sql = (prisma.$queryRaw.mock.calls[0] as [{ values: unknown[] }])[0];
    expect(sql.values).toEqual([COMPANY_ID]);
  });

  it('um `companyId` na query não muda o clube (D6)', async () => {
    const accessToken = await tokenDe('company_admin');
    prisma.$queryRaw.mockResolvedValue([]);

    const resposta = await request(app.getHttpServer())
      .get(ROTA)
      .query({ companyId: '22222222-2222-4222-8222-222222222222' })
      .set('Authorization', `Bearer ${accessToken}`);

    expect(resposta.status).toBe(200);
    const sql = (prisma.$queryRaw.mock.calls[0] as [{ values: unknown[] }])[0];
    expect(sql.values).toEqual([COMPANY_ID]);
  });

  it.each(['professor', 'aluno'] as const)(
    'AC-005 — %s recebe 403, e o banco não é consultado',
    async (role) => {
      const accessToken = await tokenDe(role);

      const resposta = await request(app.getHttpServer())
        .get(ROTA)
        .set('Authorization', `Bearer ${accessToken}`);

      expect(resposta.status).toBe(403);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    },
  );

  it('AC-005 — sem login, 401, e o banco não é consultado', async () => {
    const resposta = await request(app.getHttpServer()).get(ROTA);
    expect(resposta.status).toBe(401);
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });
});
