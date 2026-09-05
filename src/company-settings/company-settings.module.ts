import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { ConfigOperacaoService } from './config-operacao.service';

/**
 * SPEC-031/TASK-003 — o serviço da configuração de operação, num módulo
 * próprio porque **dois módulos o consomem**: `courts` (a rota do gestor, que
 * é onde `CompanySettingsController` já mora) e `companies` (a rota de
 * capability do aluno).
 *
 * Registrar o mesmo `@Injectable` em dois `providers` daria duas instâncias e
 * funcionaria por acidente — o serviço é sem estado hoje. Exportar de um
 * módulo é o que mantém isso verdadeiro quando deixar de ser.
 */
@Module({
  imports: [PrismaModule],
  providers: [ConfigOperacaoService],
  exports: [ConfigOperacaoService],
})
export class CompanySettingsModule {}
