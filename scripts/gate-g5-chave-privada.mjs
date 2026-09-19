#!/usr/bin/env node
// SPEC-062/TASK-006 — **G5: exatamente UM leitor da chave privada.**
//
// ## Por que "exatamente um" é regra, e não preferência
//
// Leitura espalhada é como um `console.log` de depuração acaba imprimindo
// segredo. Com um lugar só, quem for mexer na chave privada tropeça no
// docblock que explica por que ela não pode sair dali; com cinco, ninguém
// tropeça em nada.
//
// É o gate **G5** da D1d. Os irmãos dele (G1–G4) moram nos frontends, porque é
// lá que a chave **não pode chegar**; este mora aqui, porque é aqui que ela
// legitimamente vive — e o que se confere é a concentração, não a ausência.
//
// ## O que ele NÃO faz
//
// Não confere o valor, não lê `.env`, não toca em nada configurado. Só conta
// arquivos que **citam o nome**. É de propósito: gate que precisa do segredo
// para funcionar multiplica os lugares onde o segredo está.

import { execFileSync } from "node:child_process";

const PAPEL = "PUSH_VAPID_PRIVATE_KEY";
const ESPERADO = "src/push/vapid.config.ts";

function arquivosQueCitam() {
  try {
    return execFileSync("git", ["grep", "-l", "-F", PAPEL, "--", "src"], {
      encoding: "utf8",
    })
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      // Arquivo de teste cita o nome legitimamente (`vapid.config.spec.ts`
      // prova que faltar variável derruba o serviço) e **não vai para
      // produção**. A primeira versão deste gate não excluía, e reprovava a
      // própria prova da invariante — gate que reprova o que deveria proteger
      // é gate que alguém desliga.
      .filter((a) => !a.endsWith(".spec.ts"));
  } catch {
    // `git grep` sai com 1 quando não acha nada.
    return [];
  }
}

const achados = arquivosQueCitam();

if (achados.length === 1 && achados[0] === ESPERADO) {
  console.log(`G5 OK: ${PAPEL} é lido em ${ESPERADO}, e só ali.`);
  process.exit(0);
}

console.error("G5 REPROVOU.\n");

if (achados.length === 0) {
  console.error(
    `Nenhum arquivo de src/ cita ${PAPEL}.\n` +
      "Ou o módulo de push saiu, ou o papel foi renomeado. Se foi renomeado,\n" +
      "este gate precisa ser atualizado junto — um gate que procura um nome\n" +
      "que não existe mais passa sempre, e cala para sempre.",
  );
} else {
  console.error(
    `Esperado exatamente 1 leitor (${ESPERADO}), encontrados ${achados.length}:`,
  );
  for (const a of achados) console.error(`  ${a}`);
  console.error(
    "\nINV-062b — a chave privada não sai do servidor, e a leitura dela fica\n" +
      "concentrada em um módulo só. Se o leitor novo é legítimo, mova a leitura\n" +
      "para o módulo de configuração e injete o valor.",
  );
}

process.exit(1);
