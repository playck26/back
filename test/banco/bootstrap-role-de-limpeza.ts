import { PrismaClient } from '@prisma/client';
import { exigirBancoLocal } from './exigir-banco-local';

/**
 * SPEC-032/TASK-005 — a role que abre a válvula da limpeza.
 *
 * ## Por que existe uma role, e não só uma configuração de sessão
 *
 * As tabelas de auditoria são append-only por trigger (INV-061). A limpeza
 * das suítes precisa apagá-las — e a válvula original era só um GUC de
 * transação:
 *
 * ```sql
 * SELECT set_config('playck.limpeza_append_only','on',true);
 * DELETE FROM eventos_de_ocupacao WHERE ...;
 * ```
 *
 * **A 3ª rodada de validação cruzada derrubou isso**, e o argumento é bom:
 * `set_config` é chamável por qualquer código, o nome do GUC está escrito na
 * migration à vista de todos, e `exigirBancoLocal` protege o `limparEmpresa`
 * — **não a trigger**. Aquilo teria funcionado em produção. Eu tinha trocado
 * uma janela temporal (processo morto antes do `ENABLE TRIGGER`) por uma
 * **porta permanente**.
 *
 * Com a role, a porta não existe onde importa: a trigger exige **as duas**
 * coisas, e `playck_test_cleanup` só é criada aqui, num banco que
 * `exigirBancoLocal` garante não ser produção.
 *
 * ## O limite, declarado
 *
 * Isto protege contra **engano**, não contra intenção: quem tem poder de
 * `ALTER TABLE` em produção pode desabilitar a trigger de qualquer jeito. O
 * que a role fecha é o caminho realista — código de aplicação que um dia
 * copie o `set_config` da migration achando que é assim que se apaga.
 */
export default async function bootstrapRoleDeLimpeza(): Promise<void> {
  // Primeiro a trava. Criar role é DDL, e DDL no banco errado é o incidente
  // de 2026-08-24 com outra roupa.
  exigirBancoLocal();

  const prisma = new PrismaClient();
  try {
    await prisma.$executeRawUnsafe(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'playck_test_cleanup') THEN
          CREATE ROLE playck_test_cleanup NOLOGIN;
        END IF;
      END $$;
    `);
    // A suíte conecta como dona do schema; para `SET LOCAL ROLE` funcionar,
    // ela precisa ser MEMBRO da role.
    await prisma.$executeRawUnsafe(`GRANT playck_test_cleanup TO CURRENT_USER`);
    // E a role precisa poder apagar — depois do `SET ROLE` quem escreve é ela.
    await prisma.$executeRawUnsafe(
      `GRANT ALL ON ALL TABLES IN SCHEMA public TO playck_test_cleanup`,
    );
    await prisma.$executeRawUnsafe(
      `GRANT USAGE ON SCHEMA public TO playck_test_cleanup`,
    );
  } finally {
    await prisma.$disconnect();
  }
}
