import { Module } from '@nestjs/common';
import { CreditosService } from './creditos.service';

/**
 * SPEC-033 — MOD-011, a carteira.
 *
 * O serviço sai do módulo porque **quem consome crédito não é este módulo**:
 * a criação de reserva (`CourtsService`) e o cancelamento debitam e devolvem,
 * e a rota administrativa da TASK-004 lança e retira. O módulo existe para
 * dar um dono ao serviço, não para guardá-lo.
 */
@Module({
  providers: [CreditosService],
  exports: [CreditosService],
})
export class CreditosModule {}
