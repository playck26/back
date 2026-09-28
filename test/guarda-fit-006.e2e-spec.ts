/**
 * SPEC-077/TASK-006 (SPEC-043/AC-012) — **a guarda do `fit-006`, nas quatro
 * combinações de ambiente.**
 *
 * A guarda morava inline no `ci.yml` e só se via o que ela fazia quando o
 * evento certo acontecia: push, PR do repositório, PR de fork, com chave. Cada
 * combinação aparece num tipo de evento diferente, e a de fork quase nunca.
 * Aqui o MESMO script que o passo chama roda nas quatro, com o comando
 * protegido trocado por um marcador — para afirmar que ele roda quando deve
 * e, mais importante, que NÃO roda quando não deve.
 *
 * `bash` e não `sh`: é o que o passo do `ci.yml` chama.
 */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const SCRIPT = join(__dirname, '..', 'scripts', 'guarda-fit-006.sh');
const REPO = 'playck26/back';
const MARCA = 'COMANDO-PROTEGIDO-RODOU';

function guarda(ambiente: Record<string, string>) {
  const r = spawnSync(
    'bash',
    // Sem aspas no argumento: no Windows, o bash as perde ao passar para o
    // `node.exe`, e o comando protegido falhava por sintaxe e não por regra.
    // O marcador vem pelo ambiente.
    [SCRIPT, 'node', '-e', 'console.log(process.env.MARCA)'],
    {
      encoding: 'utf-8',
      // Só o que a guarda lê, mais o PATH para achar o `node`: um SPACES_KEY
      // vazado do ambiente de quem roda o teste mudaria o caso.
      env: { PATH: process.env.PATH ?? '', REPO, MARCA, ...ambiente },
    },
  );
  return { codigo: r.status, saida: `${r.stdout}${r.stderr}` };
}

describe('SPEC-077/AC-028 — a guarda do fit-006 (043 AC-012)', () => {
  it('push SEM chave ⇒ falha com `::error`, e o comando não roda', () => {
    const r = guarda({ EVENTO: 'push', SPACES_KEY: '', REPO_DA_PR: '' });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('::error title=FIT-006 não rodou::');
    expect(r.saida).not.toContain(MARCA);
  });

  it('PR do PRÓPRIO repositório sem chave ⇒ falha com `::error`, e o comando não roda', () => {
    const r = guarda({
      EVENTO: 'pull_request',
      SPACES_KEY: '',
      REPO_DA_PR: REPO,
    });
    expect(r.codigo).toBe(1);
    expect(r.saida).toContain('::error title=FIT-006 não rodou::');
    expect(r.saida).not.toContain(MARCA);
  });

  it('PR de FORK (nunca recebe a chave) ⇒ sucesso com `::warning`, e o comando não roda', () => {
    const r = guarda({
      EVENTO: 'pull_request',
      SPACES_KEY: '',
      REPO_DA_PR: 'alguem/back',
    });
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain('::warning title=FIT-006 não rodou::');
    expect(r.saida).not.toContain('::error');
    expect(r.saida).not.toContain(MARCA);
  });

  it('COM chave ⇒ roda o comando, e sai com o código dele', () => {
    const r = guarda({
      EVENTO: 'push',
      SPACES_KEY: 'chave-de-teste',
      REPO_DA_PR: '',
    });
    expect(r.codigo).toBe(0);
    expect(r.saida).toContain(MARCA);
    expect(r.saida).not.toContain('::error');
    expect(r.saida).not.toContain('::warning');

    // E o código de saída é o DO COMANDO: uma guarda que engolisse a falha
    // da suíte do bucket deixaria o job verde sobre um vermelho.
    const falha = spawnSync('bash', [SCRIPT, 'node', '-e', 'process.exit(7)'], {
      encoding: 'utf-8',
      env: {
        PATH: process.env.PATH ?? '',
        REPO,
        EVENTO: 'push',
        SPACES_KEY: 'chave-de-teste',
      },
    });
    expect(falha.status).toBe(7);
  });

  it('o passo do `ci.yml` chama ESTE script, com o contexto do GitHub por ambiente', () => {
    // Sem esta linha, o teste acima provaria um script que o CI não usa.
    const { readFileSync } =
      jest.requireActual<typeof import('node:fs')>('node:fs');
    const ci = readFileSync(
      join(__dirname, '..', '.github', 'workflows', 'ci.yml'),
      'utf-8',
    );
    expect(ci).toContain(
      'run: bash scripts/guarda-fit-006.sh pnpm run test:bucket',
    );
    expect(ci).toContain('EVENTO: ${{ github.event_name }}');
    expect(ci).toContain(
      'REPO_DA_PR: ${{ github.event.pull_request.head.repo.full_name }}',
    );
    expect(ci).toContain('REPO: ${{ github.repository }}');
    expect(ci).toContain('SPACES_KEY: ${{ secrets.SPACES_KEY }}');
  });
});
