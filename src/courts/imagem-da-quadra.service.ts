import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { conferirChave, montarChave } from '../storage/chave-de-midia';
import { FilaDeExclusao } from '../storage/fila-de-exclusao.service';
import {
  STORAGE_PROVIDER,
  type StorageProvider,
} from '../storage/storage-provider.interface';
import { StorageService } from '../storage/storage.service';
import { validarWebp } from '../storage/webp.validator';
import { PrismaService } from '../prisma/prisma.service';
import type { AccessTokenPayload } from '../common/types/jwt-payload.type';

/**
 * SPEC-018/TASK-005 — a imagem da quadra.
 *
 * **O que separa esta task da logo (TASK-006) é a confirmação.** A logo é
 * material corporativo; a imagem de quadra é pública, permanente e pode
 * mostrar aluno — que pode ser menor de idade. Em 2026-08-23 o Israel
 * decidiu a **opção B** (decisão 1 da spec): a imagem continua pública, e o
 * produto **exige afirmação explícita do gestor** de que ela não mostra
 * pessoa identificável.
 *
 * **O que faz a opção B valer alguma coisa, e por que cada peça existe:**
 *
 * 1. **o servidor exige o campo** (AC-007) — aviso de tela que o cliente
 *    pode não mandar é decoração; `curl` sem o campo leva 422 e nada é
 *    gravado;
 * 2. **a afirmação é registrada com autor e data** (AC-008) — deixa de ser
 *    premissa silenciosa da spec e vira ato de alguém com nome;
 * 3. **trocar exige confirmar de novo** — a confirmação vale para *aquela*
 *    imagem, não é licença permanente para a quadra.
 *
 * **E o banco não confia em nada disso.** A constraint
 * `quadras_imagem_confirmada_check` exige as três colunas juntas ou nenhuma:
 * não existe imagem sem alguém tendo afirmado, com nome e data. Código que
 * esquecesse de gravar o autor não escreveria linha torta — não escreveria.
 *
 * **`super_admin` não alcança esta rota**, e é estrutural, não de produto:
 * ele não tem empresa, e a chave começa por `empresas/<company_id>/`
 * (LIM-005). Quem confirma tem de ter empresa, porque a confirmação é sobre
 * a quadra de alguém.
 */

export const QUADRA_DE_OUTRA_EMPRESA = {
  statusCode: 404,
  code: 'QUADRA_NAO_ENCONTRADA',
  message: 'Quadra não encontrada.',
} as const;

/** AC-007 — a recusa quando a afirmação não veio, ou não veio como `true`. */
export const CONFIRMACAO_OBRIGATORIA = {
  statusCode: 422,
  code: 'CONFIRMACAO_OBRIGATORIA',
  message:
    'Confirme que a imagem não mostra pessoas identificáveis para poder enviá-la.',
} as const;

export const MOTIVO_TROCA_IMAGEM = 'imagem_de_quadra_trocada';
export const MOTIVO_REMOCAO_IMAGEM = 'imagem_de_quadra_removida';

/** O que a tela precisa para desenhar a quadra. */
export interface ImagemResolvida {
  /** URL de CDN, sem assinatura (AC-002), ou `null` quando não há imagem. */
  readonly imagemUrl: string | null;
}

export interface QuadraComImagem {
  readonly id: string;
  readonly companyId: string;
  readonly imagemKey: string | null;
}

/**
 * **AC-007, e é aqui que mora a armadilha desta task.** O campo chega por
 * `multipart/form-data` junto do arquivo, e em multipart **todo valor é
 * string** — `true` vira `"true"`, e não existe boolean no fio.
 *
 * O jeito ingênuo (`Boolean(valor)`) aceitaria **`"false"`**, porque toda
 * string não vazia é `true` em JavaScript. Uma tela com o checkbox
 * desmarcado que mandasse `semPessoasIdentificaveis=false` passaria pelo
 * gate que existe justamente para barrá-la — e a linha gravada diria que
 * alguém confirmou.
 *
 * Por isso a lista é **fechada**: `true` (boolean, para cliente JSON) e a
 * string `"true"`. Qualquer outra coisa — `"false"`, `"1"`, `"on"`,
 * `"TRUE"`, ausente, vazia — é recusa. Ser estrito aqui custa uma tela ter
 * de mandar o valor certo; ser frouxo custa a afirmação não valer nada.
 */
export function confirmouSemPessoas(valor: unknown): boolean {
  return valor === true || valor === 'true';
}

@Injectable()
export class ImagemDaQuadraService {
  private readonly logger = new Logger(ImagemDaQuadraService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fila: FilaDeExclusao,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  /**
   * Traduz chave em URL, e é **o único lugar que faz isso** para quadra —
   * mesma razão do `LogoDaEmpresaService.resolver()`: a imagem aparece na
   * lista do gestor, na ficha da quadra e no app do aluno, e três cópias do
   * mesmo `??` seriam três chances de alguém quebrar uma delas.
   *
   * **Fail-soft.** Chave corrompida no banco vira `null` na tela e erro no
   * log, em vez de derrubar a listagem inteira — isto roda no caminho de
   * LEITURA, e uma linha ruim não pode custar a página.
   */
  resolver(quadra: QuadraComImagem): ImagemResolvida {
    if (quadra.imagemKey === null) {
      return { imagemUrl: null };
    }

    // Mesmo sendo pública, a chave passa pela conferência (INV-037): é ela
    // que pega chave de outra empresa gravada no banco — cenário que o
    // escopo por token não pega, porque os dois leem o mesmo token.
    const conferida = conferirChave(quadra.imagemKey, {
      companyId: quadra.companyId,
      tipo: 'quadra',
      recursoId: quadra.id,
      visibilidade: 'publico',
    });

    if (!conferida.valida) {
      this.logger.error({
        evento: 'imagem_de_quadra_key_invalida',
        companyId: quadra.companyId,
        quadraId: quadra.id,
        motivo: conferida.motivo,
      });
      return { imagemUrl: null };
    }

    return { imagemUrl: this.provider.urlPublica(conferida.chave.key) };
  }

  /**
   * **A ordem aqui é deliberada: a confirmação é conferida ANTES de tudo.**
   * Antes de validar o WebP, antes de calcular sha256, antes de falar com o
   * bucket. Um upload sem afirmação não deve deixar rastro nenhum — nem um
   * objeto órfão, nem uma linha na fila (AC-007 diz "nada gravado").
   */
  async substituir(
    quadraId: string,
    ator: AccessTokenPayload,
    corpo: Buffer,
    confirmacao: unknown,
  ): Promise<ImagemResolvida> {
    if (!confirmouSemPessoas(confirmacao)) {
      throw new UnprocessableEntityException(CONFIRMACAO_OBRIGATORIA);
    }

    const quadra = await this.carregar(quadraId, ator);

    const validacao = validarWebp(corpo);
    if (!validacao.valido) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: validacao.codigo,
        message: validacao.motivo,
      });
    }

    const sha256 = createHash('sha256').update(corpo).digest('hex');
    const key = montarChave({
      companyId: quadra.companyId,
      tipo: 'quadra',
      recursoId: quadra.id,
      sha256,
    });
    if (key === null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'TIPO_DE_MIDIA_DESCONHECIDO',
        message: 'Não foi possível montar a chave da imagem.',
      });
    }

    // Storage primeiro, banco depois — mesma ordem da logo, e pelo mesmo
    // motivo: órfão invisível é melhor que referência mentirosa.
    await this.provider.gravar({
      key,
      corpo,
      contentType: 'image/webp',
      visibilidade: this.storage.visibilidadeDoTipo('quadra'),
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.quadra.update({
        where: { id: quadra.id },
        data: {
          imagemKey: key,
          // AC-008: as três andam juntas. Trocar a imagem **regrava** autor e
          // data porque a confirmação é sobre esta imagem, não sobre a
          // quadra — quem trocou responde pelo que subiu agora.
          imagemConfirmadaPor: ator.sub,
          imagemConfirmadaEm: new Date(),
        },
      });
      await this.fila.enfileirar(
        {
          chaveAnterior: quadra.imagemKey,
          chaveNova: key,
          motivo: MOTIVO_TROCA_IMAGEM,
        },
        tx,
      );
    });

    return this.resolver({ ...quadra, imagemKey: key });
  }

  /**
   * AC-010 — remover sem substituir. As três colunas voltam a `NULL` juntas,
   * porque a constraint não aceita meia-linha: imagem sem confirmação e
   * confirmação sem imagem são o mesmo tipo de mentira.
   */
  async remover(
    quadraId: string,
    ator: AccessTokenPayload,
  ): Promise<ImagemResolvida> {
    const quadra = await this.carregar(quadraId, ator);

    if (quadra.imagemKey === null) {
      // Idempotente: remover o que não existe é sucesso.
      return this.resolver(quadra);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.quadra.update({
        where: { id: quadra.id },
        data: {
          imagemKey: null,
          imagemConfirmadaPor: null,
          imagemConfirmadaEm: null,
        },
      });
      await this.fila.enfileirar(
        {
          chaveAnterior: quadra.imagemKey,
          chaveNova: null,
          motivo: MOTIVO_REMOCAO_IMAGEM,
        },
        tx,
      );
    });

    return this.resolver({ ...quadra, imagemKey: null });
  }

  /**
   * O escopo. **Quadra de outra empresa recebe o mesmo 404 de quadra que não
   * existe** (AC-014) — 403 confirmaria que ela existe, e a imagem de uma
   * quadra é informação de outro clube.
   *
   * O `companyId` vem do **token**, nunca da URL: é o que impede alguém de
   * pedir a quadra certa dizendo ser de outra empresa.
   */
  private async carregar(
    quadraId: string,
    ator: AccessTokenPayload,
  ): Promise<QuadraComImagem> {
    if (ator.companyId === null || ator.companyId === undefined) {
      // `super_admin` cai aqui: não tem empresa, e a chave de mídia começa
      // por `empresas/<company_id>/` (LIM-005). Sem empresa não há chave que
      // se possa montar, e 404 é a resposta honesta.
      throw new NotFoundException(QUADRA_DE_OUTRA_EMPRESA);
    }

    const quadra = await this.prisma.quadra.findFirst({
      where: { id: quadraId, companyId: ator.companyId },
      select: { id: true, companyId: true, imagemKey: true },
    });

    if (quadra === null) {
      throw new NotFoundException(QUADRA_DE_OUTRA_EMPRESA);
    }
    return quadra;
  }
}
