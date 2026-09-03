/**
 * SPEC-017 — trava de segurança das suítes de banco.
 *
 * **Achado operacional da validação cruzada de 2026-08-24.** Rodando
 * `pnpm test:banco` sem `DATABASE_URL` explícito, o `.env` real é carregado
 * e a suíte aponta para o **Neon de produção**.
 *
 * Isso nunca foi teórico: `matriz-raiz` e `fit-005` criam empresa, quadra,
 * turma, aluno e presença, e apagam tudo no fim. Contra produção, isso é
 * escrita em dado real — e um `afterAll` que não roda porque o teste quebrou
 * deixa lixo lá dentro.
 *
 * A trava é chata de propósito: falha ANTES de abrir conexão, e a mensagem
 * diz o comando certo. Nenhuma suíte de banco deve rodar sem passar por ela.
 */
// Id do endpoint Neon de produção (`ep-bitter-cake-ac2vk5uy`). Está aqui
// de propósito, como denylist: nenhuma variável de ambiente abre esta porta.
const ENDPOINT_DE_PRODUCAO = 'bitter-cake';

const HOSTS_PERMITIDOS = new Set([
  'localhost',
  '127.0.0.1',
  '::1',
  '[::1]',
  'postgres', // nome de serviço, quando o runner roda em rede de container
  'db',
]);

export function exigirBancoLocal(): void {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL não definida. As suítes de banco exigem Postgres ' +
        'local/efêmero explícito — nunca o `.env` real.',
    );
  }

  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    throw new Error('DATABASE_URL não é uma URL válida.');
  }

  // SPEC-043 — o canário Neon (`db-migrate.yml`, jobs `fit-00x-neon`) roda
  // as suítes FIT contra o banco de DEV, e só contra ele. A permissão é
  // explícita e por host exato: a variável `FIT_CANARIO_HOST` precisa ser
  // IGUAL ao hostname da URL. E o endpoint de PRODUÇÃO é recusado sempre,
  // mesmo que alguém aponte a variável para ele — a trava original existe
  // porque estas suítes apagam empresa inteira.
  if (host.includes(ENDPOINT_DE_PRODUCAO)) {
    throw new Error(
      `Suíte de banco recusou rodar contra "${host}": é o endpoint de PRODUÇÃO.`,
    );
  }
  const canario = process.env.FIT_CANARIO_HOST;
  if (canario && canario === host) {
    return;
  }
  if (!HOSTS_PERMITIDOS.has(host)) {
    throw new Error(
      `Suíte de banco recusou rodar contra "${host}". Estas suítes ESCREVEM ` +
        'e apagam linhas; contra um banco remoto isso é dado real.\n' +
        'Rode com URL local explícita, por exemplo:\n' +
        '  DATABASE_URL=postgresql://postgres:harness@localhost:55432/playck ' +
        'pnpm test:banco',
    );
  }
}
