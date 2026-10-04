import { Prisma } from '@prisma/client';
import type { PrismaService } from '../../prisma/prisma.service';

/**
 * SPEC-081/D2 — **o marcador que abre o texto da consulta do portão.**
 *
 * Os dublês de teste roteiam por ele (`test/utils/portao-no-duble.ts`), e
 * nunca pelo predicado da consulta (DEF-VC031-02): uma sabotagem no `WHERE`
 * não pode mudar de ramo o dublê.
 */
export const MARCADOR_DO_PORTAO = '/* portao-do-usuario */';

/** O que o `JwtAuthGuard` lê do usuário e da empresa, em toda requisição. */
export interface PortaoDoUsuario {
  senhaTemporaria: boolean;
  status: string;
  role: string;
  termoVersaoAceita: number | null;
  contratoVersaoAceita: number | null;
  empresa: { contratoVersaoVigente: number | null; status: string } | null;
}

/**
 * SPEC-081/D2 — **usuário e empresa numa ida ao banco.**
 *
 * Era um `usuario.findUnique` com `select: { empresa: … }`, e o Prisma 6.19
 * sem `relationJoins` resolve isso em DUAS consultas. Aqui é uma, com
 * `LEFT JOIN` porque o `super_admin` não tem empresa. A linha sai no mesmo
 * formato do `findUnique` de antes (a empresa aninhada, ou `null`), para o
 * resto do guard não mudar.
 */
export async function lerPortaoDoUsuario(
  prisma: Pick<PrismaService, '$queryRaw'>,
  usuarioId: string,
): Promise<PortaoDoUsuario | null> {
  const linhas = await prisma.$queryRaw<
    PortaoDoUsuario[]
  >(Prisma.sql`/* portao-do-usuario */
    SELECT u.senha_temporaria AS "senhaTemporaria",
           u.status::text AS status,
           u.role::text AS role,
           u.termo_versao_aceita AS "termoVersaoAceita",
           u.contrato_versao_aceita AS "contratoVersaoAceita",
           CASE WHEN e.id IS NULL THEN NULL
                ELSE json_build_object(
                       'contratoVersaoVigente', e.contrato_versao_vigente,
                       'status', e.status::text)
           END AS empresa
      FROM usuarios u
      LEFT JOIN empresas e ON e.id = u.company_id
     WHERE u.id = ${usuarioId}::uuid`);
  return linhas[0] ?? null;
}
