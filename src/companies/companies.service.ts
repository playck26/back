import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { parseTimeOnly } from '../courts/date-time.util';
import { PrismaService } from '../prisma/prisma.service';
import { LogoDaEmpresaService } from './logo-da-empresa.service';
import { AuthService } from '../auth/auth.service';
import type { CreateCompanyDto } from './dto/create-company.dto';
import type { ListCompaniesQueryDto } from './dto/list-companies-query.dto';
import type { UpdateCompanyDto } from './dto/update-company.dto';
import type { UpdateCompanyStatusDto } from './dto/update-company-status.dto';

const BCRYPT_COST = 12;

/**
 * SPEC-020/TASK-008 — **a resposta continua `esportes: string[]`, e a fonte
 * dela deixa de ser a coluna.**
 *
 * Manter a forma da resposta não é preguiça, é o que permite a TASK-004
 * derrubar `empresas.esportes` **sem quebrar o SAdmin**. O SAdmin faz
 * `empresa.esportes.join(", ")`; se aqui saísse um array de objetos, ele
 * quebraria exatamente como o app do aluno quebrou hoje (DEF-012) — e desta
 * vez com o defeito conhecido de antemão.
 *
 * A INV-057 pede **uma** lista de esportes por empresa. Ela passa a ser o
 * catálogo; a coluna vira cópia condenada.
 */
const COM_CATALOGO = {
  esportesQuadra: { select: { nome: true }, orderBy: { ordem: 'asc' } },
} as const;

/**
 * A lista que o SAdmin manda, pronta para virar catálogo: sem espaço nas
 * pontas, sem vazio, e **sem repetido sem distinguir maiúscula**.
 *
 * O dedup não é zelo: o catálogo tem `UNIQUE(company_id, lower(nome))`, e
 * "Tenis, tenis" digitado no campo de texto derrubaria a criação da empresa
 * inteira com erro de constraint — a transação leva junto o admin inicial e
 * os 7 horários. Vence a primeira grafia digitada.
 */
function nomesDeCatalogo(nomes: string[]): string[] {
  const vistos = new Set<string>();
  const saida: string[] = [];
  for (const bruto of nomes) {
    const nome = bruto.trim();
    if (nome === '') continue;
    const chave = nome.toLowerCase();
    if (vistos.has(chave)) continue;
    vistos.add(chave);
    saida.push(nome);
  }
  return saida;
}

export interface PublicAdminUsuario {
  id: string;
  nome: string;
  email: string;
  role: 'company_admin';
  companyId: string;
}

@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    // SPEC-018/TASK-006: quem resolve `logo_key` -> URL, com o fallback
    // para `logo_url` (AC-013), é um lugar só. Ver `LogoDaEmpresaService`.
    private readonly logos: LogoDaEmpresaService,
  ) {}

  async list(query: ListCompaniesQueryDto) {
    const page = query.page ?? 1;
    const pageSize = query.pageSize ?? 20;

    const [data, total] = await Promise.all([
      this.prisma.empresa.findMany({
        skip: (page - 1) * pageSize,
        take: pageSize,
        orderBy: { createdAt: 'desc' },
        include: COM_CATALOGO,
      }),
      this.prisma.empresa.count(),
    ]);

    return {
      data: data.map((empresa) => this.comLogo(this.comEsportes(empresa))),
      page,
      pageSize,
      total,
    };
  }

  /**
   * Troca a coluna `esportes` pelo catálogo, **mantendo o nome e o formato do
   * campo**. Quem consome não percebe a troca; é essa invisibilidade que
   * libera a TASK-004 para derrubar a coluna.
   *
   * A relação sai da resposta: ela é detalhe de como a lista foi obtida, e
   * mandá-la junto criaria duas fontes para a mesma pergunta — o defeito que
   * esta spec inteira veio desfazer.
   */
  private comEsportes<T extends { esportesQuadra: { nome: string }[] }>(
    empresa: T,
  ): Omit<T, 'esportesQuadra'> & { esportes: string[] } {
    const { esportesQuadra, ...resto } = empresa;
    return { ...resto, esportes: esportesQuadra.map((e) => e.nome) };
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
            // A escrita dupla em `empresas.esportes` viveu entre a TASK-008 e
            // a TASK-004, e acabou: a coluna não existe mais. O campo do
            // SAdmin continua chegando aqui como `dto.esportes` — o que mudou
            // é para onde ele vai.
            //
            // SPEC-020/TASK-008 — o campo do SAdmin passa a SEMEAR o
            // catálogo. Antes, um clube nascia com a lista de esportes numa
            // coluna que nenhuma quadra consultava, e o gestor tinha de
            // cadastrar tudo de novo em `/quadras/catalogos`. Duas listas que
            // não se falam era o estado que a INV-057 condena.
            esportesQuadra: {
              create: nomesDeCatalogo(dto.esportes).map((nome, ordem) => ({
                nome,
                ordem,
              })),
            },
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
    const empresa = await this.prisma.empresa.findUnique({
      where: { id },
      include: COM_CATALOGO,
    });
    if (!empresa) {
      throw new NotFoundException();
    }
    return this.comLogo(this.comEsportes(empresa));
  }

  /**
   * SPEC-018/TASK-006 — troca `logo_key` pela URL pronta e **remove a chave
   * da resposta**.
   *
   * A chave não é segredo (o objeto é público), mas expô-la é dizer ao
   * cliente uma coisa que ele não deve usar: montar URL a partir dela
   * contornaria o `StorageService`, que é justamente quem confere se a chave
   * pertence à empresa (INV-037). O que sai daqui é `logoUrl` — a única
   * forma suportada de desenhar a marca.
   */
  private comLogo<
    T extends { id: string; logoKey: string | null; logoUrl: string | null },
  >(empresa: T): Omit<T, 'logoKey'> {
    const resto = { ...empresa } as Record<string, unknown>;
    delete resto.logoKey;
    return {
      ...(resto as Omit<T, 'logoKey'>),
      logoUrl: this.logos.resolver(empresa).logoUrl,
    };
  }

  /**
   * SPEC-016/AC-001 — os gestores da empresa, para o super admin saber a
   * quem devolver acesso. Sem esta lista, a rota de senha exigiria que ele
   * descobrisse o `usuarioId` de outro jeito, e não há nenhum.
   */
  async listAdmins(companyId: string) {
    await this.findOne(companyId);

    return this.prisma.usuario.findMany({
      where: { companyId, role: 'company_admin' },
      select: {
        id: true,
        nome: true,
        email: true,
        status: true,
        senhaTemporaria: true,
      },
      orderBy: { nome: 'asc' },
    });
  }

  /**
   * SPEC-016/AC-002 — devolve o acesso de um gestor trancado do lado de
   * fora.
   *
   * **A escrita não acontece aqui.** MOD-002 valida o escopo (a empresa
   * existe, o usuário é gestor dela) e **delega** a MOD-001, dono de
   * `usuarios` e `refresh_tokens` (INV-031). É a mesma correção de
   * fronteira que a SPEC-009/REQ-007 fez quando `auth` parou de escrever
   * direto em `alunos`.
   */
  async gerarSenhaTemporariaDeAdmin(companyId: string, usuarioId: string) {
    const empresa = await this.findOne(companyId);

    // 404 e não 403 para usuário de outra empresa ou que não é gestor:
    // 403 confirmaria que o id existe (AC-006).
    const admin = await this.prisma.usuario.findFirst({
      where: { id: usuarioId, companyId, role: 'company_admin' },
      select: { id: true, nome: true, email: true },
    });
    if (!admin) {
      throw new NotFoundException();
    }

    const { senhaTemporaria, expiraEm } =
      await this.auth.gerarSenhaTemporariaParaUsuario({
        usuarioId: admin.id,
        // AC-007b: gestor inativo é recusado, não reativado em silêncio.
        contaInativa: 'rejeitar',
      });

    return {
      usuario: admin,
      senhaTemporaria,
      expiraEm,
      // AC-007 — a senha é gerada, mas não vai funcionar enquanto a empresa
      // estiver inativa: o login recusa antes de olhar a senha. Dizer isso
      // aqui evita o super admin entregar credencial achando que funciona.
      empresaInativa: empresa.status !== 'ativa',
    };
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

    const empresa = await this.prisma.$transaction(async (tx) => {
      if (dto.esportes !== undefined) {
        await this.sincronizarCatalogo(tx, id, dto.esportes);
      }

      return tx.empresa.update({
        where: { id },
        data: {
          nome: dto.nome,
          logoUrl: dto.logoUrl,
          // `dto.esportes` não aparece aqui: desde a TASK-004 ele não tem
          // coluna para ir. Quem o consome é `sincronizarCatalogo`, acima.
        },
        include: COM_CATALOGO,
      });
    });

    // **`comLogo` faltava aqui, e era um vazamento.** `list` e `findOne`
    // removiam `logoKey` da resposta (INV-037) e este método devolvia a linha
    // crua. Invariante cumprida em dois lugares e esquecida no terceiro é a
    // forma mais comum de ela morrer.
    return this.comLogo(this.comEsportes(empresa));
  }

  /**
   * SPEC-020/TASK-008 — o campo do SAdmin substitui a lista, e **substituir
   * não pode furar a INV-055**.
   *
   * A rota `DELETE /court-sports/:id` recusa apagar opção em uso. Se editar a
   * empresa apagasse em silêncio, existiriam dois caminhos para a mesma ação
   * com regras diferentes — e o mais fácil de alcançar seria o sem guarda: a
   * quadra ficaria apontando para o nada, ou a FK derrubaria a edição inteira
   * com uma mensagem sobre constraint que ninguém liga ao campo de texto.
   *
   * Então: acrescenta o que falta, apaga o que sobra **se não estiver em
   * uso**, e recusa com `422` nomeando os esportes que impedem.
   */
  private async sincronizarCatalogo(
    tx: Pick<PrismaService, 'esporteDeQuadra' | 'quadra'>,
    companyId: string,
    pedidos: string[],
  ): Promise<void> {
    const desejados = nomesDeCatalogo(pedidos);
    const atuais = await tx.esporteDeQuadra.findMany({
      where: { companyId },
      select: { id: true, nome: true },
    });

    const chave = (nome: string) => nome.toLowerCase();
    const desejadosPorChave = new Set(desejados.map(chave));
    const atuaisPorChave = new Set(atuais.map((e) => chave(e.nome)));

    const remover = atuais.filter((e) => !desejadosPorChave.has(chave(e.nome)));
    if (remover.length > 0) {
      const emUso = await tx.quadra.findMany({
        where: { esporteId: { in: remover.map((e) => e.id) } },
        select: { esporteId: true },
        distinct: ['esporteId'],
      });
      if (emUso.length > 0) {
        const idsEmUso = new Set(emUso.map((q) => q.esporteId));
        throw new UnprocessableEntityException({
          code: 'ESPORTE_EM_USO',
          message:
            'Não é possível remover esporte que já está em uso por alguma quadra.',
          esportes: remover
            .filter((e) => idsEmUso.has(e.id))
            .map((e) => e.nome),
        });
      }
      await tx.esporteDeQuadra.deleteMany({
        where: { id: { in: remover.map((e) => e.id) } },
      });
    }

    // A `ordem` acompanha a posição digitada — é ela que ordena a barra de
    // filtro do aluno, e o super admin espera que a ordem que ele escreveu
    // seja a que aparece.
    for (const [ordem, nome] of desejados.entries()) {
      if (atuaisPorChave.has(chave(nome))) continue;
      await tx.esporteDeQuadra.create({ data: { companyId, nome, ordem } });
    }
  }

  async updateStatus(id: string, dto: UpdateCompanyStatusDto) {
    await this.findOne(id);

    const empresa = await this.prisma.empresa.update({
      where: { id },
      data: { status: dto.status },
      include: COM_CATALOGO,
    });
    // Mesmo vazamento de `logoKey` que o `update` tinha. Ver ali.
    return this.comLogo(this.comEsportes(empresa));
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
