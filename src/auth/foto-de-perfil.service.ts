import {
  ForbiddenException,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { montarChave } from '../storage/chave-de-midia';
import { FilaDeExclusao } from '../storage/fila-de-exclusao.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/storage-provider.interface';
import { StorageService } from '../storage/storage.service';
import { validarWebp } from '../storage/webp.validator';
import { Inject } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SPEC-018/TASK-003 — a foto de perfil de quem tem conta.
 *
 * **Primeira mídia do produto.** Tudo aqui usa a fundação da SPEC-017 sem
 * reimplementar nada: o validador, a gramática da chave, o `StorageService`
 * e a fila de exclusão. Nenhuma linha deste arquivo fala com o Spaces
 * diretamente para **ler** — só o `provider.gravar` aparece, e é o único
 * caminho de escrita que a spec prevê (INV-040).
 */

/** AC-022 — quem não tem empresa não tem foto, e o motivo é a gramática. */
export const PERFIL_SEM_EMPRESA = {
  statusCode: 403,
  code: 'PERFIL_SEM_EMPRESA',
  message: 'Contas sem empresa não têm foto de perfil.',
} as const;

export const TIPO_DE_MIDIA_DESCONHECIDO = {
  statusCode: 422,
  code: 'TIPO_DE_MIDIA_DESCONHECIDO',
  message: 'Não foi possível montar a chave da imagem.',
} as const;

export const MOTIVO_TROCA = 'foto_de_perfil_trocada';
export const MOTIVO_REMOCAO = 'foto_de_perfil_removida';

export interface FotoDePerfil {
  /** `null` quando não há foto — não é erro, é o estado normal. */
  readonly url: string | null;
}

@Injectable()
export class FotoDePerfilService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fila: FilaDeExclusao,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  async ler(usuarioId: string): Promise<FotoDePerfil> {
    const usuario = await this.carregar(usuarioId);
    if (usuario.fotoKey === null) {
      return { url: null };
    }
    // A chave vem do banco e é tratada como **não confiável**: o
    // `StorageService` reconfere contra `companyId` e `usuarioId` antes de
    // assinar (INV-037). É a camada que pega chave adulterada, que nem o
    // prefixo nem o escopo por token pegariam — os dois leem o mesmo token.
    const url = await this.storage.urlDeLeitura({
      key: usuario.fotoKey,
      companyId: this.exigirEmpresa(usuario.companyId),
      tipo: 'perfil',
      recursoId: usuarioId,
    });
    return { url };
  }

  async substituir(usuarioId: string, corpo: Buffer): Promise<FotoDePerfil> {
    const usuario = await this.carregar(usuarioId);
    // AC-022 — **antes** de validar, de hashear e de tocar o storage. Fazer
    // isto depois gastaria banda e CPU num pedido que já se sabe recusado,
    // e — pior — deixaria o caminho passar perto de um `INSERT` que a
    // constraint recusaria, virando 500 em vez de 403.
    const companyId = this.exigirEmpresa(usuario.companyId);

    const validacao = validarWebp(corpo);
    if (!validacao.valido) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: validacao.codigo,
        message: validacao.motivo,
      });
    }

    // A chave é o CONTEÚDO (SPEC-017/AC-007): reenviar a mesma foto produz
    // a mesma chave, e é o que torna o retry inofensivo.
    const sha256 = createHash('sha256').update(corpo).digest('hex');
    const key = montarChave({
      companyId,
      tipo: 'perfil',
      recursoId: usuarioId,
      sha256,
    });
    if (key === null) {
      throw new UnprocessableEntityException(TIPO_DE_MIDIA_DESCONHECIDO);
    }

    // **Storage primeiro, banco depois, e a ordem não é indiferente.**
    // Se o banco falhar depois desta linha, sobra um objeto sem referência —
    // que a LIM-002 já declara não ser alcançável pela cascata, e que ninguém
    // vê. Na ordem inversa, uma falha do storage deixaria a coluna apontando
    // para objeto inexistente: imagem quebrada na tela de quem acabou de
    // subir. Órfão invisível é melhor que referência mentirosa.
    await this.provider.gravar({
      key,
      corpo,
      contentType: 'image/webp',
      // Do TIPO, nunca do chamador: é assim que foto de pessoa não vira URL
      // permanente de CDN.
      visibilidade: this.storage.visibilidadeDoTipo('perfil'),
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuarioId },
        data: { fotoKey: key },
      });
      // Na MESMA transação: enfileirar fora dela deixaria a janela em que a
      // troca foi gravada e a chave antiga não entrou na fila — órfã para
      // sempre, porque ninguém mais a conhece.
      await this.fila.enfileirar(
        {
          chaveAnterior: usuario.fotoKey,
          chaveNova: key,
          motivo: MOTIVO_TROCA,
        },
        tx,
      );
    });

    return this.ler(usuarioId);
  }

  /**
   * AC-010, "remover sem substituir". **Idempotente**: remover foto que não
   * existe é sucesso, não 404 — quem clicou em apagar quer o mesmo estado
   * final nos dois casos, e um 404 aqui só produziria erro na tela de alguém
   * que clicou duas vezes.
   */
  async remover(usuarioId: string): Promise<void> {
    const usuario = await this.carregar(usuarioId);
    this.exigirEmpresa(usuario.companyId);

    if (usuario.fotoKey === null) {
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.usuario.update({
        where: { id: usuarioId },
        data: { fotoKey: null },
      });
      // **Enfileira, não apaga.** Quem apaga é o worker, depois da carência
      // e da reconferência pelo `KeyReferenceChecker` (INV-040/AC-014).
      // Apagar aqui tiraria a janela em que um engano ainda é reversível.
      await this.fila.enfileirar(
        {
          chaveAnterior: usuario.fotoKey,
          chaveNova: null,
          motivo: MOTIVO_REMOCAO,
        },
        tx,
      );
    });
  }

  private async carregar(usuarioId: string) {
    return this.prisma.usuario.findUniqueOrThrow({
      where: { id: usuarioId },
      select: { id: true, companyId: true, fotoKey: true },
    });
  }

  /**
   * O `super_admin` tem `company_id` NULL desde a SPEC-001, e a gramática da
   * chave começa por `empresas/<company_id>/`: **não existe chave que
   * represente a foto dele** (LIM-005). Decidido em 2026-08-25 — é conta
   * operacional, e o SAdmin não tem tela de perfil.
   *
   * Sem esta guarda o caminho seguiria até o `UPDATE`, o CHECK
   * `usuarios_foto_da_empresa_check` recusaria, e o Prisma lançaria: **500
   * num caso perfeitamente previsível.**
   */
  private exigirEmpresa(companyId: string | null): string {
    if (companyId === null) {
      throw new ForbiddenException(PERFIL_SEM_EMPRESA);
    }
    return companyId;
  }
}
