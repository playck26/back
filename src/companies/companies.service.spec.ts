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
  empresa: { create: jest.Mock; findUnique: jest.Mock; update: jest.Mock };
  usuario: { create: jest.Mock };
  // SPEC-010: empresa nova nasce com o horário padrão dos 7 dias.
  horarioFuncionamento: { createMany: jest.Mock };
  // SPEC-020/TASK-008: editar a empresa sincroniza o catálogo de esportes,
  // e a sincronização precisa saber o que já existe e o que está em uso.
  esporteDeQuadra: {
    findMany: jest.Mock;
    create: jest.Mock;
    deleteMany: jest.Mock;
  };
  quadra: { findMany: jest.Mock };
}

/**
 * SPEC-020/TASK-008 — **toda empresa que sai do serviço passa por
 * `comEsportes`**, que lê a relação `esportesQuadra`.
 *
 * O serviço NÃO tolera a relação ausente, de propósito: tolerar esconderia
 * exatamente o defeito de esquecer o `include` numa consulta nova, e o
 * sintoma apareceria em produção como `esportes: []` — uma lista vazia que
 * parece dado, não erro.
 */
const SEM_CATALOGO = { esportesQuadra: [] as { nome: string }[] };

function buildPrismaMock() {
  const tx: TxMock = {
    // Padrão: nenhum slug colidindo. Um teste específico sobrescreve para
    // provar o caminho de colisão.
    empresa: {
      create: jest.fn(),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue(SEM_CATALOGO),
    },
    usuario: { create: jest.fn() },
    // SPEC-010: empresa nova nasce com o horário padrão dos 7 dias, na
    // mesma transação.
    horarioFuncionamento: {
      createMany: jest.fn().mockResolvedValue({ count: 7 }),
    },
    // SPEC-020/TASK-008 — o padrão é "empresa sem catálogo nenhum": quem
    // testa remoção ou uso sobrescreve. Deixar o padrão vazio faz o caminho
    // de adicionar ser o exercitado por omissão, que é o mais comum.
    esporteDeQuadra: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(),
      deleteMany: jest.fn(),
    },
    quadra: { findMany: jest.fn().mockResolvedValue([]) },
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
      (prisma.empresa.findMany as jest.Mock).mockResolvedValue([
        { id: 'e1', ...SEM_CATALOGO },
      ]);
      (prisma.empresa.count as jest.Mock).mockResolvedValue(1);

      const result = await service.list({ page: 2, pageSize: 10 });

      expect(prisma.empresa.findMany).toHaveBeenCalledWith({
        skip: 10,
        take: 10,
        orderBy: { createdAt: 'desc' },
        // SPEC-020/TASK-008 — a consulta traz o catálogo junto. Fixar a forma
        // aqui é o que impede alguém remover o `include` e a resposta virar
        // `esportes: []` sem nenhum teste reclamar — uma lista vazia parece
        // dado, não erro.
        include: {
          esportesQuadra: { select: { nome: true }, orderBy: { ordem: 'asc' } },
        },
      });
      expect(result).toEqual({
        // SPEC-020/TASK-008 — `esportes` sai do catálogo, e a relação
        // `esportesQuadra` NÃO aparece: mandá-la junto criaria duas fontes
        // para a mesma pergunta, que é o que a INV-057 desfaz.
        data: [{ id: 'e1', esportes: [] }],
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
      tx.empresa.create.mockResolvedValue({ id: 'e1', ...SEM_CATALOGO });
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
      tx.empresa.create.mockResolvedValue({ id: 'e1', ...SEM_CATALOGO });
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
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        ...SEM_CATALOGO,
      });

      await expect(service.findOne('e1')).resolves.toEqual({
        id: 'e1',
        // Catálogo vazio vira lista vazia — e a relação NÃO vaza na resposta.
        esportes: [],
      });
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
        .mockResolvedValueOnce({ id: 'e1', ...SEM_CATALOGO }) // findOne
        .mockResolvedValueOnce({ id: 'e2' }); // checagem de nome duplicado

      await expect(
        service.update('e1', { nome: 'Nome de Outra Empresa' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('atualiza campos parciais (REQ-004)', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValueOnce({
        id: 'e1',
        nome: 'Antigo',
        ...SEM_CATALOGO,
      });
      tx.empresa.update.mockResolvedValue({
        id: 'e1',
        nome: 'Antigo',
        logoUrl: 'https://x.com/logo.png',
        ...SEM_CATALOGO,
      });

      const result = await service.update('e1', {
        logoUrl: 'https://x.com/logo.png',
      });

      // SPEC-020/TASK-008 — a escrita passou para DENTRO da transação, porque
      // sincronizar o catálogo e gravar a coluna precisam acontecer juntos ou
      // não acontecer.
      expect(tx.empresa.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: {
          nome: undefined,
          logoUrl: 'https://x.com/logo.png',
          esportes: undefined,
        },
        include: {
          esportesQuadra: { select: { nome: true }, orderBy: { ordem: 'asc' } },
        },
      });
      // `esportes` ausente no dto NÃO mexe no catálogo: editar só a logo não
      // pode apagar a lista de esportes do clube.
      expect(tx.esporteDeQuadra.deleteMany).not.toHaveBeenCalled();
      expect(tx.esporteDeQuadra.create).not.toHaveBeenCalled();
      expect(result.logoUrl).toBe('https://x.com/logo.png');
    });
  });

  /**
   * SPEC-020/TASK-008 — o campo "Esportes" do SAdmin passa a semear e
   * sincronizar o **catálogo**, não só uma coluna que ninguém consulta.
   *
   * Antes disto, um clube nascia com `empresas.esportes` preenchido e o
   * catálogo vazio: o gestor tinha de cadastrar tudo de novo em
   * `/quadras/catalogos`, e o campo do SAdmin parecia funcionar sem fazer
   * nada. Duas listas que não se falam é o que a INV-057 condena.
   */
  /**
   * INV-037 — a chave crua de mídia nunca chega ao cliente.
   *
   * **Estes testes nasceram de uma sabotagem que PASSOU.** Ao provar a
   * TASK-008 eu troquei o retorno de `update` pela linha crua do Prisma, e
   * nenhum teste reclamou — e era esse exatamente o estado do código: `list`
   * e `findOne` removiam `logoKey`, `update` e `updateStatus` devolviam a
   * linha inteira.
   *
   * Invariante cumprida em dois lugares e esquecida no terceiro é a forma
   * mais comum de ela morrer, e a única defesa é o teste perguntar pelo
   * **ausente**, não pelo presente.
   */
  describe('INV-037 — logoKey não sai na resposta', () => {
    it('update não devolve logoKey', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        ...SEM_CATALOGO,
      });
      tx.empresa.update.mockResolvedValue({
        id: 'e1',
        logoKey: 'c1/empresa/logo.webp',
        logoUrl: null,
        ...SEM_CATALOGO,
      });

      const result = await service.update('e1', { nome: 'Novo' });

      expect(result).not.toHaveProperty('logoKey');
    });

    it('updateStatus não devolve logoKey', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'ativa',
        ...SEM_CATALOGO,
      });
      (prisma.empresa.update as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'inativa',
        logoKey: 'c1/empresa/logo.webp',
        logoUrl: null,
        ...SEM_CATALOGO,
      });

      const result = await service.updateStatus('e1', { status: 'inativa' });

      expect(result).not.toHaveProperty('logoKey');
    });

    it('findOne e list também não — a invariante vale nos quatro', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        logoKey: 'c1/empresa/logo.webp',
        logoUrl: null,
        ...SEM_CATALOGO,
      });
      (prisma.empresa.findMany as jest.Mock).mockResolvedValue([
        {
          id: 'e1',
          logoKey: 'c1/empresa/logo.webp',
          logoUrl: null,
          ...SEM_CATALOGO,
        },
      ]);
      (prisma.empresa.count as jest.Mock).mockResolvedValue(1);

      expect(await service.findOne('e1')).not.toHaveProperty('logoKey');
      const lista = await service.list({});
      expect(lista.data[0]).not.toHaveProperty('logoKey');
    });
  });

  describe('catálogo de esportes (SPEC-020/TASK-008)', () => {
    const dtoBase = {
      nome: 'Clube Novo',
      adminInicial: {
        nome: 'Admin',
        email: 'admin@x.com',
        senha: 'senha-forte',
      },
    };

    function prontoParaCriar() {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue(null);
      (prisma.usuario.findUnique as jest.Mock).mockResolvedValue(null);
      tx.empresa.create.mockResolvedValue({ id: 'e1', ...SEM_CATALOGO });
      tx.usuario.create.mockResolvedValue({ id: 'u1' });
    }

    function esportesCriadosNaEmpresa(): { nome: string; ordem: number }[] {
      const chamada = tx.empresa.create.mock.calls[0] as [
        {
          data: {
            esportesQuadra: { create: { nome: string; ordem: number }[] };
          };
        },
      ];
      return chamada[0].data.esportesQuadra.create;
    }

    it('criar empresa semeia o catálogo com os esportes digitados', async () => {
      prontoParaCriar();

      await service.create({ ...dtoBase, esportes: ['Tênis', 'Padel'] });

      expect(esportesCriadosNaEmpresa()).toEqual([
        { nome: 'Tênis', ordem: 0 },
        { nome: 'Padel', ordem: 1 },
      ]);
    });

    // **Este teste inverteu na TASK-004.** Entre a 008 e a 004 ele afirmava
    // o contrário: que a coluna `empresas.esportes` CONTINUAVA sendo escrita,
    // porque a escrita dupla era o que permitia as duas fases conviverem.
    // A contract derrubou a coluna, e o teste passou a provar a ausência.
    it('a coluna antiga NÃO é mais escrita — ela não existe (TASK-004)', async () => {
      prontoParaCriar();

      await service.create({ ...dtoBase, esportes: ['Tênis'] });

      const chamada = tx.empresa.create.mock.calls[0] as [
        { data: Record<string, unknown> },
      ];
      // Perguntar pelo AUSENTE é o ponto: se alguém reintroduzir a escrita,
      // o Prisma falharia em produção com "Unknown argument `esportes`" — um
      // erro que só aparece contra banco real, e este teste não usa banco.
      expect(chamada[0].data).not.toHaveProperty('esportes');
    });

    it('"Tenis, tenis " vira UMA opção, e vence a primeira grafia', async () => {
      // Não é zelo: o catálogo tem UNIQUE por nome sem distinguir maiúscula, e
      // o duplicado derrubaria a transação inteira — que leva junto o admin
      // inicial e os 7 horários. O clube não nasceria por causa de uma vírgula.
      prontoParaCriar();

      await service.create({
        ...dtoBase,
        esportes: ['Tenis', 'tenis ', '  ', 'Padel'],
      });

      expect(esportesCriadosNaEmpresa()).toEqual([
        { nome: 'Tenis', ordem: 0 },
        { nome: 'Padel', ordem: 1 },
      ]);
    });

    it('editar acrescenta o esporte novo sem tocar nos que já existem', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        ...SEM_CATALOGO,
      });
      tx.esporteDeQuadra.findMany.mockResolvedValue([
        { id: 's1', nome: 'Tênis' },
      ]);

      await service.update('e1', { esportes: ['Tênis', 'Padel'] });

      expect(tx.esporteDeQuadra.create).toHaveBeenCalledTimes(1);
      expect(tx.esporteDeQuadra.create).toHaveBeenCalledWith({
        data: { companyId: 'e1', nome: 'Padel', ordem: 1 },
      });
      expect(tx.esporteDeQuadra.deleteMany).not.toHaveBeenCalled();
    });

    it('editar apaga o esporte que saiu da lista, se ninguém usa', async () => {
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        ...SEM_CATALOGO,
      });
      tx.esporteDeQuadra.findMany.mockResolvedValue([
        { id: 's1', nome: 'Tênis' },
        { id: 's2', nome: 'Padel' },
      ]);
      tx.quadra.findMany.mockResolvedValue([]);

      await service.update('e1', { esportes: ['Tênis'] });

      expect(tx.esporteDeQuadra.deleteMany).toHaveBeenCalledWith({
        where: { id: { in: ['s2'] } },
      });
    });

    it('INV-055 — editar NÃO apaga esporte em uso: 422 e nada removido', async () => {
      // A rota `DELETE /court-sports/:id` já recusa isto. Se editar a empresa
      // apagasse em silêncio, existiriam dois caminhos para a mesma ação com
      // regras diferentes — e o sem guarda seria o mais fácil de alcançar.
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        ...SEM_CATALOGO,
      });
      tx.esporteDeQuadra.findMany.mockResolvedValue([
        { id: 's1', nome: 'Tênis' },
        { id: 's2', nome: 'Padel' },
      ]);
      tx.quadra.findMany.mockResolvedValue([{ esporteId: 's2' }]);

      await expect(
        service.update('e1', { esportes: ['Tênis'] }),
      ).rejects.toBeInstanceOf(UnprocessableEntityException);

      expect(tx.esporteDeQuadra.deleteMany).not.toHaveBeenCalled();
      expect(tx.empresa.update).not.toHaveBeenCalled();
    });

    it('o 422 NOMEIA o esporte que impede, não só o código', async () => {
      // Sem o nome, o super admin vê "esporte em uso" com quatro esportes na
      // tela e não sabe qual devolver ao campo.
      (prisma.empresa.findUnique as jest.Mock).mockResolvedValue({
        id: 'e1',
        ...SEM_CATALOGO,
      });
      tx.esporteDeQuadra.findMany.mockResolvedValue([
        { id: 's1', nome: 'Tênis' },
        { id: 's2', nome: 'Padel' },
        { id: 's3', nome: 'Beach Tennis' },
      ]);
      tx.quadra.findMany.mockResolvedValue([{ esporteId: 's3' }]);

      await expect(
        service.update('e1', { esportes: ['Tênis'] }),
      ).rejects.toMatchObject({
        response: {
          code: 'ESPORTE_EM_USO',
          esportes: ['Beach Tennis'],
        },
      });
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
        ...SEM_CATALOGO,
      });
      (prisma.empresa.update as jest.Mock).mockResolvedValue({
        id: 'e1',
        status: 'inativa',
        ...SEM_CATALOGO,
      });

      const result = await service.updateStatus('e1', { status: 'inativa' });

      expect(prisma.empresa.update).toHaveBeenCalledWith({
        where: { id: 'e1' },
        data: { status: 'inativa' },
        include: {
          esportesQuadra: { select: { nome: true }, orderBy: { ordem: 'asc' } },
        },
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
        ...SEM_CATALOGO,
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
        ...SEM_CATALOGO,
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
