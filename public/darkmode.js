/*
 * Dark / light mode check and fix for emails.
 *
 * How it works: the email is loaded into a hidden frame and its real styles are
 * computed twice, once as light mode and once as dark mode (by switching on the
 * email's own "@media (prefers-color-scheme: dark)" rules). Then:
 *   - a light block that is still light in dark mode is "not adapted"
 *   - text that is hard to read in dark mode (low contrast) is "unreadable"
 *   - dark-mode rules without a color-scheme tag is a missing tag
 * The fix adds dark-mode colors for just those spots, in a style block the tool
 * owns, and never touches the email's own dark-mode styling.
 *
 * window.EmailDarkMode = { analyze(html), fix(html) }  (both return Promises)
 */
(function () {
  'use strict';

  const LIGHT_BG = 0.7;      // a background this bright counts as "light"
  const MIN_CONTRAST = 3;    // text below this contrast is hard to read
  const DEFAULT_TEXT = '#e6e6e6';
  const DEFAULT_PAGE = '#121212';

  /* ---------- colors ---------- */
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
  }
  function contrast(a, b) {
    const x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function toHsl([r, g, b]) {
    r /= 255; g /= 255; b /= 255;
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
    let h = 0, s = 0;
    if (mx !== mn) {
      const d = mx - mn;
      s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
      if (mx === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (mx === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h /= 6;
    }
    return [h, s, l];
  }
  function fromHsl([h, s, l]) {
    if (s === 0) { const v = Math.round(l * 255); return [v, v, v]; }
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const hue = (t) => {
      if (t < 0) t += 1; if (t > 1) t -= 1;
      if (t < 1 / 6) return p + (q - p) * 6 * t;
      if (t < 1 / 2) return q;
      if (t < 2 / 3) return p + (q - p) * (2 / 3 - t) * 6;
      return p;
    };
    return [hue(h + 1 / 3), hue(h), hue(h - 1 / 3)].map((v) => Math.round(v * 255));
  }
  const hex = (c) => c.map((v) => v.toString(16).padStart(2, '0')).join('');
  const fromHex = (h) => [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16));

  // A light background becomes a dark one with the same tint, so cards stay distinguishable.
  function darkBackground(c) {
    const [h, s, l] = toHsl(c);
    return fromHsl([h, Math.min(s, 0.35), 0.10 + (1 - l) * 0.20]);
  }
  // Dark text becomes light text of the same hue.
  function lightText(c) {
    const [h, s, l] = toHsl(c);
    const nl = Math.max(0.72, Math.min(0.92, 0.88 - l * 0.4));
    return fromHsl([h, Math.min(s, 0.55), nl]);
  }

  // "rgb(1, 2, 3)" / "rgba(1, 2, 3, 0.5)" -> { rgb, a }
  function parseComputed(str) {
    const m = /rgba?\(([^)]+)\)/.exec(str || '');
    if (!m) return null;
    const p = m[1].split(/[\s,/]+/).filter(Boolean).map(Number);
    if (p.length < 3 || p.some((n) => Number.isNaN(n))) return null;
    return { rgb: p.slice(0, 3).map((n) => Math.round(n)), a: p.length > 3 ? p[3] : 1 };
  }

  /* ---------- the hidden frame ---------- */
  let frame = null;
  let queue = Promise.resolve();

  function ensureFrame() {
    if (frame) return frame;
    frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-same-origin');
    frame.setAttribute('aria-hidden', 'true');
    frame.tabIndex = -1;
    frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:700px;height:900px;border:0;visibility:hidden;pointer-events:none';
    document.body.appendChild(frame);
    return frame;
  }

  // Images are not needed for colors; stop them loading while we look at the email.
  const hideImages = (html) =>
    html.replace(/<img\b[^>]*>/gi, (t) => t.replace(/\s(src|srcset)\s*=/gi, ' data-es-$1='));
  const showImages = (html) =>
    html.replace(/<img\b[^>]*>/gi, (t) => t.replace(/\sdata-es-(src|srcset)\s*=/gi, ' $1='));

  // Run fn(doc, win) against the email, one email at a time.
  function withEmail(html, fn) {
    const job = queue.then(() => new Promise((resolve) => {
      const f = ensureFrame();
      let done = false;
      const finish = (v) => { if (!done) { done = true; resolve(v); } };
      const timer = setTimeout(() => finish(null), 5000);
      f.onload = async () => {
        clearTimeout(timer);
        try { finish(await fn(f.contentDocument, f.contentWindow)); }
        catch (e) { finish(null); }
      };
      f.srcdoc = hideImages(html);
    }));
    queue = job.catch(() => {});
    return job;
  }

  /* ---------- reading the email's dark mode ---------- */
  // Rules we have switched on/off before no longer say "dark" in their condition text, so remember them.
  const toggled = new WeakSet();
  function darkRules(doc) {
    const out = [];
    const walk = (rules) => {
      for (const r of rules) {
        if (r.type === 4) { // media rule
          const cond = (r.conditionText || (r.media && r.media.mediaText) || '');
          if (toggled.has(r) || /prefers-color-scheme\s*:\s*dark/i.test(cond)) out.push(r);
          else walk(r.cssRules);
        }
      }
    };
    for (const sh of doc.styleSheets) { try { walk(sh.cssRules); } catch (e) { /* cross-origin sheet */ } }
    return out;
  }
  const setScheme = (rules, dark) => rules.forEach((r) => { toggled.add(r); r.media.mediaText = dark ? 'all' : 'not all'; });

  function snapshot(doc, win) {
    const map = new Map();
    for (const el of [doc.body, ...doc.body.querySelectorAll('*')]) {
      const cs = win.getComputedStyle(el);
      const fill = parseComputed(cs.webkitTextFillColor);
      map.set(el, { color: fill && fill.a > 0 ? fill : parseComputed(cs.color), bg: parseComputed(cs.backgroundColor) });
    }
    return map;
  }

  function effectiveBg(el, snap, canvas) {
    for (let n = el; n; n = n.parentElement) {
      const s = snap.get(n);
      if (s && s.bg && s.bg.a >= 0.5) return s.bg.rgb;
    }
    return canvas;
  }

  const hasOwnText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.nodeValue.trim());
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE']);

  function declaresDark(doc, win) {
    const meta = doc.querySelector('meta[name="color-scheme" i]');
    if (meta && /dark/i.test(meta.getAttribute('content') || '')) return true;
    return /dark/i.test(win.getComputedStyle(doc.documentElement).colorScheme || '');
  }
  const hasSchemeMeta = (doc) => {
    const m = doc.querySelector('meta[name="color-scheme" i]');
    return !!(m && /dark/i.test(m.getAttribute('content') || ''));
  };

  // A background picture hides what color is really behind the text, so we leave those alone.
  function overPicture(el, win) {
    for (let n = el; n; n = n.parentElement) {
      if (n.hasAttribute && n.hasAttribute('background')) return true;
      const bi = win.getComputedStyle(n).backgroundImage;
      if (bi && bi !== 'none') return true;
    }
    return false;
  }

  // Find what is wrong. Needs both light and dark snapshots.
  function findProblems(doc, win, light, dark, canvasDark) {
    const bright = [];
    const unreadable = [];
    const lightBad = [];
    for (const el of [doc.body, ...doc.body.querySelectorAll('*')]) {
      if (SKIP.has(el.tagName)) continue;
      const a = light.get(el), b = dark.get(el);
      if (!a || !b) continue;
      if (a.bg && a.bg.a >= 0.5 && lum(a.bg.rgb) > LIGHT_BG && b.bg && b.bg.a >= 0.5 && lum(b.bg.rgb) > LIGHT_BG) {
        // a bright cell that only frames a picture is fine (the picture is what you see)
        if (el.textContent.trim()) bright.push(el);
      }
      if (hasOwnText(el) && el.getClientRects().length && a.color && !overPicture(el, win)) {
        // text that can't be read even in plain light mode (white text pasted from a dark app, say)
        if (contrast(a.color.rgb, effectiveBg(el, light, [255, 255, 255])) < MIN_CONTRAST) { lightBad.push(el); continue; }
      }
      if (hasOwnText(el) && el.getClientRects().length && b.color) {
        const bg = effectiveBg(el, dark, canvasDark);
        if (contrast(b.color.rgb, bg) < MIN_CONTRAST) unreadable.push(el);
      }
    }
    return { bright, unreadable, lightBad };
  }

  /* ---------- analyze ---------- */
  function analyze(html) {
    return withEmail(html, (doc, win) => {
      if (!doc || !doc.body) return null;
      const rules = darkRules(doc);
      setScheme(rules, false);
      const light = snapshot(doc, win);
      setScheme(rules, true);
      const dark = snapshot(doc, win);
      const canvasDark = declaresDark(doc, win) ? fromHex(DEFAULT_PAGE.slice(1)) : [255, 255, 255];
      const p = findProblems(doc, win, light, dark, canvasDark);
      const needsMeta = rules.length > 0 && !hasSchemeMeta(doc);
      return {
        bright: p.bright.length,
        unreadable: p.unreadable.length,
        lightBad: p.lightBad.length,
        needsMeta,
        total: p.bright.length + p.unreadable.length + p.lightBad.length + (needsMeta ? 1 : 0),
      };
    });
  }

  /* ---------- fix ---------- */
  function buildCss(state) {
    const bg = [...state.bg].map(([h, c]) => ({ h, c: hex(c) }));
    const tx = [...state.txt].map(([h, c]) => ({ h, c: hex(c) }));
    let css = ':root{color-scheme:light dark;supported-color-schemes:light dark}\n';
    css += '@media (prefers-color-scheme: dark){\n';
    css += `body{background-color:${DEFAULT_PAGE}!important;color:${DEFAULT_TEXT}!important}\n`;
    css += 'a{color:#9ec1ff}\n';
    for (const x of bg) css += `.dmb-${x.h}{background-color:#${x.c}!important;color:${DEFAULT_TEXT}!important}\n`;
    for (const x of tx) css += `.dmt-${x.h}{color:#${x.c}!important}\n`;
    css += '}\n';
    for (const x of bg) css += `[data-ogsb] .dmb-${x.h}{background-color:#${x.c}!important}\n`;
    for (const x of tx) css += `[data-ogsc] .dmt-${x.h}{color:#${x.c}!important}\n`;
    return css;
  }

  function injectStyle(doc, css) {
    let st = doc.querySelector('style[data-es-dark]');
    if (!st) {
      st = doc.createElement('style');
      st.setAttribute('data-es-dark', '');
      doc.head.appendChild(st);
    }
    st.textContent = css;
  }

  // Drop dark-mode classes this tool added earlier if the element's color has since changed.
  function dropStaleClasses(doc, win) {
    const probe = doc.createElement('span');
    probe.style.display = 'none';
    doc.body.appendChild(probe);
    const toHex = (v) => {
      if (!v) return null;
      probe.style.color = '';
      probe.style.color = v;
      if (!probe.style.color) return null;
      const c = parseComputed(win.getComputedStyle(probe).color);
      return c && c.a >= 0.5 ? hex(c.rgb) : null;
    };
    for (const el of doc.body.querySelectorAll('[class]')) {
      for (const cls of [...el.classList]) {
        const m = /^dm([bt])-([0-9a-f]{6})$/.exec(cls);
        if (!m) continue;
        const now = m[1] === 'b'
          ? toHex(el.style.backgroundColor) || toHex(el.getAttribute('bgcolor'))
          : toHex(el.style.color) || toHex(el.getAttribute('color'));
        if (now !== m[2]) el.classList.remove(cls);
      }
      if (!el.getAttribute('class')) el.removeAttribute('class');
    }
    probe.remove();
  }

  function fix(html) {
    return withEmail(html, (doc, win) => {
      if (!doc || !doc.body) return null;
      dropStaleClasses(doc, win);

      const state = { bg: new Map(), txt: new Map() };
      // dark colors for classes added on an earlier run
      for (const el of doc.body.querySelectorAll('[class]')) {
        for (const cls of el.classList) {
          const m = /^dm([bt])-([0-9a-f]{6})$/.exec(cls);
          if (!m) continue;
          if (m[1] === 'b') state.bg.set(m[2], darkBackground(fromHex(m[2])));
          else state.txt.set(m[2], lightText(fromHex(m[2])));
        }
      }
      injectStyle(doc, buildCss(state));

      const measure = () => {
        const rules = darkRules(doc);
        setScheme(rules, false);
        const light = snapshot(doc, win);
        setScheme(rules, true);
        const dark = snapshot(doc, win);
        const canvasDark = fromHex(DEFAULT_PAGE.slice(1)); // after the fix the email declares dark support
        return { rules, light, dark, canvasDark };
      };

      // Step 0: text that is unreadable even in light mode (stuck white or near-white text, for
      // example from pasting out of a dark app). Give it a readable color for its background.
      let m = measure();
      let p = findProblems(doc, win, m.light, m.dark, m.canvasDark);
      let changed = 0;
      for (const el of p.lightBad) {
        const bg = effectiveBg(el, m.light, [255, 255, 255]);
        el.style.removeProperty('-webkit-text-fill-color');
        el.removeAttribute('color');
        el.style.color = lum(bg) > 0.4 ? '#222222' : '#ffffff';
        for (const cls of [...el.classList]) if (/^dmt-/.test(cls)) el.classList.remove(cls);
        changed++;
      }
      if (p.lightBad.length) { dropStaleClasses(doc, win); injectStyle(doc, buildCss(state)); }

      // Step 1: light blocks that stay light.
      m = measure();
      p = findProblems(doc, win, m.light, m.dark, m.canvasDark);
      for (const el of p.bright) {
        const c = m.light.get(el).bg.rgb;
        const h = hex(c);
        el.classList.add('dmb-' + h);
        state.bg.set(h, darkBackground(c));
        changed++;
      }
      if (p.bright.length) injectStyle(doc, buildCss(state));

      // Step 2: text that is hard to read now that backgrounds are settled.
      m = measure();
      p = findProblems(doc, win, m.light, m.dark, m.canvasDark);
      for (const el of p.unreadable) {
        const c = m.light.get(el).color;
        if (!c) continue;
        const h = hex(c.rgb);
        el.classList.add('dmt-' + h);
        state.txt.set(h, lightText(c.rgb));
        changed++;
      }

      let metaAdded = false;
      if (!hasSchemeMeta(doc)) {
        for (const [name, content] of [['color-scheme', 'light dark'], ['supported-color-schemes', 'light dark']]) {
          if (!doc.querySelector(`meta[name="${name}"]`)) {
            const mt = doc.createElement('meta');
            mt.setAttribute('name', name);
            mt.setAttribute('content', content);
            doc.head.insertBefore(mt, doc.head.firstChild);
          }
        }
        metaAdded = true;
      }

      if (!changed && !metaAdded) return { html, count: 0 };
      injectStyle(doc, buildCss(state));
      const dt = /^\s*(<!doctype[^>]*>)/i.exec(html);
      const out = (dt ? dt[1] : '<!doctype html>') + '\n' + showImages(doc.documentElement.outerHTML) + '\n';
      return { html: out, count: changed + (metaAdded ? 1 : 0) };
    });
  }

  window.EmailDarkMode = { analyze, fix };
})();
