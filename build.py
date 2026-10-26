"""把 gid_table.json 嵌进 template.user.js，生成 iuno-ykt-decrypt.user.js。"""
import json, os
here = os.path.dirname(os.path.abspath(__file__))
table = json.load(open(os.path.join(here, 'gid_table.json'), encoding='utf-8'))
js = json.dumps({int(k): v for k, v in sorted(table.items(), key=lambda kv: int(kv[0]))}, ensure_ascii=False, separators=(',', ':'))
src = open(os.path.join(here, 'template.user.js'), encoding='utf-8').read()
assert src.count('__GID_TABLE__') == 1
open(os.path.join(here, 'iuno-ykt-decrypt.user.js'), 'w', encoding='utf-8').write(src.replace('__GID_TABLE__', js))
print('写入', len(table), '个字形')
