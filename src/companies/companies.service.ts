import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { PrismaService } from '../prisma/prisma.service';
import type { CreateCompanyDto } from './dto/create-company.dto';
import type { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import type { UpdateCompanyDto } from './dto/update-company.dto';
import type { UpdateCompanyStatusDto } from './dto/update-company-status.dto';

const BCRYPT_COST = 12;

export interface PublicAdminUsuario {
  id: string;
  nome: string;
  email: string;
  role: 'company_admin';
  companyId: string;
}

@Injectable()
export class CompaniesService {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: ListCompaniesQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.empresa.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
      }),
      this.prisma.empresa.count(),
    ]);

    return { data, page, pageSize, total };
  }

  async create(dto: CreateCompanyDto) {
    const nomeExistente = await this.prisma.empresa.findUnique({
      where: { nome: dto.nome },
    });
    if (nomeExistente) {
      throw new ConflictException('Empresa já cadastrada com esse nome');
    }

    const emailExistente = await this.prisma.usuario.findUnique({
      where: { email: dto.adminInicial.email },
    });
    if (emailExistente) {
      throw new UnprocessableEntityException(
        'Email do admin inicial já cadastrado',
      );
    }

    const senhaHash = await bcrypt.hash(dto.adminInicial.senha, BCRYPT_COST);

    // Transação: empresa + admin inicial nascem juntos ou nenhum dos dois
    // (NFR-002, AC-001) — nenhuma criação acontece fora do $transaction.
    const { empresa, adminUsuario } = await this.prisma.$transaction(
      async (tx) => {
        const empresaCriada = await tx.empresa.create({
          data: {
            nome: dto.nome,
            logoUrl: dto.logoUrl,
            esportes: dto.esportes,
          },
        });

        const adminCriado = await tx.usuario.create({
          data: {
            email: dto.adminInicial.email,
            senhaHash,
            nome: dto.adminInicial.nome,
            telefone: dto.adminInicial.telefone,
            role: 'company_admin',
            companyId: empresaCriada.id,
          },
        });

        return { empresa: empresaCriada, adminUsuario: adminCriado };
      },
    );

    return { empresa, adminUsuario: this.toPublicAdminUsuario(adminUsuario) };
  }

  async findOne(id: string) {
    const empresa = await this.prisma.empresa.findUnique({ where: { id } });
    if (!empresa) {
      throw new NotFoundException();
    }
    return empresa;
  }

  async update(id: string, dto: UpdateCompanyDto) {
    await this.findOne(id);

    if (dto.nome) {
      const nomeExistente = await this.prisma.empresa.findUnique({
        where: { nome: dto.nome },
      });
      if (nomeExistente && nomeExistente.id !== id) {
        throw new ConflictException('Empresa já cadastrada com esse nome');
      }
    }

    return this.prisma.empresa.update({
      where: { id },
      data: {
        nome: dto.nome,
        logoUrl: dto.logoUrl,
        esportes: dto.esportes,
      },
    });
  }

  async updateStatus(id: string, dto: UpdateCompanyStatusDto) {
    await this.findOne(id);

    return this.prisma.empresa.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  private toPublicAdminUsuario(usuario: {
    id: string;
    nome: string;
    email: string;
    companyId: string | null;
  }): PublicAdminUsuario {
    return {
      id: usuario.id,
      nome: usuario.nome,
      email: usuario.email,
      role: 'company_admin',
      companyId: usuario.companyId as string,
    };
  }
}
