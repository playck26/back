import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateTeacherDto } from './dto/create-teacher.dto';
import type { PaginationQueryDto } from './dto/pagination-query.dto';
import type { UpdateTeacherDto } from './dto/update-teacher.dto';

@Injectable()
export class TeachersService {
  constructor(private readonly prisma: PrismaService) {}

  async list(companyId: string, query: PaginationQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.professor.findMany({
        where: { companyId },
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.professor.count({ where: { companyId } }),
    ]);

    return { data, page, pageSize, total };
  }

  create(companyId: string, dto: CreateTeacherDto) {
    return this.prisma.professor.create({
      data: {
        companyId,
        nome: dto.nome,
        telefone: dto.telefone,
        email: dto.email,
      },
    });
  }

  async findOne(companyId: string, id: string) {
    const professor = await this.prisma.professor.findFirst({
      where: { id, companyId },
    });
    if (!professor) {
      throw new NotFoundException();
    }
    return professor;
  }

  async update(companyId: string, id: string, dto: UpdateTeacherDto) {
    await this.findOne(companyId, id);

    return this.prisma.professor.update({
      where: { id },
      data: {
        nome: dto.nome,
        telefone: dto.telefone,
        email: dto.email,
        status: dto.status,
      },
    });
  }
}
