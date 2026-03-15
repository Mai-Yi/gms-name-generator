# -*- coding: utf-8 -*-
import json
with open('d:/Name/char_to_game.json', 'r', encoding='utf-8') as f:
    d = json.load(f)
with open('d:/Name/check_result.txt', 'w', encoding='utf-8') as out:
    out.write('靘 -> %s\n' % repr(d.get('靘', 'NOT FOUND')))
    out.write('艶 -> %s\n' % repr(d.get('艶', 'NOT FOUND')))
