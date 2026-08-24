# Corpus de WebP — SPEC-017 / TASK-002

São 52 arquivos, de **dois encoders independentes**. **Os 27 primeiros existiam antes da primeira linha do
validador** — a spec pede assim de propósito: *"validador escrito primeiro
e testado depois acaba testado contra o que ele já faz"*.

**Os outros 10 nasceram depois, e cada um tem nome de um defeito real.**
Com os 27, o validador passava em tudo. Mas 22 mutações deliberadas foram
aplicadas ao código, em 5 rodadas, e **10 sobreviveram** — ou seja, 10
checagens não estavam sendo testadas por nada. Oito viraram arquivo novo,
marcado com **(mutação)** abaixo; duas viraram asserção de motivo, porque
o defeito não era falta de arquivo (ver a última seção).

Passar em corpus não é prova de nada se o corpus foi escolhido depois.

São binários commitados, não gerados em tempo de teste — o CI não tem
Pillow nem ffmpeg, e corpus que muda com a versão da biblioteca deixa de ser
corpus.

| Origem | Regerar com | O que cobre |
|---|---|---|
| **Pillow 12.3.0** | `python gerar-corpus.py` | os válidos, todas as recusas e as mutações |
| **libwebp (ffmpeg 8.1.2)** | `./gerar-corpus-ffmpeg.sh` | os 5 `ff-*.webp` — só válidos |

**Por que dois encoders.** Todo o corpus vinha de um só, e validador afinado
num encoder passa a codificar as manias dele — ninguém percebe até chegar
arquivo de outra origem. Os `ff-*.webp` entraram depois da validação cruzada
de 2026-08-24, para responder à dúvida que sobrou dela: *`validarSequencia`
recusa forma legítima do container?* Eles dizem que não, e **não fui eu que
os montei** — é o mesmo libwebp que o Chrome usa por baixo do
`canvas.toBlob`.

**O que eles NÃO atestam:** nenhum dos dois encoders produz `VP8X` +
`VP8L` sem `ALPH`. Essa forma é legal pelo container spec e está no corpus
como `valido-vp8x-com-vp8l.webp`, montada à mão — **é a única forma válida
cuja aceitação só tem a minha palavra.**

## Válidos — precisam passar

| Arquivo | Estrutura real | Por que está aqui |
|---|---|---|
| `valido-vp8-lossy.webp` | `VP8 ` | o caso comum: o que o `canvas` do navegador produz |
| `valido-vp8l-lossless.webp` | `VP8L` | outro cabeçalho, outra leitura de dimensão |
| `valido-vp8x-com-alpha.webp` | `VP8X`(0x10) `ALPH` `VP8 ` | container estendido com alpha — `ALPH` é da allowlist |
| `valido-2500px-no-limite.webp` | `VP8 `, 2500×8 | **a fronteira da AC-004**. Existe em par com o de 2501 |
| `valido-vp8-com-bits-de-escala.webp` | `VP8 `, 64×48 | **(mutação)** os 2 bits altos de cada campo são ESCALA, não dimensão. Quem lê os 16 bits inteiros vê 49216 e recusa uma imagem de 64px. Os dois eixos, porque errar só a altura sobreviveu |

## Formato errado — AC-001, recusa pelos bytes

`jpeg-valido.jpg`, `png-valido.png`, `gif-valido.gif`, `bmp-valido.bmp`,
`bytes-aleatorios.bin`.

E `webp-magic-trocado.webp` **(mutação)**: `WEBP` no lugar certo, magic
`RIFX`. Sem ele, apagar a checagem do `RIFF` não reprovava nada — todo
arquivo do corpus original também falhava no `WEBP`, dois passos depois.

E `jpeg-disfarcado-de.webp`: **JPEG com nome e extensão de WebP.** É o
arquivo que separa "validar pelos bytes" de "validar pelo `Content-Type` ou
pela extensão", que é a AC-001 inteira.

## Metadado — AC-002, allowlist e não blocklist

| Arquivo | Chunk | Nota |
|---|---|---|
| `webp-com-exif.webp` | `EXIF` (flag 0x08) | **é o GPS.** Foto tirada na quadra carrega a coordenada |
| `webp-com-xmp.webp` | `XMP ` (flag 0x04) | |
| `webp-com-iccp.webp` | `ICCP` (flag 0x20) | |
| `webp-com-chunk-desconhecido.webp` | `FOO ` | **o caso que a blocklist não pega.** O formato permite chunk customizado, e é onde dado arbitrário viaja |
| `webp-com-chunk-minusculo.webp` | `vp8 ` | FourCC é case-sensitive; allowlist frouxa deixaria passar |

## Animação — AC-003

| Arquivo | Nota |
|---|---|
| `webp-animado.webp` | `ANIM` + 2× `ANMF`, flag 0x02 — animado de verdade |
| `webp-vp8x-bit-de-animacao.webp` | `VP8X` flags **0x12**, `ALPH`, `VP8 ` — **sem chunk `ANIM`**. Só o bit ligado. Quem varre chunk e ignora flag deixa passar |

## Dimensão — AC-004, lida do cabeçalho

`webp-2501px-largura.webp` (`VP8 `), `webp-2501px-altura.webp` (`VP8 `) e
`webp-vp8x-2501px.webp` (canvas do `VP8X`, 2501×8) — os três caminhos de
leitura de dimensão, um por cabeçalho.

## Quebrado — AC-005, 422 sem crash e sem decode

| Arquivo | O que quebra |
|---|---|
| `webp-vazio.webp` | 0 bytes |
| `webp-cabecalho-cortado.webp` | 9 bytes: acaba no meio do cabeçalho RIFF |
| `webp-so-cabecalho-riff.webp` | 12 bytes: `RIFF`+`WEBP` e mais nada |
| `webp-riff-sem-webp.webp` | `RIFF` seguido de `AVI ` |
| `webp-truncado-no-meio.webp` | arquivo válido cortado pela metade |
| `webp-riff-mentindo-tamanho.webp` | RIFF declara 999999 e o arquivo tem 86 B |
| `webp-chunk-mentindo-tamanho.webp` | **o chunk declara payload maior que o arquivo** — o clássico do parser que confia no tamanho declarado e lê fora do buffer |
| `webp-chunk-grande-par.webp` | **(mutação)** o mesmo, com tamanho PAR. É o que separa a guarda de limite da leniência de padding: sem a guarda, este truncado seria aceito |
| `webp-sem-chunk-nenhum.webp` | **(mutação)** `RIFF`+`WEBP` bem formados, tamanho declarado correto, zero chunks. O de 12 bytes cortado morre antes, no tamanho do RIFF |
| `webp-vp8x-tamanho-errado.webp` | **(mutação)** `VP8X` declarando 12 bytes de payload em vez dos 10 do formato |
| `webp-vp8-sync-quebrado.webp` | **(mutação)** sync code `9D 01 2A` do VP8 adulterado |
| `webp-vp8-nao-keyframe.webp` | **(mutação)** bit de keyframe desligado |
| `webp-vp8l-assinatura-errada.webp` | **(mutação)** assinatura `0x2F` do VP8L trocada |
| `webp-vp8-largura-zero.webp` | **(mutação)** 14 bits de largura zerados: cabeçalho legível, imagem degenerada |
| `webp-vp8-chunk-curto.webp` | **(mutação)** chunk `VP8 ` de 8 bytes: sync intacto, dimensão cortada ao meio. É o arquivo que faz um parser sem checagem de tamanho ler fora do buffer |

## Por que o teste checa o *motivo*, e não só a recusa

`validarWebp` tem um `catch` de último recurso que devolve
`MOTIVO_ILEGIVEL`. Ele existe para o fail-closed — mas **enquanto ele apara
exceção, toda checagem removida continua "recusando", e mutação nenhuma
reprova**. Foi exatamente o que aconteceu: três mutações sobreviveram
porque o `catch` estava fazendo o trabalho delas.

Por isso a suíte tem um teste que roda o corpus inteiro e exige que
**nenhum arquivo** seja decidido pelo `catch`. É ele que torna as checagens
de limite load-bearing, e é o teste mais importante deste arquivo.
