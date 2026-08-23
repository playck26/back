import type { INestApplication } from '@nestjs/common';
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

interface ListBody {
  data: unknown[];
  total: number;
}
interface CreateCompanyBody {
  empresa: { id: string; nome: string };
  adminUsuario: { email: string; role: string };
}
interface CompanyBody {
  id: string;
  nome?: string;
  status?: string;
}
interface MinhaEmpresaBody {
  nome: string;
  slug: string;
  permiteAutoCadastro: boolean;
}

// TEST-002 (SPEC-002): suíte Supertest formal do módulo de empresas —
// Prisma mockado (sem banco vivo). A prova com banco vivo (CRUD real,
// transação atômica, bloqueio de login após inativar) já existe no smoke
// test de `back/.github/workflows/db-migrate.yml` — esta suíte cobre a
// camada HTTP/guard/DTO que aquele smoke test não isola: 403 exato pra
// cada role errada, 400 de validação, e o corpo de erro em cada caso.

const OUTRA_COMPANY_ID = '22222222-2222-4222-8222-222222222222';

async function loginSuperAdmin(app: INestApplication<App>, prisma: PrismaMock) {
  const superAdmin = await buildUsuarioAtivo({
    id: 'sa1',
    email: 'super@playck.demo',
    role: 'super_admin',
    companyId: null,
  });
  const { accessToken } = await loginAndGetTokens(app, prisma, superAdmin);
  return accessToken;
}

async function loginCompanyAdmin(
  app: INestApplication<App>,
  prisma: PrismaMock,
) {
  const admin = await buildUsuarioAtivo({
    id: 'ca1',
    email: 'admin@empresa.demo',
    role: 'company_admin',
  });
  const { accessToken } = await loginAndGetTokens(app, prisma, admin);
  return accessToken;
}

describe('Companies (e2e) - TEST-002', () => {
  let app: INestApplication<App>;
  let prisma: PrismaMock;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    app = await createTestApp(prisma);
  });

  afterEach(async () => {
    await app.close();
  });

  describe('autorização (REQ-006, NFR-001)', () => {
    it('sem token retorna 401 em qualquer rota de /companies', async () => {
      await request(app.getHttpServer()).get('/api/v1/companies').expect(401);
    });

    it('AC-004: company_admin autenticado recebe 403 em GET /companies', async () => {
      const accessToken = await loginCompanyAdmin(app, prisma);

      await request(app.getHttpServer())
        .get('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('company_admin recebe 403 em POST /companies', async () => {
      const accessToken = await loginCompanyAdmin(app, prisma);

      await request(app.getHttpServer())
        .post('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({
          nome: 'Nova Empresa',
          esportes: ['tenis'],
          adminInicial: {
            nome: 'Admin',
            email: 'novo-admin@x.com',
            senha: SENHA_VALIDA,
          },
        })
        .expect(403);

      expect(prisma.empresa.findUnique).not.toHaveBeenCalledWith(
        expect.objectContaining({ where: { nome: 'Nova Empresa' } }),
      );
    });
  });

  describe('GET /api/v1/companies (REQ-001)', () => {
    it('super_admin lista empresas paginado', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findMany.mockResolvedValue([
        { id: OUTRA_COMPANY_ID, nome: 'Empresa X', status: 'ativa' },
      ]);
      prisma.empresa.count.mockResolvedValue(1);

      const res = await request(app.getHttpServer())
        .get('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      const body = bodyOf<ListBody>(res);
      expect(body.total).toBe(1);
      expect(body.data).toHaveLength(1);
    });
  });

  describe('POST /api/v1/companies (REQ-002, REQ-003)', () => {
    const dto = {
      nome: 'Empresa Nova',
      esportes: ['tenis'],
      adminInicial: {
        nome: 'Admin Novo',
        email: 'admin-novo@x.com',
        senha: SENHA_VALIDA,
      },
    };

    it('cria empresa + admin inicial numa operação atômica', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue(null);
      prisma.usuario.findUnique.mockResolvedValue(null);
      prisma.tx.empresa.create.mockResolvedValue({
        id: OUTRA_COMPANY_ID,
        nome: dto.nome,
        esportes: dto.esportes,
        status: 'ativa',
      });
      prisma.tx.usuario.create.mockResolvedValue({
        id: 'ca2',
        nome: dto.adminInicial.nome,
        email: dto.adminInicial.email,
        companyId: OUTRA_COMPANY_ID,
      });

      const res = await request(app.getHttpServer())
        .post('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(dto)
        .expect(201);

      const body = bodyOf<CreateCompanyBody>(res);
      expect(body.empresa.nome).toBe(dto.nome);
      expect(body.adminUsuario).toMatchObject({
        email: dto.adminInicial.email,
        role: 'company_admin',
      });
      expect(JSON.stringify(res.body)).not.toMatch(/senhaHash/i);
    });

    it('AC-001: email do admin inicial já existente falha inteira com 422, sem criar nada', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue(null);
      prisma.usuario.findUnique.mockResolvedValue({ id: 'existente' });

      await request(app.getHttpServer())
        .post('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(dto)
        .expect(422);

      expect(prisma.tx.empresa.create).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('AC-002/REQ-003: nome de empresa duplicado retorna 409', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue({
        id: OUTRA_COMPANY_ID,
        nome: dto.nome,
      });

      await request(app.getHttpServer())
        .post('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .send(dto)
        .expect(409);
    });

    it('ValidationPipe: sem adminInicial retorna 400 (DTO aninhado obrigatório)', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);

      await request(app.getHttpServer())
        .post('/api/v1/companies')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nome: 'Empresa Sem Admin', esportes: ['tenis'] })
        .expect(400);
    });
  });

  describe('PATCH /api/v1/companies/:id (REQ-004)', () => {
    it('edita nome/esportes de uma empresa existente', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue({
        id: OUTRA_COMPANY_ID,
        nome: 'Nome Antigo',
      });
      prisma.empresa.update.mockResolvedValue({
        id: OUTRA_COMPANY_ID,
        nome: 'Nome Novo',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/companies/${OUTRA_COMPANY_ID}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nome: 'Nome Novo' })
        .expect(200);

      expect(bodyOf<CompanyBody>(res).nome).toBe('Nome Novo');
    });

    it('id que não existe retorna 404', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue(null);

      await request(app.getHttpServer())
        .patch(`/api/v1/companies/${OUTRA_COMPANY_ID}`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nome: 'Nome Novo' })
        .expect(404);
    });

    it('id fora do formato UUID retorna 400 (ParseUUIDPipe)', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);

      await request(app.getHttpServer())
        .patch('/api/v1/companies/nao-e-uuid')
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ nome: 'Nome Novo' })
        .expect(400);
    });
  });

  describe('PATCH /api/v1/companies/:id/status (REQ-005)', () => {
    it('inativa uma empresa', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue({
        id: OUTRA_COMPANY_ID,
        status: 'ativa',
      });
      prisma.empresa.update.mockResolvedValue({
        id: OUTRA_COMPANY_ID,
        status: 'inativa',
      });

      const res = await request(app.getHttpServer())
        .patch(`/api/v1/companies/${OUTRA_COMPANY_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'inativa' })
        .expect(200);

      expect(bodyOf<CompanyBody>(res).status).toBe('inativa');
    });

    it('ValidationPipe: status fora do enum retorna 400', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);

      await request(app.getHttpServer())
        .patch(`/api/v1/companies/${OUTRA_COMPANY_ID}/status`)
        .set('Authorization', `Bearer ${accessToken}`)
        .send({ status: 'suspensa' })
        .expect(400);
    });
  });
  // DEF-003: o gestor não tinha rota nenhuma que devolvesse o `slug` da
  // própria empresa, e sem ele não há como divulgar `/cadastro/<slug>`.
  // O que estes testes fixam é o escopo: a empresa vem do token, não da
  // URL, e só o `company_admin` lê.
  describe('GET /api/v1/me/company (DEF-003)', () => {
    it('company_admin recebe o slug da própria empresa', async () => {
      const accessToken = await loginCompanyAdmin(app, prisma);
      prisma.empresa.findUnique.mockResolvedValue({
        nome: 'Clube Teste',
        slug: 'clube-teste',
        logoUrl: null,
        status: 'ativa',
        permiteAutoCadastro: true,
      });

      const res = await request(app.getHttpServer())
        .get('/api/v1/me/company')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(200);

      expect(bodyOf<MinhaEmpresaBody>(res).slug).toBe('clube-teste');
      // A empresa sai do token: nenhum id trafega na URL para ser trocado.
      expect(prisma.empresa.findUnique).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: { id: COMPANY_ID } }),
      );
    });

    it('super_admin recebe 403 — a rota é do gestor, não da plataforma', async () => {
      const accessToken = await loginSuperAdmin(app, prisma);

      await request(app.getHttpServer())
        .get('/api/v1/me/company')
        .set('Authorization', `Bearer ${accessToken}`)
        .expect(403);
    });

    it('sem token retorna 401', async () => {
      await request(app.getHttpServer()).get('/api/v1/me/company').expect(401);
    });
  });
});
