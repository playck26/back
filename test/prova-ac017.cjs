/**
 * SPEC-068/AC-017 — **o rollout, nas duas fases, com o cliente ANTERIOR.**
 *
 * Prova de rodada, não gate de CI: gerar o cliente de um SHA antigo custa uma
 * geração e um diretório temporário. Roda **de dentro de `apps/Back`** porque
 * o Node resolve dependência a partir do diretório DO ARQUIVO (CLAUDE.md).
 *
 * Fase 1 — migration antes do código é segura **enquanto ninguém grava o valor
 * novo**: o cliente anterior lê e escreve normalmente no banco migrado.
 * Fase 2 — depois da primeira gravação, o cliente anterior **quebra a consulta
 * inteira**, e não só a linha nova. É por isso que o rollback é para a frente.
 *
 * uso: DATABASE_URL=... node prova-ac017.cjs <caminho-do-cliente-antigo>
 */
const { randomUUID } = require('node:crypto');

const caminho = process.argv[2];
if (!caminho) {
  console.error('uso: node prova-ac017.cjs <caminho-do-cliente-antigo>');
  process.exit(2);
}

const { PrismaClient } = require(caminho);
const antigo = new PrismaClient();

const EMPRESA = randomUUID();
const USUARIO = randomUUID();
// SPEC-069/INV-069a — o alvo das acoes desta prova. Elas nasciam nuas, e o
// `acao_exige_alvo` recusa isso no COMMIT; agora cada uma vem com um evento
// sobre esta ocupacao, na MESMA transacao. A prova do enum nao enfraquece: o
// cliente antigo continua lendo o tipo conhecido e falhando no valor novo,
// que e o que ela mede.
const ESPORTE = randomUUID();
const QUADRA = randomUUID();
const OCUPACAO = randomUUID();

/** Uma acao COM efeito, como o produto sempre gravou. */
async function acaoComEvento(tipo) {
  const acaoId = randomUUID();
  await antigo.$transaction(async (tx) => {
    await tx.$executeRawUnsafe(
      `INSERT INTO acoes_administrativas (id,company_id,tipo,autor_id,criado_em)
       VALUES ('${acaoId}','${EMPRESA}','${tipo}','${USUARIO}',now())`,
    );
    await tx.$executeRawUnsafe(
      `INSERT INTO eventos_de_ocupacao (id,company_id,acao_id,ocupacao_id,tipo,transicao_id)
       VALUES (gen_random_uuid(),'${EMPRESA}','${acaoId}','${OCUPACAO}','criada',gen_random_uuid())`,
    );
  });
  return acaoId;
}

async function main() {
  await antigo.$executeRawUnsafe(
    `INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${EMPRESA}','AC-017','ac017-${EMPRESA}',now())`,
  );
  await antigo.$executeRawUnsafe(
    `INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at)
     VALUES ('${USUARIO}','ac017-${USUARIO}@teste.local','x','Gestor','company_admin','${EMPRESA}',now())`,
  );
  await antigo.$executeRawUnsafe(
    `INSERT INTO esportes_de_quadra (id,company_id,nome,ordem,created_at)
     VALUES ('${ESPORTE}','${EMPRESA}','Tenis',0,now())`,
  );
  await antigo.$executeRawUnsafe(
    `INSERT INTO quadras (id,company_id,nome,esporte_id,preco_hora)
     VALUES ('${QUADRA}','${EMPRESA}','Q1','${ESPORTE}',100)`,
  );
  await antigo.$executeRawUnsafe(
    `INSERT INTO ocupacoes_quadra
       (id,company_id,quadra_id,data,hora_inicio,hora_fim,origem_tipo,updated_at,valor)
     VALUES ('${OCUPACAO}','${EMPRESA}','${QUADRA}',DATE '2038-01-01',TIME '08:00',TIME '09:00','AVULSO',now(),80)`,
  );

  // ---- FASE 1 ----------------------------------------------------------
  // O cliente anterior grava uma ação de um tipo que ELE conhece, e lê.
  const acaoConhecida = await acaoComEvento('turma_criada');
  const antes = await antigo.acaoAdministrativa.findMany({
    where: { companyId: EMPRESA },
    select: { tipo: true },
  });
  console.log('FASE1_LINHAS=' + antes.length + ' TIPOS=' + antes.map((a) => a.tipo).join(','));

  // E o CHECK novo não atrapalha o que o código anterior escreve: aviso de
  // gesto continua entrando (o CHECK só fala de `avaliacao_baixa`).
  await antigo.$executeRawUnsafe(
    `INSERT INTO notificacoes (id,company_id,destinatario_id,origem_id,tipo,titulo,corpo)
     VALUES ('${randomUUID()}','${EMPRESA}','${USUARIO}','${acaoConhecida}','gesto','Sua turma','x')`,
  );
  const avisos = await antigo.notificacao.count({ where: { companyId: EMPRESA } });
  console.log('FASE1_AVISO_DO_CODIGO_ANTIGO=' + avisos);

  // ---- FASE 2 ----------------------------------------------------------
  // Agora existe UMA linha com o valor novo, gravada por SQL (como o código
  // novo faria em produção).
  await acaoComEvento('turma_professor_alterado');

  let linhas = null;
  let erro = null;
  try {
    linhas = await antigo.acaoAdministrativa.findMany({
      where: { companyId: EMPRESA },
      select: { tipo: true },
    });
  } catch (e) {
    erro = e.message.replace(/\s+/g, ' ').slice(-160);
  }
  console.log(
    'FASE2_LINHAS=' + (linhas === null ? 'NENHUMA' : linhas.length) +
      ' ERRO=' + (erro === null ? 'NENHUM' : erro),
  );
}

main()
  .then(async () => {
    // **Sem limpeza, e de propósito.** A primeira versão apagava as linhas no
    // fim e morreu com `23514`: `acoes_administrativas` é **append-only**
    // (SPEC-032/INV-061), e a trigger recusou o DELETE. O gate está certo e a
    // prova é que estava errada — o banco desta prova é descartável.
    await antigo.$disconnect();
  })
  .catch(async (e) => {
    console.error('FALHOU:', e.message);
    await antigo.$disconnect();
    process.exitCode = 1;
  });
