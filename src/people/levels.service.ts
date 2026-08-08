import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateLevelDto } from './dto/create-level.dto';
import type { UpdateLevelDto } from './dto/update-level.dto';

@Injectable()
export class LevelsService {
  constructor(private readonly prisma: PrismaService) {}

  list(companyId: string) {
    return this.prisma.nivel.findMany({
      where: { companyId },
      orderBy: { ordem: 'asc' },
    });
  }

  async create(companyId: string, dto: CreateLevelDto) {
    const existente = await this.prisma.nivel.findUnique({
      where: { companyId_nome: { companyId, nome: dto.nome } },
    });
    if (existente) {
      throw new ConflictException('Já existe um nível com esse nome (AC-003)');
    }

    return this.prisma.nivel.create({
      data: { companyId, nome: dto.nome, ordem: dto.ordem },
    });
  }

  async findOne(companyId: string, id: string) {
    const nivel = await this.prisma.nivel.findFirst({
      where: { id, companyId },
    });
    if (!nivel) {
      throw new NotFoundException();
    }
    return nivel;
  }

  async update(companyId: string, id: string, dto: UpdateLevelDto) {
    await this.findOne(companyId, id);

    if (dto.nome) {
      const existente = await this.prisma.nivel.findUnique({
        where: { companyId_nome: { companyId, nome: dto.nome } },
      });
      if (existente && existente.id !== id) {
        throw new ConflictException(
          'Já existe um nível com esse nome (AC-003)',
        );
      }
    }

    return this.prisma.nivel.update({
      where: { id },
      data: { nome: dto.nome, ordem: dto.ordem },
    });
  }

  async remove(companyId: string, id: string): Promise<void> {
    await this.findOne(companyId, id);

    const emUsoPorAluno = await this.prisma.aluno.count({
      where: { nivelId: id },
    });
    if (emUsoPorAluno > 0) {
      throw new UnprocessableEntityException(
        'Nível em uso por aluno(s) — não pode ser removido (CON-003.6)',
      );
    }

    await this.prisma.nivel.delete({ where: { id } });
  }
}
