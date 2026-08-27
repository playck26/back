import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { LogoDaEmpresaResponseDto } from '../storage/dto/midia-response.dto';
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
 * SPEC-018/TASK-006 — a logo da empresa.
 *
 * **Feita antes da 004 e da 005 por decisão do Israel (2026-08-25):** a logo
 * é o que a empresa precisa ver na tela, e até aqui ela era **coletada e
 * nunca exibida** — o SAdmin tem um campo "URL do logo" desde a SPEC-002, o
 * `/me/company` e o `/public/companies/:slug` devolvem `logoUrl`, e nenhum
 * componente renderizava.
 *
 * **A diferença desta task para a foto de perfil é o `:id` na URL.** Em
 * `/me/foto` não havia como outro id chegar; aqui há, e o escopo tem de ser
 * conferido de verdade — `company_admin` só na própria empresa, e a recusa é
 * **404, nunca 403** (AC-014), porque 403 confirmaria que a empresa existe.
 */

export const LOGO_DE_OUTRA_EMPRESA = {
  statusCode: 404,
  code: 'EMPRESA_NAO_ENCONTRADA',
  message: 'Empresa não encontrada.',
} as const;

export const MOTIVO_TROCA_LOGO = 'logo_trocada';
export const MOTIVO_REMOCAO_LOGO = 'logo_removida';

/** O que toda tela precisa saber para desenhar a marca da empresa. */
/** SPEC-021/TASK-005 — a forma canonica vive no DTO. */
export type LogoResolvida = LogoDaEmpresaResponseDto;

export interface EmpresaComLogo {
  readonly id: string;
  readonly logoKey: string | null;
  readonly logoUrl: string | null;
}

@Injectable()
export class LogoDaEmpresaService {
  private readonly logger = new Logger(LogoDaEmpresaService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fila: FilaDeExclusao,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  /**
   * **AC-013, e é a razão de este método existir em vez de quatro cópias
   * do mesmo `??`.** A logo aparece em quatro lugares — painel do gestor,
   * app do aluno, página pública de cadastro e lista do SAdmin — e um
   * `logoKey ?? logoUrl` repetido quatro vezes é quatro chances de alguém
   * esquecer o fallback e apagar da tela a logo de quem ainda usa URL
   * externa.
   *
   * **Fail-soft de propósito.** Chave corrompida no banco cai para a
   * `logo_url` antiga em vez de estourar: isto roda no caminho de LEITURA,
   * inclusive numa listagem de empresas, e uma linha ruim não pode derrubar
   * a página inteira. O erro vai para o log, que é onde alguém pode agir.
   */
  resolver(empresa: EmpresaComLogo): LogoResolvida {
    if (empresa.logoKey === null) {
      return { logoUrl: empresa.logoUrl };
    }

    // Mesmo sendo pública, a chave passa pela conferência (INV-037): é ela
    // que pega chave de outra empresa gravada no banco — cenário que o
    // escopo por token não pega, porque os dois leem o mesmo token.
    const conferida = conferirChave(empresa.logoKey, {
      companyId: empresa.id,
      tipo: 'logo',
      recursoId: empresa.id,
      visibilidade: 'publico',
    });

    if (!conferida.valida) {
      this.logger.error({
        evento: 'logo_key_invalida',
        companyId: empresa.id,
        motivo: conferida.motivo,
      });
      return { logoUrl: empresa.logoUrl };
    }

    return { logoUrl: this.provider.urlPublica(conferida.chave.key) };
  }

  async substituir(
    companyId: string,
    ator: AccessTokenPayload,
    corpo: Buffer,
  ): Promise<LogoResolvida> {
    const empresa = await this.carregar(companyId, ator);

    const validacao = validarWebp(corpo);
    if (!validacao.valido) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: validacao.codigo,
        message: validacao.motivo,
      });
    }

    const sha256 = createHash('sha256').update(corpo).digest('hex');
    // `recursoId` é o **próprio id da empresa**: a empresa é dona de si
    // mesma, e há uma logo só por empresa.
    const key = montarChave({
      companyId,
      tipo: 'logo',
      recursoId: companyId,
      sha256,
    });
    if (key === null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'TIPO_DE_MIDIA_DESCONHECIDO',
        message: 'Não foi possível montar a chave da imagem.',
      });
    }

    // Storage primeiro, banco depois — mesma ordem da TASK-003, e pelo mesmo
    // motivo: órfão invisível é melhor que referência mentirosa.
    await this.provider.gravar({
      key,
      corpo,
      contentType: 'image/webp',
      visibilidade: this.storage.visibilidadeDoTipo('logo'),
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.empresa.update({
        where: { id: companyId },
        data: { logoKey: key },
      });
      await this.fila.enfileirar(
        {
          chaveAnterior: empresa.logoKey,
          chaveNova: key,
          motivo: MOTIVO_TROCA_LOGO,
        },
        tx,
      );
    });

    return this.resolver({ ...empresa, logoKey: key });
  }

  /**
   * **O `DELETE` não estava na tabela de contrato da spec**, que só lista o
   * `PUT` para logo. A adição é deliberada e tem lastro na AC-010
   * ("remover sem substituir: existe ação de apagar"): sem ela, quem subisse
   * a logo errada ficaria com ela para sempre, e a única saída seria subir
   * outra por cima.
   *
   * **`logo_url` NÃO é tocada.** Remover o upload devolve a empresa ao
   * estado anterior — se havia URL externa, ela volta a valer (AC-013).
   */
  async remover(
    companyId: string,
    ator: AccessTokenPayload,
  ): Promise<LogoResolvida> {
    const empresa = await this.carregar(companyId, ator);

    if (empresa.logoKey === null) {
      // Idempotente: remover o que não existe é sucesso.
      return this.resolver(empresa);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.empresa.update({
        where: { id: companyId },
        data: { logoKey: null },
      });
      await this.fila.enfileirar(
        {
          chaveAnterior: empresa.logoKey,
          chaveNova: null,
          motivo: MOTIVO_REMOCAO_LOGO,
        },
        tx,
      );
    });

    return this.resolver({ ...empresa, logoKey: null });
  }

  /**
   * O escopo. **`super_admin` alcança qualquer empresa; `company_admin` só a
   * própria**, e quem pede outra recebe o mesmo 404 de quem pede uma que não
   * existe — a diferença entre "não existe" e "não é sua" é justamente o que
   * o 404 esconde (AC-014).
   */
  private async carregar(
    companyId: string,
    ator: AccessTokenPayload,
  ): Promise<EmpresaComLogo> {
    if (ator.role !== 'super_admin' && ator.companyId !== companyId) {
      throw new NotFoundException(LOGO_DE_OUTRA_EMPRESA);
    }

    const empresa = await this.prisma.empresa.findUnique({
      where: { id: companyId },
      select: { id: true, logoKey: true, logoUrl: true },
    });

    if (empresa === null) {
      throw new NotFoundException(LOGO_DE_OUTRA_EMPRESA);
    }
    return empresa;
  }
}
