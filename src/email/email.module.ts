import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  carregarEmailConfig,
  CONFIGURACAO_DE_EMAIL,
  CONFIGURACAO_DOS_MODELOS,
  registrarEmailNoBoot,
  type ConfiguracaoDeEmail,
  type ConfiguracaoDosModelos,
} from './email.config';
import { MemoriaProvedorDeEmail } from './memoria-provedor-de-email';
import { PROVEDOR_DE_EMAIL, type ProvedorDeEmail } from './provedor-de-email';
import { ResendProvedorDeEmail } from './resend-provedor-de-email';

/**
 * SPEC-083/D12 — MOD-015 (Email): porta, adaptadores e modelos. Sem controller
 * e sem tabela; quem grava o resultado do envio é o `AcessoModule`.
 *
 * Os provedores são fábricas pela razão do `StorageModule`: a configuração é
 * validada quando o app sobe, e não quando o primeiro convite sai (AC-030).
 */
@Module({
  providers: [
    {
      provide: CONFIGURACAO_DE_EMAIL,
      inject: [ConfigService],
      useFactory: (config: ConfigService): ConfiguracaoDeEmail => {
        const email = carregarEmailConfig(config);
        registrarEmailNoBoot(email, new Logger('Email'));
        return email;
      },
    },
    {
      // Um objeto novo, e não a configuração inteira com outro tipo: o tipo
      // some na execução, e `chaveDoResend` iria junto para quem injetasse.
      provide: CONFIGURACAO_DOS_MODELOS,
      inject: [CONFIGURACAO_DE_EMAIL],
      useFactory: (email: ConfiguracaoDeEmail): ConfiguracaoDosModelos => ({
        remetente: email.remetente,
        responderPara: email.responderPara,
        urlCliente: email.urlCliente,
      }),
    },
    {
      provide: PROVEDOR_DE_EMAIL,
      inject: [CONFIGURACAO_DE_EMAIL],
      useFactory: (email: ConfiguracaoDeEmail): ProvedorDeEmail =>
        email.provedor === 'resend'
          ? ResendProvedorDeEmail.comChave(email.chaveDoResend)
          : new MemoriaProvedorDeEmail(),
    },
  ],
  // **Exporta a porta e a configuração sem segredo.** `CONFIGURACAO_DE_EMAIL`
  // carrega a chave da Resend e fica aqui dentro, como o `STORAGE_CONFIG`.
  exports: [PROVEDOR_DE_EMAIL, CONFIGURACAO_DOS_MODELOS],
})
export class EmailModule {}
