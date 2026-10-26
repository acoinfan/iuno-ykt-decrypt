"""从雨课堂的加密字体生成「字形编号 → 真字」对照表（gid_table.json）。

用法：
    uv run --with fonttools --with pillow --with numpy --with scipy \
        tools/update_table.py SourceHanSansSC-VF.ttf exam_font_a.ttf exam_font_b.ttf ...

SourceHanSansSC-VF.ttf 是 Adobe 原版思源黑体 SC 可变字体：
    https://github.com/adobe-fonts/source-han-sans/raw/release/Variable/TTF/SourceHanSansSC-VF.ttf
加密字体给同一批里的几个（地址在页面 @font-face 里，exam_font_*.ttf），越多越好。

步骤：
1. 结构匹配：加密字形和原版字形点数结构相同，只是轮廓起点被挪动、少数点有 ±1 抖动。
   按「每条轮廓的点数」分桶，桶里允许起点旋转算坐标距离，距离很小且明显优于第二名的算可靠。
2. 合并：同一批字体 glyf 表一样，可靠结果按字形编号合并。
3. 剩下的字形和剩下的字用原版字体画图，余弦距离加一一配对（匈牙利算法）补齐。
4. 全部 882 个字用画图距离复核一遍，并输出 check.png（上排加密字形，下排认出来的字）。
"""
import collections
import json
import os
import sys

import numpy as np
from fontTools.ttLib import TTFont
from PIL import Image, ImageDraw, ImageFilter, ImageFont
from scipy.optimize import linear_sum_assignment

OUT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def contours(font, gname):
    g = font['glyf'][gname]
    c, ends, _ = g.getCoordinates(font['glyf'])
    c = list(c)
    out, s = [], 0
    for e in ends:
        out.append(c[s:e + 1])
        s = e + 1
    return out


def contour_dist(a, b):
    """同点数的两条轮廓，允许起点旋转，取最小的坐标 L1 距离。"""
    n, best = len(a), float('inf')
    for r in range(n):
        d = 0
        for i in range(n):
            (x1, y1), (x2, y2) = a[i], b[(i + r) % n]
            d += abs(x1 - x2) + abs(y1 - y2)
            if d >= best:
                break
        best = min(best, d)
    return best


def shape_key(cs):
    return tuple(len(x) for x in cs)


S, G = 64, 24


def feature(font, ch):
    im = Image.new('L', (S, S), 0)
    ImageDraw.Draw(im).text((0, S * .88), ch, font=font, fill=255, anchor='ls')
    v = np.asarray(im.filter(ImageFilter.GaussianBlur(1.5)).resize((G, G), Image.BOX), np.float32).ravel()
    v -= v.mean()
    return v / (np.linalg.norm(v) + 1e-6)


def main(orig_path, enc_paths):
    orig = TTFont(orig_path)
    encs = [TTFont(p) for p in enc_paths]
    sums = {hex(f.reader.tables['glyf'].checkSum) for f in encs}
    if len(sums) != 1:
        sys.exit(f'这几个字体的 glyf 校验和不一样（{sums}），不是同一批，请分开处理')
    glyf_sum = sums.pop()

    buckets = collections.defaultdict(list)
    for cp, gn in orig.getBestCmap().items():
        if 0x4E00 <= cp <= 0x9FFF:
            cs = contours(orig, gn)
            buckets[shape_key(cs)].append((chr(cp), cs))

    gid, conflict = {}, 0
    for f, p in zip(encs, enc_paths):
        n = 0
        for cp, gn in f.getBestCmap().items():
            cs = contours(f, gn)
            sc = sorted((sum(contour_dist(a, b) for a, b in zip(cs, o)), ch)
                        for ch, o in buckets.get(shape_key(cs), []))
            if sc and sc[0][0] <= 40 and (len(sc) == 1 or sc[1][0] > 200):
                g = f.getGlyphID(gn)
                if g in gid and gid[g] != sc[0][1]:
                    conflict += 1
                gid[g] = sc[0][1]
                n += 1
        print(f'{os.path.basename(p)}：结构匹配可靠 {n} 字')
    if conflict:
        sys.exit(f'结构匹配有 {conflict} 处冲突，请检查')

    base = encs[0]
    cmap = base.getBestCmap()
    g2fake = {base.getGlyphID(gn): chr(cp) for cp, gn in cmap.items()}
    charset = sorted(g2fake.values())
    left = sorted(set(charset) - set(gid.values()))
    miss = sorted(set(g2fake) - set(gid))
    print(f'共 {len(g2fake)} 字形，结构匹配确定 {len(gid)}，剩 {len(miss)} 个用画图配对')
    if len(left) != len(miss):
        sys.exit(f'剩下的字形（{len(miss)}）和剩下的字（{len(left)}）数目不同，字符集不是自身的置换，需要人工看')

    enc_font = ImageFont.truetype(enc_paths[0], S)
    ref_font = ImageFont.truetype(orig_path, S)
    if miss:
        E = np.stack([feature(enc_font, g2fake[g]) for g in miss])
        R = np.stack([feature(ref_font, c) for c in left])
        r, c = linear_sum_assignment(2 - 2 * E @ R.T)
        for i, j in zip(r, c):
            gid[miss[i]] = left[j]

    worst, bad = 0.0, []
    for g, fake in g2fake.items():
        d = 2 - 2 * float(feature(enc_font, fake) @ feature(ref_font, gid[g]))
        worst = max(worst, d)
        if d > 0.3:
            bad.append((g, gid[g], round(d, 3)))
    print(f'复核：最大画图距离 {worst:.3f}，可疑 {bad or "无"}')

    cols = 31
    rows = (len(miss) + cols - 1) // cols or 1
    img = Image.new('L', (cols * 40 + 10, rows * 92 + 10), 255)
    d = ImageDraw.Draw(img)
    e32, r32 = ImageFont.truetype(enc_paths[0], 32), ImageFont.truetype(orig_path, 32)
    for k, g in enumerate(miss):
        x, y = 10 + (k % cols) * 40, 10 + (k // cols) * 92
        d.text((x, y), g2fake[g], font=e32, fill=0)
        d.text((x, y + 40), gid[g], font=r32, fill=0)
    img.save(os.path.join(OUT_DIR, 'check.png'))

    with open(os.path.join(OUT_DIR, 'gid_table.json'), 'w', encoding='utf-8') as fp:
        json.dump({str(k): v for k, v in sorted(gid.items())}, fp, ensure_ascii=False)
    print(f'已写 gid_table.json（{len(gid)} 字）和 check.png。glyf 校验和 {glyf_sum}，'
          f'和脚本里的 GLYF_CHECKSUM 不同时记得一起改，再运行 build.py')


if __name__ == '__main__':
    if len(sys.argv) < 3:
        sys.exit(__doc__)
    main(sys.argv[1], sys.argv[2:])
