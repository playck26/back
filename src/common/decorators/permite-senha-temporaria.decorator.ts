import { SetMetadata } from '@nestjs/common';

export const PERMITE_SENHA_TEMPORARIA = 'permiteSenhaTemporaria';

/**
 * SPEC-009/INV-008 — marca as poucas rotas que uma conta com senha
 * temporária ainda pode usar: trocar a senha (o que ela precisa fazer),
 * `/auth/me` (o frontend precisa saber que está nesse estado para
 * redirecionar) e logout (ninguém fica preso numa sessão).
 *
 * A lista é uma **exceção declarada por rota**, não um filtro de caminho:
 * rota nova nasce bloqueada por padrão e só entra na exceção quem escrever
 * este decorator de propósito.
 */
export const PermiteSenhaTemporaria = () =>
  SetMetadata(PERMITE_SENHA_TEMPORARIA, true);
