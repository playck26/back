#!/usr/bin/env bash
# SPEC-017/TASK-002 — a metade do corpus que NÃO veio do Pillow.
#
# Todo o resto de `test/fixtures/webp/` sai de um único encoder. Validador
# afinado num encoder só passa a codificar as manias dele, e ninguém percebe
# até chegar um arquivo de outra origem. Estes cinco vêm do **libwebp**, pelo
# ffmpeg — o mesmo encoder que o Chrome usa por baixo do `canvas.toBlob`.
#
# Entraram depois da validação cruzada de 2026-08-24, para responder à dúvida
# que sobrou dela: `validarSequencia` recusa forma legítima do container?
# Estes arquivos dizem que não, e não fui eu que os montei.
#
# Requer ffmpeg com libwebp. Gerado com ffmpeg 8.1.2 em 2026-08-24.
set -euo pipefail
cd "$(dirname "$0")"

ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=320x240:rate=1" \
  -frames:v 1 -c:v libwebp -lossless 0 -quality 80 ff-lossy.webp
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=320x240:rate=1" \
  -frames:v 1 -c:v libwebp -lossless 1 ff-lossless.webp
ffmpeg -y -loglevel error -f lavfi -i "color=c=red@0.5:size=200x150:rate=1,format=rgba" \
  -frames:v 1 -c:v libwebp -lossless 0 ff-alpha-lossy.webp
ffmpeg -y -loglevel error -f lavfi -i "color=c=blue@0.5:size=200x150:rate=1,format=rgba" \
  -frames:v 1 -c:v libwebp -lossless 1 ff-alpha-lossless.webp
ffmpeg -y -loglevel error -f lavfi -i "testsrc=size=64x64:rate=1" \
  -frames:v 1 -c:v libwebp -pix_fmt yuv420p -preset photo ff-preset-photo.webp

echo "5 arquivos do libwebp gerados."
