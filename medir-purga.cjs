/**
 * SPEC-065/AC-022 — o plano da purga, MEDIDO.
 *
 * A D8 aposta que nao vale um indice de purga: ela roda de hora em hora, com
 * teto por lote, e um indice a mais custaria escrita em todo INSERT da fila.
 * **E uma aposta, e ninguem tinha medido.**
 */
const { PrismaClient } = require('@prisma/client');
const { randomUUID } = require('node:crypto');
const db = new PrismaClient();

(async () => {
  const cid = randomUUID(), uid = randomUUID();
  await db.$executeRawUnsafe(`INSERT INTO empresas (id,nome,slug,updated_at) VALUES ('${cid}','M ${cid.slice(0,6)}','m-${cid.slice(0,8)}',now())`);
  await db.$executeRawUnsafe(`INSERT INTO usuarios (id,email,senha_hash,nome,role,company_id,updated_at) VALUES ('${uid}','m-${uid.slice(0,8)}@x.y','h','A','aluno','${cid}',now())`);

  // **O caso NORMAL da purga e achar pouco ou nada.** Ela roda de hora em
  // hora; so a primeira de cada dia tem trabalho. Com poucos elegiveis, o
  // LIMIT nao ajuda -- a varredura tem de ir ate o fim para se convencer.
  for (const [n, elegiveis] of [[10_000, 10], [50_000, 10], [200_000, 10], [50_000, 25_000]]) {
    await db.$executeRawUnsafe(`DELETE FROM notificacoes WHERE company_id='${cid}'`);
    // Metade elegivel (velha e terminal), metade nao -- o caso realista.
    await db.$executeRawUnsafe(`INSERT INTO notificacoes
      (id,company_id,destinatario_id,origem_id,tipo,titulo,corpo,criada_em,estado,concluida_em)
      SELECT gen_random_uuid(),'${cid}','${uid}',gen_random_uuid(),'gesto','Sua aula','a'||g,
             now() - (CASE WHEN g <= ${elegiveis} THEN interval '100 days' ELSE interval '10 days' END),
             'aceita_pelo_servico'::estado_da_notificacao, now()
        FROM generate_series(1,${n}) g`);
    await db.$executeRawUnsafe('ANALYZE notificacoes');

    const [p] = await db.$queryRawUnsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id FROM notificacoes
       WHERE concluida_em IS NOT NULL AND criada_em < now() - interval '90 days'
       LIMIT 5000`);
    const plan = p['QUERY PLAN'][0];
    const no = plan.Plan.Plans ? plan.Plan.Plans[0] : plan.Plan;
    console.log(`${String(n).padStart(7)} linhas, ${String(elegiveis).padStart(5)} elegiveis | ${no['Node Type']}${no['Index Name'] ? ' ('+no['Index Name']+')' : ''}` +
      ` | ${plan['Execution Time'].toFixed(1)} ms` +
      ` | buffers lidos=${(no['Shared Hit Blocks']||0)+(no['Shared Read Blocks']||0)}`);
  }
  await db.$executeRawUnsafe(`DELETE FROM notificacoes WHERE company_id='${cid}'`);
  await db.$disconnect();
})().catch(e => { console.error(e.message.slice(0,400)); process.exit(1); });
