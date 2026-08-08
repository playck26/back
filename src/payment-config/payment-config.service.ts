import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { UpdatePaymentConfigDto } from './dto/update-payment-config.dto';

export interface PaymentConfigResponse {
  companyId: string;
  linkPagamentoUrl: string | null;
  whatsappNumero: string | null;
}

@Injectable()
export class PaymentConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async get(companyId: string): Promise<PaymentConfigResponse> {
    const config = await this.prisma.configPagamentoEmpresa.findUnique({
      where: { companyId },
    });
    return this.toResponse(companyId, config);
  }

  // PUT (CON-006.1): substitui o recurso inteiro — campo omitido no corpo
  // vira `null` (semântica de PUT, não PATCH parcial). Upsert porque a
  // linha pode não existir ainda (empresa nunca configurou pagamento).
  async update(
    companyId: string,
    dto: UpdatePaymentConfigDto,
  ): Promise<PaymentConfigResponse> {
    const data = {
      linkPagamentoUrl: dto.linkPagamentoUrl ?? null,
      whatsappNumero: dto.whatsappNumero ?? null,
    };
    const config = await this.prisma.configPagamentoEmpresa.upsert({
      where: { companyId },
      update: data,
      create: { companyId, ...data },
    });
    return this.toResponse(companyId, config);
  }

  // CON-006.2, NFR-001: endpoint público (role `aluno`) só devolve o que
  // é necessário para pagar — nunca `id`/timestamps ou qualquer outro
  // dado administrativo, mesmo que esta tabela hoje só tenha esses dois
  // campos de configuração.
  async getPublic(
    companyId: string,
  ): Promise<Omit<PaymentConfigResponse, 'companyId'>> {
    const config = await this.prisma.configPagamentoEmpresa.findUnique({
      where: { companyId },
    });
    return {
      linkPagamentoUrl: config?.linkPagamentoUrl ?? null,
      whatsappNumero: config?.whatsappNumero ?? null,
    };
  }

  private toResponse(
    companyId: string,
    config: {
      linkPagamentoUrl: string | null;
      whatsappNumero: string | null;
    } | null,
  ): PaymentConfigResponse {
    return {
      companyId,
      linkPagamentoUrl: config?.linkPagamentoUrl ?? null,
      whatsappNumero: config?.whatsappNumero ?? null,
    };
  }
}
