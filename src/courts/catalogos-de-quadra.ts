import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CategoriaDeQuadra, EsporteDeQuadra } from '@prisma/client';
import {
  CatalogoDeQuadraService,
  type DelegateDeCatalogo,
} from './catalogo-de-quadra.service';
import type { CatalogoDeQuadraResponseDto } from './dto/quadra-response.dto';

/**
 * SPEC-020/TASK-002 — os dois catálogos concretos.
 *
 * **Cada um só diz três coisas:** qual tabela, como se chama, e o que conta
 * como "em uso". Toda a regra — nome único sem distinguir maiúscula, escopo
 * por empresa, 404 em vez de 403, recusa de apagar em uso — mora na base.
 *
 * Se um terceiro eixo aparecer (cobertura, iluminação), são mais três linhas
 * aqui e nenhuma regra nova. Essa é a prova de que a base valeu.
 */

/**
 * SPEC-020/TASK-007 — **o duplo cast abaixo apaga a checagem, e isto a traz
 * de volta.**
 *
 * `this.prisma.esporteDeQuadra as unknown as DelegateDeCatalogo` é necessário
 * — os dois delegates do Prisma têm tipos diferentes e a base precisa de uma
 * forma só. Mas `as unknown as` faz o TypeScript acreditar no que o delegate
 * *declara*, aconteça o que acontecer no schema. **Se alguém renomear `ordem`
 * na migration, o cast continua compilando e o contrato publicado passa a
 * mentir** — que é exatamente a familia do DEF-012, um nível mais fundo.
 *
 * Estas duas linhas não geram código: são uma pergunta feita ao compilador.
 * O modelo do Prisma ainda satisfaz o contrato que a API publica? Se deixar
 * de satisfazer, **a compilação para aqui**, com o nome do modelo na
 * mensagem.
 */
type ConfereContraOContrato<T extends CatalogoDeQuadraResponseDto> = T;
// O lint pede que todo tipo declarado seja usado, e estes de propósito não
// são: o trabalho deles acontece na hora de resolver o `extends`, não na hora
// de alguém referenciá-los. Apagá-los para calar o lint apagaria a checagem.
/* eslint-disable @typescript-eslint/no-unused-vars */
type _EsporteSatisfazOContrato = ConfereContraOContrato<EsporteDeQuadra>;
type _CategoriaSatisfazOContrato = ConfereContraOContrato<CategoriaDeQuadra>;
/* eslint-enable @typescript-eslint/no-unused-vars */

@Injectable()
export class EsportesDeQuadraService extends CatalogoDeQuadraService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get delegate(): DelegateDeCatalogo {
    return this.prisma.esporteDeQuadra as unknown as DelegateDeCatalogo;
  }

  protected get rotulo(): string {
    return 'esporte';
  }

  protected contarEmUso(id: string): Promise<number> {
    return this.prisma.quadra.count({ where: { esporteId: id } });
  }
}

@Injectable()
export class CategoriasDeQuadraService extends CatalogoDeQuadraService {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  protected get delegate(): DelegateDeCatalogo {
    return this.prisma.categoriaDeQuadra as unknown as DelegateDeCatalogo;
  }

  protected get rotulo(): string {
    return 'categoria';
  }

  protected contarEmUso(id: string): Promise<number> {
    return this.prisma.quadra.count({ where: { categoriaId: id } });
  }
}
