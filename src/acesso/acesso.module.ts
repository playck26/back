import { Module } from '@nestjs/common';
import { EmailModule } from '../email/email.module';
import { AcessoService } from './acesso.service';
import { AtivacaoPublicaController } from './ativacao-publica.controller';

/**
 * SPEC-083/D12 — o `AcessoModule` (dados de MOD-001): `convites_de_acesso`,
 * emitir, consultar, ativar e a situação.
 *
 * **A direção das setas é a decisão.** O `PeopleModule` importa este (a ficha
 * do aluno e a do professor emitem convite), e este **não** importa o
 * `PeopleModule`: o `AuthModule` já importa o `PeopleModule`, e o convite
 * dentro de um dos dois fecharia um ciclo. O `PrismaModule` é global.
 */
@Module({
  imports: [EmailModule],
  // As rotas públicas do link moram aqui, e não no `AuthModule`: quem chama é
  // quem recebeu o e-mail, e o serviço é este.
  controllers: [AtivacaoPublicaController],
  providers: [AcessoService],
  exports: [AcessoService],
})
export class AcessoModule {}
