import { Module } from '@nestjs/common';
import { CreditosAdminService } from './creditos-admin.service';
import { CreditosController } from './creditos.controller';
import { CreditosDoAlunoService } from './creditos-do-aluno.service';
import { MeCreditosController } from './me-creditos.controller';
import { CreditosService } from './creditos.service';

/**
 * SPEC-033 — MOD-011, a carteira.
 *
 * `CreditosService` sai do módulo porque **quem consome crédito não é este
 * módulo**: a criação de reserva e o cancelamento debitam e devolvem
 * (TASK-005). `CreditosAdminService` não sai — o caso de uso administrativo
 * tem uma porta só, que é o controller daqui.
 */
@Module({
  controllers: [CreditosController, MeCreditosController],
  providers: [CreditosService, CreditosAdminService, CreditosDoAlunoService],
  exports: [CreditosService],
})
export class CreditosModule {}
