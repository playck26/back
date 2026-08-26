import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  CatalogoDeQuadraService,
  type DelegateDeCatalogo,
} from './catalogo-de-quadra.service';

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
