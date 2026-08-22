import type { INestApplication } from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import request from 'supertest';
import type { App } from 'supertest/types';
import {
  buildUsuarioAtivo,
  COMPANY_ID,
  loginAndGetTokens,
  SENHA_VALIDA,
} from './utils/auth-helpers';
import { createTestApp } from './utils/create-test-app';
import { bodyOf } from './utils/http';
import { buildPrismaMock, type PrismaMock } from './utils/prisma-mock';

interface LoginBody {
  accessToken: string;
  refreshToken: string;
  usuario: {
    id: string;
    email: string;
    role: string;
    companyId: string | null;
  };
}
interface ErrorBody {
  message: string;
}
interface RefreshBody {
  accessToken: string;
}
interface RegisterAlunoBody {
  usuario: {
    id: string;
    email: string;
    role: string;
    companyId: string | null;
  };
}
interface MeBody {
  email: string;
}

// TEST-001 (SPEC-001): suíte Supertest formal do módulo de auth — Prisma
// mockado (sem banco vivo, roda em qualquer CI sem depender do Neon),
// cobrindo a camada HTTP real: guards, ValidationPipe, throttler e o
// formato exato de resposta/erro que a rota entrega. A prova com banco
// vivo (login/refresh/register-aluno reais, FIT-002) já existe no smoke
// test de `back/.github/workflows/db-migrate.yml` — esta suíte cobre o
// que aquele smoke test não cobre: validação de DTO (400), rate limit
// (429) e a garantia de que a senha nunca aparece numa resposta.
//
// Cada teste sobe uma instância nova do app (`beforeEach`) de propósito:
// o ThrottlerModule usa storage em memória por instância de módulo, e o
// teste de rate limit (NFR-002/TEST-001b) precisa de um contador zerado
// — instâncias compartilhadas entre testes fariam chamadas de um teste
// "vazarem" pro orçamento de tentativas de outro (mesma armadilha
// descoberta ao escrever FIT-002 com login dentro de um loop).

describe('Auth (e2e) - TEST-001', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('POST /api/v1/auth/login', () => {
    it('REQ-002: credenciais válidas retornam accessToken + refreshToken + usuario', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken, refreshToken } = await loginAndGetTokens(
        app,
        prisma,
        usuario,
      );

      expect(accessToken).toEqual(expect.any(String));
      expect(refreshToken).toEqual(expect.any(String));
    });

    it('NFR-001: a resposta nunca inclui o hash da senha', async () => {
      const usuario = await buildUsuarioAtivo();
      prisma.usuario.findUnique.mockResolvedValue(usuario);
      prisma.empresa.findUnique.mockResolvedValue({
        id: COMPANY_ID,
        status: 'ativa',
        permiteAutoCadastro: true,
      });
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt1' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: usuario.email, senha: SENHA_VALIDA })
        .expect(200);

      expect(bodyOf<LoginBody>(res).usuario).toMatchObject({
        id: usuario.id,
        email: usuario.email,
        role: 'company_admin',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/senhaHash/i);
    });

    it('AC-002: senha errada retorna 401 genérico', async () => {
      const usuario = await buildUsuarioAtivo();
      prisma.usuario.findUnique.mockResolvedValue(usuario);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: usuario.email, senha: 'senha-errada-123' })
        .expect(401);

      expect(bodyOf<ErrorBody>(res).message).toBe('Credenciais inválidas');
    });

    it('AC-002: email inexistente retorna a mesma mensagem genérica (não revela se o email existe)', async () => {
      prisma.usuario.findUnique.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'ninguem@x.com', senha: SENHA_VALIDA })
        .expect(401);

      expect(bodyOf<ErrorBody>(res).message).toBe('Credenciais inválidas');
    });

    it('AC-008: bloqueia login se a empresa do usuário está inativa', async () => {
      const usuario = await buildUsuarioAtivo();
      prisma.usuario.findUnique.mockResolvedValue(usuario);
      prisma.empresa.findUnique.mockResolvedValue({
        id: COMPANY_ID,
        status: 'inativa',
      });

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: usuario.email, senha: SENHA_VALIDA })
        .expect(401);
    });

    it('ValidationPipe: email malformado retorna 400 antes de tocar o banco', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'nao-e-email', senha: SENHA_VALIDA })
        .expect(400);

      expect(prisma.usuario.findUnique).not.toHaveBeenCalled();
    });

    it('ValidationPipe: campo desconhecido no corpo retorna 400 (forbidNonWhitelisted)', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'x@x.com', senha: SENHA_VALIDA, role: 'super_admin' })
        .expect(400);
    });
  });

  describe('POST /api/v1/auth/refresh', () => {
    it('REQ-003: refresh token válido (via cookie) retorna novo access token', async () => {
      const usuario = await buildUsuarioAtivo();
      const { refreshToken } = await loginAndGetTokens(app, prisma, usuario);

      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt1',
        usuarioId: usuario.id,
        tokenHash: await bcrypt.hash(refreshToken, 4),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: null,
      });
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });
      prisma.usuario.findUniqueOrThrow.mockResolvedValue(usuario);
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt2' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', [`refresh_token=${refreshToken}`])
        .expect(200);

      // O refresh token novo só vai no cookie httpOnly (SECURITY_PRIVACY.md)
      // — a resposta JSON deste endpoint traz só o access token.
      expect(bodyOf<RefreshBody>(res).accessToken).toEqual(expect.any(String));
      expect(res.body).not.toHaveProperty('refreshToken');
      const setCookie = res.headers['set-cookie'];
      expect(setCookie).toBeDefined();
      expect(String(setCookie)).toMatch(/refresh_token=/);
    });

    it('AC-003: reuso de token já rotacionado (claim perdida) retorna 401', async () => {
      const usuario = await buildUsuarioAtivo();
      const { refreshToken } = await loginAndGetTokens(app, prisma, usuario);

      prisma.refreshToken.findUnique.mockResolvedValue({
        id: 'rt1',
        usuarioId: usuario.id,
        tokenHash: await bcrypt.hash(refreshToken, 4),
        expiresAt: new Date(Date.now() + 60 * 60 * 1000),
        revokedAt: null,
      });
      // count: 0 nas duas chamadas de updateMany (claim perdida + revoga
      // tudo) — simula que outra requisição já rotacionou este token.
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 0 });

      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .set('Cookie', [`refresh_token=${refreshToken}`])
        .expect(401);
    });

    it('REQ-006: sem cookie de refresh retorna 401', async () => {
      await request(app.getHttpServer())
        .post('/api/v1/auth/refresh')
        .expect(401);
    });
  });

  describe('POST /api/v1/auth/register-aluno', () => {
    const dto = {
      email: 'aluno-novo@x.com',
      senha: SENHA_VALIDA,
      nome: 'Aluno Novo',
      // SPEC-009/REQ-001: identificação por slug do link público.
      empresaSlug: 'empresa-demo',
    };

    it('REQ-005: cria usuario (role aluno) vinculado a empresa ativa existente', async () => {
      prisma.empresa.findUnique.mockResolvedValue({
        id: COMPANY_ID,
        status: 'ativa',
        permiteAutoCadastro: true,
      });
      prisma.usuario.findUnique.mockResolvedValue(null);
      prisma.tx.usuario.create.mockResolvedValue({
        id: 'u2',
        nome: dto.nome,
        email: dto.email,
        role: 'aluno',
        companyId: COMPANY_ID,
      });
      prisma.tx.aluno.create.mockResolvedValue({ id: 'a1' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register-aluno')
        .send(dto)
        .expect(201);

      expect(bodyOf<RegisterAlunoBody>(res).usuario).toMatchObject({
        email: dto.email,
        role: 'aluno',
        companyId: COMPANY_ID,
      });
      // SPEC-009/REQ-007: a escrita continua acontecendo, mas por MOD-003
      // (`StudentsService.criarPerfilDeAluno`), não por MOD-001. Aqui a
      // suíte roda o serviço real, então o que se prova é a forma final da
      // linha — inclusive `vinculo: 'pendente'`, porque auto-cadastro
      // público depende de aprovação do admin (REQ-008/INV-010).
      expect(prisma.tx.aluno.create).toHaveBeenCalledWith({
        data: {
          usuarioId: 'u2',
          companyId: COMPANY_ID,
          nivelId: null,
          vinculo: 'pendente',
        },
        include: { usuario: true },
      });
    });

    // SPEC-009/REQ-011 (AC-021): antes este caso devolvia `409 "Email já
    // cadastrado"` e o de empresa inválida devolvia `422` com outra
    // mensagem — num endpoint aberto, isso é um verificador de existência
    // de conta e de tenant. Agora os quatro modos de falha devolvem a
    // mesma resposta, byte a byte.
    it('AC-021: e-mail já cadastrado devolve 422 genérico', async () => {
      prisma.empresa.findUnique.mockResolvedValue({
        id: COMPANY_ID,
        status: 'ativa',
        permiteAutoCadastro: true,
      });
      prisma.usuario.findUnique.mockResolvedValue({ id: 'existente' });

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register-aluno')
        .send(dto)
        .expect(422);

      expect(bodyOf<{ message: string }>(res).message).toBe(
        'Não foi possível concluir o cadastro com esses dados.',
      );
      expect(prisma.tx.usuario.create).not.toHaveBeenCalled();
    });

    it('AC-021: auto-cadastro desligado devolve a MESMA resposta de e-mail duplicado', async () => {
      prisma.empresa.findUnique.mockResolvedValue({
        id: COMPANY_ID,
        status: 'ativa',
        permiteAutoCadastro: false,
      });
      prisma.usuario.findUnique.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register-aluno')
        .send(dto)
        .expect(422);

      expect(bodyOf<{ message: string }>(res).message).toBe(
        'Não foi possível concluir o cadastro com esses dados.',
      );
    });

    it('AC-021: slug inexistente devolve a MESMA resposta dos demais casos', async () => {
      prisma.empresa.findUnique.mockResolvedValue(null);
      prisma.usuario.findUnique.mockResolvedValue(null);

      const res = await request(app.getHttpServer())
        .post('/api/v1/auth/register-aluno')
        .send(dto)
        .expect(422);

      expect(bodyOf<{ message: string }>(res).message).toBe(
        'Não foi possível concluir o cadastro com esses dados.',
      );
    });
  });

  // =====================================================================
  // SPEC-009/REQ-001 — página pública de auto-cadastro
  // =====================================================================
  describe('GET /api/v1/public/companies/:slug', () => {
    it('devolve só nome e logo de empresa ativa que aceita auto-cadastro', async () => {
      prisma.empresa.findUnique.mockResolvedValue({
        nome: 'Empresa Demo',
        logoUrl: 'https://x/logo.png',
        status: 'ativa',
        permiteAutoCadastro: true,
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/public/companies/empresa-demo')
        .expect(200);

      expect(res.body).toEqual({
        nome: 'Empresa Demo',
        logoUrl: 'https://x/logo.png',
      });
      // Nada de id, status ou configuração interna numa rota aberta.
      expect(JSON.stringify(res.body)).not.toMatch(/status|permite|id/i);
    });

    // AC-022: os três casos devolvem o mesmo 404. Distinguir transformaria
    // a rota num verificador de existência de tenant.
    it.each([
      ['slug inexistente', null],
      [
        'empresa inativa',
        {
          nome: 'X',
          logoUrl: null,
          status: 'inativa',
          permiteAutoCadastro: true,
        },
      ],
      [
        'auto-cadastro desligado',
        {
          nome: 'X',
          logoUrl: null,
          status: 'ativa',
          permiteAutoCadastro: false,
        },
      ],
    ])('AC-022: %s devolve 404 idêntico', async (_caso, empresa) => {
      prisma.empresa.findUnique.mockResolvedValue(empresa);

      const res = await request(app.getHttpServer())
        .get('/api/v1/public/companies/qualquer')
        .expect(404);

      expect(bodyOf<{ message: string }>(res).message).toBe('Not Found');
    });
  });

  // =====================================================================
  // SPEC-009 — INV-008 na camada HTTP real (guard + controller + service)
  // =====================================================================
  describe('senha temporária (SPEC-009/INV-008)', () => {
    it('AC-008: conta com senha temporária é barrada com 403 numa rota comum', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);

      // O guard consulta o banco a cada requisição autenticada — é ele que
      // decide, não um claim do token já emitido.
      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: true });

      const res = await request(app.getHttpServer())
        .get('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);

      expect(bodyOf<{ code: string }>(res).code).toBe('SENHA_TEMPORARIA');
    });

    it('AC-008: /auth/me continua acessível em primeiro acesso e denuncia o estado', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);

      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: true });
      prisma.usuario.findUniqueOrThrow.mockResolvedValue({
        ...usuario,
        senhaTemporaria: true,
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(bodyOf<{ senhaTemporaria: boolean }>(res).senhaTemporaria).toBe(
        true,
      );
    });

    it('AC-009: trocar a senha libera o acesso e revoga as sessões anteriores', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);

      prisma.usuario.findUnique.mockResolvedValue({ senhaTemporaria: true });
      prisma.usuario.findUniqueOrThrow.mockResolvedValue({
        ...usuario,
        senhaTemporaria: true,
        senhaTemporariaExpiraEm: new Date(Date.now() + 86_400_000),
      });
      prisma.tx.usuario.update.mockResolvedValue({});
      prisma.tx.refreshToken.updateMany.mockResolvedValue({});
      prisma.refreshToken.create.mockResolvedValue({ id: 'rt2' });

      await request(app.getHttpServer())
        .post('/api/v1/auth/trocar-senha')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ senhaAtual: SENHA_VALIDA, novaSenha: 'senha-nova-forte-1' })
        .expect(200);

      const chamada = prisma.tx.usuario.update.mock.calls[0] as [
        { where: { id: string }; data: { senhaTemporaria: boolean } },
      ];
      expect(chamada[0].where.id).toBe(usuario.id);
      expect(chamada[0].data.senhaTemporaria).toBe(false);
      expect(prisma.tx.refreshToken.updateMany).toHaveBeenCalled();
    });

    it('AC-020: logout funciona sem access token válido, pelo cookie de refresh', async () => {
      const usuario = await buildUsuarioAtivo();
      const { refreshToken } = await loginAndGetTokens(app, prisma, usuario);
      prisma.refreshToken.updateMany.mockResolvedValue({ count: 1 });

      await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', [`refresh_token=${refreshToken}`])
        .expect(204);

      expect(prisma.refreshToken.updateMany).toHaveBeenCalled();
    });
  });

  describe('GET /api/v1/auth/me', () => {
    it('REQ-006: sem token retorna 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/auth/me').expect(401);
    });

    it('com token válido retorna os dados do usuário autenticado', async () => {
      const usuario = await buildUsuarioAtivo();
      const { accessToken } = await loginAndGetTokens(app, prisma, usuario);

      prisma.usuario.findUniqueOrThrow.mockResolvedValue(usuario);

      const res = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(bodyOf<MeBody>(res).email).toBe(usuario.email);
      expect(JSON.stringify(res.body)).not.toMatch(/senhaHash/i);
    });
  });

  describe('NFR-002 / TEST-001b: rate limit de 10 tentativas/15min em /auth/login', () => {
    it('a 11ª tentativa na mesma janela retorna 429', async () => {
      prisma.usuario.findUnique.mockResolvedValue(null);

      for (let i = 0; i < 10; i++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ email: 'x@x.com', senha: 'errada-123' });
      }

      await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ email: 'x@x.com', senha: 'errada-123' })
        .expect(429);
    });
  });
});
