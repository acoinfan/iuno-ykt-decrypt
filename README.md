# iuno-ykt-decrypt

雨课堂作业里的题目用加密字体显示：网页源码里存的是打乱过的汉字，再由一个专门的字体把它们画成正确的字，所以页面看着正常，复制出来却是乱码。这个油猴脚本把页面上的乱码直接换回真字，复制、翻译、搜索都和普通网页一样。

## 安装

1. 浏览器装好 Tampermonkey（油猴）。新版 Chrome / Edge 要在扩展详情里打开「允许用户脚本」。
2. 油猴「管理面板」→「实用工具」→「导入」，选 `iuno-ykt-decrypt.user.js`；或者新建脚本，把文件内容整个粘进去保存。
3. 打开作业页，按一次 F5。左下角出现「已还原加密文字 · N 段」就好了，点它可以在还原后的文字和页面原样之间切换。

装过别的雨课堂解密脚本的话先关掉，不然它会把已经还原的真字再当乱码解一遍。

## 原理

- 雨课堂的加密字体（`fe-static-yuketang.yuketang.cn/fe_font/product/exam_font_*.ttf`）是从思源黑体 SC 可变字体里取出 882 个常用汉字做的子集。题目里落在这 882 个字里的字会被加密，其余的字原样显示。
- 这些字体是事先批量生成的，每次打开页面从池子里挑一个。池里每个文件打乱码位的方式不同，但 `glyf` 表逐字节一致，只有 `cmap`（码位 → 字形编号）不同。
- 所以「字形编号 → 真字」是固定的，做成一张表（`gid_table.json`）放进脚本。运行时读出字体的 `cmap` 查表，几毫秒就能精确还原，不画图、不猜字。
- 脚本会核对字体 `glyf` 表的校验和（`GLYF_CHECKSUM`）。碰到没见过的字体就不改页面，只在左下角提示需要更新对照表。

对照表是这样做出来的：加密字形和原版思源黑体的轮廓结构相同，只是每条轮廓的起点被挪动、少数点有 ±1 的抖动，按结构分桶、允许起点旋转比坐标，能可靠认出大约 760 个；剩下的用原版字体画图，再一一配对补齐。最后用三套不同的加密字体把全部 882 个字复核过。

## 字体换了怎么更新

1. 在作业页的控制台运行下面这行，拿到字体地址；多刷新几次，攒两三个地址，下载下来：

   ```js
   [...document.styleSheets].flatMap(s => { try { return [...s.cssRules] } catch (e) { return [] } }).filter(r => r instanceof CSSFontFaceRule && /decrypt/.test(r.cssText)).map(r => r.cssText).join('\n')
   ```

2. 下载原版 [SourceHanSansSC-VF.ttf](https://github.com/adobe-fonts/source-han-sans/raw/release/Variable/TTF/SourceHanSansSC-VF.ttf)（约 36M），然后：

   ```bash
   uv run --with fonttools --with pillow --with numpy --with scipy \
       tools/update_table.py SourceHanSansSC-VF.ttf exam_font_a.ttf exam_font_b.ttf
   ```

   它会写出新的 `gid_table.json` 和 `check.png`（上排加密字形、下排认出来的字，用来人工核对画图配对的那部分），并打印新的 glyf 校验和。

3. 把 `template.user.js` 里的 `GLYF_CHECKSUM` 改成新值，升一下 `@version`，运行 `python3 build.py` 生成新的 `iuno-ykt-decrypt.user.js`。

## 文件

| 文件 | 说明 |
| --- | --- |
| `iuno-ykt-decrypt.user.js` | 装进油猴的成品（由 build.py 生成） |
| `template.user.js` | 脚本源码，对照表的位置是 `__GID_TABLE__` |
| `gid_table.json` | 字形编号 → 真字，882 项 |
| `build.py` | 把对照表嵌进模板 |
| `tools/update_table.py` | 从加密字体重新生成对照表 |

## 说明

只读取页面已经加载的字体、只改动加密文字所在的元素，不上传任何数据。请在课程和平台规则允许的范围内使用。

MIT License
