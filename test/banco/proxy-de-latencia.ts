/**
 * SPEC-082/AC-020 — **o proxy de latência** entre o serviço e o Postgres
 * local: atrasa cada pedaço, em cada sentido, preservando a ordem dos bytes.
 *
 * É o `proxy-latencia.cjs` dos scripts da avaliação de arquitetura
 * (`tmp/avaliacao-arquitetura-2026-09-30/`), trazido para dentro do teste — a
 * prova tem de rodar onde a suíte roda, e não depender de um arquivo fora do
 * repositório. Uma diferença: o atraso é **mutável** (`definirAtraso`), para o
 * teste aquecer a conexão sem latência e só depois medir.
 */
import net from 'node:net';

export interface ProxyDeLatencia {
  porta: number;
  definirAtraso(ms: number): void;
  fechar(): Promise<void>;
}

export async function abrirProxy(
  portaDestino: number,
): Promise<ProxyDeLatencia> {
  let atraso = 0;
  const sockets = new Set<net.Socket>();

  function atrasar(origem: net.Socket, destino: net.Socket) {
    const fila: { pedaco: Buffer; quando: number }[] = [];
    let liberando = false;
    const liberar = () => {
      if (fila.length === 0) {
        liberando = false;
        return;
      }
      liberando = true;
      setTimeout(
        () => {
          const agora = Date.now();
          while (fila.length && fila[0].quando <= agora) {
            destino.write(fila.shift()!.pedaco);
          }
          liberar();
        },
        Math.max(0, fila[0].quando - Date.now()),
      );
    };
    origem.on('data', (pedaco: Buffer) => {
      fila.push({ pedaco, quando: Date.now() + atraso });
      if (!liberando) liberar();
    });
    origem.on('end', () => setTimeout(() => destino.end(), atraso));
    origem.on('error', () => destino.destroy());
  }

  const servidor = net.createServer((cliente) => {
    const banco = net.connect(portaDestino, '127.0.0.1');
    sockets.add(cliente);
    sockets.add(banco);
    atrasar(cliente, banco);
    atrasar(banco, cliente);
    cliente.on('close', () => banco.destroy());
    banco.on('close', () => cliente.destroy());
  });
  await new Promise<void>((r) => servidor.listen(0, '127.0.0.1', r));
  const porta = (servidor.address() as net.AddressInfo).port;

  return {
    porta,
    definirAtraso: (ms) => {
      atraso = ms;
    },
    fechar: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        servidor.close(() => r());
      }),
  };
}
