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
