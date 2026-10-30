-- SPEC-093/D1 — clube novo nasce LIBERADO: o nível é só um rótulo até o gestor
-- ligar a restrição pela tela de Níveis (decisão do Israel, 2026-10-29: "um
-- clube novo é o padrão, sempre liberado").
--
-- Só troca o `DEFAULT`. `ALTER COLUMN ... SET DEFAULT` não reescreve linha
-- nenhuma: os clubes que já existem ficam com o valor que têm (AC-001).
ALTER TABLE "empresas"
  ALTER COLUMN "nivel_restringe_acesso" SET DEFAULT false;
