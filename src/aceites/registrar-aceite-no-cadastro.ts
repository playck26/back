import { ConflictException } from '@nestjs/common';
import { TERMO_VERSAO_VIGENTE } from './termo-vigente';

/**
 * SPEC-024/TASK-007 — **o aceite gravado no mesmo ato que cria a conta.**
 *
 * Mora numa função solta, e não no `AceitesService`, por uma razão prática:
 * quem a chama já está **dentro** de uma transação de outro serviço
 * (`InvitesService.aceitar`, `AuthService.registerAluno`). Injetar o serviço
 * ali significaria ou passar o `tx` para ele — quebrando o encapsulamento
 * dele — ou abrir uma segunda transação, que é exatamente o que a dúvida 2
 * da spec proíbe.
 *
 * **Por que a mesma transação:** fora dela existe uma janela em que a conta
 * está criada e o aceite não. O portão do `JwtAuthGuard` mandaria a pessoa
 * para a tela de aceite **logo depois de ela ter aceitado** — e ela veria o
 * produto pedindo duas vezes a mesma coisa no primeiro minuto de uso.
 *
 * **Versão conferida, não confiada.** O cliente manda o que leu; se não bater
 * com o vigente, é 409. Aceitar "o que estiver valendo" seria registrar
 * concordância com um texto que a pessoa não viu — e o registro perderia
 * exatamente o valor que a spec existe para criar.
 */
export interface ClienteDeTransacao {
  aceite: {
    createMany: (args: {
      data: { usuarioId: string; tipo: 'termo' | 'contrato'; versao: number }[];
      skipDuplicates?: boolean;
    }) => Promise<unknown>;
  };
  usuario: {
    update: (args: {
      where: { id: string };
      data: { termoVersaoAceita?: number; contratoVersaoAceita?: number };
    }) => Promise<unknown>;
  };
}

export async function registrarAceiteNoCadastro(
  tx: ClienteDeTransacao,
  usuarioId: string,
  dados: {
    termoLido?: number;
    contratoLido?: number;
    contratoVigente: number | null;
  },
): Promise<void> {
  const registros: {
    usuarioId: string;
    tipo: 'termo' | 'contrato';
    versao: number;
  }[] = [];
  const colunas: { termoVersaoAceita?: number; contratoVersaoAceita?: number } =
    {};

  if (dados.termoLido !== undefined) {
    if (dados.termoLido !== TERMO_VERSAO_VIGENTE) {
      throw new ConflictException({
        statusCode: 409,
        code: 'VERSAO_DESATUALIZADA',
        message:
          'O termo de uso foi atualizado. Recarregue a página para ler a versão nova.',
      });
    }
    registros.push({ usuarioId, tipo: 'termo', versao: dados.termoLido });
    colunas.termoVersaoAceita = dados.termoLido;
  }

  if (dados.contratoLido !== undefined) {
    if (dados.contratoLido !== dados.contratoVigente) {
      throw new ConflictException({
        statusCode: 409,
        code: 'VERSAO_DESATUALIZADA',
        message:
          'O contrato do clube foi atualizado. Recarregue a página para ler a versão nova.',
      });
    }
    registros.push({ usuarioId, tipo: 'contrato', versao: dados.contratoLido });
    colunas.contratoVersaoAceita = dados.contratoLido;
  }

  // Cliente antigo (ou caminho que ainda não manda as versões) simplesmente
  // não registra nada — e o portão pega a pessoa no primeiro acesso. É um
  // degrau a mais para ela, nunca um furo: ninguém entra sem aceitar.
  if (registros.length === 0) {
    return;
  }

  await tx.aceite.createMany({ data: registros, skipDuplicates: true });
  await tx.usuario.update({ where: { id: usuarioId }, data: colunas });
}
