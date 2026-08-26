import {
  Inject,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { montarChave } from '../storage/chave-de-midia';
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
 * SPEC-018/TASK-004 — a foto do professor, subida pela ficha.
 *
 * **O caso normal é o professor SEM conta**, e é por isso que esta rota
 * existe: `professores.usuario_id` é nulável (decisão 2 da spec), o clube
 * cadastra quem dá aula sem que essa pessoa precise de login, e a foto dela
 * não teria onde morar.
 *
 * ## A INV-034, que é de leitura e não de escrita
 *
 * A foto exibida de um professor é
 * `coalesce(usuarios.foto_key, professores.foto_key)` — **quem tem conta
 * manda na própria imagem** (AC-006). São duas colunas com dois donos:
 *
 * | Coluna | De quem | Quem sobe | Tipo de mídia |
 * |---|---|---|---|
 * | `usuarios.foto_key` | a pessoa | ela mesma, em `/me/foto` | `perfil` |
 * | `professores.foto_key` | a ficha | o gestor, aqui | `professor` |
 *
 * **As duas podem estar preenchidas ao mesmo tempo, e isso não é anomalia —
 * é o fluxo normal do produto.** O professor entra sem conta, o gestor põe a
 * foto na ficha, e mais tarde `POST /teachers/:id/acesso` cria o login. A
 * partir dali ele tem conta e continua tendo a foto da ficha; enquanto não
 * subir a própria, `usuarios.foto_key` é nula e o `coalesce` mostra a do
 * gestor.
 *
 * ## Por que a rota ACEITA professor que já tem conta
 *
 * Era decisão em aberto, e o `STATUS.md` a formulou dizendo que aceitar
 * "grava um objeto que ninguém nunca vai ver". **Isso é falso no caso
 * comum**: só é invisível se a pessoa já tiver subido a própria foto. Se não
 * subiu — e a maioria não sobe — a foto do gestor é justamente a que
 * aparece.
 *
 * Recusar cobraria um preço concreto: o gestor que quer a lista de
 * professores com cara de gente ficaria sem saída para todo professor que
 * tem login e nunca mexeu no perfil. E criaria uma assimetria difícil de
 * explicar, porque **o mesmo professor aceitaria a foto cinco minutos antes
 * de ganhar o acesso e a recusaria cinco minutos depois**, sem que nada
 * sobre ele tivesse mudado.
 *
 * Aceitar não atropela ninguém: a precedência da INV-034 continua valendo, e
 * no dia em que o professor subir a própria foto, a dele ganha.
 */

export const PROFESSOR_DE_OUTRA_EMPRESA = {
  statusCode: 404,
  code: 'PROFESSOR_NAO_ENCONTRADO',
  message: 'Professor não encontrado.',
} as const;

export const MOTIVO_TROCA_FOTO = 'foto_de_professor_trocada';
export const MOTIVO_REMOCAO_FOTO = 'foto_de_professor_removida';

/** O que a ficha e a lista precisam para desenhar o professor. */
export interface FotoDeProfessor {
  /** URL assinada, ou `null` quando não há foto por nenhum dos dois lados. */
  readonly fotoUrl: string | null;
}

export interface ProfessorComFoto {
  readonly id: string;
  readonly companyId: string;
  readonly usuarioId: string | null;
  readonly fotoKey: string | null;
  /** `usuarios.foto_key` do dono da conta, quando há conta. */
  readonly fotoDoUsuario: string | null;
}

@Injectable()
export class FotoDeProfessorService {
  private readonly logger = new Logger(FotoDeProfessorService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly storage: StorageService,
    private readonly fila: FilaDeExclusao,
    @Inject(STORAGE_PROVIDER) private readonly provider: StorageProvider,
  ) {}

  /**
   * **INV-034 num lugar só.** A precedência mora aqui e em nenhum outro
   * lugar: a lista de professores, a ficha e qualquer tela futura chamam
   * este método. Repetido, bastaria uma cópia esquecer a ordem para a foto
   * que a pessoa escolheu sumir atrás da que o gestor subiu.
   *
   * **É fail-soft, e tem de ser.** `urlDeLeitura` lança 404 em chave
   * inválida — o que é certo numa rota de um objeto só, e errado numa
   * listagem: uma linha corrompida derrubaria a página inteira. Aqui o erro
   * vira `null` na tela e linha no log, que é onde alguém pode agir.
   */
  async resolver(professor: ProfessorComFoto): Promise<FotoDeProfessor> {
    // A ordem do `coalesce` (AC-006): a conta ganha da ficha.
    if (professor.fotoDoUsuario !== null && professor.usuarioId !== null) {
      return {
        fotoUrl: await this.assinarOuNulo(
          {
            key: professor.fotoDoUsuario,
            companyId: professor.companyId,
            tipo: 'perfil',
            recursoId: professor.usuarioId,
          },
          { professorId: professor.id, lado: 'usuario' },
        ),
      };
    }

    if (professor.fotoKey !== null) {
      return {
        fotoUrl: await this.assinarOuNulo(
          {
            key: professor.fotoKey,
            companyId: professor.companyId,
            tipo: 'professor',
            recursoId: professor.id,
          },
          { professorId: professor.id, lado: 'ficha' },
        ),
      };
    }

    return { fotoUrl: null };
  }

  async substituir(
    professorId: string,
    ator: AccessTokenPayload,
    corpo: Buffer,
  ): Promise<FotoDeProfessor> {
    const professor = await this.carregar(professorId, ator);

    const validacao = validarWebp(corpo);
    if (!validacao.valido) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: validacao.codigo,
        message: validacao.motivo,
      });
    }

    const sha256 = createHash('sha256').update(corpo).digest('hex');
    // **Sempre `professores.foto_key`, mesmo quando há conta.** O gestor não
    // escreve em `usuarios.foto_key`: aquela coluna é da pessoa, e a tabela
    // de atores da spec dá a foto de perfil a `aluno` e `professor`, cada um
    // na própria. Escrever lá seria o gestor trocando a imagem de alguém.
    const key = montarChave({
      companyId: professor.companyId,
      tipo: 'professor',
      recursoId: professor.id,
      sha256,
    });
    if (key === null) {
      throw new UnprocessableEntityException({
        statusCode: 422,
        code: 'TIPO_DE_MIDIA_DESCONHECIDO',
        message: 'Não foi possível montar a chave da imagem.',
      });
    }

    // Storage primeiro, banco depois — órfão invisível é melhor que
    // referência mentirosa.
    await this.provider.gravar({
      key,
      corpo,
      contentType: 'image/webp',
      visibilidade: this.storage.visibilidadeDoTipo('professor'),
    });

    await this.prisma.$transaction(async (tx) => {
      await tx.professor.update({
        where: { id: professor.id },
        data: { fotoKey: key },
      });
      await this.fila.enfileirar(
        {
          chaveAnterior: professor.fotoKey,
          chaveNova: key,
          motivo: MOTIVO_TROCA_FOTO,
        },
        tx,
      );
    });

    return this.resolver({ ...professor, fotoKey: key });
  }

  /**
   * AC-010 — remover sem substituir.
   *
   * **O `DELETE` não está na tabela de contrato da spec**, que só lista o
   * `PUT` para professor. A adição é deliberada e tem o mesmo lastro da
   * TASK-006: sem ela, quem subisse a foto errada de uma pessoa ficaria com
   * ela até subir outra por cima — e aqui é foto de gente, não logo.
   *
   * **Só apaga `professores.foto_key`.** Se a pessoa tiver a própria foto,
   * ela continua lá e continua sendo a exibida: o gestor não tem como apagar
   * a imagem de perfil de ninguém por esta rota.
   */
  async remover(
    professorId: string,
    ator: AccessTokenPayload,
  ): Promise<FotoDeProfessor> {
    const professor = await this.carregar(professorId, ator);

    if (professor.fotoKey === null) {
      // Idempotente: remover o que não existe é sucesso.
      return this.resolver(professor);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.professor.update({
        where: { id: professor.id },
        data: { fotoKey: null },
      });
      await this.fila.enfileirar(
        {
          chaveAnterior: professor.fotoKey,
          chaveNova: null,
          motivo: MOTIVO_REMOCAO_FOTO,
        },
        tx,
      );
    });

    return this.resolver({ ...professor, fotoKey: null });
  }

  /**
   * Assina, e devolve `null` em vez de estourar quando a chave não confere.
   *
   * O motivo NÃO vai para a resposta — ele distingue "não existe" de "existe
   * e não é sua". Vai para o log, com o id do professor e **qual dos dois
   * lados** falhou, que é o que alguém precisa para achar a linha ruim.
   */
  private async assinarOuNulo(
    pedido: {
      key: string;
      companyId: string;
      tipo: 'perfil' | 'professor';
      recursoId: string;
    },
    contexto: { professorId: string; lado: 'usuario' | 'ficha' },
  ): Promise<string | null> {
    try {
      return await this.storage.urlDeLeitura(pedido);
    } catch {
      this.logger.error({
        evento: 'foto_de_professor_key_invalida',
        companyId: pedido.companyId,
        professorId: contexto.professorId,
        lado: contexto.lado,
      });
      return null;
    }
  }

  /**
   * O escopo. **Professor de outra empresa recebe o mesmo 404 de professor
   * que não existe** (AC-014) — 403 confirmaria que ele existe, e o quadro
   * de professores de um clube é informação daquele clube.
   *
   * O `companyId` vem do **token**, nunca da URL.
   */
  private async carregar(
    professorId: string,
    ator: AccessTokenPayload,
  ): Promise<ProfessorComFoto> {
    if (ator.companyId === null || ator.companyId === undefined) {
      // `super_admin` cai aqui: sem empresa não há chave que se possa montar
      // (LIM-005).
      throw new NotFoundException(PROFESSOR_DE_OUTRA_EMPRESA);
    }

    const professor = await this.prisma.professor.findFirst({
      where: { id: professorId, companyId: ator.companyId },
      select: {
        id: true,
        companyId: true,
        usuarioId: true,
        fotoKey: true,
        usuario: { select: { fotoKey: true } },
      },
    });

    if (professor === null) {
      throw new NotFoundException(PROFESSOR_DE_OUTRA_EMPRESA);
    }

    return {
      id: professor.id,
      companyId: professor.companyId,
      usuarioId: professor.usuarioId,
      fotoKey: professor.fotoKey,
      fotoDoUsuario: professor.usuario?.fotoKey ?? null,
    };
  }
}
