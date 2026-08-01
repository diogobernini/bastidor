"""
Codificador Huffman/LZ compatível com pystitch.EmbCompress.decompress (usado
pelo HUS). NÃO faz parte do app Bastidor: existe só para gerar fixtures de
teste (.hus), já que o pystitch tem HusReader mas NÃO tem um writer/encoder
funcional para esse formato (o próprio EmbCompress.compress() do pystitch não
é o inverso de expand() — o teste correspondente no repositório do pystitch
está marcado @unittest.skip, confirmando que os mantenedores sabem disso).

Estratégia: só literais (sem referências LZ) — mais simples de implementar
corretamente e suficiente para validar o decodificador (a parte que importa
para leitura de arquivos .hus reais). Um único bloco por fluxo.
"""
import heapq
from pystitch.EmbCompress import Huffman


class BitWriter:
    def __init__(self):
        self.data = bytearray()
        self.bit_pos = 0

    def write_bits(self, value, length):
        for i in range(length - 1, -1, -1):
            bit = (value >> i) & 1
            byte_index = self.bit_pos // 8
            bit_in_byte = self.bit_pos % 8
            if byte_index == len(self.data):
                self.data.append(0)
            if bit:
                self.data[byte_index] |= (1 << (7 - bit_in_byte))
            self.bit_pos += 1

    def get_bytes(self):
        return bytes(self.data)


def huffman_lengths(symbols):
    """symbols: lista de valores distintos. Retorna dict symbol->length (>=1),
    ou None se só houver 1 símbolo (usar a codificação trivial count=0)."""
    symbols = list(symbols)
    if len(symbols) <= 1:
        return None
    heap = []
    for i, s in enumerate(symbols):
        heapq.heappush(heap, (1, i, ('leaf', s)))
    counter = len(symbols)
    while len(heap) > 1:
        f1, _, n1 = heapq.heappop(heap)
        f2, _, n2 = heapq.heappop(heap)
        counter += 1
        heapq.heappush(heap, (f1 + f2, counter, ('node', n1, n2)))
    root = heap[0][2]
    lengths = {}

    def walk(node, depth):
        if node[0] == 'leaf':
            lengths[node[1]] = depth
        else:
            walk(node[1], depth + 1)
            walk(node[2], depth + 1)

    walk(root, 0)
    return lengths


def build_table(lengths_array):
    huff = Huffman(lengths_array)
    huff.build_table()
    return huff


def code_for(huff, symbol):
    idx = huff.table.index(symbol)
    length = huff.lengths[symbol]
    code = idx >> (huff.table_width - length)
    return code, length


def write_variable_length(bw, m):
    """Inverso de EmbCompress.read_variable_length."""
    if m < 7:
        bw.write_bits(m, 3)
        return
    bw.write_bits(7, 3)
    extra = m - 7
    for _ in range(extra):
        bw.write_bits(1, 1)
    bw.write_bits(0, 1)


def write_length_array(bw, lengths_array):
    """Escreve um array de comprimentos posição a posição via
    write_variable_length, reproduzindo o desvio hardcoded do índice 3 de
    load_character_length_huffman (2 bits de "pulo", sempre 0 aqui)."""
    count = len(lengths_array)
    index = 0
    while index < count:
        if index == 3:
            bw.write_bits(0, 2)
        write_variable_length(bw, lengths_array[index])
        index += 1


def encode_meta_sequence(target_lengths):
    """Gera a sequência de meta-símbolos (0/1/2 = pulo, N = comprimento N-2)
    que reconstrói `target_lengths` via load_character_huffman."""
    seq = []
    count = len(target_lengths)
    index = 0
    while index < count:
        if target_lengths[index] == 0:
            remaining = count - index
            run = 0
            while run < remaining and target_lengths[index + run] == 0:
                run += 1
            if run >= 20:
                chunk = min(run, 20 + 511)
                seq.append(('skip2', chunk))
            elif run >= 3:
                chunk = min(run, 3 + 15)
                seq.append(('skip1', chunk))
            else:
                chunk = 1
                seq.append(('skip0', chunk))
            index += chunk
        else:
            seq.append(('value', target_lengths[index] + 2))
            index += 1
    return seq


def write_character_huffman(bw, target_lengths):
    """Escreve o cabeçalho completo de load_character_huffman: PRIMEIRO a
    meta-tabela (character_length_huffman — é isso que load_block() lê antes),
    depois o contador de 9 bits e os comprimentos reais codificados através
    dela. A ordem importa: load_block() chama load_character_length_huffman()
    e só DEPOIS load_character_huffman() (que lê seu próprio contador)."""
    seq = encode_meta_sequence(target_lengths)
    meta_symbols = set()
    for kind, val in seq:
        if kind == 'skip0':
            meta_symbols.add(0)
        elif kind == 'skip1':
            meta_symbols.add(1)
        elif kind == 'skip2':
            meta_symbols.add(2)
        else:
            meta_symbols.add(val)

    meta_lengths_map = huffman_lengths(sorted(meta_symbols))

    if meta_lengths_map is None:
        # Só um meta-símbolo usado (stream trivial): tabela de valor único.
        only_symbol = next(iter(meta_symbols))
        meta_count = 0
        bw.write_bits(meta_count, 5)
        bw.write_bits(only_symbol, 5)
        meta_huff = None
    else:
        meta_alphabet_size = max(meta_symbols) + 1
        meta_lengths_array = [0] * meta_alphabet_size
        for sym, length in meta_lengths_map.items():
            meta_lengths_array[sym] = length
        bw.write_bits(meta_alphabet_size, 5)
        write_length_array(bw, meta_lengths_array)
        meta_huff = build_table(meta_lengths_array)

    # Só agora vem o contador da tabela PRINCIPAL (load_character_huffman lê
    # seu próprio `count = pop(9)` antes de consumir a sequência de símbolos).
    count = len(target_lengths)
    bw.write_bits(count, 9)

    for kind, val in seq:
        if kind == 'skip0':
            sym = 0
        elif kind == 'skip1':
            sym = 1
        elif kind == 'skip2':
            sym = 2
        else:
            sym = val
        if meta_huff is None:
            continue  # tabela trivial: nenhum bit é gasto para o símbolo
        code, length = code_for(meta_huff, sym)
        bw.write_bits(code, length)
        if kind == 'skip1':
            bw.write_bits(val - 3, 4)
        elif kind == 'skip2':
            bw.write_bits(val - 20, 9)


def compress_stream(byte_values):
    """Comprime uma lista de valores de byte (0-255) num único bloco, só com
    literais + marcador de fim (510). Retorna bytes prontos para gravar no
    arquivo .hus (nos três trechos: comando, x, y)."""
    bw = BitWriter()
    used = sorted(set(byte_values)) + [510]
    lengths_map = huffman_lengths(used)

    total_tokens = len(byte_values) + 1  # + marcador de fim
    bw.write_bits(total_tokens, 16)  # block_elements

    if lengths_map is None:
        # Um único símbolo de dado + marcador de fim viraria um alfabeto de 2;
        # isso só ocorre se byte_values estiver vazio E só sobrar o próprio
        # marcador de fim.
        only_symbol = used[0]
        target_lengths = [0] * (only_symbol + 1)
        target_lengths[only_symbol] = 1
    else:
        alphabet_size = 511
        target_lengths = [0] * alphabet_size
        for sym, length in lengths_map.items():
            target_lengths[sym] = length

    write_character_huffman(bw, target_lengths)

    # distance_huffman: nunca usado (sem referências LZ) — tabela trivial.
    bw.write_bits(0, 5)
    bw.write_bits(0, 5)

    main_huff = build_table(target_lengths)
    for b in byte_values:
        code, length = code_for(main_huff, b)
        bw.write_bits(code, length)
    code, length = code_for(main_huff, 510)
    bw.write_bits(code, length)

    return bw.get_bytes()


if __name__ == '__main__':
    import random
    from pystitch.EmbCompress import expand

    random.seed(42)
    for trial in range(20):
        n = random.randint(1, 500)
        data = [random.randint(0, 255) for _ in range(n)]
        compressed = compress_stream(data)
        result = expand(bytearray(compressed), n)
        result = result[:n]
        assert result == data, f"falhou no trial {trial}: n={n}"
    print("OK: round-trip via pystitch.EmbCompress.expand confere em todos os testes")
