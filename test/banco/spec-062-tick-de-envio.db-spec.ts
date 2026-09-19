import { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';
import { AdaptadorDeMemoria } from '../../src/push/adaptador-de-memoria';
import type { PrismaService } from '../../src/prisma/prisma.service';
import { TickDeEnvioService } from '../../src/push/tick-de-envio.service';
import { exigirBancoLocal } from './exigir-banco-local';
import { limparEmpresa } from './limpar-empresa';

jest.setTimeout(120_000);

exigirBancoLocal();

/**
 * SPEC-062/TASK-003 — **as seis transições contra banco de verdade.**
 *
 * Isto é a semente da FIT-048 (TASK-006), não a FIT inteira: aqui se prova que
 * cada transição leva a linha ao estado certo, com `concluida_em` certo e o
 * lease limpo. O que a FIT acrescenta é concorrência em conexões separadas.
 *
 * **Por que contra banco, e não com mock:** as seis transições são SQL — o
 * `FOR UPDATE SKIP LOCKED`, a cerca por `reivindicada_por`, o `CASE` que
 * decide `estado` e `concluida_em` pelo mesmo predicado, e o `CHECK` que
 * recusa terminal sem conclusão. Um mock provaria o mock.
 */
const db = new PrismaClient();
const EMPRESA = '062a0000-0000-4000-8000-000000000001';
const USUARIO = '062a0000-0000-4000-8000-000000000002';

function tickCom(porta: AdaptadorDeMemoria | null): TickDeEnvioService {
  return new TickDeEnvioService(db as unknown as PrismaService, porta);
}

async function criarNotificacao(campos: {
  estado?: string;
  expiraEm?: Date | null;
  tentativas?: number;
  proximaTentativaEm?: Date;
  tipo?: string;
}): Promise<string> {
  const id = randomUUID();
  await db.notificacao.create({
    data: {
      id,
      companyId: EMPRESA,
      destinatarioId: USUARIO,
      tipo: campos.tipo ?? 'aviso',
      titulo: 'Titulo',
      corpo: 'Corpo',
      expiraEm: campos.expiraEm ?? null,
      tentativas: campos.tentativas ?? 0,
      proximaTentativaEm: campos.proximaTentativaEm ?? new Date(),
    },
  });
  return id;
}

async function assinar(endpoint: string): Promise<void> {
  await db.assinaturaPush.create({
    data: {
      id: randomUUID(),
      companyId: EMPRESA,
      usuarioId: USUARIO,
      endpoint,
      p256dh: 'chave-publica-do-aparelho',
      auth: 'segredo-do-aparelho',
    },
  });
}

async function ler(id: string) {
  return db.notificacao.findUniqueOrThrow({ where: { id } });
}

beforeAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$executeRawUnsafe(
    `INSERT INTO empresas (id, nome, slug, updated_at)
     VALUES ($1::uuid, 'SPEC-062', 'spec-062', now())`,
    EMPRESA,
  );
  await db.$executeRawUnsafe(
    `INSERT INTO usuarios (id, email, senha_hash, nome, role, company_id, updated_at)
     VALUES ($1::uuid, 'spec062@teste.local', 'x', 'Teste', 'company_admin', $2::uuid, now())`,
    USUARIO,
    EMPRESA,
  );
});

afterAll(async () => {
  await limparEmpresa(db, EMPRESA);
  await db.$disconnect();
});

beforeEach(async () => {
  await db.notificacao.deleteMany({ where: { companyId: EMPRESA } });
  await db.assinaturaPush.deleteMany({ where: { companyId: EMPRESA } });
});

describe('AC-009 — sem par VAPID o tick não roda', () => {
  it('não reivindica nada, e diz que não está configurado', async () => {
    const id = await criarNotificacao({});

    const r = await tickCom(null).executarTick();

    expect(r.configurado).toBe(false);
    expect(r.processadas).toBe(0);
    // Falha FECHADA: a linha continua pendente. O oposto seria descartá-la e
    // o aviso sumir por falta de configuração, em silêncio.
    expect((await ler(id)).estado).toBe('pendente');
  });
});

describe('Transição 2 — o caminho feliz, e o que ele exige do banco', () => {
  it('aceita pelo serviço: terminal COM conclusão e lease limpo', async () => {
    await assinar('https://push.exemplo/viva');
    const id = await criarNotificacao({});
    const porta = new AdaptadorDeMemoria();

    const r = await tickCom(porta).executarTick();

    expect(r.aceitas).toBe(1);
    const linha = await ler(id);
    expect(linha.estado).toBe('aceita_pelo_servico');
    expect(linha.concluidaEm).not.toBeNull();
    expect(linha.reivindicadaPor).toBeNull();
    expect(linha.reivindicadaAte).toBeNull();
    expect(linha.tentativas).toBe(1);
    expect(porta.enviados).toHaveLength(1);
  });

  it('D5/LIM-062b — sem assinatura viva, `sem_destino`', async () => {
    const id = await criarNotificacao({});

    const r = await tickCom(new AdaptadorDeMemoria()).executarTick();

    expect(r.semDestino).toBe(1);
    expect((await ler(id)).estado).toBe('sem_destino');
  });

  it('D5 — uma aceita e outra morre: aceita, e a morta é apagada', async () => {
    await assinar('https://push.exemplo/morta');
    await assinar('https://push.exemplo/viva');
    const id = await criarNotificacao({});
    const porta = new AdaptadorDeMemoria();
    // A primeira assinatura morre, a segunda aceita — na ordem de `criadaEm`.
    porta.responderEmSequencia([
      { tipo: 'assinatura_morta', status: 410 },
      { tipo: 'aceito' },
    ]);

    const r = await tickCom(porta).executarTick();

    expect(r.aceitas).toBe(1);
    expect(r.assinaturasApagadas).toBe(1);
    expect((await ler(id)).estado).toBe('aceita_pelo_servico');
    expect(
      await db.assinaturaPush.count({ where: { companyId: EMPRESA } }),
    ).toBe(1);
  });
});

describe('Transição 3 — falha temporária (AC-014)', () => {
  it('reagenda sem conclusão e respeita o Retry-After quando ele é maior', async () => {
    await assinar('https://push.exemplo/1');
    const id = await criarNotificacao({});
    const porta = new AdaptadorDeMemoria();
    porta.responderCom({
      tipo: 'temporario',
      status: 429,
      esperaSugeridaSegundos: 900,
      detalhe: 'HTTP 429',
    });

    await tickCom(porta).executarTick();

    const linha = await ler(id);
    expect(linha.estado).toBe('pendente');
    expect(linha.concluidaEm).toBeNull();
    expect(linha.reivindicadaPor).toBeNull();
    // 900 s do serviço vence a espera crescente de 60 s: nunca se espera
    // menos do que o serviço pediu.
    const daqui = linha.proximaTentativaEm.getTime() - Date.now();
    expect(daqui).toBeGreaterThan(800_000);
  });

  it('a TERCEIRA tentativa queimada vira falha_definitiva, com conclusão', async () => {
    await assinar('https://push.exemplo/1');
    // Duas já queimadas: a reivindicação desta rodada faz a terceira.
    const id = await criarNotificacao({ tentativas: 2 });
    const porta = new AdaptadorDeMemoria();
    porta.responderCom({
      tipo: 'temporario',
      status: 500,
      esperaSugeridaSegundos: null,
      detalhe: 'HTTP 500',
    });

    await tickCom(porta).executarTick();

    const linha = await ler(id);
    expect(linha.tentativas).toBe(3);
    expect(linha.estado).toBe('falha_definitiva');
    expect(linha.concluidaEm).not.toBeNull();
  });
});

describe('AC-006 — 400/403/413 é falha_operacional, SEM retentativa', () => {
  it('termina na hora', async () => {
    await assinar('https://push.exemplo/1');
    const id = await criarNotificacao({});
    const porta = new AdaptadorDeMemoria();
    porta.responderCom({
      tipo: 'falha_operacional',
      status: 400,
      detalhe: 'HTTP 400',
    });

    await tickCom(porta).executarTick();

    const linha = await ler(id);
    expect(linha.estado).toBe('falha_operacional');
    expect(linha.concluidaEm).not.toBeNull();
    // Terminal: não há próxima tentativa. Repetir o que o servidor recusou
    // por ser inválido só gasta o serviço de push.
    expect(linha.tentativas).toBe(1);
  });
});

describe('AC-013 — o prazo (transições 5 e 6)', () => {
  it('transição 5: vencida na fila fecha como `expirada`, sem enviar', async () => {
    await assinar('https://push.exemplo/1');
    const id = await criarNotificacao({
      expiraEm: new Date(Date.now() - 1000),
    });
    const porta = new AdaptadorDeMemoria();

    const r = await tickCom(porta).executarTick();

    expect(r.vencidasNaFila).toBe(1);
    const linha = await ler(id);
    expect(linha.estado).toBe('expirada');
    expect(linha.concluidaEm).not.toBeNull();
    // **Não chegou a ser enviada**, e é esse o ponto: aviso vencido que chega
    // é pior que aviso que não chega.
    expect(porta.enviados).toHaveLength(0);
    expect(linha.tentativas).toBe(0);
  });

  it('transição 6: vence ENTRE reivindicar e enviar, e termina `expirada`', async () => {
    await assinar('https://push.exemplo/1');
    // Prazo à frente do varredor (transição 5 não a pega) mas abaixo de 1 s
    // quando o TTL é calculado: é exatamente a borda que a v3 da spec deixava
    // virar `falha_definitiva` — o aviso não falhou, ele venceu.
    const id = await criarNotificacao({ expiraEm: new Date(Date.now() + 400) });
    const porta = new AdaptadorDeMemoria();

    const r = await tickCom(porta).executarTick();

    expect(r.expiradasNoEmissor).toBe(1);
    const linha = await ler(id);
    expect(linha.estado).toBe('expirada');
    expect(linha.concluidaEm).not.toBeNull();
    expect(porta.enviados).toHaveLength(0);
  });

  it('sem prazo, o TTL é o padrão de 24 h', async () => {
    await assinar('https://push.exemplo/1');
    await criarNotificacao({ expiraEm: null });
    const porta = new AdaptadorDeMemoria();

    await tickCom(porta).executarTick();

    expect(porta.enviados[0].aviso.ttl).toBe(86_400);
  });

  it('com prazo, o TTL é o piso dos segundos restantes', async () => {
    await assinar('https://push.exemplo/1');
    await criarNotificacao({ expiraEm: new Date(Date.now() + 65_500) });
    const porta = new AdaptadorDeMemoria();

    await tickCom(porta).executarTick();

    // `floor`, nunca `max(1, …)`: arredondar para cima guardaria a mensagem
    // um segundo ALÉM do prazo.
    expect(porta.enviados[0].aviso.ttl).toBeLessThanOrEqual(65);
    expect(porta.enviados[0].aviso.ttl).toBeGreaterThan(60);
  });
});

describe('AC-003 e AC-004 — a cerca e o lease', () => {
  it('dois ticks concorrentes não pegam a MESMA linha', async () => {
    await assinar('https://push.exemplo/1');
    await criarNotificacao({});
    await criarNotificacao({});

    const [a, b] = await Promise.all([
      tickCom(new AdaptadorDeMemoria()).executarTick(),
      tickCom(new AdaptadorDeMemoria()).executarTick(),
    ]);

    // Duas linhas, dois ticks: cada um pegou o que o outro não pegou. O
    // `FOR UPDATE SKIP LOCKED` é quem garante — nenhuma foi processada duas
    // vezes, e nenhuma ficou para trás.
    expect(a.processadas + b.processadas).toBe(2);
    const estados = await db.notificacao.findMany({
      where: { companyId: EMPRESA },
      select: { estado: true },
    });
    expect(estados.every((e) => e.estado === 'aceita_pelo_servico')).toBe(true);
  });

  it('AC-012/LIM-062a — lease vencido: o emissor antigo NÃO conclui', async () => {
    await assinar('https://push.exemplo/1');
    const id = await criarNotificacao({});

    // Um emissor segura o envio; enquanto isso, o lease é vencido à mão e
    // outro tick assume a linha. É a LIM-062a acontecendo: o segundo envio
    // não é impedido — o que a cerca impede é a CONCLUSÃO do primeiro.
    let soltar!: () => void;
    const trava = new Promise<void>((resolve) => {
      soltar = resolve;
    });
    const lenta = new AdaptadorDeMemoria();
    lenta.segurarAte(trava);
    const primeiro = tickCom(lenta).executarTick();

    await new Promise((r) => setTimeout(r, 300));
    await db.$executeRawUnsafe(
      `UPDATE notificacoes SET reivindicada_ate = now() - interval '1 second'
        WHERE company_id = $1::uuid`,
      EMPRESA,
    );

    const segundo = await tickCom(new AdaptadorDeMemoria()).executarTick();
    soltar();
    const r1 = await primeiro;

    expect(segundo.leasesRecuperados).toBe(1);
    expect(segundo.aceitas).toBe(1);
    // A cerca recusou a conclusão do emissor antigo.
    expect(r1.cercadas).toBe(1);

    const linha = await ler(id);
    expect(linha.estado).toBe('aceita_pelo_servico');
    expect(linha.concluidaEm).not.toBeNull();
  });

  it('INV-062e — a cerca é pelo TOKEN, e não só pelo estado', async () => {
    // **Este teste existe porque uma sabotagem passou.** O teste acima parecia
    // provar a cerca, e não provava: quando o emissor antigo tentava concluir,
    // a linha já estava `aceita_pelo_servico`, então o predicado
    // `estado = 'enviando'` sozinho já recusava. Tirar
    // `AND reivindicada_por = $token` do SQL não deixava nada vermelho.
    //
    // A janela de verdade é outra: o segundo emissor está com a linha
    // `enviando` AINDA, sob outro token, quando o primeiro volta. Aí só o
    // token separa um do outro — e sem ele o emissor morto concluiria por
    // cima de um envio em andamento.
    await assinar('https://push.exemplo/1');
    const id = await criarNotificacao({});

    let soltarPrimeiro!: () => void;
    let soltarSegundo!: () => void;
    const travaA = new Promise<void>((r) => (soltarPrimeiro = r));
    const travaB = new Promise<void>((r) => (soltarSegundo = r));

    const portaA = new AdaptadorDeMemoria();
    portaA.segurarAte(travaA);
    const primeiro = tickCom(portaA).executarTick();
    await new Promise((r) => setTimeout(r, 300));

    await db.$executeRawUnsafe(
      `UPDATE notificacoes SET reivindicada_ate = now() - interval '1 second'
        WHERE id = $1::uuid`,
      id,
    );

    const portaB = new AdaptadorDeMemoria();
    portaB.segurarAte(travaB);
    const segundo = tickCom(portaB).executarTick();
    await new Promise((r) => setTimeout(r, 300));

    // Neste instante a linha está `enviando` sob o token de B. O primeiro
    // acorda e tenta concluir: tem de ser recusado pelo TOKEN.
    const antes = await ler(id);
    expect(antes.estado).toBe('enviando');

    soltarPrimeiro();
    const r1 = await primeiro;
    expect(r1.cercadas).toBe(1);

    // E o segundo, dono legítimo, conclui normalmente.
    soltarSegundo();
    const r2 = await segundo;
    expect(r2.aceitas).toBe(1);
    expect((await ler(id)).estado).toBe('aceita_pelo_servico');
  });

  it('transição 4 prefere `expirada` a `falha_definitiva`', async () => {
    const id = await criarNotificacao({
      tentativas: 3,
      expiraEm: new Date(Date.now() - 1000),
    });
    await db.$executeRawUnsafe(
      `UPDATE notificacoes SET estado = 'enviando', reivindicada_por = 'token-morto',
              reivindicada_ate = now() - interval '1 minute'
        WHERE id = $1::uuid`,
      id,
    );

    await tickCom(new AdaptadorDeMemoria()).executarTick();

    // Com tentativas esgotadas E prazo vencido, vence o prazo: o aviso não
    // falhou, ele venceu. Estado e `concluida_em` saem do mesmo predicado.
    const linha = await ler(id);
    expect(linha.estado).toBe('expirada');
    expect(linha.concluidaEm).not.toBeNull();
    expect(linha.reivindicadaPor).toBeNull();
  });
});

describe('INV-062h — o CHECK do banco, que é a garantia de verdade', () => {
  it('recusa terminal sem conclusão, venha de onde vier', async () => {
    const id = await criarNotificacao({});
    await expect(
      db.$executeRawUnsafe(
        `UPDATE notificacoes SET estado = 'expirada' WHERE id = $1::uuid`,
        id,
      ),
    ).rejects.toThrow();
  });
});
