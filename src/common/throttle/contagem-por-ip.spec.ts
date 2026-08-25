import { AuthController } from '../../auth/auth.controller';
import { PublicInvitesController } from '../../auth/invites.controller';
import { PublicCompaniesController } from '../../companies/public-companies.controller';
import {
  CONTAGEM_POR_IP,
  ContagemPorIp,
  LimiteDeLogin,
  LimitePublico,
  LOGIN_THROTTLE,
  PUBLICO_THROTTLE,
} from './contagem-por-ip';

// SPEC-017/TASK-006, 4ª validação cruzada.
//
// **Identidade só pode estreitar o limite, nunca comprar um limite novo.**
// Sem isso, um atacante com auto-cadastro criaria contas e cada token lhe
// daria um balde novo de 10 tentativas de login.

/** Lê a marca como o guard lê: do handler. */
function marcado(alvo: object): boolean {
  return Reflect.getMetadata(CONTAGEM_POR_IP, alvo) === true;
}

describe('ContagemPorIp', () => {
  it('marca o alvo', () => {
    class Alvo {
      @ContagemPorIp()
      metodo() {}
    }
    expect(marcado(Alvo.prototype.metodo)).toBe(true);
  });

  it('quem não é marcado não herda a marca', () => {
    class Alvo {
      metodo() {}
    }
    expect(marcado(Alvo.prototype.metodo)).toBe(false);
  });

  describe('as fábricas trazem as duas metades juntas', () => {
    // Separar `@Throttle` da contagem por IP seria questão de tempo até
    // alguém aplicar uma sem a outra — que é literalmente o defeito desta
    // rodada. Mesmo raciocínio da INV-048 no `@UploadDeMidia()`.
    it('LimiteDeLogin marca por IP', () => {
      class Alvo {
        @LimiteDeLogin()
        metodo() {}
      }
      expect(marcado(Alvo.prototype.metodo)).toBe(true);
    });

    it('LimitePublico marca por IP', () => {
      class Alvo {
        @LimitePublico()
        metodo() {}
      }
      expect(marcado(Alvo.prototype.metodo)).toBe(true);
    });
  });

  it('NFR-002: 10 tentativas / 15 min — números congelados', () => {
    expect(LOGIN_THROTTLE.default).toEqual({ limit: 10, ttl: 900_000 });
    expect(PUBLICO_THROTTLE.default).toEqual({ limit: 10, ttl: 900_000 });
  });

  describe('as rotas REAIS que não podem contar por usuário', () => {
    // Esta é a prova que sobrevive ao refactor: não testa a fábrica, testa
    // **os handlers que estão no ar**. Uma rota pública nova que esqueça a
    // marca não aparece aqui — por isso a lista vem com a razão de cada
    // uma, para quem adicionar a próxima saber que precisa entrar.
    it.each([
      ['login — adivinhação de senha', AuthController.prototype.login],
      [
        'aceitar-convite — enumeração de token',
        AuthController.prototype.aceitarConvite,
      ],
      [
        'register-aluno — criação de conta em massa',
        AuthController.prototype.registerAluno,
      ],
      [
        'consulta pública de convite',
        PublicInvitesController.prototype.consultar,
      ],
      [
        'vitrine da empresa por slug',
        PublicCompaniesController.prototype.porSlug,
      ],
    ])('%s conta por IP', (_razao, handler) => {
      expect(marcado(handler)).toBe(true);
    });
  });
});
