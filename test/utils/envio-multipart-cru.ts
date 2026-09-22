import { request as requisicaoCrua } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * **O cliente HTTP para quando o servidor RECUSA antes de o corpo acabar.**
 *
 * ## Por que o Supertest não serve aqui
 *
 * Nos testes de upload acima do teto, o servidor responde `413` e **fecha a
 * conexão enquanto o cliente ainda está enviando**. Isso é o comportamento
 * desejado (é o que o `client_max_body_size` do nginx faz), mas para o
 * cliente significa que a escrita morre com `ECONNRESET` — e o Supertest
 * reporta o erro da escrita em vez de ler a resposta que já chegou.
 *
 * Se isso acontece ou não depende de o corpo inteiro caber no buffer de
 * socket antes de o servidor fechar, e **esse buffer varia por sistema e por
 * carga da máquina**: o `storage-upload.e2e-spec.ts` mediu 393 KB escritos
 * nesta máquina e 2,69 MB no runner do CI, no mesmo teste. Por isso um teste
 * de `413` escrito com Supertest **não é determinístico** — ele passa quando
 * o corpo cabe no buffer e falha quando não cabe. Foi a causa do
 * `FIT-007 > 413` que falhava em 1 de 4 rodadas completas e passava sozinho
 * (a suíte inteira disputa CPU, o socket drena mais devagar).
 *
 * ## A regra que este arquivo carrega
 *
 * **Teste que envia mais bytes do que o servidor aceita usa este cliente, não
 * o Supertest.** Ele resolve na resposta, não no fim da escrita, e trata o
 * `ECONNRESET` posterior como esperado — porque é.
 *
 * ## Onde o Supertest CONTINUA servindo, e por quê
 *
 * A regra acima tem uma exceção medida, e ela está registrada para ninguém
 * "consertar" o que não está quebrado: o caso `chunked` do
 * `storage-upload.e2e-spec.ts` (3 MB **sem** `Content-Length`, recusado pelo
 * `limits.fileSize`) manda o corpo inteiro **antes** de a resposta chegar —
 * medido, **3.145.863 bytes de 3.145.728 + cabeçalho**. Lá o Multer só aborta
 * depois de ler o teto, e escrever 3 MB em loopback é mais rápido que isso.
 * Sem escrita pendente não há corrida, e aquele teste segue com Supertest.
 *
 * Devolve também `bytesEscritos`, que é o que permite provar que o servidor
 * **não** leu o corpo inteiro (ver AC-006 em `storage-upload.e2e-spec.ts`).
 */
export interface MedidaDeEnvio {
  status: number;
  /** O corpo já desserializado; `{}` se não for JSON (ver `texto`). */
  body: { code?: string };
  /** O corpo cru, para a mensagem de falha fazer sentido quando não é JSON. */
  texto: string;
  /** Quantos bytes o cliente escreveu até a resposta chegar. */
  bytesEscritos: number;
}

export interface EnvioCru {
  porta: number;
  caminho: string;
  /** O nome do campo do arquivo — contrato da rota (CON-017.1). */
  campo: string;
  /** Tamanho do arquivo em bytes; o conteúdo é `0x41` repetido. */
  tamanho: number;
  metodo?: string;
  /** Campos de formulário que a rota exige além do arquivo. */
  campos?: Record<string, string>;
  nomeDoArquivo?: string;
  cabecalhos?: Record<string, string>;
}

const LIMITE = '----playckfixture';

/**
 * A porta real de um app que já está escutando. Falha com mensagem clara em
 * vez de `undefined`, porque esquecer o `await app.listen(0)` daria um erro
 * de conexão recusada a três camadas de distância da causa.
 */
type ComEndereco = { address(): AddressInfo | string | null };

function temEndereco(alvo: unknown): alvo is ComEndereco {
  return (
    typeof alvo === 'object' &&
    alvo !== null &&
    typeof (alvo as ComEndereco).address === 'function'
  );
}

// `app.getHttpServer()` é tipado como `App` do Supertest, que inclui `string`
// — por isso a checagem é em tempo de execução, e não uma asserção `as`.
export function portaDe(servidor: unknown): number {
  const endereco = temEndereco(servidor) ? servidor.address() : null;
  if (endereco === null || typeof endereco === 'string') {
    throw new Error(
      'o servidor nao esta escutando numa porta TCP: chame `await app.listen(0)` no beforeAll',
    );
  }
  return endereco.port;
}

function cabecalhoMultipart(envio: EnvioCru): Buffer {
  const partes: string[] = [];
  for (const [nome, valor] of Object.entries(envio.campos ?? {})) {
    partes.push(
      `--${LIMITE}\r\n` +
        `Content-Disposition: form-data; name="${nome}"\r\n\r\n` +
        `${valor}\r\n`,
    );
  }
  partes.push(
    `--${LIMITE}\r\n` +
      `Content-Disposition: form-data; name="${envio.campo}"; ` +
      `filename="${envio.nomeDoArquivo ?? 'grande.webp'}"\r\n` +
      'Content-Type: application/octet-stream\r\n\r\n',
  );
  return Buffer.from(partes.join(''));
}

/**
 * Envia um corpo multipart com `Content-Length` declarado e resolve **assim
 * que a resposta chega**, sem esperar a escrita terminar.
 */
export function enviarSemEsperarFim(envio: EnvioCru): Promise<MedidaDeEnvio> {
  const cabecalho = cabecalhoMultipart(envio);
  const rodape = Buffer.from(`\r\n--${LIMITE}--\r\n`);
  const total = cabecalho.length + envio.tamanho + rodape.length;

  return new Promise((resolve, reject) => {
    let bytesEscritos = 0;
    let respondido = false;

    const req = requisicaoCrua(
      {
        port: envio.porta,
        method: envio.metodo ?? 'PUT',
        path: envio.caminho,
        headers: {
          ...envio.cabecalhos,
          'content-type': `multipart/form-data; boundary=${LIMITE}`,
          'content-length': String(total),
        },
      },
      (res) => {
        let texto = '';
        res.on('data', (p: Buffer) => (texto += p.toString()));
        res.on('end', () => {
          respondido = true;
          req.destroy();
          let body: { code?: string } = {};
          try {
            body = JSON.parse(texto || '{}') as { code?: string };
          } catch {
            // Resposta não-JSON (um 404 de rota errada, por exemplo). O
            // `texto` vai junto para a falha dizer o que veio de verdade.
          }
          resolve({ status: res.statusCode ?? 0, body, texto, bytesEscritos });
        });
      },
    );

    // ECONNRESET aqui é ESPERADO: o servidor fechou porque já respondeu.
    req.on('error', (erro) => {
      if (!respondido) reject(erro);
    });

    req.write(cabecalho);
    bytesEscritos += cabecalho.length;

    const pedaco = Buffer.alloc(64 * 1024, 0x41);
    let restante = envio.tamanho;
    const escrever = () => {
      while (restante > 0 && !respondido) {
        const n = Math.min(pedaco.length, restante);
        const ok = req.write(pedaco.subarray(0, n));
        bytesEscritos += n;
        restante -= n;
        if (!ok) {
          req.once('drain', escrever);
          return;
        }
      }
      if (!respondido) {
        req.end(rodape);
      }
    };
    escrever();
  });
}
