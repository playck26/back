-- SABOTAGEM (SPEC-043/AC-002) -- NAO MERGEAR. Derruba a EXCLUDE da INV-001;
-- o fit-critical tem de cair no cenario (a) com 201/201.
ALTER TABLE "ocupacoes_quadra" DROP CONSTRAINT "no_overlap_por_quadra";
