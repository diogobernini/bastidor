"""
Gera as fixtures de referência usadas para validar os leitores/gravadores
VP3, HUS, SEW e PCS (issue #18) contra o pystitch.

- VP3 e SEW: o pystitch tem writers reais (Vp3Writer, SewWriter) — usados
  diretamente.
- HUS: o pystitch só tem HusReader (não há writer funcional — o próprio
  EmbCompress.compress() não é o inverso de expand(); ver hus_encoder.py e
  test/test_read_hus.py no repositório do pystitch, que marca esse roundtrip
  como @unittest.skip). O arquivo .hus é montado manualmente aqui, seguindo
  o layout de HusReader.py, comprimindo os fluxos de comando/x/y com o
  codificador equivalente (hus_encoder.compress_stream — compatível com
  pystitch.EmbCompress.expand, testado em hus_encoder.py).
- PCS: o pystitch também não tem PcsWriter. A fixture .pcs é gerada pelo
  NOSSO writer JS (src/core/io/pcs.js) — ver generate-pcs-fixtures.js.

Uso:
  python3 -m venv venv && source venv/bin/activate && pip install pystitch
  cd tools/pystitch-fixtures && python3 generate_fixtures.py
"""
import os
import struct

import pystitch
from pystitch.EmbConstant import COMMAND_MASK, STITCH, JUMP, TRIM, COLOR_CHANGE, END
from pystitch.EmbThreadHus import get_thread_set as get_hus_thread_set
from pystitch.EmbThreadSew import get_thread_set as get_sew_thread_set

from hus_encoder import compress_stream

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
FIXTURES_DIR = os.path.join(REPO_ROOT, 'tests', 'fixtures')
SAMPLES_DIR = os.path.join(REPO_ROOT, 'samples')

HUS_SETTINGS = {'max_jump': 127, 'max_stitch': 127, 'full_jump': True, 'round': True}

# SewWriter.py não declara MAX_JUMP_DISTANCE/MAX_STITCH_DISTANCE (ao contrário
# de Vp3Writer.py) — sem esses atributos, EmbPattern.write_embroidery() NÃO
# aplica nenhum limite automaticamente, e write_int_array_8 grava dx/dy num
# único byte sem checar faixa: um salto maior que 127 fica silenciosamente
# corrompido (trunca em vez de dividir). Precisamos passar os limites na mão.
SEW_SETTINGS = {'max_jump': 127, 'max_stitch': 127, 'full_jump': True, 'round': True}


# --------------------------------------------------------------- desenhos

def build_multicolor_pattern():
    """Espelho EXATO de buildMultiColorSample() em tools/make-samples.js —
    mesmas coordenadas e mesma ordem de comandos. Só segmentos alinhados aos
    eixos (múltiplos exatos de STEP): não há divisão fracionária em nenhum
    passo, então o Math.round (JS) e o round() do Python (bankers' rounding)
    nunca precisam desempatar — os dois geram a mesma lista de pontos."""
    p = pystitch.EmbPattern()
    p.add_thread(pystitch.EmbThread('#d11f2c'))
    p.add_thread(pystitch.EmbThread('#1f9d55'))
    p.add_thread(pystitch.EmbThread('#1f5fd1'))
    p.add_thread(pystitch.EmbThread('#e8c200'))

    STEP = 20

    def line_to(x, y):
        x0, y0 = p.stitches[-1][0], p.stitches[-1][1]
        dist = abs(x - x0) + abs(y - y0)
        steps = round(dist / STEP)
        for s in range(1, steps + 1):
            p.stitch_abs(x0 + round((x - x0) * s / steps), y0 + round((y - y0) * s / steps))

    p.move_abs(-400, -400)
    line_to(-100, -400)
    line_to(-100, -100)
    line_to(-400, -100)
    line_to(-400, -400)
    p.trim()
    p.color_change()

    p.move_abs(300, -400)
    line_to(500, -400)
    line_to(500, -200)
    line_to(300, -200)
    line_to(300, -400)
    p.trim()
    p.color_change()

    p.move_abs(-400, 200)
    for _ in range(6):
        x0, y0 = p.stitches[-1][0], p.stitches[-1][1]
        line_to(x0 + 60, y0)
        x0, y0 = p.stitches[-1][0], p.stitches[-1][1]
        line_to(x0, y0 + 60)
    p.trim()
    p.color_change()

    p.move_abs(200, 200)
    p.stitch_abs(200, 200)
    for i in range(1, 6):
        p.move_abs(200 + i * 60, 200 + (i % 2) * 60)
        p.stitch_abs(200 + i * 60, 200 + (i % 2) * 60)
    p.end()
    return p


def nearest_index(thread, palette):
    best_i, best_d = 0, None
    for i, t in enumerate(palette):
        dr = thread.get_red() - t.get_red()
        dg = thread.get_green() - t.get_green()
        db = thread.get_blue() - t.get_blue()
        d = dr * dr + dg * dg + db * db
        if best_d is None or d < best_d:
            best_d = d
            best_i = i
    return best_i


def assign_catalog_numbers_for_sew(pattern):
    """SewWriter só grava o índice de um fio se thread.catalog_number estiver
    definido — sem isso (caso do XXX, que não tem números de catálogo), a
    tabela de cores sai vazia. Aqui escolhemos o índice mais próximo na
    paleta SEW de fábrica, só para ter uma fixture com cores reais."""
    palette = get_sew_thread_set()
    for thread in pattern.threadlist:
        thread.catalog_number = str(nearest_index(thread, palette))


# --------------------------------------------------------------- HUS

def pattern_to_hus_streams(pattern):
    commands, xs, ys = [], [], []
    prev_x = 0
    prev_y = 0
    for stitch in pattern.stitches:
        x, y, raw = stitch
        flag = raw & COMMAND_MASK
        if flag == STITCH:
            cmd = 0x80
        elif flag == JUMP:
            cmd = 0x81
        elif flag == COLOR_CHANGE:
            cmd = 0x84
        elif flag == TRIM:
            cmd = 0x88
        elif flag == END:
            continue
        else:
            continue
        dx = int(round(x - prev_x))
        dy = int(round(y - prev_y))
        prev_x += dx
        prev_y += dy
        commands.append(cmd)
        xs.append(dx & 0xFF)
        ys.append((-dy) & 0xFF)
    return commands, xs, ys


def write_hus_fixture(pattern, out_path):
    normalized = pattern.get_normalized_pattern(HUS_SETTINGS)
    commands, xs, ys = pattern_to_hus_streams(normalized)
    n = len(commands)
    if n == 0:
        raise ValueError('sem pontos para gravar em HUS')

    command_compressed = compress_stream(commands)
    x_compressed = compress_stream(xs)
    y_compressed = compress_stream(ys)

    hus_palette = get_hus_thread_set()
    thread_indices = [nearest_index(t, hus_palette) for t in normalized.threadlist]

    left, top, right, bottom = normalized.bounds()

    def s16(v):
        v = int(round(v))
        v = max(-32768, min(32767, v))
        return struct.pack('<h', v)

    header = bytearray()
    header += struct.pack('<I', 0x00000000)  # magic_code (não validado por nenhum leitor)
    header += struct.pack('<I', n)
    header += struct.pack('<I', len(thread_indices))
    header += s16(right) + s16(bottom) + s16(left) + s16(top)

    offsets_pos = len(header)
    header += b'\x00' * 12  # placeholders: command_offset, x_offset, y_offset
    header += b'Bastidor'  # string_value (8 bytes, não usada pelo leitor)
    header += struct.pack('<H', 0)  # unknown_16_bit

    for idx in thread_indices:
        header += struct.pack('<H', idx)

    command_offset = len(header)
    x_offset = command_offset + len(command_compressed)
    y_offset = x_offset + len(x_compressed)
    struct.pack_into('<III', header, offsets_pos, command_offset, x_offset, y_offset)

    data = bytes(header) + command_compressed + x_compressed + y_compressed
    with open(out_path, 'wb') as f:
        f.write(data)
    return normalized


# --------------------------------------------------------------- main

def main():
    os.makedirs(FIXTURES_DIR, exist_ok=True)

    rosacea = pystitch.read(os.path.join(SAMPLES_DIR, 'rosacea.xxx'))
    multicolor = build_multicolor_pattern()

    for name, pattern in (('rosacea', rosacea), ('multicolor', multicolor)):
        pystitch.write(pattern, os.path.join(FIXTURES_DIR, f'{name}.vp3'))
        print(f'gravado {name}.vp3')

        assign_catalog_numbers_for_sew(pattern)
        pystitch.write(pattern, os.path.join(FIXTURES_DIR, f'{name}.sew'), SEW_SETTINGS)
        print(f'gravado {name}.sew')

        write_hus_fixture(pattern, os.path.join(FIXTURES_DIR, f'{name}.hus'))
        print(f'gravado {name}.hus')


if __name__ == '__main__':
    main()
