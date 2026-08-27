import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * SPEC-021/TASK-005 — o **contrato de resposta de `companies`**, consumido
 * inteiro pelo SAdmin.
 *
 * ## O campo que este arquivo existe para explicar
 *
 * `esportes: string[]` **não é uma coluna desde 2026-08-26**. A
 * SPEC-020/TASK-004 derrubou `empresas.esportes`, e a TASK-008 preservou o
 * campo na resposta projetando o catálogo `esportes_de_quadra` no mesmo nome
 * e no mesmo formato — de propósito, para que a coluna pudesse cair sem
 * quebrar a lista do SAdmin, que faz `empresa.esportes.join(", ")`.
 *
 * Deu certo: foi a única tela dos quatro repositórios que atravessou a
 * SPEC-020 sem alteração. **E foi construído, não sorte** — se `esportes`
 * tivesse virado array de objetos, aquela lista quebraria exatamente como o
 * app do aluno quebrou no DEF-012.
 *
 * O que faltava era isto: a decisão morava num comentário de
 * `companies.service.ts` e num parágrafo da planta do SAdmin. Agora está no
 * contrato publicado, onde quem gera tipo enxerga.
 */

export class EmpresaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Smart Tennis' })
  nome!: string;

  /** SPEC-009: identifica a empresa no link público `/cadastro/<slug>`. */
  @ApiProperty({ type: String, example: 'smart-tennis' })
  slug!: string;

  /**
   * **Projeção do catálogo, não coluna.** Ver o bloco no topo do arquivo.
   *
   * Vem ordenada por `ordem` do catálogo, e é a mesma lista que o gestor
   * edita no Admin, na tela de esportes e pisos. Escrever este campo num
   * `POST`/`PATCH` de empresa **semeia o catálogo**.
   */
  @ApiProperty({ type: [String], example: ['Tênis', 'Padel'] })
  esportes!: string[];

  /**
   * SPEC-018/TASK-006 — **`logoKey` nunca sai; `logoUrl` sai.**
   *
   * A chave não é segredo, mas publicá-la convida a montar URL por fora e
   * contornar o `StorageService`, que é quem confere se ela pertence à
   * empresa (INV-037). Mesma regra do `fotoUrl` de professor.
   */
  @ApiProperty({ type: String, nullable: true })
  logoUrl!: string | null;

  @ApiProperty({ type: String, enum: ['ativa', 'inativa'] })
  status!: string;

  /**
   * SPEC-009/REQ-006 (ADR-013) — a empresa decide se aceita auto-cadastro
   * público. Ligado por padrão, e seguro porque quem se auto-cadastra nasce
   * `pendente` (INV-010).
   *
   * **Este campo é lido e nunca escrito por rota nenhuma** — o REQ-006 segue
   * em aberto, registrado em `STATUS.md`. O contrato o publica como ele é:
   * quem consome consegue mostrá-lo, e não consegue mudá-lo.
   */
  @ApiProperty({ type: Boolean })
  permiteAutoCadastro!: boolean;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class EmpresaPaginadaResponseDto {
  @ApiProperty({ type: [EmpresaResponseDto] })
  data!: EmpresaResponseDto[];

  @ApiProperty({ type: Number, example: 1 })
  page!: number;

  @ApiProperty({ type: Number, example: 20 })
  pageSize!: number;

  @ApiProperty({ type: Number, example: 7 })
  total!: number;
}

/** O gestor inicial, como ele volta na criação da empresa. */
export class AdminInicialResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  @ApiProperty({ type: String, enum: ['company_admin'] })
  role!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  companyId!: string;
}

export class EmpresaCriadaResponseDto {
  @ApiProperty({ type: EmpresaResponseDto })
  empresa!: EmpresaResponseDto;

  /**
   * **A empresa e o gestor nascem juntos ou nenhum dos dois** (NFR-002): a
   * criação é transacional, e por isso a resposta traz os dois. Devolver só
   * a empresa faria o SAdmin ter de procurar o gestor que ele acabou de
   * criar.
   */
  @ApiProperty({ type: AdminInicialResponseDto })
  adminUsuario!: AdminInicialResponseDto;
}

/**
 * SPEC-016/AC-001 — os gestores da empresa, para o super admin saber a quem
 * devolver acesso.
 *
 * `senhaTemporaria` aqui é **booleano**, não a senha: diz se aquela conta
 * está em primeiro acesso. A senha em si só existe na resposta que a gerou
 * (`SenhaDeAdminResponseDto`), e nunca numa listagem.
 */
export class AdminDaEmpresaResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;

  @ApiProperty({ type: String, enum: ['ativo', 'inativo'] })
  status!: string;

  @ApiProperty({ type: Boolean })
  senhaTemporaria!: boolean;
}

/** A conta que recebeu a senha, na resposta que a gerou. */
export class ContaDeAdminResponseDto {
  @ApiProperty({ type: String, format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, example: 'Ana Souza' })
  nome!: string;

  @ApiProperty({ type: String, format: 'email' })
  email!: string;
}

export class SenhaDeAdminResponseDto {
  @ApiProperty({ type: ContaDeAdminResponseDto })
  usuario!: ContaDeAdminResponseDto;

  /** SPEC-016 — **uma vez só.** Nenhuma outra rota devolve este valor. */
  @ApiProperty({ type: String, example: 'pck-Xk4p-9Qm2' })
  senhaTemporaria!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  expiraEm!: Date;

  /**
   * SPEC-016/AC-007 — **a senha é gerada e não vai funcionar** enquanto a
   * empresa estiver inativa: o login recusa antes de olhar a senha.
   *
   * Está na resposta para o super admin não entregar credencial achando que
   * funciona. É informação que só existe no momento da geração, e por isso
   * não cabe em nenhum outro DTO.
   */
  @ApiProperty({ type: Boolean })
  empresaInativa!: boolean;
}

/** Ver `SenhaDeAdminResponseDto`: mesma forma, sem o campo de empresa. */
export class SenhaTemporariaDeContaResponseDto {
  @ApiProperty({ type: String })
  senhaTemporaria!: string;

  @ApiPropertyOptional({ type: String, format: 'date-time' })
  expiraEm?: Date;
}
