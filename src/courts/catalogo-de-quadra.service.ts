import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CatalogoDeQuadraResponseDto } from './dto/quadra-response.dto';

/**
 * SPEC-020/TASK-002 — a regra dos catálogos de quadra, escrita **uma vez**.
 *
 * ## Por que uma base compartilhada, e não dois serviços
 *
 * Esporte e categoria têm forma idêntica e regra idêntica: nome único por
 * empresa, escopo por empresa, e não se apaga o que está em uso. Dois
 * arquivos iguais seriam duas chances de a regra divergir — alguém conserta
 * o `lower()` num e esquece do outro, e o clube passa a poder criar "Saibro"
 * e "saibro" só nas categorias.
 *
 * **Aqui não vale a desculpa que a duplicação do `comprimir-imagem.ts` tem.**
 * Aquela é entre repositórios (ADR-001, poly-repo, sem pacote compartilhado)
 * e está declarada como custo. Esta seria dentro do mesmo arquivo de módulo.
 *
 * ## A comparação de nome é case-INSENSITIVE, e o banco não é
 *
 * O `UNIQUE(company_id, nome)` do Postgres distingue "Tênis" de "tênis" —
 * conferido em `catalogos-de-quadra.db-spec.ts`. E o defeito que esta spec
 * existe para resolver é exatamente esse: a barra de filtro do aluno virava
 * duas opções por causa de uma tecla.
 *
 * Então **quem impede a segunda grafia é este serviço**, e o banco fica como
 * a rede que pega o caminho que não passar por aqui. É a mesma divisão de
 * trabalho do resto do projeto: o código dá a mensagem, o banco dá a
 * garantia.
 */

/**
 * O que uma opção de catálogo é, dos dois lados.
 *
 * **SPEC-020/TASK-007 — era uma interface local, e virou apelido do DTO
 * publicado.** Enquanto era local, a forma da resposta de `/court-sports` não
 * existia no `openapi.json`, e o Admin escrevia a própria versão dela à mão —
 * com campos a mais do que a API devolve, e o typecheck concordando.
 *
 * Agora o retorno destes métodos **é** o contrato: mudar a forma quebra o
 * typecheck aqui, o `openapi.json` muda junto, e o frontend que regenerar
 * pega a diferença.
 */
export type OpcaoDeCatalogo = CatalogoDeQuadraResponseDto;

/**
 * O recorte do delegate do Prisma que esta base usa.
 *
 * Estrutural de propósito: `esporteDeQuadra` e `categoriaDeQuadra` têm a
 * mesma forma, e amarrar a base a um dos dois tipos gerados obrigaria a um
 * `as never` na outra ponta — que é onde o typecheck deixaria de ajudar.
 */
export interface DelegateDeCatalogo {
  findMany(args: {
    where: { companyId: string };
    orderBy: { ordem: 'asc' };
  }): Promise<OpcaoDeCatalogo[]>;
  findFirst(args: {
    where: { id: string; companyId: string };
  }): Promise<OpcaoDeCatalogo | null>;
  findFirst(args: {
    where: {
      companyId: string;
      nome: { equals: string; mode: 'insensitive' };
      id?: { not: string };
    };
  }): Promise<OpcaoDeCatalogo | null>;
  create(args: {
    data: { companyId: string; nome: string; ordem: number };
  }): Promise<OpcaoDeCatalogo>;
  update(args: {
    where: { id: string };
    data: { nome?: string; ordem?: number };
  }): Promise<OpcaoDeCatalogo>;
  delete(args: { where: { id: string } }): Promise<OpcaoDeCatalogo>;
}

export interface EntradaDeCatalogo {
  nome?: string;
  ordem?: number;
}

@Injectable()
export abstract class CatalogoDeQuadraService {
  constructor(protected readonly prisma: PrismaService) {}

  /** `prisma.esporteDeQuadra` ou `prisma.categoriaDeQuadra`. */
  protected abstract get delegate(): DelegateDeCatalogo;

  /** "esporte" ou "categoria" — entra nas mensagens e nos códigos de erro. */
  protected abstract get rotulo(): string;

  /** Quantas quadras usam esta opção. É o que a AC-003/AC-004 protege. */
  protected abstract contarEmUso(id: string): Promise<number>;

  list(companyId: string): Promise<OpcaoDeCatalogo[]> {
    return this.delegate.findMany({
      where: { companyId },
      orderBy: { ordem: 'asc' },
    });
  }

  async findOne(companyId: string, id: string): Promise<OpcaoDeCatalogo> {
    const opcao = await this.delegate.findFirst({ where: { id, companyId } });
    if (opcao === null) {
      // 404 e não 403: opção de outra empresa recebe o mesmo que opção que
      // não existe. A diferença entre "não existe" e "não é sua" é o que o
      // 404 esconde — mesma regra da AC-014 da SPEC-018.
      throw new NotFoundException(this.naoEncontrado());
    }
    return opcao;
  }

  async create(
    companyId: string,
    dto: EntradaDeCatalogo,
  ): Promise<OpcaoDeCatalogo> {
    const nome = exigirNome(dto.nome, this.rotulo);
    await this.recusarNomeRepetido(companyId, nome);

    return this.delegate.create({
      data: { companyId, nome, ordem: dto.ordem ?? 0 },
    });
  }

  async update(
    companyId: string,
    id: string,
    dto: EntradaDeCatalogo,
  ): Promise<OpcaoDeCatalogo> {
    await this.findOne(companyId, id);

    const nome =
      dto.nome === undefined ? undefined : exigirNome(dto.nome, this.rotulo);
    if (nome !== undefined) {
      // `id` excluído da busca: renomear "Tênis" para "Tênis" não é conflito
      // consigo mesmo, e sem isto toda edição que não muda o nome falharia.
      await this.recusarNomeRepetido(companyId, nome, id);
    }

    return this.delegate.update({
      where: { id },
      data: { nome, ordem: dto.ordem },
    });
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.findOne(companyId, id);

    const emUso = await this.contarEmUso(id);
    if (emUso > 0) {
      // O banco também recusa (FK `RESTRICT`, INV-055). Este 422 existe para
      // a pessoa saber **por quê** e **quantas** — o erro do banco diria
      // "violates foreign key constraint" e nada mais.
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: `${this.rotulo.toUpperCase()}_EM_USO`,
        message: `Esta opção está em uso por ${emUso} quadra(s) e não pode ser removida.`,
        quadras: emUso,
      });
    }

    await this.delegate.delete({ where: { id } });
  }

  /**
   * **A comparação é `insensitive`, e é o coração desta task.** O banco
   * distingue "Tênis" de "tênis"; a barra de filtro do aluno não deveria.
   */
  private async recusarNomeRepetido(
    companyId: string,
    nome: string,
    exceto?: string,
  ): Promise<void> {
    const existente = await this.delegate.findFirst({
      where: {
        companyId,
        nome: { equals: nome, mode: 'insensitive' },
        ...(exceto === undefined ? {} : { id: { not: exceto } }),
      },
    });

    if (existente !== null) {
      throw new ConflictException({
        statusCode: 409,
        code: 'NOME_EM_USO',
        message: `Já existe "${existente.nome}" nesta empresa.`,
        existente: existente.nome,
      });
    }
  }

  private naoEncontrado() {
    return {
      statusCode: 404,
      code: `${this.rotulo.toUpperCase()}_NAO_ENCONTRADO`,
      message: 'Opção não encontrada.',
    };
  }
}

/**
 * Nome sem espaço em volta e não vazio.
 *
 * O `trim` não é cosmético: `" Tênis"` e `"Tênis"` passariam pela checagem de
 * repetido como nomes diferentes, e a barra de filtro voltaria a ter duas
 * entradas para a mesma coisa — o defeito que esta spec existe para resolver,
 * entrando pela porta dos fundos.
 */
function exigirNome(bruto: string | undefined, rotulo: string): string {
  const nome = (bruto ?? '').trim();
  if (nome === '') {
    throw new UnprocessableEntityException({
      statusCode: 422,
      code: 'NOME_OBRIGATORIO',
      message: `Informe o nome ${rotulo === 'esporte' ? 'do esporte' : 'da categoria'}.`,
    });
  }
  return nome;
}
