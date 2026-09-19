/**
 * SPEC-062/FIT-048 — **o tick sob concorrência, em conexões separadas.**
 *
 * É a FIT que importa desta spec. A caixa de saída é o único lugar onde duas
 * instâncias do `back` podem disputar a mesma linha, e a versão anterior do
 * desenho foi reprovada **quatro vezes** por causa disto — lote preso no
 * lease, `Promise.race` que não cancela requisição, cerca que não cobria todas
 * as transições, terminal sem conclusão.
 *
 * O `db-spec` irmão (`test/banco/spec-062-tick-de-envio.db-spec.ts`) prova
 * cada transição isoladamente, numa conexão só. **Aqui é diferente:** duas
 * `PrismaClient` independentes, como duas réplicas do App Platform, e o que se
 * julga é o que acontece quando elas se encontram.
 *
 *   (a) dois ticks simultâneos, várias linhas → **nenhuma processada duas
 *       vezes, nenhuma esquecida** (AC-003).
 *
 *       **O que este caso NÃO prova, e a sabotagem mostrou:** trocar
 *       `FOR UPDATE SKIP LOCKED` por `FOR UPDATE` deixa o teste verde. E está
 *       certo que deixe — a reivindicação é **uma instrução única, com
 *       autocommit**, então o lock da linha vive microssegundos. Quem impede
 *       a duplicata é o predicado `estado='pendente'`, reavaliado depois que
 *       o lock sai; o `SKIP LOCKED` evita **bloqueio**, não duplicata.
 *       Afirmar que ele garante a unicidade seria dar crédito ao mecanismo
 *       errado — e no dia em que alguém o removesse "porque o teste passa",
 *       o que se perderia é vazão sob disputa, não correção;
 *   (b) lease vencido com o envio AINDA no ar → o segundo tick assume, e a
 *       **cerca recusa a conclusão do primeiro** (INV-062e). O aviso pode ir
 *       duas vezes — é a LIM-062a, declarada, e a AC-012 exige prová-la em vez
 *       de negá-la;
 *   (c) a linha que vence entre reivindicar e enviar termina **`expirada`**,
 *       não `falha_definitiva` (AC-013). O aviso não falhou: ele venceu;
 *   (d) o `CHECK` do banco recusa terminal sem `concluida_em` (INV-062h, AC-026)
 *       — a garantia que **nenhuma transição futura** consegue furar.
 */
import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AdaptadorDeMemoria } from '../../src/push/adaptador-de-memoria';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TickDeEnvioService } from '../../src/push/tick-de-envio.service';
import { exigirBancoLocal } from '../banco/exigir-banco-local';
import { limparEmpresa } from '../banco/limpar-empresa';

jest.setTimeout(600_000);
exigirBancoLocal();

const EMPRESA = '062f0480-0000-4000-8000-000000000001';
const USUARIO = '062f0480-0000-4000-8000-000000000002';

/**
 * **Duas conexões, e é isso que separa esta FIT do `db-spec`.** Uma pool só
 * serializaria o que deveria disputar, e o teste passaria dizendo nada — a
 * mesma armadilha que o FIT-001 documenta para o overbooking.
 */
const dbA = new PrismaClient();
const dbB = new PrismaClient();

function tick(db: PrismaClient, porta: AdaptadorDeMemoria): TickDeEnvioService {
  return new TickDeEnvioService(db as unknown as PrismaService, porta);
}

async function enfileirar(
  quantas: number,
  extra: { expiraEm?: Date; tentativas?: number } = {},
): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < quantas; i += 1) {
    const id = randomUUID();
    await dbA.notificacao.create({
      data: {
        id,
        companyId: EMPRESA,
        destinatarioId: USUARIO,
        tipo: 'aviso',
        titulo: `Aviso ${i}`,
        corpo: 'Corpo',
        expiraEm: extra.expiraEm ?? null,
        tentativas: extra.tentativas ?? 0,
      },
    });
    ids.push(id);
  }
  return ids;
}

beforeAll(async () => {
  await limparEmpresa(dbA, EMPRESA);
  await dbA.$executeRawUnsafe(
    `INSERT INTO empresas (id, nome, slug, updated_at)
     VALUES ($1::uuid, 'FIT-048', 'fit-048', now())`,
    EMPRESA,
  );
  await dbA.$executeRawUnsafe(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, 'fit048@teste.local', 'x', 'FIT', 'company_admin', $2::uuid, now())`,
    USUARIO,
    EMPRESA,
  );
  await dbA.assinaturaPush.create({
    data: {
      id: randomUUID(),
      companyId: EMPRESA,
      usuarioId: USUARIO,
      endpoint: 'https://push.exemplo.test/fit-048',
      p256dh: 'chave',
      auth: 'segredo',
    },
  });
});

afterAll(async () => {
  await limparEmpresa(dbA, EMPRESA);
  await dbA.$disconnect();
  await dbB.$disconnect();
});

beforeEach(async () => {
  await dbA.notificacao.deleteMany({ where: { companyId: EMPRESA } });
});

describe('FIT-048 (a) — dois ticks, nenhuma linha em duplicata', () => {
  it('cada uma é processada por exatamente um dos dois', async () => {
    const ids = await enfileirar(6);
    const portaA = new AdaptadorDeMemoria();
    const portaB = new AdaptadorDeMemoria();

    const [a, b] = await Promise.all([
      tick(dbA, portaA).executarTick(),
      tick(dbB, portaB).executarTick(),
    ]);

    // Nenhuma esquecida...
    expect(a.processadas + b.processadas).toBe(ids.length);
    // ...e nenhuma enviada duas vezes. Quem garante e o predicado
    // `estado='pendente'`, reavaliado apos o lock sair — ver o cabecalho.
    const enviados = [...portaA.enviados, ...portaB.enviados];
    expect(enviados).toHaveLength(ids.length);

    const linhas = await dbA.notificacao.findMany({
      where: { companyId: EMPRESA },
      select: { estado: true, tentativas: true, concluidaEm: true },
    });
    expect(linhas).toHaveLength(ids.length);
    for (const l of linhas) {
      expect(l.estado).toBe('aceita_pelo_servico');
      expect(l.tentativas).toBe(1);
      expect(l.concluidaEm).not.toBeNull();
    }
  });
});

describe('FIT-048 (b) — lease vencido com o envio no ar (AC-012, LIM-062a)', () => {
  it('o segundo tick assume, e a cerca recusa a conclusão do primeiro', async () => {
    const [id] = await enfileirar(1);

    // O primeiro emissor fica preso no envio. É assim que se faz o lease
    // vencer com a requisição viva — sem `sleep` e sem relógio falso.
    let soltar!: () => void;
    const trava = new Promise<void>((r) => (soltar = r));
    const portaLenta = new AdaptadorDeMemoria();
    portaLenta.segurarAte(trava);
    const primeiro = tick(dbA, portaLenta).executarTick();

    await new Promise((r) => setTimeout(r, 300));
    await dbB.$executeRawUnsafe(
      `UPDATE notificacoes SET reivindicada_ate = now() - interval '1 second'
        WHERE id = $1::uuid`,
      id,
    );

    const portaB = new AdaptadorDeMemoria();
    const segundo = await tick(dbB, portaB).executarTick();
    soltar();
    const r1 = await primeiro;

    expect(segundo.leasesRecuperados).toBe(1);
    expect(segundo.aceitas).toBe(1);
    // INV-062e — o emissor com lease vencido **não consegue concluir**.
    expect(r1.cercadas).toBe(1);

    // E o preço, declarado: o aviso foi enviado DUAS vezes. A cerca impede a
    // conclusão antiga; não impede o segundo envio. Entrega exatamente-uma-vez
    // não é oferecida, e a AC-012 exige provar isso em vez de negar.
    expect(portaLenta.enviados.length + portaB.enviados.length).toBe(2);

    const linha = await dbA.notificacao.findUniqueOrThrow({ where: { id } });
    expect(linha.estado).toBe('aceita_pelo_servico');
    expect(linha.concluidaEm).not.toBeNull();
  });
});

describe('FIT-048 (b2) — a cerca é pelo TOKEN, não só pelo estado', () => {
  it('o emissor morto não conclui por cima de um envio em andamento', async () => {
    // **Este caso existe porque a sabotagem passou.** O caso (b) parecia
    // provar a cerca e provava outra coisa: quando o primeiro emissor volta,
    // a linha já está `aceita_pelo_servico`, e o predicado `estado='enviando'`
    // sozinho já recusa. Tirar `AND reivindicada_por = $token` do SQL não
    // deixava nada vermelho — nem aqui, nem no `db-spec`, até eu escrever a
    // janela certa lá.
    //
    // A janela é esta: o SEGUNDO emissor ainda está com a linha `enviando`,
    // sob outro token, quando o primeiro acorda. Só o token separa os dois.
    const [id] = await enfileirar(1);

    let soltarA!: () => void;
    let soltarB!: () => void;
    const travaA = new Promise<void>((r) => (soltarA = r));
    const travaB = new Promise<void>((r) => (soltarB = r));

    const portaA = new AdaptadorDeMemoria();
    portaA.segurarAte(travaA);
    const primeiro = tick(dbA, portaA).executarTick();
    await new Promise((r) => setTimeout(r, 300));

    await dbB.$executeRawUnsafe(
      `UPDATE notificacoes SET reivindicada_ate = now() - interval '1 second'
        WHERE id = $1::uuid`,
      id,
    );

    const portaB = new AdaptadorDeMemoria();
    portaB.segurarAte(travaB);
    const segundo = tick(dbB, portaB).executarTick();
    await new Promise((r) => setTimeout(r, 300));

    // Neste instante a linha está `enviando` sob o token de B.
    const antes = await dbA.notificacao.findUniqueOrThrow({ where: { id } });
    expect(antes.estado).toBe('enviando');

    soltarA();
    const r1 = await primeiro;
    expect(r1.cercadas).toBe(1);

    soltarB();
    const r2 = await segundo;
    expect(r2.aceitas).toBe(1);

    const depois = await dbA.notificacao.findUniqueOrThrow({ where: { id } });
    expect(depois.estado).toBe('aceita_pelo_servico');
  });
});

describe('FIT-048 (c) — vencer entre reivindicar e enviar (AC-013)', () => {
  it('termina `expirada`, e não `falha_definitiva`', async () => {
    // Prazo à frente do varredor, mas abaixo de 1 s quando o TTL é calculado.
    const [id] = await enfileirar(1, { expiraEm: new Date(Date.now() + 400) });
    const porta = new AdaptadorDeMemoria();

    const r = await tick(dbA, porta).executarTick();

    expect(r.expiradasNoEmissor).toBe(1);
    // **Não chegou a ser enviada**: aviso vencido que chega é pior que aviso
    // que não chega.
    expect(porta.enviados).toHaveLength(0);

    const linha = await dbA.notificacao.findUniqueOrThrow({ where: { id } });
    expect(linha.estado).toBe('expirada');
    expect(linha.concluidaEm).not.toBeNull();
  });
});

describe('FIT-048 (d) — INV-062h: o CHECK, que nenhuma transição fura', () => {
  it('o banco recusa terminal sem conclusão, por qualquer caminho', async () => {
    const [id] = await enfileirar(1);

    // SQL direto, sem passar pelo serviço: é o caminho que uma transição
    // futura mal escrita usaria. O `CHECK` não pergunta quem está escrevendo.
    await expect(
      dbB.$executeRawUnsafe(
        `UPDATE notificacoes SET estado = 'expirada' WHERE id = $1::uuid`,
        id,
      ),
    ).rejects.toThrow();

    await expect(
      dbB.$executeRawUnsafe(
        `UPDATE notificacoes SET concluida_em = now() WHERE id = $1::uuid`,
        id,
      ),
    ).rejects.toThrow();
  });
});
