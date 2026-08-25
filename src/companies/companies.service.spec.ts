import {
  ConflictException,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CompaniesService } from './companies.service';

// TEST-002 (SPEC-002): unit tests de MOD-002 com PrismaService mockado —
// $transaction simulado chamando o callback direto com um objeto `tx`
// próprio, o suficiente para provar que create/create do admin só
// acontecem dentro da transação (nunca fora dela).

interface TxMock {
  // `findUnique` entrou em SPEC-009:TASK-000: a criação de empresa agora
  // gera `slug` único e consulta colisão dentro da própria transação.
  empresa: { create: jest.Mock; findUnique: jest.Mock };
  usuario: { create: jest.Mock };
  // SPEC-010: empresa nova nasce com o horário padrão dos 7 dias.
  horarioFuncionamento: { createMany: jest.Mock };
}

function buildPrismaMock() {
  const tx: TxMock = {
    // Padrão: nenhum slug colidindo. Um teste específico sobrescreve para
    // provar o caminho de colisão.
    empresa: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    usuario: { create: jest.fn() },
    // SPEC-010: empresa nova nasce com o horário padrão dos 7 dias, na
    // mesma transação.
    horarioFuncionamento: {
      createMany: jest.fn().mockResolvedValue({ count: 7 }),
    },
  };
  const prisma = {
    empresa: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    usuario: {
      findUnique: jest.fn(),
      // SPEC-016: a busca do gestor amarra id + empresa + papel no WHERE.
      findFirst: jest.fn(),
      findMany: jest.fn(),
    },
    $transaction: jest.fn((callback: (tx: TxMock) => unknown) => callback(tx)),
  };
  return { prisma: prisma as unknown as PrismaService, tx };
}

describe('CompaniesService', () => {
  let prisma: PrismaService;
  let tx: ReturnType<typeof buildPrismaMock>['tx'];
  let service: CompaniesService;
  // SPEC-016/INV-031: MOD-002 não escreve senha nem sessão — delega a
  // MOD-001. O mock existe para provar a delegação, não o efeito.
  let auth: { gerarSenhaTemporariaParaUsuario: jest.Mock };

  beforeEach(() => {
    const built = buildPrismaMock();
    prisma = built.prisma;
    tx = built.tx;
    auth = {
      gerarSenhaTemporariaParaUsuario: jest.fn().mockResolvedValue({
        senhaTemporaria: 'pck-ABC234',
        expiraEm: new Date('2026-09-01T00:00:00.000Z'),
      }),
    };
    service = new CompaniesService(
      prisma,
      auth as unknown as ConstructorParameters<typeof CompaniesService>[1],
      // SPEC-018/TASK-006 — o resolvedor de logo. Aqui ele é o caso "sem
      // upload": devolve a `logo_url` como está, que é o comportamento da
      // AC-013 e o único que estas suítes exercitam.
      {
        resolver: (empresa: { logoUrl: string | null }) => ({
          logoUrl: empresa.logoUrl,
        }),
      } as unknown as ConstructorParameters<typeof CompaniesService>[2],
    );
  });

  describe('list', () => {
    it('retorna dado paginado (REQ-001)', async () => {
      (prisma.empresa.findMany as jest.Mock).mockResolvedValue([{ id: 'e1' }]);
      (prisma.empresa.count as jest.Mock).mockResolvedValue(1);

      const result = await service.list({ page: 2, pageSize: 10 });

      expect(prisma.empresa.findMany).toHaveBeenCalledWith({
        skip: 10,
        take: 10,
        orderBy: { createdAt: 'desc' },
      });
      expect(result).toEqual({
        data: [{ id: 'e1' }],
        page: 2,
        pageSize: 10,
        total: 1,
      });
    });
  });

  describe('create', () => {
    const dto = {
      nome: 'Smart Tennis',
      esportes: ['tenis'],
      adminInicial: {
        nome: 'Admin',
        email: 'admin@x.com',
        senha: 'senha-forte',
      },
    };

    // SPEC-009:TASK-000 — o slug vira parte do link público de
    // auto-cadastro (`/cadastro/<slug>`), então precisa ser derivado do
    // nome e único.
    it('deriva slug do nome, sem acento nem símbolo (SPEC-009)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.empresa.create.mockResolvedValue({ id: 'e1' });
      tx.usuario.create.mockResolvedValue({ id: 'u1' });

      await service.create({ ...dto, nome: 'Tênis Clube & Cia.' });

      expect(tx.empresa.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ slug: 'tenis-clube-cia' }),
        }),
      );
    });

    it('desempata slug quando dois nomes geram o mesmo (SPEC-009)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      // Primeira consulta acha colisão; a seguinte (com sufixo) não.
      tx.empresa.findUnique
        .mockResolvedValueOnce({ id: 'outra-empresa' })
        .mockResolvedValue(null);
      tx.empresa.create.mockResolvedValue({ id: 'e1' });
      tx.usuario.create.mockResolvedValue({ id: 'u1' });

      await service.create({ ...dto, nome: 'Tenis Clube' });

      const primeiraChamada = tx.empresa.create.mock.calls[0] as [
        { data: { slug: string } },
      ];
      const slugUsado = primeiraChamada[0].data.slug;
      expect(slugUsado).not.toBe('tenis-clube');
      expect(slugUsado).toMatch(/^tenis-clube-[a-z0-9]{4}$/);
    });

    it('rejeita nome duplicado com 409 e nunca abre transação (AC-002)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(service.create(dto)).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rejeita email do admin já cadastrado com 422 e nunca abre transação (AC-001)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue({
        id: 'existing',
      });

      await expect(service.create(dto)).rejects.toBeInstanceOf(
        UnprocessableEntityException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('cria empresa + admin numa transação e não expõe senhaHash (REQ-002, NFR-002)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.empresa.create.mockResolvedValue({
        id: 'e1',
        nome: dto.nome,
        status: 'ativa',
      });
      tx.usuario.create.mockResolvedValue({
        id: 'u1',
        nome: 'Admin',
        email: 'admin@x.com',
        senhaHash: 'hash-nunca-deveria-aparecer',
        role: 'company_admin',
        companyId: 'e1',
      });

      const result = await service.create(dto);

      expect(tx.empresa.create).toHaveBeenCalledTimes(1);
      expect(tx.usuario.create).toHaveBeenCalledTimes(1);
      expect(result.empresa).toEqual({
        id: 'e1',
        nome: dto.nome,
        status: 'ativa',
      });
      expect(result.adminUsuario).toEqual({
        id: 'u1',
        nome: 'Admin',
        email: 'admin@x.com',
        role: 'company_admin',
        companyId: 'e1',
      });
      expect(JSON.stringify(result)).not.toContain(
        'hash-nunca-deveria-aparecer',
      );
    });

    it('se a criação do admin falhar dentro da transação, a chamada inteira rejeita (rollback, NFR-002)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.empresa.create.mockResolvedValue({ id: 'e1', nome: dto.nome });
      tx.usuario.create.mockRejectedValue(new Error('falha simulada'));

      await expect(service.create(dto)).rejects.toThrow('falha simulada');
    });
  });

  describe('findOne', () => {
    it('lança 404 quando não existe', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(service.findOne('inexistente')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('retorna a empresa quando existe', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({ id: 'e1' });

      await expect(service.findOne('e1')).resolves.toEqual({ id: 'e1' });
    });
  });

  describe('update', () => {
    it('propaga 404 se a empresa não existe', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.update('e1', { nome: 'Novo nome' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('rejeita renomear para um nome já usado por outra empresa (INV-005)', async () => {
      (prisma.empresa.findUnique as jest.Mock)
        .mockResolvedValueOnce({ id: 'e1' }) // findOne
        .mockResolvedValueOnce({ id: 'e2' }); // checagem de nome duplicado

      await expect(
        service.update('e1', { nome: 'Nome de Outra Empresa' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('atualiza campos parciais (REQ-004)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'e1',
        nome: 'Antigo',
      });
      (prisma.empresa.update as jest.Mock).mockResolvedValue({
        id: 'e1',
        nome: 'Antigo',
        logoUrl: 'https://x.com/logo.png',
      });

      const result = await service.update('e1', {
        logoUrl: 'https://x.com/logo.png',
      });

      expect(prisma.empresa.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: {
          nome: undefined,
          logoUrl: 'https://x.com/logo.png',
          esportes: undefined,
        },
      });
      expect(result.logoUrl).toBe('https://x.com/logo.png');
    });
  });

  describe('updateStatus', () => {
    it('propaga 404 se a empresa não existe', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);

      await expect(
        service.updateStatus('e1', { status: 'inativa' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('inativa a empresa (REQ-005)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'ativa',
      });
      (prisma.empresa.update as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'inativa',
      });

      const result = await service.updateStatus('e1', { status: 'inativa' });

      expect(prisma.empresa.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { status: 'inativa' },
      });
      expect(result.status).toBe('inativa');
    });
  });
  // SPEC-016 — a fronteira é o ponto: MOD-002 valida escopo, MOD-001
  // escreve. Estes testes provam a delegação e o 404 que não confirma
  // existência.
  describe('gerarSenhaTemporariaDeAdmin (SPEC-016)', () => {
    beforeEach(() => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'ativa',
      });
    });

    it('delega a escrita a MOD-001 com a política de conta inativa', async () => {
      (prisma.usuario.findFirst as jest.Mock).mockResolvedValue({
        id: 'u1',
        nome: 'Gestor',
        email: 'gestor@clube.demo',
      });

      const res = await service.gerarSenhaTemporariaDeAdmin('e1', 'u1');

      expect(auth.gerarSenhaTemporariaParaUsuario).toHaveBeenCalledWith({
        usuarioId: 'u1',
        contaInativa: 'rejeitar',
      });
      expect(res.senhaTemporaria).toBe('pck-ABC234');
      expect(res.empresaInativa).toBe(false);
    });

    it('empresa inativa gera, mas avisa (AC-007)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'inativa',
      });
      (prisma.usuario.findFirst as jest.Mock).mockResolvedValue({
        id: 'u1',
        nome: 'Gestor',
        email: 'gestor@clube.demo',
      });

      const res = await service.gerarSenhaTemporariaDeAdmin('e1', 'u1');

      expect(res.empresaInativa).toBe(true);
    });

    it('usuário que não é gestor daquela empresa devolve 404, e nada é gerado', async () => {
      (prisma.usuario.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.gerarSenhaTemporariaDeAdmin('e1', 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(auth.gerarSenhaTemporariaParaUsuario).not.toHaveBeenCalled();
    });

    it('o WHERE amarra empresa e papel — não basta o id existir', async () => {
      (prisma.usuario.findFirst as jest.Mock).mockResolvedValue(null);

      await expect(
        service.gerarSenhaTemporariaDeAdmin('e1', 'u1'),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.usuario.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'u1', companyId: 'e1', role: 'company_admin' },
        }),
      );
    });
  });
});
