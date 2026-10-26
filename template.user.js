// ==UserScript==
// @name         雨课堂加密字体还原（iuno）
// @namespace    iuno-ykt-decrypt
// @version      1.0.0
// @description  雨课堂作业里的题目用加密字体显示，复制出来是乱码。本脚本读出加密字体的 cmap，按固定的字形对照表把页面文字直接换成真字，复制、翻译、搜索都正常。
// @match        *://*.yuketang.cn/*
// @match        *://yuketang.cn/*
// @run-at       document-idle
// @grant        none
// @license      MIT
// ==/UserScript==

/*
 * 原理：雨课堂的加密字体（exam_font_*.ttf）都是同一份思源黑体子集，882 个汉字，
 * glyf 表一模一样，每次加载只换 cmap（码位 → 字形编号）。
 * 所以「字形编号 → 真字」是固定的一张表（GID_TABLE），
 * 运行时读出 cmap 就能得到「乱码码位 → 真字」，几毫秒，不画图、不猜。
 * glyf 表的校验和对不上时说明雨课堂换了字形，脚本不会乱改，只提示需要更新对照表。
 */

(function () {
  'use strict';

  const GLYF_CHECKSUM = 0x755c0c0f;
  const GID_TABLE = __GID_TABLE__;
  const SELECTOR = '[class*="encrypted-font"], [class*="decrypt-font"]';
  const LOG = '[iuno-ykt]';

  const famUrl = new Map();     // 字体家族名 -> 字体文件地址
  const urlMap = new Map();     // 字体文件地址 -> Promise<Map<乱码字, 真字> | null>
  const fakeOf = new WeakMap(); // 文本节点 -> 原来的乱码
  const written = new WeakMap();// 文本节点 -> 写进去的明文
  const done = new Set();       // 处理过的元素
  let enabled = true;
  let button = null;
  let warned = false;

  /**************** 找加密字体 ****************/
  function scanFontFaces() {
    for (const sheet of document.styleSheets) {
      let rules;
      try { rules = sheet.cssRules; } catch (e) { continue; }
      for (const r of rules) {
        if (!(r instanceof CSSFontFaceRule)) continue;
        const fam = r.style.getPropertyValue('font-family').replace(/["']/g, '').trim();
        const m = /url\(\s*["']?([^"')]+)["']?\s*\)/.exec(r.style.getPropertyValue('src'));
        if (!m) continue;
        if (/exam_font_|encrypt|decrypt/i.test(m[1] + ' ' + fam)) {
          famUrl.set(fam, new URL(m[1], sheet.href || location.href).href);
        }
      }
    }
  }

  function splitFamilies(ff) {
    return ff.split(',').map(s => s.trim()).filter(Boolean);
  }

  /**************** 读 cmap ****************/
  function parseFont(buf) {
    const v = new DataView(buf);
    const numTables = v.getUint16(4);
    let cmap = 0, glyfSum = null;
    for (let i = 0; i < numTables; i++) {
      const p = 12 + i * 16;
      const tag = String.fromCharCode(v.getUint8(p), v.getUint8(p + 1), v.getUint8(p + 2), v.getUint8(p + 3));
      if (tag === 'cmap') cmap = v.getUint32(p + 8);
      if (tag === 'glyf') glyfSum = v.getUint32(p + 4);
    }
    if (!cmap) return null;
    let sub4 = 0, sub12 = 0;
    const n = v.getUint16(cmap + 2);
    for (let i = 0; i < n; i++) {
      const off = cmap + v.getUint32(cmap + 4 + i * 8 + 4);
      const fmt = v.getUint16(off);
      if (fmt === 12) sub12 = off;
      else if (fmt === 4) sub4 = off;
    }
    const map = new Map();
    if (sub12) {
      const groups = v.getUint32(sub12 + 12);
      for (let i = 0; i < groups; i++) {
        const p = sub12 + 16 + i * 12;
        const s = v.getUint32(p), e = v.getUint32(p + 4), g = v.getUint32(p + 8);
        for (let c = s; c <= e; c++) map.set(c, g + c - s);
      }
    } else if (sub4) {
      const segX2 = v.getUint16(sub4 + 6);
      const endP = sub4 + 14, startP = endP + segX2 + 2, deltaP = startP + segX2, rangeP = deltaP + segX2;
      for (let i = 0; i < segX2 / 2; i++) {
        const end = v.getUint16(endP + 2 * i), start = v.getUint16(startP + 2 * i);
        const delta = v.getInt16(deltaP + 2 * i), ro = v.getUint16(rangeP + 2 * i);
        for (let c = start; c <= end && c !== 0xFFFF; c++) {
          let g;
          if (ro === 0) g = (c + delta) & 0xFFFF;
          else {
            g = v.getUint16(rangeP + 2 * i + ro + 2 * (c - start));
            if (g) g = (g + delta) & 0xFFFF;
          }
          if (g) map.set(c, g);
        }
      }
    }
    return { map, glyfSum };
  }

  function loadMap(url) {
    if (!urlMap.has(url)) {
      urlMap.set(url, (async () => {
        const t0 = performance.now();
        const buf = await (await fetch(url)).arrayBuffer();
        const font = parseFont(buf);
        if (!font) throw new Error('读不出 cmap');
        if (font.glyfSum !== GLYF_CHECKSUM) {
          console.warn(LOG, '字形表校验和不符，雨课堂可能换了字体，对照表需要更新：', url,
            '0x' + (font.glyfSum >>> 0).toString(16));
          notice('雨课堂换了新的加密字体，对照表需要更新，这次没有改动页面');
          return null;
        }
        const m = new Map();
        for (const [cp, g] of font.map) {
          const real = GID_TABLE[g];
          if (real) m.set(String.fromCodePoint(cp), real);
        }
        console.log(LOG, `字体已解析：${m.size} 字，用时 ${(performance.now() - t0).toFixed(0)}ms`, url);
        return m;
      })().catch(e => {
        console.warn(LOG, '字体读取失败：', url, e);
        notice('加密字体读取失败，详情见控制台');
        return null;
      }));
    }
    return urlMap.get(url);
  }

  /**************** 改页面 ****************/
  function decodeTextNodes(el, map) {
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = tw.nextNode());) {
      if (written.get(n) === n.data) continue;
      let changed = false, out = '';
      for (const ch of n.data) {
        const r = map.get(ch);
        if (r) { out += r; changed = true; } else out += ch;
      }
      if (!changed) continue;
      fakeOf.set(n, n.data);
      written.set(n, out);
      n.data = out;
    }
  }

  async function processEl(el) {
    let fam = el.dataset.iunoYktFam;
    if (!fam) {
      const ff = getComputedStyle(el).fontFamily;
      const list = splitFamilies(ff);
      const first = (list[0] || '').replace(/["']/g, '');
      if (!famUrl.has(first)) scanFontFaces();
      if (!famUrl.has(first)) return;
      fam = first;
      el.dataset.iunoYktFam = fam;
      el.dataset.iunoYktRest = list.filter(f => !famUrl.has(f.replace(/["']/g, ''))).join(', ') || 'sans-serif';
    }
    const map = await loadMap(famUrl.get(fam));
    if (!map || !enabled) return;
    decodeTextNodes(el, map);
    el.style.setProperty('font-family', el.dataset.iunoYktRest, 'important');
    done.add(el);
  }

  function restoreAll() {
    for (const el of done) {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      for (let n; (n = tw.nextNode());) {
        if (fakeOf.has(n) && written.get(n) === n.data) {
          n.data = fakeOf.get(n);
          written.delete(n);
        }
      }
      el.style.removeProperty('font-family');
    }
    done.clear();
  }

  let pending = null;
  function scan() {
    pending = null;
    if (!enabled) return;
    const els = document.querySelectorAll(SELECTOR);
    if (!els.length) return;
    Promise.all([...els].map(processEl)).then(updateButton);
  }
  function schedule() {
    if (!pending) pending = setTimeout(scan, 150);
  }

  /**************** 小按钮 ****************/
  function updateButton() {
    for (const el of done) if (!el.isConnected) done.delete(el);
    if (!button) {
      if (!done.size) return;
      button = document.createElement('div');
      button.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:5px 10px;' +
        'font:12px/1.4 "PingFang SC","Microsoft YaHei",sans-serif;color:#1f2328;background:rgba(255,255,255,.92);' +
        'border:1px solid #e3e5e8;border-radius:14px;box-shadow:0 1px 4px rgba(0,0,0,.08);cursor:pointer;user-select:none;opacity:.75';
      button.title = '点击切换：还原后的文字 / 页面原样';
      button.onclick = () => {
        enabled = !enabled;
        if (enabled) scan(); else restoreAll();
        updateButton();
      };
      document.body.appendChild(button);
    }
    // 文字没变就不写，否则会触发 MutationObserver 反复扫描
    const text = enabled ? `已还原加密文字 · ${done.size} 段` : '已显示原样 · 点击还原';
    if (button.textContent !== text) button.textContent = text;
  }

  function notice(text) {
    if (warned) return;
    warned = true;
    const t = document.createElement('div');
    t.textContent = 'iuno：' + text;
    t.style.cssText = 'position:fixed;left:12px;bottom:12px;z-index:2147483647;padding:6px 12px;max-width:360px;' +
      'font:12px/1.5 "PingFang SC","Microsoft YaHei",sans-serif;color:#7a2e0e;background:#fff7ed;' +
      'border:1px solid #fed7aa;border-radius:8px';
    document.body.appendChild(t);
    setTimeout(() => t.remove(), 8000);
  }

  /**************** 启动 ****************/
  function init() {
    if (!document.body) { setTimeout(init, 300); return; }
    new MutationObserver(schedule).observe(document.body, { childList: true, subtree: true, characterData: true });
    scan();
  }
  init();
})();
