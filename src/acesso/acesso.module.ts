import { Module } from '@nestjs/common';
import { LogoDaEmpresaService } from '../companies/logo-da-empresa.service';
import { EmailModule } from '../email/email.module';
import { StorageModule } from '../storage/storage.module';
import { AcessoService } from './acesso.service';
import { AtivacaoPublicaController } from './ativacao-publica.controller';
import {
  EsqueciSenhaController,
  RedefinicaoPublicaController,
} from './redefinicao-publica.controller';
import { RedefinicaoService } from './redefinicao.service';

/**
 * SPEC-083/D12 — o `AcessoModule` (dados de MOD-001): `convites_de_acesso`,
 * emitir, consultar, ativar e a situação. SPEC-090 — e o "esqueci minha
 * senha": `pedidos_de_redefinicao`, `contas_da_redefinicao` e as três rotas.
 *
 * **A direção das setas é a decisão.** O `PeopleModule` importa este (a ficha
 * do aluno e a do professor emitem convite), e este **não** importa o
 * `PeopleModule`: o `AuthModule` já importa o `PeopleModule`, e o convite
 * dentro de um dos dois fecharia um ciclo. Pela mesma razão o
 * `POST /auth/esqueci-senha` é servido daqui, e não do `AuthModule`. O
 * `PrismaModule` é global.
 */
@Module({
  // SPEC-090 — o `StorageModule` entra pela logo de cada clube na página do
  // link (`LogoDaEmpresaService`, D4). Ele não importa nada deste lado, então
  // não há ciclo.
  imports: [EmailModule, StorageModule],
  // As rotas públicas do link moram aqui, e não no `AuthModule`: quem chama é
  // quem recebeu o e-mail, e o serviço é este.
  controllers: [
    AtivacaoPublicaController,
    EsqueciSenhaController,
    RedefinicaoPublicaController,
  ],
  providers: [
    AcessoService,
    RedefinicaoService,
    // SPEC-090/D4 — registrado aqui como no `AuthModule` (SPEC-086): as
    // dependências vêm do `StorageModule`, e importar o `CompaniesModule`
    // fecharia um ciclo.
    LogoDaEmpresaService,
  ],
  exports: [AcessoService],
})
export class AcessoModule {}
