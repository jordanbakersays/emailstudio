/* Email Studio: visual (click-to-edit) layer for the preview pane.
 *
 * The preview iframe is sandboxed WITHOUT allow-scripts, so nothing inside an
 * email can run code. This file runs in the parent page, edits the iframe's
 * document directly, then turns the result back into clean HTML.
 *
 * What people can do in the preview:
 *   - click any text block and type, bold/italic/underline, links, bullets
 *   - paste text (Word / Google Docs / web pages are cleaned up automatically)
 *   - click a picture to replace it, describe it (alt text), link it or remove it
 *   - drop or paste a picture to add or replace one
 */
(function () {
  'use strict';

  /* ------------------------------------------------------------------ */
  /* Which parts of an email are editable                                */
  /* ------------------------------------------------------------------ */

  const INLINE = new Set([
    'A', 'B', 'STRONG', 'I', 'EM', 'U', 'S', 'STRIKE', 'SPAN', 'BR', 'FONT',
    'SMALL', 'BIG', 'SUB', 'SUP', 'MARK', 'CODE', 'ABBR', 'WBR', 'IMG',
  ]);
  const BLOCKISH =
    'table,div,p,ul,ol,li,h1,h2,h3,h4,h5,h6,td,th,tr,tbody,thead,tfoot,center,' +
    'blockquote,hr,section,article,header,footer,form,pre,address,dl,dt,dd,figure';
  const SKIP = new Set([
    'SCRIPT', 'STYLE', 'HEAD', 'TITLE', 'META', 'LINK', 'NOSCRIPT', 'TEXTAREA',
    'SELECT', 'BUTTON', 'OBJECT', 'IFRAME', 'SVG', 'VIDEO', 'AUDIO', 'CANVAS',
    'MAP', 'TEMPLATE',
  ]);
  const NO_LOOSE_TEXT = new Set([
    'TABLE', 'TBODY', 'THEAD', 'TFOOT', 'TR', 'UL', 'OL', 'SELECT', 'COLGROUP', 'COL',
  ]);

  // An element is a "text block" when it holds text plus only inline things
  // (bold, links, line breaks, small images). Those are made editable. Layout
  // pieces (tables, rows, cells that hold other blocks) are left alone, so
  // nobody can accidentally delete the structure of an email.
  function isTextBlock(el) {
    let hasText = false;
    for (const n of el.childNodes) {
      if (n.nodeType === 3) {
        if (n.nodeValue.trim()) hasText = true;
        continue;
      }
      if (n.nodeType !== 1) continue; // comments are fine
      if (!INLINE.has(n.tagName)) return false;
      if (n.tagName === 'IMG') continue;
      if (n.querySelector(BLOCKISH)) return false;
      if (n.textContent.trim()) hasText = true;
    }
    return hasText;
  }

  function listIsEditable(el) {
    const kids = [...el.children];
    return kids.length > 0 && kids.every((c) => c.tagName === 'LI' && isTextBlock(c));
  }

  function setEditable(el) {
    el.setAttribute('contenteditable', 'true');
    el.setAttribute('data-es-edit', '');
  }

  function markEditable(el) {
    if (SKIP.has(el.tagName)) return;
    // A whole bullet list is one editing area so Enter makes a new bullet.
    if ((el.tagName === 'UL' || el.tagName === 'OL') && listIsEditable(el)) {
      setEditable(el);
      return;
    }
    if (isTextBlock(el)) {
      setEditable(el);
      return;
    }
    for (const n of [...el.childNodes]) {
      if (n.nodeType === 1) {
        markEditable(n);
      } else if (n.nodeType === 3 && n.nodeValue.trim() && !NO_LOOSE_TEXT.has(el.tagName)) {
        // Loose text sitting next to other blocks: give it its own editable wrapper
        // (removed again when the HTML is written back out).
        const span = el.ownerDocument.createElement('span');
        span.setAttribute('data-es-loose', '');
        setEditable(span);
        n.replaceWith(span);
        span.appendChild(n);
      }
    }
  }

  // Choices offered in the formatting bar. Fonts are the ones nearly every email app has.
  const SIZES = [12, 14, 16, 18, 20, 24, 28, 32, 40];
  const FONTS = [
    ['Arial', 'Arial, Helvetica, sans-serif'],
    ['Georgia', 'Georgia, serif'],
    ['Verdana', 'Verdana, Geneva, sans-serif'],
    ['Tahoma', 'Tahoma, Geneva, sans-serif'],
    ['Times New Roman', "'Times New Roman', Times, serif"],
    ['Courier New', "'Courier New', monospace"],
  ];
  const TEXT_COLORS = ['#000000', '#444444', '#888888', '#ffffff', '#c0392b', '#e67e22', '#d4a017', '#2e8b57', '#1a5fb4', '#7b3fa0'];
  const HILITES = ['#fff3a3', '#c8f2d4', '#cfe3ff', '#ffd6e0', '#e5e5e5'];

  /* ------------------------------------------------------------------ */
  /* Small helpers                                                       */
  /* ------------------------------------------------------------------ */

  const esc = (s) =>
    String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function closestEl(node, selector) {
    const el = node && (node.nodeType === 1 ? node : node.parentElement);
    return el && el.closest ? el.closest(selector) : null;
  }

  function textToHtml(text) {
    return esc(String(text).replace(/\r\n?/g, '\n').trim()).replace(/\n/g, '<br>');
  }

  // Turn what someone typed into the Link box into a safe address.
  // Returns '' for empty, null for something we won't allow.
  function normalizeUrl(raw) {
    const v = String(raw || '').trim();
    if (!v) return '';
    if (/^(https?:|mailto:|tel:)/i.test(v)) return v;
    if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 'mailto:' + v;
    if (/^\+?[\d\s().-]{7,}$/.test(v)) return 'tel:' + v.replace(/[^\d+]/g, '');
    if (/^[a-z][a-z0-9+.-]*:/i.test(v)) return null; // javascript:, data:, etc.
    return 'https://' + v;
  }

  // Clean up pasted rich text: keep bold, italic, underline, links and line
  // breaks; drop fonts, colors, sizes, tables, and all the junk Word adds.
  function cleanPaste(html) {
    const d = new DOMParser().parseFromString(html, 'text/html');
    d.querySelectorAll('style,script,meta,link,title,xml,head').forEach((n) => n.remove());
    const BLOCK = new Set([
      'P', 'DIV', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'TR', 'TABLE', 'UL', 'OL',
      'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER', 'PRE',
    ]);

    function walk(node) {
      let out = '';
      for (const n of node.childNodes) {
        if (n.nodeType === 3) {
          out += esc(n.nodeValue.replace(/\s+/g, ' '));
          continue;
        }
        if (n.nodeType !== 1) continue;
        const t = n.tagName;
        if (t === 'BR') { out += '<br>'; continue; }
        let inner = walk(n);
        if (BLOCK.has(t)) {
          if (t === 'LI') inner = '• ' + inner;
          out += inner + (t === 'P' ? '<br><br>' : '<br>');
          continue;
        }
        if (t === 'TD' || t === 'TH') { out += inner + ' '; continue; }
        if (!inner.trim()) { out += inner; continue; }
        if (t === 'A') {
          const href = n.getAttribute('href') || '';
          out += ALLOWED.test(href) ? '<a href="' + esc(href) + '">' + inner + '</a>' : inner;
          continue;
        }
        const style = (n.getAttribute('style') || '').toLowerCase();
        let bold = /font-weight\s*:\s*(bold|[6-9]00)/.test(style);
        if (t === 'B' || t === 'STRONG') bold = !/font-weight\s*:\s*(normal|[1-4]00)/.test(style);
        const italic = t === 'I' || t === 'EM' || /font-style\s*:\s*italic/.test(style);
        const under = t === 'U' || /text-decoration[^;]*underline/.test(style);
        let r = inner;
        if (under) r = '<u>' + r + '</u>';
        if (italic) r = '<i>' + r + '</i>';
        if (bold) r = '<b>' + r + '</b>';
        out += r;
      }
      return out;
    }

    return walk(d.body)
      .replace(/\s*<br>\s*/g, '<br>')
      .replace(/(<br>){3,}/g, '<br><br>')
      .replace(/^(<br>)+|(<br>)+$/g, '')
      .trim();
  }
  const ALLOWED = /^(https?:|mailto:|tel:)/i;

  /* ------------------------------------------------------------------ */
  /* Styles for the toolbar and dialog (the page itself defines colors)   */
  /* ------------------------------------------------------------------ */

  function injectParentStyles() {
    if (document.getElementById('ve-styles')) return;
    const s = document.createElement('style');
    s.id = 've-styles';
    s.textContent = `
      #fmt .ve-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 12px}
      #fmt .ve-row button{padding:3px 9px;font-size:12px}
      #fmt .ve-row button.on{background:var(--accent);border-color:var(--accent);color:#fff}
      #fmt .ve-row select{font:inherit;font-size:12px;padding:3px 4px;border:1px solid var(--line);border-radius:7px;background:var(--panel);color:var(--ink);max-width:110px}
      #fmt .ve-pw{position:relative;display:inline-block}
      #fmt .ve-pop{position:fixed;z-index:40;background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:8px;box-shadow:0 8px 28px rgba(0,0,0,.22);display:grid;gap:6px;width:176px}
      #fmt .ve-pop[hidden]{display:none}
      #fmt .ve-sw{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}
      #fmt .ve-sw button{width:28px;height:28px;padding:0;border-radius:6px;border:1px solid rgba(0,0,0,.25)}
      #fmt .ve-pop .ve-more{display:flex;gap:6px;align-items:center;font-size:12px}
      #fmt .ve-pop .ve-more input{width:34px;height:26px;padding:0;border:1px solid var(--line);border-radius:6px;background:#fff}
      #fmt .ve-pop button.ve-def{font-size:12px;padding:3px 8px}
      #fmt .ve-note{font-size:11px;color:var(--muted);line-height:1.3}
      #fmt .ve-colbar{display:inline-block;width:12px;height:3px;margin-left:3px;vertical-align:middle;border-radius:2px}
      #fmt .ve-grp{display:inline-flex;gap:6px;align-items:center;flex-wrap:nowrap}
      #fmt .ve-sep{width:1px;height:18px;background:var(--line)}
      #fmt .ve-img{background:#e6f2f0;border-top:1px solid #bfe0db;border-bottom:1px solid #bfe0db}
      #fmt .ve-blk{background:#eaf0fb;border-top:1px solid #c5d3ee;border-bottom:1px solid #c5d3ee}
      #fmt .ve-bname{font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #fmt .ve-alt{flex:1 1 200px;padding:3px 8px;font-size:12px}
      #fmt .ve-danger,.ve-dlg .ve-danger{color:var(--danger)}
      #fmt .ve-hint{padding:0 12px 6px;color:var(--muted);font-size:12px}
      .ve-dlg{position:fixed;inset:0;background:rgba(0,0,0,.28);display:grid;place-items:center;z-index:20}
      .ve-dlg-box{background:var(--panel);border:1px solid var(--line);border-radius:12px;padding:16px;width:min(420px,92vw);display:grid;gap:10px;box-shadow:0 10px 40px rgba(0,0,0,.25)}
      .ve-dlg-box label{font-weight:600}
      .ve-dlg-box input{width:100%}
      .ve-dlg-actions{display:flex;gap:8px;align-items:center}
      .ve-dlg-actions .grow{flex:1}
    `;
    document.head.appendChild(s);
  }

  // Added to the email while editing only; removed again when saving.
  const IFRAME_CSS = `
    [data-es-edit]{cursor:text}
    [data-es-edit]:hover{outline:1px dashed rgba(15,118,110,.65);outline-offset:2px}
    [data-es-edit]:focus{outline:2px solid #0f766e;outline-offset:2px}
    img{cursor:pointer}
    img:hover{outline:2px dashed rgba(15,118,110,.65);outline-offset:2px}
    img[data-es-sel]{outline:3px solid #0f766e!important;outline-offset:2px}
    [data-es-block]{outline:2px solid rgba(37,99,235,.55)!important;outline-offset:-2px}
    [data-es-drop]{outline:3px dashed #0f766e!important;outline-offset:2px}
  `;

  /* ------------------------------------------------------------------ */
  /* The editor                                                          */
  /* ------------------------------------------------------------------ */

  window.EmailVisualEditor = function (opts) {
    const iframe = opts.iframe;
    const bar = opts.toolbar;
    let doc = null;
    let doctype = '<!doctype html>';
    let selectedImg = null;
    let lastRange = null;
    let pending = false;
    let timer = null;
    let linkApply = null;

    injectParentStyles();

    /* ---------- toolbar ---------- */
    bar.innerHTML = `
      <div class="ve-row">
        <span class="ve-grp">
          <select data-sel="font" title="Font" aria-label="Font"></select>
          <select data-sel="size" title="Text size" aria-label="Text size"></select>
        </span>
        <span class="ve-sep"></span>
        <span class="ve-grp">
          <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
          <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
          <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
          <button type="button" data-cmd="strikeThrough" title="Strikethrough"><s>S</s></button>
          <span class="ve-pw" data-pop="color">
            <button type="button" data-act="popToggle" title="Text color">A<span class="ve-colbar" style="background:#c0392b"></span></button>
            <div class="ve-pop" hidden></div>
          </span>
          <span class="ve-pw" data-pop="hilite">
            <button type="button" data-act="popToggle" title="Highlight color"><span style="background:#fff3a3;padding:0 3px">ab</span></button>
            <div class="ve-pop" hidden></div>
          </span>
        </span>
        <span class="ve-sep"></span>
        <span class="ve-grp">
          <button type="button" data-act="align" data-v="left" title="Align left" aria-label="Align left"><svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><path d="M2 3h12M2 7h8M2 11h12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
          <button type="button" data-act="align" data-v="center" title="Center" aria-label="Center"><svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><path d="M2 3h12M4 7h8M2 11h12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
          <button type="button" data-act="align" data-v="right" title="Align right" aria-label="Align right"><svg width="16" height="14" viewBox="0 0 16 14" aria-hidden="true"><path d="M2 3h12M6 7h8M2 11h12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/></svg></button>
        </span>
        <span class="ve-sep"></span>
        <span class="ve-grp">
          <button type="button" data-act="link" title="Turn the selected words into a link">Link</button>
          <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">&bull; List</button>
          <button type="button" data-cmd="insertOrderedList" title="Numbered list">1. List</button>
          <button type="button" data-cmd="removeFormat" title="Remove bold, italics, etc. from the selected words">Clear</button>
        </span>
        <span class="ve-sep"></span>
        <span class="ve-grp">
          <button type="button" data-act="undo" title="Undo (Ctrl+Z)">&#8630;</button>
          <button type="button" data-act="redo" title="Redo (Ctrl+Y)">&#8631;</button>
        </span>
        <span class="ve-sep"></span>
        <span class="ve-grp">
          <button type="button" data-act="addImage" title="Add a picture where your cursor is">+ Picture</button>
        </span>
      </div>
      <div class="ve-row ve-img" hidden>
        <strong>Picture</strong>
        <button type="button" data-act="imgLibrary">Choose from library</button>
        <button type="button" data-act="imgUpload">Upload new&hellip;</button>
        <input type="file" accept="image/png,image/jpeg,image/gif,image/webp" hidden>
        <input type="text" class="ve-alt" placeholder="Describe the picture (alt text)" maxlength="200" aria-label="Alt text">
        <button type="button" data-act="imgLink">Link</button>
        <button type="button" data-act="imgRemove" class="ve-danger">Remove</button>
      </div>
      <div class="ve-row ve-blk" hidden>
        <strong>Section</strong>
        <span class="ve-bname"></span>
        <button type="button" data-act="blkUp" title="Move this section up">&uarr; Up</button>
        <button type="button" data-act="blkDown" title="Move this section down">&darr; Down</button>
        <button type="button" data-act="blkDup" title="Make a copy right below">Duplicate</button>
        <button type="button" data-act="blkDel" class="ve-danger" title="Remove this whole section">Delete</button>
        <button type="button" data-act="blkUndo" hidden>Undo</button>
      </div>
      <div class="ve-hint">Click any text to edit it. Click a picture to change it.</div>`;
    // Fill the dropdowns and color boxes.
    const fontSel = bar.querySelector('[data-sel=font]');
    const sizeSel = bar.querySelector('[data-sel=size]');
    const addOpt = (sel, value, label) => {
      const o = document.createElement('option');
      o.value = value;
      o.textContent = label;
      sel.appendChild(o);
    };
    addOpt(fontSel, '', 'Font');
    addOpt(fontSel, '__default', 'Email default');
    FONTS.forEach(([n, v]) => addOpt(fontSel, v, n));
    addOpt(sizeSel, '', 'Size');
    addOpt(sizeSel, '__default', 'Email default');
    SIZES.forEach((n) => addOpt(sizeSel, n + 'px', n + ' px'));
    for (const [kind, colors, none] of [['color', TEXT_COLORS, 'Email default color'], ['hilite', HILITES, 'No highlight']]) {
      const pop = bar.querySelector(`[data-pop=${kind}] .ve-pop`);
      const sw = document.createElement('div');
      sw.className = 've-sw';
      for (const c of colors) {
        const b = document.createElement('button');
        b.type = 'button';
        b.dataset.act = 'swatch';
        b.dataset.kind = kind;
        b.dataset.v = c;
        b.style.background = c;
        b.title = c;
        b.setAttribute('aria-label', 'Color ' + c);
        sw.appendChild(b);
      }
      const def = document.createElement('button');
      def.type = 'button';
      def.className = 've-def';
      def.dataset.act = 'swatch';
      def.dataset.kind = kind;
      def.dataset.v = '';
      def.textContent = none;
      const more = document.createElement('label');
      more.className = 've-more';
      more.innerHTML = '<input type="color" value="#1a5fb4" data-kind="' + kind + '"> Other color';
      pop.append(sw, def, more);
      if (kind === 'color') {
        const n = document.createElement('div');
        n.className = 've-note';
        n.textContent = 'Custom colors do not change in dark mode, so avoid very dark or very light ones for important text.';
        pop.appendChild(n);
      }
    }
    const ui = {
      imgRow: bar.querySelector('.ve-img'),
      alt: bar.querySelector('.ve-alt'),
      file: bar.querySelector('input[type=file]'),
    };

    /* ---------- link dialog ---------- */
    const dlg = document.createElement('div');
    dlg.className = 've-dlg';
    dlg.hidden = true;
    dlg.innerHTML = `
      <div class="ve-dlg-box" role="dialog" aria-label="Link">
        <label for="ve-url">Web address, email address or phone number</label>
        <input id="ve-url" type="text" placeholder="https://example.org/signup" autocomplete="off">
        <div class="ve-dlg-actions">
          <button type="button" data-d="remove" class="ve-danger">Remove link</button>
          <span class="grow"></span>
          <button type="button" data-d="cancel">Cancel</button>
          <button type="button" data-d="ok" class="primary">Apply</button>
        </div>
      </div>`;
    document.body.appendChild(dlg);
    const urlInput = dlg.querySelector('input');
    const removeBtn = dlg.querySelector('[data-d=remove]');

    function openLinkDialog(href, apply) {
      linkApply = apply;
      urlInput.value = href || '';
      removeBtn.hidden = !href;
      dlg.hidden = false;
      urlInput.focus();
      urlInput.select();
    }
    function closeLinkDialog() {
      dlg.hidden = true;
      linkApply = null;
    }
    function submitLink(remove) {
      if (!linkApply) return;
      let url = '';
      if (!remove) {
        url = normalizeUrl(urlInput.value);
        if (url === null) {
          opts.toast("That doesn't look like a web address, email address or phone number.", true);
          return;
        }
      }
      const fn = linkApply;
      closeLinkDialog();
      fn(url);
    }
    dlg.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (e.target === dlg) return closeLinkDialog();
      if (!b) return;
      if (b.dataset.d === 'ok') submitLink(false);
      else if (b.dataset.d === 'remove') submitLink(true);
      else if (b.dataset.d === 'cancel') closeLinkDialog();
    });
    urlInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); submitLink(false); }
      else if (e.key === 'Escape') { e.preventDefault(); closeLinkDialog(); }
    });

    /* ---------- selection helpers ---------- */
    function selectionHost() {
      if (!doc) return null;
      const sel = doc.getSelection();
      if (!sel || !sel.rangeCount) return null;
      return closestEl(sel.anchorNode, '[data-es-edit]');
    }
    function rememberRange() {
      if (!doc) return;
      const sel = doc.getSelection();
      if (sel && sel.rangeCount && selectionHost()) lastRange = sel.getRangeAt(0).cloneRange();
    }
    function ensureSelection() {
      if (!doc) return false;
      if (iframe.contentWindow) iframe.contentWindow.focus();
      if (selectionHost()) return true;
      if (lastRange) {
        try {
          const sel = doc.getSelection();
          sel.removeAllRanges();
          sel.addRange(lastRange);
        } catch (e) { /* range no longer valid */ }
      }
      return !!selectionHost();
    }
    function hostOfRange(range) {
      return closestEl(range && range.startContainer, '[data-es-edit]');
    }
    function rangeFromPoint(x, y) {
      if (doc.caretRangeFromPoint) return doc.caretRangeFromPoint(x, y);
      if (doc.caretPositionFromPoint) {
        const p = doc.caretPositionFromPoint(x, y);
        if (p) {
          const r = doc.createRange();
          r.setStart(p.offsetNode, p.offset);
          r.collapse(true);
          return r;
        }
      }
      return null;
    }

    function updateState() {
      if (!doc) return;
      for (const b of bar.querySelectorAll('[data-cmd]')) {
        let on = false;
        try { on = doc.queryCommandState(b.dataset.cmd); } catch (e) { /* ignore */ }
        b.classList.toggle('on', !!on && b.dataset.cmd !== 'removeFormat');
      }
      let al = '';
      try {
        const t = alignTargets()[0];
        if (t) {
          al = doc.defaultView.getComputedStyle(t).textAlign;
          if (al === 'start' || al === '-webkit-left') al = 'left';
          if (al === 'end' || al === '-webkit-right') al = 'right';
          if (al === '-webkit-center') al = 'center';
        }
      } catch (e) { /* ignore */ }
      for (const b of bar.querySelectorAll('[data-act=align]')) b.classList.toggle('on', b.dataset.v === al);
    }

    /* ---------- alignment, size, font and color ---------- */
    // The pieces of the email the current selection touches: each paragraph or
    // heading, or each bullet of a list.
    function alignTargets() {
      if (!doc) return [];
      const sel = doc.getSelection();
      if (!sel || !sel.rangeCount) return [];
      const r = sel.getRangeAt(0);
      const hosts = sel.isCollapsed
        ? [selectionHost()].filter(Boolean)
        : [...doc.querySelectorAll('[data-es-edit]')].filter((h) => r.intersectsNode(h));
      const out = [];
      for (const h of hosts) {
        if (h.tagName === 'UL' || h.tagName === 'OL') {
          const items = [...h.children].filter((li) => li.tagName === 'LI' && (sel.isCollapsed ? li.contains(sel.anchorNode) : r.intersectsNode(li)));
          out.push(...items);
        } else {
          out.push(h);
        }
      }
      return out;
    }

    function setAlign(v) {
      if (!ensureSelection()) return opts.toast('Click in the text you want to change first.', true);
      const targets = alignTargets();
      if (!targets.length) return;
      for (const t of targets) {
        t.style.textAlign = v;
        if (t.hasAttribute('align')) t.setAttribute('align', v);
        // Loose text has no paragraph of its own; give it one so the alignment sticks.
        if (t.hasAttribute('data-es-loose')) t.style.display = 'block';
      }
      scheduleChange();
      updateState();
    }

    // Apply (or, with '', remove) inline styles such as font-size on the selected words.
    // With nothing selected it applies to the whole paragraph the cursor is in.
    function applyInline(props) {
      if (!ensureSelection()) return opts.toast('Click in the text you want to change first.', true);
      const sel = doc.getSelection();
      if (sel.isCollapsed) {
        let target = selectionHost();
        if (target && (target.tagName === 'UL' || target.tagName === 'OL')) {
          target = closestEl(sel.anchorNode, 'li') || target;
        }
        const r = doc.createRange();
        r.selectNodeContents(target);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      const before = new Set(doc.querySelectorAll('font[size="7"]'));
      doc.execCommand('styleWithCSS', false, false);
      doc.execCommand('fontSize', false, '7');
      const fonts = [...doc.querySelectorAll('font[size="7"]')].filter((f) => !before.has(f));
      const spans = [];
      let partial = false;
      for (const f of fonts) {
        const span = doc.createElement('span');
        while (f.firstChild) span.appendChild(f.firstChild);
        // Anything inside that already sets the same thing would override the new choice.
        span.querySelectorAll('[style]').forEach((e) => {
          for (const k of Object.keys(props)) e.style[k] = '';
          if (!e.getAttribute('style')) e.removeAttribute('style');
        });
        for (const [k, v] of Object.entries(props)) if (v) span.style[k] = v;
        f.replaceWith(span);
        spans.push(span);
        // An outer span that sets the same thing: when the selection fills it, change it
        // too; when it only partly fills it, a removal can't be done without splitting it.
        for (let a = span.parentElement; a && !a.hasAttribute('data-es-edit') && a !== doc.body; a = a.parentElement) {
          if (a.tagName !== 'SPAN' || !a.getAttribute('style')) continue;
          const keys = Object.keys(props).filter((k) => a.style[k]);
          if (!keys.length) continue;
          if (a.textContent === span.textContent) {
            keys.forEach((k) => { a.style[k] = ''; });
            if (!a.getAttribute('style')) a.removeAttribute('style');
          } else if (!Object.values(props).some((v) => v)) {
            partial = true;
          }
        }
      }
      // Tidy: a span that ended up with no styling is just removed.
      const tidy = (sp) => {
        if (sp.isConnected && !sp.getAttribute('style') && !sp.attributes.length) sp.replaceWith(...sp.childNodes);
      };
      spans.forEach((sp) => { if (!sp.getAttribute('style')) sp.removeAttribute('style'); tidy(sp); });
      doc.querySelectorAll('span[style=""]').forEach((e) => { e.removeAttribute('style'); tidy(e); });
      doc.querySelectorAll('span:not([style])').forEach((e) => { if (!e.attributes.length) e.replaceWith(...e.childNodes); });
      if (partial) opts.toast('That text is part of a longer formatted phrase. Select the whole phrase to remove its formatting.', true);
      const live = spans.filter((x) => x.isConnected);
      if (live.length) {
        const r = doc.createRange();
        r.setStartBefore(live[0]);
        r.setEndAfter(live[live.length - 1]);
        sel.removeAllRanges();
        sel.addRange(r);
      }
      rememberRange();
      scheduleChange();
      updateState();
    }
    const SIZE_PROPS = (v) => ({ fontSize: v, lineHeight: v ? '1.3' : '' });

    // When the whole editing area is already a list, bullets <-> numbers just swaps the list type.
    function switchList(tag) {
      const host = selectionHost();
      if (!host || (host.tagName !== 'UL' && host.tagName !== 'OL')) return false;
      if (host.tagName === tag) {
        opts.toast(tag === 'OL' ? 'This is already a numbered list.' : 'This is already a bulleted list.');
        return true;
      }
      const n = doc.createElement(tag);
      for (const a of [...host.attributes]) {
        if (a.name !== 'contenteditable' && a.name !== 'data-es-edit') n.setAttribute(a.name, a.value);
      }
      while (host.firstChild) n.appendChild(host.firstChild);
      host.replaceWith(n);
      setEditable(n);
      const li = n.querySelector('li');
      if (li) {
        const r = doc.createRange();
        r.selectNodeContents(li);
        r.collapse(false);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
        n.focus();
        rememberRange();
      }
      scheduleChange();
      updateState();
      return true;
    }

    function closePops() {
      bar.querySelectorAll('.ve-pop').forEach((p) => { p.hidden = true; });
    }
    document.addEventListener('mousedown', (e) => {
      if (!e.target.closest || !e.target.closest('.ve-pw')) closePops();
    });

    /* ---------- change tracking ---------- */
    function scheduleChange() {
      if (!pending && opts.onDirty) opts.onDirty();
      pending = true;
      clearTimeout(timer);
      timer = setTimeout(flush, 250);
    }

    // Turn the edited preview back into clean email HTML.
    function serialize() {
      const clone = doc.documentElement.cloneNode(true);
      clone.querySelectorAll('[data-es-edit]').forEach((e) => e.removeAttribute('contenteditable'));
      clone.querySelectorAll('[data-es-loose]').forEach((s) => {
        if (/text-align/i.test(s.getAttribute('style') || '')) {
          const div = doc.createElement('div');
          div.setAttribute('style', s.getAttribute('style'));
          div.append(...s.childNodes);
          s.replaceWith(div);
        } else {
          s.replaceWith(...s.childNodes);
        }
      });
      ['data-es-edit', 'data-es-sel', 'data-es-drop', 'data-es-new', 'data-es-block'].forEach((a) =>
        clone.querySelectorAll('[' + a + ']').forEach((e) => e.removeAttribute(a)));
      clone.querySelectorAll('style[data-es-style]').forEach((e) => e.remove());
      clone.querySelectorAll('[style=""]').forEach((e) => e.removeAttribute('style'));
      return doctype + '\n' + clone.outerHTML + '\n';
    }

    function flush() {
      clearTimeout(timer);
      if (!pending || !doc) return;
      pending = false;
      opts.onChange(serialize());
    }

    /* ---------- pictures ---------- */
    function selectImage(img) {
      if (selectedImg && selectedImg !== img) selectedImg.removeAttribute('data-es-sel');
      selectedImg = img || null;
      if (img) {
        img.setAttribute('data-es-sel', '');
        ui.alt.value = img.getAttribute('alt') || '';
      }
      ui.imgRow.hidden = !img;
      if (opts.onImageSelect) opts.onImageSelect(!!img);
    }

    // Swap a picture. The old fixed height is dropped so a different-shaped
    // picture isn't stretched.
    function setImageSrc(img, rec) {
      img.setAttribute('src', rec.url);
      img.removeAttribute('height');
      const st = img.getAttribute('style');
      if (st) {
        img.setAttribute('style', st.replace(/(^|;)\s*height\s*:\s*[\d.]+(px|%)\s*(?=;|$)/gi, '$1height:auto'));
      }
      // Never let a swapped-in picture stick out of the email on phones.
      if (!/max-width\s*:/i.test(img.getAttribute('style') || '')) {
        const cur = (img.getAttribute('style') || '').replace(/[\s;]+$/, '');
        img.setAttribute('style', (cur ? cur + ';' : '') + 'max-width:100%');
      }
      scheduleChange();
    }

    // mode 'replace': swap the selected picture. mode 'add': put a NEW picture right after
    // the selected one. With no picture selected either mode inserts at the cursor.
    function insertImage(rec, atRange, mode) {
      if (!doc) return false;
      const sel0 = !atRange && selectedImg && selectedImg.isConnected ? selectedImg : null;
      if (sel0 && mode !== 'add') {
        setImageSrc(sel0, rec);
        return true;
      }
      if (sel0 && mode === 'add') {
        let after = sel0;
        const par = sel0.parentElement;
        if (par && par.tagName === 'A' && par.childNodes.length === 1) after = par;
        const r = doc.createRange();
        r.setStartAfter(after);
        r.collapse(true);
        if (!closestEl(r.startContainer, '[data-es-edit]')) return false;
        atRange = r;
        selectImage(null);
      }
      if (atRange) {
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(atRange);
        if (iframe.contentWindow) iframe.contentWindow.focus();
      } else if (!ensureSelection()) {
        return false;
      }
      if (!selectionHost()) return false;
      const tag =
        '<img data-es-new="1" src="' + esc(rec.url) + '" alt="" width="600" ' +
        'style="display:block;width:100%;max-width:600px;height:auto;border:0;">';
      doc.execCommand('insertHTML', false, tag);
      const img = doc.querySelector('img[data-es-new]');
      if (img) {
        img.removeAttribute('data-es-new');
        selectImage(img);
      }
      scheduleChange();
      return true;
    }

    async function addFromFile(file, atRange) {
      try {
        const rec = await opts.uploadFile(file);
        if (!insertImage(rec, atRange)) {
          opts.toast('Click inside some text first, then paste or drop the picture.', true);
        }
      } catch (err) {
        opts.toast(err.message, true);
      }
    }

    function applyImgLink(img, url) {
      const a = img.parentElement && img.parentElement.tagName === 'A' ? img.parentElement : null;
      if (!url) {
        if (a) a.replaceWith(...a.childNodes);
      } else if (a) {
        a.setAttribute('href', url);
      } else {
        const link = doc.createElement('a');
        link.setAttribute('href', url);
        img.replaceWith(link);
        link.appendChild(img);
      }
      scheduleChange();
    }

    /* ---------- text links ---------- */
    function openTextLink() {
      if (!ensureSelection()) {
        opts.toast('Click in the text first, then select the words you want to link.', true);
        return;
      }
      const sel = doc.getSelection();
      const existing = closestEl(sel.anchorNode, 'a');
      if (sel.isCollapsed && !existing) {
        opts.toast('Select the words you want to turn into a link first.', true);
        return;
      }
      rememberRange();
      openLinkDialog(existing ? existing.getAttribute('href') : '', (url) => {
        ensureSelection();
        const s = doc.getSelection();
        const a = closestEl(s.anchorNode, 'a');
        if (!url) {
          if (a) {
            if (s.isCollapsed) {
              const r = doc.createRange();
              r.selectNodeContents(a);
              s.removeAllRanges();
              s.addRange(r);
            }
            doc.execCommand('unlink');
          }
        } else if (a && s.isCollapsed) {
          a.setAttribute('href', url);
        } else {
          doc.execCommand('createLink', false, url);
        }
        scheduleChange();
      });
    }

    /* ---------- sections (whole blocks) ---------- */
    // A section is a table or div that sits in a stack of two or more of them
    // (like the Elder Spotlight in the newsletter). A plain comment right above
    // it (<!-- Elder Spotlight -->) travels with it and gives it its name.
    const blkRow = bar.querySelector('.ve-blk');
    const blkName = bar.querySelector('.ve-bname');
    const blkUndo = bar.querySelector('[data-act=blkUndo]');
    let curBlock = null;
    let undoOp = null;

    const isBox = (n) => n && n.nodeType === 1 && (n.tagName === 'TABLE' || n.tagName === 'DIV');
    function blockOf(node) {
      for (let a = node && (node.nodeType === 1 ? node : node.parentElement); a && a !== doc.body && a !== doc.documentElement; a = a.parentElement) {
        const p = a.parentElement;
        if (!isBox(a) || !p || p === doc.body) continue;
        if ([...p.children].filter(isBox).length >= 2) return a;
      }
      return null;
    }
    const plainComment = (n) => n && n.nodeType === 8 && !/^\s*\[if|\[endif\]/i.test(n.data) && !/^\s*<!\[endif/i.test(n.data);
    function labelOf(el) {
      let n = el.previousSibling;
      while (n && n.nodeType === 3 && !n.nodeValue.trim()) n = n.previousSibling;
      return plainComment(n) ? n : null;
    }
    const isSpacer = (el) => !el.textContent.trim() && !el.querySelector('img');
    function nameOf(el) {
      const c = labelOf(el);
      const t = c && c.data.replace(/[=\-]/g, ' ').replace(/\s+/g, ' ').trim();
      if (t && !/^spacer$/i.test(t)) return t;
      const h = el.querySelector('h1,h2,h3,h4,strong,b');
      const txt = (h || el).textContent.replace(/\s+/g, ' ').trim();
      return txt ? txt.slice(0, 40) : 'Section';
    }
    function unitOf(el) {
      const nodes = [el];
      const c = labelOf(el);
      if (c) {
        for (let n = el.previousSibling; n; n = n.previousSibling) {
          nodes.unshift(n);
          if (n === c) break;
        }
      }
      return nodes;
    }
    function siblingBlock(el, dir) {
      for (let n = dir < 0 ? el.previousElementSibling : el.nextElementSibling; n; n = dir < 0 ? n.previousElementSibling : n.nextElementSibling) {
        if (isBox(n) && !isSpacer(n)) return n;
      }
      return null;
    }
    function showBlock(el) {
      if (curBlock && curBlock !== el) curBlock.removeAttribute('data-es-block');
      curBlock = el && el.isConnected ? el : null;
      if (curBlock) curBlock.setAttribute('data-es-block', '');
      blkRow.hidden = !curBlock && !undoOp;
      blkName.textContent = curBlock ? nameOf(curBlock) : '';
      bar.querySelectorAll('[data-act=blkUp],[data-act=blkDown],[data-act=blkDup],[data-act=blkDel]').forEach((b) => { b.hidden = !curBlock; });
      if (curBlock) {
        bar.querySelector('[data-act=blkUp]').disabled = !siblingBlock(curBlock, -1);
        bar.querySelector('[data-act=blkDown]').disabled = !siblingBlock(curBlock, 1);
      }
      blkUndo.hidden = !undoOp;
    }
    function trackBlock(node) {
      if (!doc) return;
      const b = node ? blockOf(node) : null;
      if (b !== curBlock) showBlock(b);
    }
    function moveBlock(dir) {
      const el = curBlock;
      const other = el && siblingBlock(el, dir);
      if (!other) return;
      const mine = unitOf(el);
      const ref = dir < 0 ? unitOf(other)[0] : other.nextSibling;
      mine.forEach((n) => other.parentNode.insertBefore(n, ref));
      undoOp = null;
      showBlock(el);
      el.scrollIntoView({ block: 'nearest' });
      scheduleChange();
    }
    function duplicateBlock() {
      const el = curBlock;
      if (!el) return;
      const nodes = unitOf(el).map((n) => n.cloneNode(true));
      nodes.forEach((n) => { if (n.nodeType === 1) n.querySelectorAll('[data-es-sel],[data-es-block]').forEach((x) => { x.removeAttribute('data-es-sel'); x.removeAttribute('data-es-block'); }); });
      const copy = nodes[nodes.length - 1];
      copy.removeAttribute && copy.removeAttribute('data-es-block');
      const ref = el.nextSibling;
      nodes.forEach((n) => el.parentNode.insertBefore(n, ref));
      undoOp = null;
      showBlock(copy);
      copy.scrollIntoView({ block: 'nearest' });
      scheduleChange();
      opts.toast('Copied. The copy is right below the original.');
    }
    function deleteBlock() {
      const el = curBlock;
      if (!el) return;
      const nodes = unitOf(el);
      const parent = el.parentNode;
      const next = el.nextSibling;
      const label = nameOf(el);
      if (selectedImg && el.contains(selectedImg)) selectImage(null);
      nodes.forEach((n) => n.remove());
      undoOp = { nodes, parent, next, label };
      curBlock = null;
      lastRange = null;
      showBlock(null);
      blkName.textContent = 'Deleted "' + label + '"';
      blkRow.hidden = false;
      scheduleChange();
    }
    function undoDelete() {
      const op = undoOp;
      if (!op) return;
      const ref = op.next && op.next.parentNode === op.parent ? op.next : null;
      op.nodes.forEach((n) => op.parent.insertBefore(n, ref));
      undoOp = null;
      showBlock(op.nodes[op.nodes.length - 1]);
      scheduleChange();
    }

    /* ---------- toolbar actions ---------- */
    // Keep the email's text selection when a toolbar button is pressed.
    bar.addEventListener('mousedown', (e) => {
      if (e.target.closest('button')) e.preventDefault();
    });

    bar.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || !doc) return;

      if (b.dataset.cmd) {
        if (!ensureSelection()) {
          opts.toast('Click in the text you want to change first.', true);
          return;
        }
        if ((b.dataset.cmd === 'insertUnorderedList' || b.dataset.cmd === 'insertOrderedList') && switchList(b.dataset.cmd === 'insertOrderedList' ? 'OL' : 'UL')) return;
        doc.execCommand(b.dataset.cmd, false, null);
        scheduleChange();
        updateState();
        return;
      }

      switch (b.dataset.act) {
        case 'link':
          openTextLink();
          break;
        case 'align':
          setAlign(b.dataset.v);
          break;
        case 'popToggle': {
          const pop = b.parentElement.querySelector('.ve-pop');
          const open = pop.hidden;
          closePops();
          pop.hidden = !open;
          if (open) {
            // Fixed position so it isn't clipped when the toolbar scrolls sideways on a phone.
            const r = b.getBoundingClientRect();
            const w = pop.offsetWidth || 176;
            pop.style.top = r.bottom + 4 + 'px';
            pop.style.left = Math.max(6, Math.min(r.left, window.innerWidth - w - 6)) + 'px';
          }
          break;
        }
        case 'swatch': {
          closePops();
          const v = b.dataset.v;
          applyInline(b.dataset.kind === 'color' ? { color: v } : { backgroundColor: v });
          if (b.dataset.kind === 'color') {
            const bar2 = bar.querySelector('[data-pop=color] .ve-colbar');
            if (bar2 && v) bar2.style.background = v;
          }
          break;
        }
        case 'blkUp': moveBlock(-1); break;
        case 'blkDown': moveBlock(1); break;
        case 'blkDup': duplicateBlock(); break;
        case 'blkDel': deleteBlock(); break;
        case 'blkUndo': undoDelete(); break;
        case 'undo':
          if (iframe.contentWindow) iframe.contentWindow.focus();
          doc.execCommand('undo');
          scheduleChange();
          break;
        case 'redo':
          if (iframe.contentWindow) iframe.contentWindow.focus();
          doc.execCommand('redo');
          scheduleChange();
          break;
        case 'addImage':
          if (!selectedImg && !selectionHost() && !lastRange) {
            opts.toast('Click where you want the picture in the email, then choose it from the library.', true);
          }
          opts.openLibrary();
          break;
        case 'imgLibrary':
          opts.openLibrary();
          break;
        case 'imgUpload':
          ui.file.click();
          break;
        case 'imgLink': {
          const img = selectedImg;
          if (!img) break;
          const a = img.parentElement && img.parentElement.tagName === 'A' ? img.parentElement : null;
          openLinkDialog(a ? a.getAttribute('href') : '', (url) => applyImgLink(img, url));
          break;
        }
        case 'imgRemove': {
          const img = selectedImg;
          if (!img || !confirm('Remove this picture from the email?')) break;
          const a = img.parentElement;
          if (a && a.tagName === 'A' && a.childNodes.length === 1) a.remove();
          else img.remove();
          selectImage(null);
          scheduleChange();
          break;
        }
        default:
      }
    });

    bar.addEventListener('change', (e) => {
      const t = e.target;
      if (!doc) return;
      if (t.matches('select[data-sel]')) {
        const v = t.value === '__default' ? '' : t.value;
        const was = t.value;
        t.selectedIndex = 0;
        if (!was) return;
        if (t.dataset.sel === 'size') applyInline(SIZE_PROPS(v));
        else applyInline({ fontFamily: v });
      } else if (t.matches('input[type=color]')) {
        closePops();
        applyInline(t.dataset.kind === 'color' ? { color: t.value } : { backgroundColor: t.value });
      }
    });

    ui.file.addEventListener('change', async () => {
      const f = ui.file.files[0];
      const img = selectedImg;
      ui.file.value = '';
      if (!f || !img) return;
      try {
        setImageSrc(img, await opts.uploadFile(f));
      } catch (err) {
        opts.toast(err.message, true);
      }
    });

    ui.alt.addEventListener('input', () => {
      if (!selectedImg) return;
      selectedImg.setAttribute('alt', ui.alt.value);
      scheduleChange();
    });

    /* ---------- events inside the email ---------- */
    function onClick(e) {
      const img = closestEl(e.target, 'img');
      if (img) {
        e.preventDefault();
        selectImage(img);
        undoOp = null;
        trackBlock(img);
        return;
      }
      if (closestEl(e.target, 'a')) e.preventDefault(); // never navigate the preview
      selectImage(null);
      undoOp = null;
      trackBlock(e.target);
      // Clicking somewhere that can't hold text: forget the old cursor spot, so a picture
      // is never dropped somewhere the person didn't pick.
      if (!closestEl(e.target, '[data-es-edit]')) lastRange = null;
    }

    function onKeyDown(e) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') {
        e.preventDefault();
        flush();
        if (opts.onSave) opts.onSave();
        return;
      }
      if (e.key === 'Escape' && selectedImg) {
        selectImage(null);
        return;
      }
      if (e.key === 'Enter' && !e.isComposing && !e.ctrlKey && !e.metaKey) {
        const host = closestEl(e.target, '[data-es-edit]');
        if (!host || host.tagName === 'UL' || host.tagName === 'OL') return;
        const sel = doc.getSelection();
        if (sel && sel.anchorNode && closestEl(sel.anchorNode, 'li')) return; // real new bullet
        // Emails use line breaks, not new paragraphs/divs.
        e.preventDefault();
        if (!doc.execCommand('insertLineBreak')) doc.execCommand('insertHTML', false, '<br>');
        scheduleChange();
      }
    }

    // Anything that arrived by pasting or dropping text must not bring its own colors,
    // fonts or sizes: the email's own styling (including dark mode) has to stay in charge.
    // 'before' is the set of elements that existed before the paste.
    const BLOCKY = new Set(['DIV', 'P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'PRE', 'SECTION', 'ARTICLE', 'HEADER', 'FOOTER']);
    function sanitizeInserted(host, before) {
      if (!host || !host.isConnected) return;
      const added = [...host.querySelectorAll('*')].filter((el) => !before.has(el));
      for (const el of added) {
        if (!el.isConnected) continue;
        const t = el.tagName;
        if (t === 'IMG' || t === 'BR' || t === 'LI' || t === 'UL' || t === 'OL') {
          if (t !== 'IMG') ['style', 'class', 'color', 'face', 'size', 'bgcolor', 'align'].forEach((a) => el.removeAttribute(a));
          continue;
        }
        if (t === 'A') {
          const href = el.getAttribute('href') || '';
          ['style', 'class', 'color', 'face', 'size'].forEach((a) => el.removeAttribute(a));
          if (!ALLOWED.test(href)) el.replaceWith(...el.childNodes);
          continue;
        }
        if (t === 'B' || t === 'STRONG' || t === 'I' || t === 'EM' || t === 'U') {
          ['style', 'class'].forEach((a) => el.removeAttribute(a));
          continue;
        }
        if (BLOCKY.has(t)) {
          const br = doc.createElement('br');
          el.replaceWith(...el.childNodes, br);
          continue;
        }
        // spans, fonts, and anything else: keep the words, drop the wrapper
        el.replaceWith(...el.childNodes);
      }
      host.normalize();
    }

    function onPaste(e) {
      const host = closestEl(e.target, '[data-es-edit]');
      e.preventDefault();
      if (!host) return;
      const dt = e.clipboardData;
      if (!dt) return;

      const file = [...(dt.files || [])].find((f) => f.type.startsWith('image/'));
      if (file) {
        const sel = doc.getSelection();
        const range = sel && sel.rangeCount ? sel.getRangeAt(0).cloneRange() : null;
        addFromFile(file, range);
        return;
      }

      const html = dt.getData('text/html');
      const text = dt.getData('text/plain');
      const inList = host.tagName === 'UL' || host.tagName === 'OL';
      const before = new Set(host.querySelectorAll('*'));
      if (inList) {
        doc.execCommand('insertText', false, text.replace(/\s*\r?\n+\s*/g, ' ').trim());
      } else if (html) {
        doc.execCommand('insertHTML', false, cleanPaste(html) || textToHtml(text));
      } else {
        doc.execCommand('insertHTML', false, textToHtml(text));
      }
      sanitizeInserted(closestEl(doc.getSelection().anchorNode, '[data-es-edit]') || host, before);
      scheduleChange();
    }

    // Safety net for any other way text can arrive (dragging text in, a phone keyboard's
    // clipboard button, a browser that skips the paste step): clean it up afterwards.
    let sanitizeNext = null;
    function onBeforeInput(e) {
      if (!/^insertFrom(Paste|Drop|Yank|PasteAsQuotation)$/.test(e.inputType || '')) return;
      const host = closestEl(e.target, '[data-es-edit]');
      if (host) sanitizeNext = { host, before: new Set(host.querySelectorAll('*')) };
    }
    function onInputSanitize() {
      if (!sanitizeNext) return;
      const { host, before } = sanitizeNext;
      sanitizeNext = null;
      sanitizeInserted(host, before);
    }

    function dropTarget(e) {
      return closestEl(doc.elementFromPoint(e.clientX, e.clientY), 'img, [data-es-edit]');
    }
    function clearDropMark() {
      if (!doc) return;
      doc.querySelectorAll('[data-es-drop]').forEach((n) => n.removeAttribute('data-es-drop'));
    }
    function wantsDrop(dt) {
      if (!dt) return false;
      return [...(dt.types || [])].includes('Files') || !!(opts.getDraggedImage && opts.getDraggedImage());
    }

    function onDragOver(e) {
      if (!wantsDrop(e.dataTransfer)) return; // normal text dragging: leave alone
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      const t = dropTarget(e);
      if (t && !t.hasAttribute('data-es-drop')) {
        clearDropMark();
        t.setAttribute('data-es-drop', '');
      }
    }

    async function onDrop(e) {
      if (!wantsDrop(e.dataTransfer)) return;
      e.preventDefault();
      clearDropMark();
      const dragged = opts.getDraggedImage && opts.getDraggedImage();
      const files = [...(e.dataTransfer.files || [])].filter((f) => f.type.startsWith('image/'));
      const overImg = closestEl(doc.elementFromPoint(e.clientX, e.clientY), 'img');
      const range = overImg ? null : rangeFromPoint(e.clientX, e.clientY);

      let rec = dragged;
      if (!rec) {
        if (!files.length) return;
        try {
          rec = await opts.uploadFile(files[0]);
        } catch (err) {
          opts.toast(err.message, true);
          return;
        }
      }
      if (overImg) {
        setImageSrc(overImg, rec);
        selectImage(overImg);
        return;
      }
      if (range && hostOfRange(range) && insertImage(rec, range)) return;
      opts.toast('Drop the picture onto some text, or onto another picture to replace it.', true);
    }

    function bind(d) {
      d.addEventListener('click', onClick, true);
      d.addEventListener('keydown', onKeyDown);
      d.addEventListener('beforeinput', onBeforeInput);
      d.addEventListener('input', () => { onInputSanitize(); scheduleChange(); });
      d.addEventListener('paste', onPaste);
      d.addEventListener('dragover', onDragOver);
      d.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDropMark(); });
      d.addEventListener('drop', onDrop);
      d.addEventListener('selectionchange', () => { rememberRange(); updateState(); });
      d.addEventListener('mousedown', () => { if (opts.onFocus) opts.onFocus(); });
      d.addEventListener('focusin', () => { if (opts.onFocus) opts.onFocus(); });
    }

    function init() {
      let d = null;
      try { d = iframe.contentDocument; } catch (e) { return; }
      if (!d || !d.body || !d.documentElement) return;
      doc = d;
      selectedImg = null;
      lastRange = null;
      curBlock = null;
      undoOp = null;
      showBlock(null);
      ui.imgRow.hidden = true;

      const st = doc.createElement('style');
      st.setAttribute('data-es-style', '');
      st.textContent = IFRAME_CSS;
      doc.head.appendChild(st);

      markEditable(doc.body);
      try { doc.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
      bind(doc);
      updateState();
    }

    iframe.addEventListener('load', init);

    /* ---------- public API ---------- */
    return {
      // Show this HTML in the preview and make it editable.
      render(html) {
        clearTimeout(timer);
        pending = false;
        const m = String(html).match(/^\s*(<!doctype[^>]*>)/i);
        doctype = m ? m[1] : '<!doctype html>';
        iframe.srcdoc = html;
      },
      // Write any not-yet-saved visual edits back to the code now.
      flush,
      // Put a library picture at the cursor, or into the selected picture.
      insertImage(rec, mode) { return insertImage(rec, null, mode); },
      hasSelectedImage() { return !!(selectedImg && selectedImg.isConnected); },
    };
  };
})();
