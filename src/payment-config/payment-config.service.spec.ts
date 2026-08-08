import { PrismaService } from '../prisma/prisma.service';
import { PaymentConfigService } from './payment-config.service';

// TEST-006 (SPEC-006): unit tests de MOD-006 com Prisma mockado.

function buildPrismaMock() {
  return {
    configPagamentoEmpresa: {
      findUnique: jest.fn(),
      upsert: jest.fn(),
    },
  } as unknown as PrismaService;
}

describe('PaymentConfigService', () => {
  let prisma: PrismaService;
  let service: PaymentConfigService;

  beforeEach(() => {
    prisma = buildPrismaMock();
    service = new PaymentConfigService(prisma);
  });

  describe('get', () => {
    it('retorna nulls quando a empresa nunca configurou (REQ-001)', async () => {
      (prisma.configPagamentoEmpresa.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.get('c1');

      expect(result).toEqual({
        companyId: 'c1',
        linkPagamentoUrl: null,
        whatsappNumero: null,
      });
    });

    it('retorna a config existente escopada à empresa', async () => {
      (prisma.configPagamentoEmpresa.findUnique as jest.Mock).mockResolvedValue(
        {
          linkPagamentoUrl: 'https://pay.example.com/x',
          whatsappNumero: '+5511999999999',
        },
      );

      const result = await service.get('c1');

      expect(prisma.configPagamentoEmpresa.findUnique).toHaveBeenCalledWith({
        where: { companyId: 'c1' },
      });
      expect(result.linkPagamentoUrl).toBe('https://pay.example.com/x');
      expect(result.whatsappNumero).toBe('+5511999999999');
    });
  });

  describe('update', () => {
    it('faz upsert com os campos informados, escopado à empresa (REQ-001)', async () => {
      (prisma.configPagamentoEmpresa.upsert as jest.Mock).mockResolvedValue({
        linkPagamentoUrl: 'https://pay.example.com/x',
        whatsappNumero: null,
      });

      await service.update('c1', {
        linkPagamentoUrl: 'https://pay.example.com/x',
      });

      expect(prisma.configPagamentoEmpresa.upsert).toHaveBeenCalledWith({
        where: { companyId: 'c1' },
        update: {
          linkPagamentoUrl: 'https://pay.example.com/x',
          whatsappNumero: null,
        },
        create: {
          companyId: 'c1',
          linkPagamentoUrl: 'https://pay.example.com/x',
          whatsappNumero: null,
        },
      });
    });

    it('campo omitido no corpo vira null (semântica de PUT)', async () => {
      (prisma.configPagamentoEmpresa.upsert as jest.Mock).mockResolvedValue({
        linkPagamentoUrl: null,
        whatsappNumero: '+5511999999999',
      });

      await service.update('c1', { whatsappNumero: '+5511999999999' });

      expect(prisma.configPagamentoEmpresa.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          update: { linkPagamentoUrl: null, whatsappNumero: '+5511999999999' },
        }),
      );
    });
  });

  describe('getPublic', () => {
    it('não vaza companyId nem dado administrativo (NFR-001)', async () => {
      (prisma.configPagamentoEmpresa.findUnique as jest.Mock).mockResolvedValue(
        {
          linkPagamentoUrl: 'https://pay.example.com/x',
          whatsappNumero: '+5511999999999',
        },
      );

      const result = await service.getPublic('c1');

      expect(result).toEqual({
        linkPagamentoUrl: 'https://pay.example.com/x',
        whatsappNumero: '+5511999999999',
      });
      expect(Object.keys(result)).not.toContain('companyId');
    });

    it('retorna nulls quando não configurado, sem 404 (aluno só vê o que existe)', async () => {
      (prisma.configPagamentoEmpresa.findUnique as jest.Mock).mockResolvedValue(
        null,
      );

      const result = await service.getPublic('c1');

      expect(result).toEqual({ linkPagamentoUrl: null, whatsappNumero: null });
    });
  });
});
