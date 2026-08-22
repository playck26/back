import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { parseTimeOnly } from '../courts/date-time.util';
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
            slug: await gerarSlugUnico(tx, dto.nome),
            logoUrl: dto.logoUrl,
            esportes: dto.esportes,
          },
        });

        // SPEC-010: empresa nova nasce com o horário padrão dos 7 dias.
        // Sem isto, uma empresa criada depois da migration não teria
        // configuração nenhuma e cairia na rede de segurança do resolver —
        // funcionaria, mas o admin abriria a tela de configuração vazia e
        // não entenderia de onde vêm os horários que o aluno enxerga.
        await tx.horarioFuncionamento.createMany({
          data: Array.from({ length: 7 }, (_, diaSemana) => ({
            companyId: empresaCriada.id,
            quadraId: null,
            diaSemana,
            horaInicio: parseTimeOnly('06:00'),
            horaFim: parseTimeOnly('22:00'),
            fechado: false,
          })),
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

// SPEC-009:TASK-000 — toda empresa precisa de `slug` (identificador do link
// público de auto-cadastro, `/cadastro/<slug>`). O slug é derivado do nome
// na criação e **não acompanha renomeações**: ele vira parte de um link que
// a empresa divulga, e link publicado que muda sozinho quebra na mão de
// quem já recebeu. Renomear a empresa é operação de vitrine; trocar o slug
// seria operação de endereço, e não é o que o admin pede ao renomear.
export function slugify(nome: string): string {
  return nome
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

type SlugTx = {
  empresa: {
    findUnique: (args: { where: { slug: string } }) => Promise<unknown>;
  };
};

async function gerarSlugUnico(tx: SlugTx, nome: string): Promise<string> {
  const base = slugify(nome) || 'empresa';
  if (!(await tx.empresa.findUnique({ where: { slug: base } }))) {
    return base;
  }
  // Colisão real: "Tênis Clube" e "Tenis Clube" geram o mesmo base. Sufixo
  // curto e aleatório em vez de contador, para não expor quantas empresas
  // de nome parecido existem na base (o SAdmin é multi-tenant).
  for (let tentativa = 0; tentativa < 5; tentativa += 1) {
    const candidato = `${base}-${Math.random().toString(36).slice(2, 6)}`;
    if (!(await tx.empresa.findUnique({ where: { slug: candidato } }))) {
      return candidato;
    }
  }
  throw new Error(`Não foi possível gerar slug único para "${nome}"`);
}
