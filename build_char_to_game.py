# -*- coding: utf-8 -*-
import json

with open('d:/Name/byte_to_char.json', 'r', encoding='utf-8') as f:
    byte_to_char = json.load(f)

def game_str(s):
    out = []
    try:
        for b in s.encode('gbk'):
            key = '%02X' % b
            v = byte_to_char.get(key, '')
            if v:
                out.append(v[0])
            else:
                out.append(chr(b))
    except UnicodeEncodeError:
        return None
    return ''.join(out)

with open('d:/Name/pinyin_chars.json', 'r', encoding='utf-8') as f:
    pinyin_chars = json.load(f)

all_chars = set()
for chars in pinyin_chars.values():
    all_chars.update(chars)

BAD_CHARS = set('[]\\^_')

char_to_game = {}
for c in all_chars:
    g = game_str(c)
    if g and not any(x in g for x in BAD_CHARS):
        char_to_game[c] = g

with open('d:/Name/char_to_game.json', 'w', encoding='utf-8') as f:
    json.dump(char_to_game, f, ensure_ascii=False)

with open('d:/Name/build_log.txt', 'w', encoding='utf-8') as f:
    f.write('char_to_game count: %d\n' % len(char_to_game))
