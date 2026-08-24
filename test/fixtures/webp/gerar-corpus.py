#!/usr/bin/env python3
"""SPEC-017/TASK-002 — gerador do corpus de WebP.

A spec pede **corpus antes do código**, e a razão está escrita nela:
"validador escrito primeiro e testado depois acaba testado contra o que ele
já faz". Estes arquivos existiam antes da primeira linha do validador.

Os arquivos ficam commitados: o CI não tem Pillow, e corpus gerado em tempo
de teste é corpus que muda quando a biblioteca muda. Este script serve para
REGERAR (e para ler, quando alguém quiser saber o que cada arquivo é).

    cd apps/Back && python test/fixtures/webp/gerar-corpus.py

Requer Pillow (`pip install pillow`). Gerado com Pillow 12.3.0 em 2026-08-24.
"""

import io
import struct
from pathlib import Path

from PIL import Image

DESTINO = Path(__file__).parent

# Bits do byte de flags do VP8X, na ordem do container spec:
#   Rsv(2) | I(ICC) | L(Alpha) | E(Exif) | X(XMP) | A(Animação) | R
FLAG_ANIMACAO = 0x02


def salvar(nome: str, conteudo: bytes) -> None:
    (DESTINO / nome).write_bytes(conteudo)
    print(f"  {nome:44} {len(conteudo):>7} B")


def webp(im: Image.Image, **kw) -> bytes:
    buf = io.BytesIO()
    im.save(buf, "WEBP", **kw)
    return buf.getvalue()


def percorrer_chunks(b: bytes):
    """Devolve (fourcc, inicio_do_payload, tamanho) de cada chunk."""
    i = 12
    while i + 8 <= len(b):
        fourcc = b[i : i + 4]
        (tamanho,) = struct.unpack("<I", b[i + 4 : i + 8])
        yield fourcc, i + 8, tamanho
        i += 8 + tamanho + (tamanho % 2)


def corrigir_riff(b: bytes) -> bytes:
    """Reescreve o campo de tamanho do RIFF para casar com o arquivo."""
    return b[:4] + struct.pack("<I", len(b) - 8) + b[8:]


def inserir_chunk(b: bytes, fourcc: bytes, payload: bytes) -> bytes:
    assert len(fourcc) == 4
    if len(payload) % 2:
        payload += b"\x00"
    chunk = fourcc + struct.pack("<I", len(payload)) + payload
    return corrigir_riff(b[:12] + chunk + b[12:])


def ligar_flag_vp8x(b: bytes, flag: int) -> bytes:
    for fourcc, inicio, _ in percorrer_chunks(b):
        if fourcc == b"VP8X":
            return b[:inicio] + bytes([b[inicio] | flag]) + b[inicio + 1 :]
    raise AssertionError("arquivo sem chunk VP8X")


def main() -> None:
    DESTINO.mkdir(parents=True, exist_ok=True)
    rgb = Image.new("RGB", (64, 48), (200, 30, 30))
    rgba = Image.new("RGBA", (64, 48), (200, 30, 30, 128))

    print("VÁLIDOS — o validador precisa deixar passar:")
    lossy = webp(rgb, quality=80)  # VP8
    salvar("valido-vp8-lossy.webp", lossy)
    salvar("valido-vp8l-lossless.webp", webp(rgb, lossless=True))  # VP8L
    com_alpha = webp(rgba, quality=80)  # VP8X + ALPH + VP8
    salvar("valido-vp8x-com-alpha.webp", com_alpha)
    # 2500 é o limite da AC-004 e passa; 2501 não. O par existe para o teste
    # provar a fronteira, e não só "um grande e um pequeno".
    salvar(
        "valido-2500px-no-limite.webp",
        webp(Image.new("RGB", (2500, 8), (10, 10, 10)), quality=50),
    )

    print("\nFORMATO ERRADO — AC-001, recusa pelos BYTES:")
    for nome, formato, kw in [
        ("jpeg-valido.jpg", "JPEG", {}),
        ("png-valido.png", "PNG", {}),
        ("gif-valido.gif", "GIF", {}),
        ("bmp-valido.bmp", "BMP", {}),
    ]:
        buf = io.BytesIO()
        rgb.save(buf, formato, **kw)
        salvar(nome, buf.getvalue())
    # O nome mente e a extensão mente. É exatamente o ponto da AC-001.
    buf = io.BytesIO()
    rgb.save(buf, "JPEG")
    salvar("jpeg-disfarcado-de.webp", buf.getvalue())

    print("\nMETADADO — AC-002, allowlist de chunks:")
    salvar(
        "webp-com-exif.webp",
        webp(rgb, exif=b"Exif\x00\x00II*\x00\x08\x00\x00\x00\x00\x00"),
    )
    salvar("webp-com-xmp.webp", webp(rgb, xmp=b"<x:xmpmeta/>"))
    salvar("webp-com-iccp.webp", webp(rgb, icc_profile=b"\x00" * 128))
    # O caso que a blocklist NÃO pegaria: chunk que ninguém previu. O formato
    # permite chunk customizado, e é onde dado arbitrário viaja.
    salvar(
        "webp-com-chunk-desconhecido.webp",
        inserir_chunk(com_alpha, b"FOO ", b"carga arbitraria"),
    )
    salvar(
        "webp-com-chunk-minusculo.webp",
        inserir_chunk(com_alpha, b"vp8 ", b"nao e o mesmo fourcc"),
    )

    print("\nANIMAÇÃO — AC-003:")
    animado = io.BytesIO()
    Image.new("RGB", (64, 48), (0, 120, 0)).save(
        animado,
        "WEBP",
        save_all=True,
        append_images=[Image.new("RGB", (64, 48), (0, 0, 120))],
        duration=100,
    )
    salvar("webp-animado.webp", animado.getvalue())
    # O caso da AC-003: SEM chunk ANIM, só o bit ligado no flag do VP8X.
    # Blocklist de chunk passaria batido.
    salvar(
        "webp-vp8x-bit-de-animacao.webp",
        ligar_flag_vp8x(com_alpha, FLAG_ANIMACAO),
    )

    print("\nDIMENSÃO — AC-004, lida do cabeçalho:")
    salvar(
        "webp-2501px-largura.webp",
        webp(Image.new("RGB", (2501, 8), (10, 10, 10)), quality=50),
    )
    salvar(
        "webp-2501px-altura.webp",
        webp(Image.new("RGB", (8, 2501), (10, 10, 10)), quality=50),
    )
    salvar(
        "webp-vp8x-2501px.webp",
        webp(Image.new("RGBA", (2501, 8), (10, 10, 10, 128)), quality=50),
    )

    print("\nQUEBRADO — AC-005, 422 sem crash e sem decode:")
    salvar("webp-vazio.webp", b"")
    salvar("webp-truncado-no-meio.webp", lossy[: len(lossy) // 2])
    salvar("webp-so-cabecalho-riff.webp", lossy[:12])
    salvar("webp-cabecalho-cortado.webp", lossy[:9])
    # RIFF declarando um tamanho que o arquivo não tem: o container mente
    # sobre si mesmo antes de qualquer chunk.
    salvar(
        "webp-riff-mentindo-tamanho.webp",
        lossy[:4] + struct.pack("<I", 999_999) + lossy[8:],
    )
    # Chunk declarando payload maior que o arquivo — o clássico de parser
    # que confia no tamanho declarado e lê fora do buffer.
    fourcc, inicio, _ = next(percorrer_chunks(lossy))
    salvar(
        "webp-chunk-mentindo-tamanho.webp",
        lossy[: inicio - 4] + struct.pack("<I", 999_999) + lossy[inicio:],
    )
    salvar("webp-riff-sem-webp.webp", lossy[:8] + b"AVI " + lossy[12:])
    # O espelho do anterior, e ele existe por causa de uma mutação que
    # SOBREVIVEU: sem ele, apagar a checagem do magic `RIFF` não reprovava
    # nenhum teste, porque todo arquivo do corpus também falhava no `WEBP`.
    salvar("webp-magic-trocado.webp", b"RIFX" + lossy[4:])
    # Chunk declarando payload maior que o arquivo, com tamanho PAR: sem a
    # guarda de limite, a leniência do padding aceitaria o truncado.
    fourcc_par, inicio_par, _ = next(percorrer_chunks(lossy))
    salvar(
        "webp-chunk-grande-par.webp",
        corrigir_riff(lossy[: inicio_par - 4] + struct.pack("<I", 400) + lossy[inicio_par:]),
    )
    # VP8X declarando payload de 12 bytes em vez dos 10 do formato. Também
    # veio de mutação sobrevivente: sem este arquivo, apagar a checagem de
    # tamanho do VP8X não reprovava nada.
    for fourcc_x, inicio_x, tamanho_x in percorrer_chunks(com_alpha):
        if fourcc_x == b"VP8X":
            salvar(
                "webp-vp8x-tamanho-errado.webp",
                corrigir_riff(
                    com_alpha[: inicio_x - 4]
                    + struct.pack("<I", tamanho_x + 2)
                    + com_alpha[inicio_x : inicio_x + tamanho_x]
                    + bytes(2)
                    + com_alpha[inicio_x + tamanho_x :]
                ),
            )
            break

    # Os tres arquivos abaixo vieram de mutacoes SOBREVIVENTES: sem eles,
    # apagar a checagem do sync code do VP8, a assinatura 0x2F do VP8L ou a
    # mascara de 14 bits da largura nao reprovava teste nenhum.
    _, inicio_vp8, _ = next(percorrer_chunks(lossy))
    quebrado = bytearray(lossy)
    quebrado[inicio_vp8 + 3 : inicio_vp8 + 6] = b"XYZ"
    salvar("webp-vp8-sync-quebrado.webp", bytes(quebrado))

    interframe = bytearray(lossy)
    interframe[inicio_vp8] |= 1  # bit de keyframe desligado
    salvar("webp-vp8-nao-keyframe.webp", bytes(interframe))

    lossless = webp(rgb, lossless=True)
    _, inicio_vp8l, _ = next(percorrer_chunks(lossless))
    sem_assinatura = bytearray(lossless)
    sem_assinatura[inicio_vp8l] = 0x2E
    salvar("webp-vp8l-assinatura-errada.webp", bytes(sem_assinatura))

    # Os 2 bits altos do campo de largura do VP8 sao ESCALA, nao dimensao.
    # O arquivo continua 64x48; quem le os 16 bits inteiros ve 49216.
    com_escala = bytearray(lossy)
    com_escala[inicio_vp8 + 7] |= 0xC0  # escala horizontal
    com_escala[inicio_vp8 + 9] |= 0xC0  # escala vertical (a mascara e por eixo)
    salvar("valido-vp8-com-bits-de-escala.webp", bytes(com_escala))

    # RIFF/WEBP bem formados e mais nada. O de 12 bytes cortado ja falha
    # antes, no tamanho do RIFF — este chega ate a contagem de chunks.
    salvar("webp-sem-chunk-nenhum.webp", b"RIFF" + struct.pack("<I", 4) + b"WEBP")

    dimensao_zero = bytearray(lossy)
    dimensao_zero[inicio_vp8 + 6 : inicio_vp8 + 8] = bytes(2)
    salvar("webp-vp8-largura-zero.webp", bytes(dimensao_zero))

    # Chunk VP8 de 8 bytes: sync code intacto, dimensao cortada ao meio. E o
    # arquivo que faz um parser sem checagem de tamanho ler FORA do buffer —
    # curto demais para ter dimensao, longo demais para o sync reprovar.
    curto = lossy[: inicio_vp8 - 4] + struct.pack("<I", 8) + lossy[inicio_vp8 : inicio_vp8 + 8]
    salvar("webp-vp8-chunk-curto.webp", corrigir_riff(curto))

    salvar("bytes-aleatorios.bin", bytes(range(256)) * 4)

    print("\nfeito.")


if __name__ == "__main__":
    main()
