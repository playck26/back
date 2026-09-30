import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { registrarPoolDoBanco } from './pool-do-banco';

// Conexão lazy de propósito (Prisma conecta sozinho na 1ª query) — deixa a
// aplicação subir (e expor /api/docs-json para geração de contrato,
// ADR-001) mesmo antes do Neon estar provisionado. Ver STATUS.md.
@Injectable()
export class PrismaService
  extends PrismaClient
  implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  // SPEC-081/D3 — registra na subida o pool efetivo, sem conectar e sem
  // nada da URL além dos dois números.
  onModuleInit() {
    registrarPoolDoBanco(process.env.DATABASE_URL, this.logger);
  }

  async onModuleDestroy() {
    await this.$disconnect();
  }
}
