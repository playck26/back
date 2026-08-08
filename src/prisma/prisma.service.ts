import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';

// Conexão lazy de propósito (Prisma conecta sozinho na 1ª query) — deixa a
// aplicação subir (e expor /api/docs-json para geração de contrato,
// ADR-001) mesmo antes do Neon estar provisionado. Ver STATUS.md.
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleDestroy {
  async onModuleDestroy() {
    await this.$disconnect();
  }
}
