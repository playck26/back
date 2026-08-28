import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { TERMO_VERSAO_VIGENTE } from './termo-vigente';

/**
 * SPEC-024 — o termo da plataforma e o contrato do clube.
 *
 * **O que esta spec existe para responder:** *"o que esta pessoa aceitou, e
 * quando?"*. Uma caixinha booleana custaria 3h e não responderia nada no dia
 * em que alguém contestasse — por isso o texto é versionado e o aceite
 * guarda **qual versão**.
 */
@Injectable()
export class AceitesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * O que falta aceitar, **com o texto junto**.
   *
   * Manda o texto na mesma resposta de propósito: a tela precisa dele para
   * a pessoa ler antes de aceitar, e uma segunda requisição criaria a janela
   * em que ela aceita um texto e recebe outro.
   */
  async pendentes(usuarioId: string) {
    const usuario = await this.prisma.usuario.findUnique({
      where: { id: usuarioId },
      select: {
        termoVersaoAceita: true,
        contratoVersaoAceita: true,
        companyId: true,
        empresa: { select: { contratoVersaoVigente: true } },
      },
    });
    if (!usuario) {
      throw new NotFoundException();
    }

    const termoPendente = usuario.termoVersaoAceita !== TERMO_VERSAO_VIGENTE;
    const contratoVigente = usuario.empresa?.contratoVersaoVigente ?? null;
    const contratoPendente =
      contratoVigente !== null &&
      usuario.contratoVersaoAceita !== contratoVigente;

    const [termo, contrato] = await Promise.all([
      termoPendente
        ? this.prisma.termoDaPlataforma.findUnique({
            where: { versao: TERMO_VERSAO_VIGENTE },
          })
        : null,
      contratoPendente && usuario.companyId
        ? this.prisma.contratoDaEmpresa.findUnique({
            where: {
              companyId_versao: {
                companyId: usuario.companyId,
                versao: contratoVigente,
              },
            },
          })
        : null,
    ]);

    return {
      termo: termo ? { versao: termo.versao, texto: termo.texto } : null,
      contrato: contrato
        ? { versao: contrato.versao, texto: contrato.texto }
        : null,
    };
  }

  /**
   * Registra o aceite.
   *
   * **Exige as versões lidas** (REQ-005 da spec): sem isso um cliente velho
   * aceitaria "o que estiver valendo", e a pessoa estaria concordando com um
   * texto que não viu.
   *
   * Tudo numa transação: as duas colunas desnormalizadas de `usuarios` e as
   * linhas de `aceites` são a mesma verdade escrita em dois lugares — uma
   * responde ao portão, a outra ao advogado. Escrever fora da mesma
   * transação seria deixá-las divergir.
   */
  async aceitar(
    usuarioId: string,
    versoes: { termo?: number; contrato?: number },
  ) {
    if (versoes.termo === undefined && versoes.contrato === undefined) {
      throw new BadRequestException('Informe ao menos uma versão aceita.');
    }

    return this.prisma.$transaction(async (tx) => {
      const usuario = await tx.usuario.findUnique({
        where: { id: usuarioId },
        select: {
          companyId: true,
          empresa: { select: { contratoVersaoVigente: true } },
        },
      });
      if (!usuario) {
        throw new NotFoundException();
      }

      if (
        versoes.termo !== undefined &&
        versoes.termo !== TERMO_VERSAO_VIGENTE
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'VERSAO_DESATUALIZADA',
          message:
            'O texto foi atualizado enquanto você lia. Leia a versão nova antes de aceitar.',
        });
      }

      const contratoVigente = usuario.empresa?.contratoVersaoVigente ?? null;
      if (
        versoes.contrato !== undefined &&
        versoes.contrato !== contratoVigente
      ) {
        throw new ConflictException({
          statusCode: 409,
          code: 'VERSAO_DESATUALIZADA',
          message:
            'O contrato do clube foi atualizado enquanto você lia. Leia a versão nova antes de aceitar.',
        });
      }

      // `skipDuplicates`: aceitar de novo o que já se aceitou é 200 e **não**
      // cria segunda linha — toque duplo em conexão ruim é o caso real, e a
      // unicidade (usuario, tipo, versao) é quem garante isso no banco.
      const registros: {
        usuarioId: string;
        tipo: 'termo' | 'contrato';
        versao: number;
      }[] = [];
      if (versoes.termo !== undefined) {
        registros.push({ usuarioId, tipo: 'termo', versao: versoes.termo });
      }
      if (versoes.contrato !== undefined) {
        registros.push({
          usuarioId,
          tipo: 'contrato',
          versao: versoes.contrato,
        });
      }
      await tx.aceite.createMany({ data: registros, skipDuplicates: true });

      const atualizado = await tx.usuario.update({
        where: { id: usuarioId },
        data: {
          ...(versoes.termo !== undefined
            ? { termoVersaoAceita: versoes.termo }
            : {}),
          ...(versoes.contrato !== undefined
            ? { contratoVersaoAceita: versoes.contrato }
            : {}),
        },
        select: { termoVersaoAceita: true, contratoVersaoAceita: true },
      });

      // Aceitar so o termo, com contrato ainda pendente, e caminho real —
      // por isso a resposta diz se sobrou algo em vez de um `ok: true` que
      // a tela teria de interpretar.
      const aindaPendente =
        atualizado.termoVersaoAceita !== TERMO_VERSAO_VIGENTE ||
        (contratoVigente !== null &&
          atualizado.contratoVersaoAceita !== contratoVigente);

      return { ...atualizado, aindaPendente };
    });
  }

  /** O contrato vigente do clube, para a tela do gestor e para a pública. */
  async contratoVigente(companyId: string) {
    const empresa = await this.prisma.empresa.findUnique({
      where: { id: companyId },
      select: { contratoVersaoVigente: true },
    });
    if (!empresa) {
      throw new NotFoundException();
    }
    if (empresa.contratoVersaoVigente === null) {
      return { versao: null, texto: null, publicadoEm: null };
    }

    const contrato = await this.prisma.contratoDaEmpresa.findUnique({
      where: {
        companyId_versao: {
          companyId,
          versao: empresa.contratoVersaoVigente,
        },
      },
    });
    return {
      versao: contrato?.versao ?? null,
      texto: contrato?.texto ?? null,
      publicadoEm: contrato?.publicadoEm ?? null,
    };
  }

  /**
   * Publica uma versão nova.
   *
   * **Não existe "despublicar"** (LIM-024a): publicar v3 por engano exige
   * publicar v4 com o texto certo. O contrário — apagar uma versão —
   * destruiria o registro de quem aceitou o quê, que é a razão desta spec
   * existir.
   */
  async publicarContrato(companyId: string, texto: string) {
    const limpo = texto.trim();
    if (limpo.length === 0) {
      throw new BadRequestException('O contrato não pode ficar vazio.');
    }

    return this.prisma.$transaction(async (tx) => {
      const empresa = await tx.empresa.findUnique({
        where: { id: companyId },
        select: { contratoVersaoVigente: true },
      });
      if (!empresa) {
        throw new NotFoundException();
      }

      const versao = (empresa.contratoVersaoVigente ?? 0) + 1;

      await tx.contratoDaEmpresa.create({
        data: { companyId, versao, texto: limpo },
      });
      // Só depois de a linha existir. Apontar a vigente para uma versão que
      // ainda não foi escrita bloquearia a empresa inteira num texto
      // inexistente — falha fechada no pior sentido.
      await tx.empresa.update({
        where: { id: companyId },
        data: { contratoVersaoVigente: versao },
      });

      return { versao, texto: limpo };
    });
  }

  /**
   * Quantas pessoas serão obrigadas a reaceitar se o clube publicar agora.
   *
   * A tela do Admin mostra isso **antes** de publicar (REQ-006): quem
   * configura precisa saber o alcance. "Publicar" sem esse número parece
   * salvar um rascunho, e não é — interrompe todo mundo no próximo acesso.
   */
  async quantosReaceitam(companyId: string) {
    return this.prisma.usuario.count({
      where: {
        companyId,
        status: 'ativo',
        role: { in: ['aluno', 'professor'] },
      },
    });
  }
}
