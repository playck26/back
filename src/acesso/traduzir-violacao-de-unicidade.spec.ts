import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  CONVITE_EM_EMISSAO,
  EMAIL_EM_USO,
  ehViolacaoDeEmail,
  traduzirViolacaoDeUnicidade,
} from './traduzir-violacao-de-unicidade';

/**
 * SPEC-083/D9 — o tradutor por constraint, sem banco (AC-043, a parte de
 * unidade).
 *
 * Os `meta` abaixo são **os medidos** contra o Postgres local pela API de
 * modelo (o cabeçalho do tradutor tem a tabela), e não uma forma imaginada.
 * Quem prova que o Prisma continua entregando esta forma é o
 * `test/banco/spec-083-corrida-do-professor.db-spec.ts`, com erros reais: se
 * ela mudar, aquele fica vermelho, e não este.
 *
 * **Os casos que não traduzem são escolhidos para separar leituras erradas.**
 * O `UNIQUE` de `professores.usuario_id` tem a coluna do índice de convite; a
 * PK de `usuarios` e o `UNIQUE` do token têm o modelo de uma das traduzidas.
 * Um tradutor que lesse só a coluna, só o modelo, ou só o código (S9), erra
 * pelo menos um deles.
 */

function p2002(meta: unknown): Prisma.PrismaClientKnownRequestError {
  return new Prisma.PrismaClientKnownRequestError(
    'Unique constraint failed on the fields',
    {
      code: 'P2002',
      clientVersion: Prisma.prismaVersion.client,
      meta: meta as Record<string, unknown>,
    },
  );
}

/** O corpo que a resposta HTTP levaria. */
function corpoDe(traduzido: unknown): unknown {
  expect(traduzido).toBeInstanceOf(ConflictException);
  return (traduzido as ConflictException).getResponse();
}

const MEDIDOS = {
  // SPEC-086 — o `['email']` agora é o índice parcial de gestão
  // (`usuarios_email_gestao_key`), e o por empresa tem as duas colunas.
  emailDaConta: { modelName: 'Usuario', target: ['email'] },
  emailNaEmpresa: { modelName: 'Usuario', target: ['company_id', 'email'] },
  conviteVivo: { modelName: 'ConviteDeAcesso', target: ['usuario_id'] },
  pkDaConta: { modelName: 'Usuario', target: ['id'] },
  vinculoDoProfessor: { modelName: 'Professor', target: ['usuario_id'] },
  tokenDoConvite: { modelName: 'ConviteDeAcesso', target: ['token_hash'] },
} as const;

describe('SPEC-083 — traduzirViolacaoDeUnicidade (D9)', () => {
  it.each([
    ['usuarios_email_gestao_key (Usuario, [email])', MEDIDOS.emailDaConta],
    [
      'usuarios_company_id_email_key (Usuario, [company_id, email])',
      MEDIDOS.emailNaEmpresa,
    ],
  ])('SPEC-086: %s → 409 EMAIL_EM_USO', (_nome, meta) => {
    const traduzido = traduzirViolacaoDeUnicidade(p2002(meta));
    expect((traduzido as ConflictException).getStatus()).toBe(409);
    expect(corpoDe(traduzido)).toEqual({
      statusCode: 409,
      code: 'EMAIL_EM_USO',
      message:
        'Este e-mail já tem conta nesta empresa ou pertence a um gestor.',
    });
  });

  it('SPEC-086: o EXCLUDE de gestão × aluno (Unknown, com o nome da constraint) → 409 EMAIL_EM_USO', () => {
    const erro = new Prisma.PrismaClientUnknownRequestError(
      String.raw`Error occurred during query execution: ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23P01", message: "conflicting key value violates exclusion constraint \"usuarios_email_gestao_excl\"", severity: "ERROR", detail: None, column: None, hint: None }), transient: false })`,
      { clientVersion: Prisma.prismaVersion.client },
    );
    expect(corpoDe(traduzirViolacaoDeUnicidade(erro))).toMatchObject({
      code: 'EMAIL_EM_USO',
    });
    expect(ehViolacaoDeEmail(erro)).toBe(true);
  });

  /**
   * IMP-086-R1-01 — mensagens na forma REAL medida em 2026-10-08
   * (`errorFormat: 'minimal'`; o padrão só acrescenta o trecho de código antes
   * de "Error occurred"). O `detail` traz o dado da linha, com as aspas
   * escapadas pelo `Debug` do Rust.
   */
  const unknownMedido = (constraint: string, detail: string) =>
    new Prisma.PrismaClientUnknownRequestError(
      '\nInvalid `prisma.usuario.create()` invocation:\n\n\nError occurred during query execution:\n' +
        String.raw`ConnectorError(ConnectorError { user_facing_error: None, kind: QueryError(PostgresError { code: "23P01", message: "conflicting key value violates exclusion constraint \"` +
        constraint +
        String.raw`\"", severity: "ERROR", detail: Some("` +
        detail +
        String.raw`"), column: None, hint: None }), transient: false })`,
      { clientVersion: Prisma.prismaVersion.client },
    );

  it('IMP-086-R1-01: o EXCLUDE de e-mail na forma real medida → 409', () => {
    const erro = unknownMedido(
      'usuarios_email_gestao_excl',
      String.raw`Key (email, (role = ANY (ARRAY['super_admin'::usuario_role, 'company_admin'::usuario_role])))=(x@t.local, f) conflicts with existing key (email, (role = ANY (ARRAY['super_admin'::usuario_role, 'company_admin'::usuario_role])))=(x@t.local, t).`,
    );
    expect(ehViolacaoDeEmail(erro)).toBe(true);
    expect(corpoDe(traduzirViolacaoDeUnicidade(erro))).toMatchObject({
      code: 'EMAIL_EM_USO',
    });
  });

  it.each([
    [
      'o nome exato no dado',
      'Key (nome)=(usuarios_email_gestao_excl) conflicts with existing key (nome)=(usuarios_email_gestao_excl).',
    ],
    [
      'a frase inteira com aspas no dado',
      String.raw`Key (nome)=(violates exclusion constraint \"usuarios_email_gestao_excl\") conflicts with existing key (nome)=(violates exclusion constraint \"usuarios_email_gestao_excl\").`,
    ],
    [
      'o trecho do campo message inteiro no dado',
      String.raw`Key (nome)=(PostgresError { code: \"23P01\", message: \"conflicting key value violates exclusion constraint \\\"usuarios_email_gestao_excl\\\"\", severity: \"ERROR\") conflicts with existing key (nome)=(x).`,
    ],
  ])(
    'IMP-086-R1-01: EXCLUDE alheio com %s NÃO vira 409, sobe intacto',
    (_nome, detail) => {
      const erro = unknownMedido('review086_exclude_alheio', detail);
      expect(erro.message).toContain('usuarios_email_gestao_excl');
      expect(ehViolacaoDeEmail(erro)).toBe(false);
      expect(traduzirViolacaoDeUnicidade(erro)).toBe(erro);
    },
  );

  it.each([
    ['um CHECK', 'violates check constraint "usuarios_company_id_role_check"'],
    ['outro EXCLUDE', 'violates exclusion constraint "outro_excl"'],
    [
      'nome parecido',
      'violates exclusion constraint "usuarios_email_gestao_excl_v2"',
    ],
  ])(
    'SPEC-086/S4: Unknown de %s NÃO é violação de e-mail, e sobe intacto',
    (_nome, mensagem) => {
      const erro = new Prisma.PrismaClientUnknownRequestError(mensagem, {
        clientVersion: Prisma.prismaVersion.client,
      });
      expect(ehViolacaoDeEmail(erro)).toBe(false);
      expect(traduzirViolacaoDeUnicidade(erro)).toBe(erro);
    },
  );

  it('convites_de_acesso_um_vivo_por_usuario (ConviteDeAcesso, [usuario_id]) → 409 CONVITE_EM_EMISSAO', () => {
    const traduzido = traduzirViolacaoDeUnicidade(p2002(MEDIDOS.conviteVivo));
    expect((traduzido as ConflictException).getStatus()).toBe(409);
    expect(corpoDe(traduzido)).toEqual({
      statusCode: 409,
      code: 'CONVITE_EM_EMISSAO',
      message:
        'Outro convite para esta pessoa está sendo emitido agora. Tente de novo.',
    });
  });

  it('S9 — as duas traduzidas dão códigos DIFERENTES (um tradutor que olhasse só o P2002 não passa)', () => {
    const codigos = [MEDIDOS.emailDaConta, MEDIDOS.conviteVivo].map(
      (meta) =>
        (corpoDe(traduzirViolacaoDeUnicidade(p2002(meta))) as { code: string })
          .code,
    );
    expect(codigos).toEqual(['EMAIL_EM_USO', 'CONVITE_EM_EMISSAO']);
  });

  it('os corpos são os exportados, os mesmos objetos congelados', () => {
    expect(
      corpoDe(traduzirViolacaoDeUnicidade(p2002(MEDIDOS.emailDaConta))),
    ).toBe(EMAIL_EM_USO);
    expect(
      corpoDe(traduzirViolacaoDeUnicidade(p2002(MEDIDOS.conviteVivo))),
    ).toBe(CONVITE_EM_EMISSAO);
    expect(Object.isFrozen(EMAIL_EM_USO)).toBe(true);
    expect(Object.isFrozen(CONVITE_EM_EMISSAO)).toBe(true);
  });

  it.each([
    [
      'professores_usuario_id_key — a MESMA coluna do índice de convite, noutro modelo',
      MEDIDOS.vinculoDoProfessor,
    ],
    [
      'usuarios_pkey — o MESMO modelo do e-mail, noutra coluna',
      MEDIDOS.pkDaConta,
    ],
    [
      'convites_de_acesso_token_hash_key — o MESMO modelo do índice, noutra coluna',
      MEDIDOS.tokenDoConvite,
    ],
  ])('%s → sobe sem tradução (o próprio erro)', (_nome, meta) => {
    const original = p2002(meta);
    expect(traduzirViolacaoDeUnicidade(original)).toBe(original);
  });

  it.each([
    ['sem meta', undefined],
    ['target ausente', { modelName: 'Usuario' }],
    [
      'target como texto (a forma de outras versões e bancos)',
      { modelName: 'Usuario', target: 'usuarios_email_key' },
    ],
    [
      'colunas a mais (as colunas são comparadas exatas)',
      { modelName: 'Usuario', target: ['email', 'company_id'] },
    ],
    [
      'colunas em outra ordem',
      { modelName: 'ConviteDeAcesso', target: ['company_id', 'usuario_id'] },
    ],
    ['modelo ausente', { target: ['email'] }],
  ])(
    'forma fora da medida (%s) → sobe sem tradução, o lado seguro',
    (_nome, meta) => {
      const original = p2002(meta);
      expect(traduzirViolacaoDeUnicidade(original)).toBe(original);
    },
  );

  it('outro código do Prisma, com o mesmo meta (P2003, P2025) → sobe sem tradução', () => {
    for (const code of ['P2003', 'P2025']) {
      const original = new Prisma.PrismaClientKnownRequestError('outro', {
        code,
        clientVersion: Prisma.prismaVersion.client,
        meta: MEDIDOS.emailDaConta,
      });
      expect(traduzirViolacaoDeUnicidade(original)).toBe(original);
    }
  });

  it('um objeto que só PARECE o erro do Prisma (não é PrismaClientKnownRequestError) → sobe sem tradução', () => {
    // A classe é parte do que foi medido. Um `{code: 'P2002'}` montado à mão
    // não veio do banco, e traduzi-lo seria responder por palpite.
    const imitacao = { code: 'P2002', meta: MEDIDOS.emailDaConta };
    expect(traduzirViolacaoDeUnicidade(imitacao)).toBe(imitacao);
  });

  it('qualquer outra coisa lançada (Error, texto, nulo) → devolvida intacta', () => {
    const erro = new Error('outra falha');
    expect(traduzirViolacaoDeUnicidade(erro)).toBe(erro);
    expect(traduzirViolacaoDeUnicidade('texto')).toBe('texto');
    expect(traduzirViolacaoDeUnicidade(null)).toBeNull();
  });
});
