/* Email Studio: visual (click-to-edit) layer for the preview pane.
 *
 * Nothing inside an email can run code in the preview (a Content-Security-Policy rule
 * blocks all scripts there; see guardHtml). This file runs in the parent page, edits the iframe's
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

  // Safari refuses to run the editor's own listeners on a frame that is sandboxed without
  // 'allow-scripts' (a known, unfixed WebKit bug), which silently breaks clicks, keys, paste and
  // drag-and-drop there. So the preview frame is given 'allow-scripts', and this rule, placed first
  // in the page, stops EVERY script, inline handler and javascript: link inside the email from
  // running. The editor itself runs in the parent page and is not affected.
  const CSP_META = '<meta http-equiv="Content-Security-Policy" data-es-csp content="script-src \'none\'; object-src \'none\'; form-action \'none\'">';
  function guardHtml(html) {
    html = String(html);
    let m = /<head(?=[\s>\/])[^>]*>/i.exec(html);
    let at, ins;
    if (m) { at = m.index + m[0].length; ins = CSP_META; }
    else if ((m = /<html(?=[\s>\/])[^>]*>/i.exec(html))) { at = m.index + m[0].length; ins = '<head>' + CSP_META; }
    else if ((m = /^\s*<!doctype[^>]*>/i.exec(html))) { at = m.index + m[0].length; ins = '<html><head>' + CSP_META; }
    else { at = 0; ins = '<html><head>' + CSP_META; }
    // scripts that sit before the rule would run first, so drop those (emails never need them there)
    const before = html.slice(0, at).replace(/<script\b[\s\S]*?(<\/script\s*>|$)/gi, '');
    return before + ins + html.slice(at);
  }

  const IS_MAC = /Mac|iPhone|iPad|iPod/.test((navigator.platform || '') + ' ' + (navigator.userAgent || ''));

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
      #fmt .ve-row,.ve-dock .ve-row{display:flex;gap:6px;align-items:center;flex-wrap:wrap;padding:6px 12px}
      #fmt .ve-row button,.ve-dock .ve-row button{padding:3px 9px;font-size:12px}
      #fmt .ve-row button.on,.ve-dock .ve-row button.on{background:var(--accent);border-color:var(--accent);color:#fff}
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
      #fmt .ve-blk,.ve-dock .ve-blk{background:#eaf0fb;border-top:1px solid #c5d3ee;border-bottom:1px solid #c5d3ee}
      #fmt .ve-txtrow,.ve-dock .ve-txtrow{background:#f4f1e6;border-top:1px solid #e0d9bd;border-bottom:1px solid #e0d9bd}
      #fmt .ve-btnrow,.ve-dock .ve-btnrow{background:#efeafa;border-top:1px solid #d4c9ee;border-bottom:1px solid #d4c9ee}
      #fmt .ve-bname,.ve-dock .ve-bname{font-weight:600;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
      #fmt .ve-alt{flex:1 1 200px;padding:3px 8px;font-size:12px}
      #fmt .ve-danger,.ve-dlg .ve-danger,.ve-dock .ve-danger{color:var(--danger)}
      .ve-dock{position:absolute;left:0;right:0;bottom:0;z-index:10;box-shadow:0 -6px 16px rgba(0,0,0,.14)}
      #fmt .ve-fmtbtn{display:none}
      @media (max-width:820px){
        #fmt .ve-ins{order:-1;margin-right:6px}
        #fmt .ve-fmtbtn{display:inline-block}
        #fmt .ve-row.ve-open{flex-wrap:wrap!important;overflow:visible!important}
        #fmt .ve-row.ve-open .ve-sep{display:none}
        #fmt .ve-row.ve-open .ve-ins{flex:0 0 100%}
        #fmt .ve-fmtbtn[aria-pressed=true]{background:var(--accent);color:#fff;border-color:var(--accent)}
        .ve-dock .ve-row{flex-wrap:wrap;padding:4px 8px;gap:4px}
        .ve-dock .ve-row strong{font-size:12px}
        .ve-dock .ve-bname{max-width:96px;font-size:12px}
        .ve-dock .ve-row button{min-width:40px;min-height:36px;padding:0 8px;font-size:0}
        .ve-dock .ve-row button::before{content:attr(data-ico);font-size:15px}
        .ve-dock .ve-row button:not([data-ico])::before{content:none}
        .ve-dock .ve-row button:not([data-ico]){font-size:13px}
      }
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
    html{padding-bottom:84px!important}
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
        <span class="ve-grp ve-ins">
          <button type="button" data-act="fmtToggle" class="ve-fmtbtn" title="Show or hide the text formatting buttons">Format</button>
          <button type="button" data-act="addImage" title="Add a picture where your cursor is">+ Picture</button>
          <button type="button" data-act="blocks" title="Add a section from your block library, right below the section you picked">+ Block</button>
          <button type="button" data-act="addButton" title="Add a button with your own words and link">+ Button</button>
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
        <button type="button" data-act="blkUp" data-ico="↑" title="Move this section up">&uarr; Up</button>
        <button type="button" data-act="blkDown" data-ico="↓" title="Move this section down">&darr; Down</button>
        <button type="button" data-act="blkDup" data-ico="⧉" title="Make a copy right below">Duplicate</button>
        <button type="button" data-act="blkSave" data-ico="Library" title="Copy this section into your block library so you can reuse it in other emails. This does not save your email.">Add to Library</button>
        <button type="button" data-act="blkDel" data-ico="🗑" class="ve-danger" title="Remove this whole section">Delete</button>
        <button type="button" data-act="blkUndo" data-ico="Undo" hidden>Undo</button>
      </div>
      <div class="ve-row ve-blk ve-txtrow" hidden>
        <strong class="ve-tlabel">Paragraph</strong>
        <span class="ve-bname ve-tname"></span>
        <button type="button" data-act="txtUp" data-ico="↑" title="Move this paragraph up">&uarr; Up</button>
        <button type="button" data-act="txtDown" data-ico="↓" title="Move this paragraph down">&darr; Down</button>
        <button type="button" data-act="txtDup" data-ico="⧉" title="Make a copy right below">Duplicate</button>
        <button type="button" data-act="txtDel" data-ico="🗑" class="ve-danger" title="Remove this paragraph">Delete</button>
        <button type="button" data-act="txtUndo" data-ico="Undo" hidden>Undo</button>
      </div>
      <div class="ve-row ve-blk ve-btnrow" hidden>
        <strong>Button</strong>
        <span class="ve-bname ve-bbname"></span>
        <button type="button" data-act="btnEdit" data-ico="Edit" title="Change the words, link, color or position">Edit&hellip;</button>
        <button type="button" data-act="btnUp" data-ico="↑" title="Move this button up">&uarr; Up</button>
        <button type="button" data-act="btnDown" data-ico="↓" title="Move this button down">&darr; Down</button>
        <button type="button" data-act="btnDup" data-ico="⧉" title="Make a copy right below">Duplicate</button>
        <button type="button" data-act="btnDel" data-ico="🗑" class="ve-danger" title="Remove this button">Delete</button>
        <button type="button" data-act="btnUndo" data-ico="Undo" hidden>Undo delete</button>
      </div>
      <div class="ve-hint">Click any text to edit it. Click a picture to change it.</div>`;
    // The Section and Paragraph bars float over the bottom of the preview instead of sitting
    // in the toolbar, so showing or hiding them never pushes the email up or down under the cursor.
    const dock = document.createElement('div');
    dock.className = 've-dock';
    (iframe.closest('#previewWrap') || iframe.parentElement).appendChild(dock);
    dock.append(...bar.querySelectorAll('.ve-blk'));
    // On phones the on-screen keyboard can cover the bottom of the page, and the bars with it.
    // When it is open, keep the bars just above it.
    const vv = window.visualViewport;
    const coarse = window.matchMedia ? window.matchMedia('(pointer:coarse)') : { matches: false };
    function placeDock() {
      if (!vv) return;
      const covered = Math.round(window.innerHeight - vv.height - vv.offsetTop);
      let editing = false;
      try { editing = !!(coarse.matches && doc && doc.hasFocus() && doc.activeElement && doc.activeElement.hasAttribute && doc.activeElement.hasAttribute('data-es-edit')); } catch (e) { /* ignore */ }
      // the keyboard is (probably) up: the page area is clearly shorter than the screen
      const kbd = covered > 80 || (editing && window.screen && vv.height < window.screen.height - 250);
      if (kbd) {
        // pin it to the bottom of what is actually visible (just above the keyboard)
        const h = dock.offsetHeight || 0;
        dock.style.position = 'fixed';
        dock.style.bottom = 'auto';
        dock.style.top = Math.max(0, Math.round(vv.offsetTop + vv.height - h)) + 'px';
        dock.style.zIndex = '60';
      } else {
        dock.style.position = '';
        dock.style.bottom = '';
        dock.style.top = '';
        dock.style.zIndex = '';
      }
    }
    if (typeof ResizeObserver !== 'undefined') new ResizeObserver(() => placeDock()).observe(dock);
    window.addEventListener('scroll', placeDock, { passive: true });
    if (vv) { vv.addEventListener('resize', placeDock); vv.addEventListener('scroll', placeDock); }
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

    // Remove everything the editor added (editing marks, loose-text wrappers, outlines).
    function cleanClone(clone) {
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
      clone.querySelectorAll('style[data-es-style], meta[data-es-csp]').forEach((e) => e.remove());
      clone.querySelectorAll('[style=""]').forEach((e) => e.removeAttribute('style'));
      return clone;
    }

    // Turn the edited preview back into clean email HTML.
    function serialize() {
      const clone = cleanClone(doc.documentElement.cloneNode(true));
      return doctype + '\n' + clone.outerHTML + '\n';
    }

    // 'lastOut' is what the code box last got from (or gave to) the preview. Comparing against it
    // lets us notice edits that arrived without the browser announcing them (some phones insert
    // pasted text silently), so the code never silently falls behind what is on screen.
    let lastOut = null;
    let loaded = false;
    function flush() {
      clearTimeout(timer);
      if (!doc || !loaded) return;
      const html = serialize();
      if (!pending && html === lastOut) return;
      pending = false;
      lastOut = html;
      opts.onChange(html);
    }

    // Watch the page itself, so any change to the words is noticed however it got there.
    let watcher = null;
    let watchTimer = null;
    function watch() {
      if (watcher) watcher.disconnect();
      if (typeof MutationObserver === 'undefined') return;
      const real = (m) => m.type !== 'attributes' || !/^(data-es-|contenteditable)/.test(m.attributeName || '');
      watcher = new MutationObserver((muts) => {
        if (!loaded || !muts.some(real)) return;
        clearTimeout(watchTimer);
        watchTimer = setTimeout(() => {
          if (!loaded || !doc) return;
          if (serialize() !== lastOut) scheduleChange();
        }, 200);
      });
      watcher.observe(doc.body, { subtree: true, childList: true, characterData: true, attributes: true });
    }

    /* ---------- pictures ---------- */
    // If the cursor has moved somewhere else (arrow keys, dragging, a tap), the picture that
    // was selected earlier no longer counts, so new pictures go where the cursor is.
    let imgPickedAt = 0;
    function dropStalePicture() {
      if (!selectedImg || !selectedImg.isConnected || Date.now() - imgPickedAt < 400) return;
      const sel = doc.getSelection();
      if (!sel || !sel.rangeCount || !selectionHost()) return;
      let touches = false;
      try {
        const r = sel.getRangeAt(0);
        touches = r.intersectsNode(selectedImg);
        // a caret right next to the picture (where the browser leaves it after inserting) counts too
        const par = selectedImg.parentNode;
        const at = par ? Array.prototype.indexOf.call(par.childNodes, selectedImg) : -1;
        if (!touches && r.collapsed && r.startContainer === par && (r.startOffset === at || r.startOffset === at + 1)) touches = true;
      } catch (e) { /* ignore */ }
      if (!touches) selectImage(null);
    }
    function selectImage(img) {
      if (img) imgPickedAt = Date.now();
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

    /* ---------- light / dark preview ---------- */
    // Shows the email the way an app that follows the system's dark mode would, by
    // switching the email's own dark-mode styles on or off (not the computer's setting).
    function darkRuleList() {
      const out = [];
      const walk = (rules) => {
        for (const r of rules) {
          if (r.type !== 4) continue;
          const cond = r.conditionText || (r.media && r.media.mediaText) || '';
          if (/prefers-color-scheme\s*:\s*dark/i.test(cond)) out.push(r);
          else walk(r.cssRules);
        }
      };
      if (doc) for (const sh of doc.styleSheets) { try { walk(sh.cssRules); } catch (e) { /* ignore */ } }
      return out;
    }
    // Found once per loaded email: after a rule is switched off it no longer reads as a dark-mode rule.
    let darkRules = null;
    const getDarkRules = () => darkRules || (darkRules = darkRuleList());
    function applyScheme() {
      if (!doc) return;
      const dark = scheme === 'dark';
      getDarkRules().forEach((r) => { r.media.mediaText = dark ? 'all' : 'not all'; });
      let st = doc.querySelector('style[data-es-scheme]');
      if (!st) {
        st = doc.createElement('style');
        st.setAttribute('data-es-style', '');
        st.setAttribute('data-es-scheme', '');
        doc.head.appendChild(st);
      }
      // Emails that say they support dark mode also get a dark page behind them, as in Apple Mail.
      const meta = doc.querySelector('meta[name="color-scheme" i]');
      const declares = (meta && /dark/i.test(meta.getAttribute('content') || '')) ||
        /dark/i.test(doc.defaultView.getComputedStyle(doc.documentElement).colorScheme || '');
      st.textContent = 'html{color-scheme:' + (dark && declares ? 'dark' : 'light') + '}';
    }

    /* ---------- sections (whole blocks) ---------- */
    // A section is a table or div that sits in a stack of two or more of them
    // (like the Elder Spotlight in the newsletter). A plain comment right above
    // it (<!-- Elder Spotlight -->) travels with it and gives it its name.
    const blkRow = dock.querySelector('.ve-blk');
    const blkName = dock.querySelector('.ve-bname');
    const blkUndo = dock.querySelector('[data-act=blkUndo]');
    let curBlock = null;
    let undoOp = null;
    let scheme = 'light';

    const isBox = (n) => n && n.nodeType === 1 && (n.tagName === 'TABLE' || n.tagName === 'DIV');
    function blockOf(node) {
      for (let a = node && (node.nodeType === 1 ? node : node.parentElement); a && a !== doc.body && a !== doc.documentElement; a = a.parentElement) {
        const p = a.parentElement;
        if (!isBox(a) || !p || p === doc.body || a.classList.contains('es-button')) continue;
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
      if (curText && !curText.isConnected) showText(null);
      if (curBlock && curBlock !== el) curBlock.removeAttribute('data-es-block');
      curBlock = el && el.isConnected ? el : null;
      if (curBlock) curBlock.setAttribute('data-es-block', '');
      blkRow.hidden = !curBlock && !undoOp;
      blkName.textContent = curBlock ? nameOf(curBlock) : '';
      dock.querySelectorAll('[data-act=blkUp],[data-act=blkDown],[data-act=blkDup],[data-act=blkSave],[data-act=blkDel]').forEach((b) => { b.hidden = !curBlock; });
      if (curBlock) {
        dock.querySelector('[data-act=blkUp]').disabled = !siblingBlock(curBlock, -1);
        dock.querySelector('[data-act=blkDown]').disabled = !siblingBlock(curBlock, 1);
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

    /* ---------- single paragraphs, headings and lists ---------- */
    const txtRow = dock.querySelector('.ve-txtrow');
    const txtName = dock.querySelector('.ve-tname');
    const txtLabel = dock.querySelector('.ve-tlabel');
    const txtUndoBtn = dock.querySelector('[data-act=txtUndo]');
    const TEXT_TAGS = new Set(['P', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'UL', 'OL', 'BLOCKQUOTE', 'DIV', 'PRE']);
    let curText = null;
    let undoTxt = null;

    function textOf(node) {
      const host = node ? closestEl(node, '[data-es-edit]') : null;
      if (!host || host === doc.body || !host.parentElement) return null;
      if (host.hasAttribute('data-es-loose') || TEXT_TAGS.has(host.tagName)) return host;
      return null;
    }
    function textKind(el) {
      if (/^H[1-6]$/.test(el.tagName)) return 'Heading';
      if (el.tagName === 'UL' || el.tagName === 'OL') return 'List';
      return 'Paragraph';
    }
    function showText(el) {
      curText = el && el.isConnected ? el : null;
      txtRow.hidden = !curText && !undoTxt;
      const kind = curText ? textKind(curText) : (undoTxt ? undoTxt.kind : 'Paragraph');
      txtLabel.textContent = kind;
      txtName.textContent = curText ? '“' + curText.textContent.replace(/\s+/g, ' ').trim().slice(0, 28) + '…”' : '';
      dock.querySelectorAll('[data-act=txtUp],[data-act=txtDown],[data-act=txtDup],[data-act=txtDel]').forEach((b) => { b.hidden = !curText; });
      if (curText) {
        dock.querySelector('[data-act=txtUp]').disabled = !curText.previousElementSibling;
        dock.querySelector('[data-act=txtDown]').disabled = !curText.nextElementSibling;
        txtName.title = curText.textContent.replace(/\s+/g, ' ').trim();
      }
      txtUndoBtn.hidden = !undoTxt;
      txtUndoBtn.textContent = 'Undo delete';
    }
    function trackText(node) {
      if (!doc) return;
      const t = node ? textOf(node) : null;
      if (t !== curText) showText(t);
    }
    function moveText(dir) {
      const el = curText;
      const other = el && (dir < 0 ? el.previousElementSibling : el.nextElementSibling);
      if (!other) return;
      const mine = unitOf(el);
      const ref = dir < 0 ? unitOf(other)[0] : other.nextSibling;
      mine.forEach((n) => other.parentNode.insertBefore(n, ref));
      undoTxt = null;
      showText(el);
      el.scrollIntoView({ block: 'nearest' });
      scheduleChange();
    }
    function duplicateText() {
      const el = curText;
      if (!el) return;
      const nodes = unitOf(el).map((n) => n.cloneNode(true));
      const copy = nodes[nodes.length - 1];
      const ref = el.nextSibling;
      nodes.forEach((n) => el.parentNode.insertBefore(n, ref));
      undoTxt = null;
      showText(copy);
      copy.scrollIntoView({ block: 'nearest' });
      scheduleChange();
    }
    function deleteText() {
      const el = curText;
      if (!el) return;
      const nodes = unitOf(el);
      const parent = el.parentNode;
      const next = el.nextSibling;
      const kind = textKind(el);
      nodes.forEach((n) => n.remove());
      undoTxt = { nodes, parent, next, kind };
      curText = null;
      lastRange = null;
      showText(null);
      txtName.textContent = kind + ' deleted';
      txtRow.hidden = false;
      showBlock(curBlock);   // the section around it may have changed state
      scheduleChange();
    }
    function undoDeleteText() {
      const op = undoTxt;
      if (!op) return;
      const ref = op.next && op.next.parentNode === op.parent ? op.next : null;
      op.nodes.forEach((n) => op.parent.insertBefore(n, ref));
      undoTxt = null;
      showText(op.nodes[op.nodes.length - 1]);
      scheduleChange();
    }

    /* ---------- where new things go (buttons, library blocks) ---------- */
    // On a phone you can only tap inside text, so a new button or block is offered a short list of
    // places instead of needing a tap exactly there: below what you tapped, below the box around it,
    // or at the bottom of the main area.
    const kindOf = (el) => (el.classList && el.classList.contains('es-button') ? 'button' : el === curBlock ? 'section' : textKind(el).toLowerCase());
    function mainArea() {
      const counts = new Map();
      doc.querySelectorAll('[data-es-edit]').forEach((h) => {
        const p = h.parentElement;
        if (p && p !== doc.body) counts.set(p, (counts.get(p) || 0) + 1);
      });
      let best = null, n = 0;
      counts.forEach((c, p) => { if (c > n) { best = p; n = c; } });
      return best;
    }
    function placementOptions() {
      const out = [];
      const add = (label, parent, before) => {
        if (!parent || out.some((o) => o.parent === parent && o.before === before)) return;
        out.push({ label, parent, before });
      };
      const below = (label, el) => add(label, el.parentNode, el.nextSibling);
      const start = curBtn || curText || curBlock;
      let top = null;
      if (start && start.isConnected) {
        below('Right below this ' + kindOf(start) + (start === curBlock ? ' (' + nameOf(start) + ')' : ''), start);
        let found = 0;
        for (let a = start.parentElement; a && a !== doc.body; a = a.parentElement) {
          const p = a.parentElement;
          if (!isBox(a) || !p || p === doc.body) continue;
          if ([...p.children].length < 2) continue;
          below('Below the box around it (' + nameOf(a) + ')', a);
          top = p;
          if (++found >= 2) break;
        }
        add(top ? 'At the bottom of the main area' : 'At the bottom of this area', top || start.parentNode, null);
      }
      const main = mainArea();
      if (main) add('At the bottom of the main area', main, null);
      return out;
    }
    // A drop-down listing those places. get() returns the chosen one.
    function placementSelect() {
      const choices = placementOptions();
      const sel = document.createElement('select');
      sel.style.cssText = 'width:100%;max-width:100%';
      choices.forEach((c, i) => { const o = document.createElement('option'); o.value = i; o.textContent = c.label; sel.appendChild(o); });
      return { el: sel, count: choices.length, get: () => choices[Number(sel.value)] || null };
    }
    const putNodes = (where, nodes) => nodes.forEach((n) => where.parent.insertBefore(n, where.before && where.before.parentNode === where.parent ? where.before : null));

    /* ---------- buttons ---------- */
    const btnRow = dock.querySelector('.ve-btnrow');
    const btnName = dock.querySelector('.ve-bbname');
    const btnUndoEl = dock.querySelector('[data-act=btnUndo]');
    const BTN_COLORS = [['Orange', '#D9480F'], ['Green', '#3E8E63'], ['Blue', '#2563EB'], ['Charcoal', '#222222'], ['Red', '#C0392B']];
    const BTN_CSS = '/* es-button */\n' +
      'td.es-btn-cell a.es-btn-light{color:#ffffff !important;text-decoration:none !important}\n' +
      'td.es-btn-cell a.es-btn-dark{color:#111111 !important;text-decoration:none !important}\n';
    let curBtn = null;
    let undoBtn = null;

    function hexLum(hex) {
      const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
      return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    }
    const lightText = (bg) => hexLum(bg) < 0.4;   // white words on dark buttons, dark words on light ones

    function buttonHtml(o) {
      const light = lightText(o.bg);
      return '<table role="presentation" class="es-button" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:16px 0;"><tbody><tr>' +
        '<td align="' + o.align + '"><table role="presentation" cellspacing="0" cellpadding="0" border="0"><tbody><tr>' +
        '<td class="es-btn-cell" align="center" bgcolor="' + o.bg + '" style="background:' + o.bg + ';border-radius:6px;mso-padding-alt:14px 28px;">' +
        '<a class="es-btn-link ' + (light ? 'es-btn-light' : 'es-btn-dark') + '" href="' + esc(o.href) + '" target="_blank" ' +
        'style="display:inline-block;padding:14px 28px;font-family:\'Open Sans\',Helvetica,Arial,sans-serif;font-size:17px;line-height:20px;font-weight:700;color:' +
        (light ? '#ffffff' : '#111111') + ';text-decoration:none;border-radius:6px;">' + esc(o.text) + '</a>' +
        '</td></tr></tbody></table></td></tr></tbody></table>';
    }
    // Make sure the email carries the small rule that keeps button words readable in dark mode.
    function ensureButtonStyle() {
      for (const s of doc.querySelectorAll('style')) if (s.textContent.includes('/* es-button */')) return;
      const st = doc.createElement('style');
      st.textContent = BTN_CSS;
      doc.head.appendChild(st);
    }
    const btnOf = (node) => (node ? closestEl(node, 'table.es-button') : null);
    function btnValues(tbl) {
      const a = tbl.querySelector('a.es-btn-link') || tbl.querySelector('a');
      const cell = tbl.querySelector('td.es-btn-cell') || (a && a.parentElement);
      const bg = ((cell && (cell.getAttribute('bgcolor') || '')) || '').toLowerCase();
      const outer = tbl.querySelector('td');
      return {
        text: a ? a.textContent.trim() : '',
        href: a ? (a.getAttribute('href') || '') : '',
        bg: /^#[0-9a-f]{6}$/.test(bg) ? bg : '#d9480f',
        align: (outer && outer.getAttribute('align')) || 'center',
      };
    }
    function showButton(tbl) {
      curBtn = tbl && tbl.isConnected ? tbl : null;
      btnRow.hidden = !curBtn && !undoBtn;
      btnName.textContent = curBtn ? '“' + (btnValues(curBtn).text || 'Button').slice(0, 24) + '”' : '';
      dock.querySelectorAll('[data-act=btnEdit],[data-act=btnUp],[data-act=btnDown],[data-act=btnDup],[data-act=btnDel]').forEach((b) => { b.hidden = !curBtn; });
      if (curBtn) {
        dock.querySelector('[data-act=btnUp]').disabled = !curBtn.previousElementSibling;
        dock.querySelector('[data-act=btnDown]').disabled = !curBtn.nextElementSibling;
      }
      btnUndoEl.hidden = !undoBtn;
    }
    function trackButton(node) {
      if (!doc) return;
      const t = btnOf(node);
      if (t !== curBtn) showButton(t);
    }
    function moveButton(dir) {
      const el = curBtn;
      const other = el && (dir < 0 ? el.previousElementSibling : el.nextElementSibling);
      if (!other) return;
      const ref = dir < 0 ? unitOf(other)[0] : other.nextSibling;
      unitOf(el).forEach((n) => other.parentNode.insertBefore(n, ref));
      undoBtn = null;
      showButton(el);
      el.scrollIntoView({ block: 'nearest' });
      scheduleChange();
    }
    function duplicateButton() {
      const el = curBtn;
      if (!el) return;
      const nodes = unitOf(el).map((n) => n.cloneNode(true));
      const copy = nodes[nodes.length - 1];
      const ref = el.nextSibling;
      nodes.forEach((n) => el.parentNode.insertBefore(n, ref));
      undoBtn = null;
      showButton(copy);
      copy.scrollIntoView({ block: 'nearest' });
      scheduleChange();
    }
    function deleteButton() {
      const el = curBtn;
      if (!el) return;
      const nodes = unitOf(el);
      undoBtn = { nodes, parent: el.parentNode, next: el.nextSibling };
      nodes.forEach((n) => n.remove());
      curBtn = null;
      lastRange = null;
      showButton(null);
      btnName.textContent = 'Deleted';
      btnRow.hidden = false;
      scheduleChange();
    }
    function undoDeleteButton() {
      const op = undoBtn;
      if (!op) return;
      const ref = op.next && op.next.parentNode === op.parent ? op.next : null;
      op.nodes.forEach((n) => op.parent.insertBefore(n, ref));
      undoBtn = null;
      showButton(op.nodes[op.nodes.length - 1]);
      scheduleChange();
    }

    // One dialog for both adding a new button and editing one that is already there.
    function openButtonDialog(existing) {
      const v = existing ? btnValues(existing) : { text: '', href: '', bg: BTN_COLORS[0][1].toLowerCase(), align: 'center' };
      const dlg = document.createElement('div');
      dlg.className = 've-dlg';
      const box = document.createElement('div');
      box.className = 've-dlg-box';
      box.style.gridTemplateColumns = 'minmax(0,1fr)';
      const mk = (tag, props, text) => { const n = document.createElement(tag); Object.assign(n, props || {}); if (text) n.textContent = text; return n; };
      const title = mk('label', {}, existing ? 'Edit button' : 'Add a button');
      const tLbl = mk('label', {}, 'Words on the button');
      const tIn = mk('input', { type: 'text', maxLength: 60, placeholder: 'Sign up here' });
      tIn.value = v.text;
      const uLbl = mk('label', {}, 'Where it goes (web address, email or phone)');
      const uIn = mk('input', { type: 'text', placeholder: 'https://…' });
      uIn.value = v.href;
      const cLbl = mk('label', {}, 'Color');
      const colors = mk('div'); colors.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;align-items:center';
      let bg = v.bg;
      const swatches = [];
      const paint = () => { swatches.forEach((s) => { s.style.outline = s.dataset.v.toLowerCase() === bg.toLowerCase() ? '3px solid var(--accent)' : 'none'; }); renderPreview(); };
      for (const [name, hex] of BTN_COLORS) {
        const b = mk('button', { type: 'button', title: name });
        b.dataset.v = hex; b.style.cssText = 'width:30px;height:30px;padding:0;border-radius:6px;border:1px solid rgba(0,0,0,.25);background:' + hex;
        b.addEventListener('click', () => { bg = hex; paint(); });
        swatches.push(b); colors.appendChild(b);
      }
      const other = mk('input', { type: 'color' }); other.value = bg; other.title = 'Other color';
      other.style.cssText = 'width:34px;height:30px;padding:0';
      other.addEventListener('input', () => { bg = other.value; paint(); });
      colors.appendChild(other);
      const aLbl = mk('label', {}, 'Position');
      const aRow = mk('div'); aRow.style.cssText = 'display:flex;gap:6px';
      let align = v.align;
      const aBtns = ['left', 'center', 'right'].map((p) => {
        const b = mk('button', { type: 'button' }, p[0].toUpperCase() + p.slice(1));
        b.addEventListener('click', () => { align = p; renderPreview(); });
        aRow.appendChild(b); return b;
      });
      const place = existing ? null : placementSelect();
      if (place && !place.count) { opts.toast('There is no text to put a button next to yet.', true); return; }
      const wLbl = mk('label', {}, 'Where should it go?');
      const pvLbl = mk('label', {}, 'Preview');
      const pv = mk('div'); pv.style.cssText = 'background:#fff;border:1px solid var(--line);border-radius:8px;padding:0 12px';
      function renderPreview() {
        aBtns.forEach((b, i) => b.classList.toggle('on', ['left', 'center', 'right'][i] === align));
        pv.innerHTML = buttonHtml({ text: tIn.value.trim() || 'Your button', href: '#', bg, align });
      }
      tIn.addEventListener('input', renderPreview);
      const actions = mk('div'); actions.className = 've-dlg-actions';
      const ok = mk('button', { type: 'button', className: 'primary' }, existing ? 'Apply' : 'Add button');
      const cancel = mk('button', { type: 'button' }, 'Cancel');
      actions.append(ok, cancel);
      box.append(title, tLbl, tIn, uLbl, uIn, cLbl, colors, aLbl, aRow);
      if (place) box.append(wLbl, place.el);
      box.append(pvLbl, pv, actions);
      dlg.appendChild(box);
      document.body.appendChild(dlg);
      paint();
      tIn.focus();
      const done = () => dlg.remove();
      cancel.addEventListener('click', done);
      dlg.addEventListener('mousedown', (ev) => { if (ev.target === dlg) done(); });
      const submit = () => {
        const text = tIn.value.trim();
        const href = normalizeUrl(uIn.value);
        if (!text) { opts.toast('Type the words for the button first.', true); tIn.focus(); return; }
        if (!href) { opts.toast(href === null ? "That doesn't look like a web address, email address or phone number." : 'Add where the button should go.', true); uIn.focus(); return; }
        done();
        if (existing) applyButton(existing, { text, href, bg, align });
        else insertButton({ text, href, bg, align }, place.get());
      };
      ok.addEventListener('click', submit);
      dlg.addEventListener('keydown', (ev) => {
        if (ev.key === 'Enter' && ev.target.tagName === 'INPUT' && ev.target.type === 'text') { ev.preventDefault(); submit(); }
        else if (ev.key === 'Escape') done();
      });
    }
    function insertButton(o, where) {
      if (!where) { opts.toast('Could not find a place for the button.', true); return; }
      ensureButtonStyle();
      const t = doc.createElement('template');
      t.innerHTML = buttonHtml(o);
      const node = t.content.firstElementChild;
      putNodes(where, [node]);
      markEditable(node);
      undoBtn = null;
      showButton(node);
      node.scrollIntoView({ block: 'nearest' });
      scheduleChange();
      opts.toast('Button added. Click its words to edit them, or Edit… to change the link or color.');
    }
    function applyButton(tbl, o) {
      ensureButtonStyle();
      const t = doc.createElement('template');
      t.innerHTML = buttonHtml(o);
      const fresh = t.content.firstElementChild;
      // keep any outer spacing the person set; swap in the rebuilt button
      tbl.replaceWith(fresh);
      markEditable(fresh);
      showButton(fresh);
      scheduleChange();
    }

    /* ---------- block library ---------- */
    async function saveCurrentBlock() {
      const el = curBlock;
      if (!el) return;
      const name = (prompt('Name this section for the library (this does not save your email):', nameOf(el)) || '').trim();
      if (!name) return;
      const wrap = doc.createElement('div');
      unitOf(el).forEach((n) => wrap.appendChild(n.cloneNode(true)));
      cleanClone(wrap);
      const preview = wrap.textContent.replace(/\s+/g, ' ').trim().slice(0, 90);
      try {
        await opts.saveBlock({ name, html: wrap.innerHTML, preview });
        opts.toast('Added “' + name + '” to the library. Your email itself is not saved. Use + Block in any email to reuse it.');
      } catch (err) {
        opts.toast(err.message, true);
      }
    }

    function insertBlockHtml(html, where) {
      if (!where) return false;
      const t = doc.createElement('template');
      t.innerHTML = html;
      t.content.querySelectorAll('script').forEach((s) => s.remove());
      const nodes = [...t.content.childNodes];
      if (!nodes.length) return false;
      putNodes(where, nodes);
      nodes.forEach((n) => { if (n.nodeType === 1) markEditable(n); });
      const added = [...nodes].reverse().find(isBox) || null;
      undoOp = null;
      showBlock(added);
      if (added) added.scrollIntoView({ block: 'nearest' });
      scheduleChange();
      return true;
    }

    async function openBlocks() {
      const place = placementSelect();
      if (!place.count) {
        opts.toast('There is no text to put a block next to yet.', true);
        return;
      }
      const dlg = document.createElement('div');
      dlg.className = 've-dlg';
      const box = document.createElement('div');
      box.className = 've-dlg-box';
      const title = document.createElement('label');
      title.textContent = 'Block library';
      const note = document.createElement('div');
      note.className = 've-note';
      note.textContent = 'Choose where it goes, then press Insert. To add to the library, tap a section and choose Add to Library.';
      const wLbl = document.createElement('label');
      wLbl.textContent = 'Where should it go?';
      const list = document.createElement('div');
      box.style.gridTemplateColumns = 'minmax(0,1fr)';   // keep long previews from stretching the box
      list.style.cssText = 'display:grid;gap:8px;max-height:50vh;overflow:auto;min-width:0';
      const actions = document.createElement('div');
      actions.className = 've-dlg-actions';
      const close = document.createElement('button');
      close.type = 'button';
      close.textContent = 'Close';
      actions.appendChild(close);
      box.append(title, note, wLbl, place.el, list, actions);
      dlg.appendChild(box);
      document.body.appendChild(dlg);
      const done = () => dlg.remove();
      close.addEventListener('click', done);
      dlg.addEventListener('mousedown', (e) => { if (e.target === dlg) done(); });
      list.textContent = 'Loading…';
      let blocks = [];
      try { blocks = await opts.listBlocks(); } catch (err) { done(); opts.toast(err.message, true); return; }
      list.textContent = '';
      if (!blocks.length) {
        list.textContent = 'The library is empty. Click a section, then choose Add to Library.';
        return;
      }
      for (const b of blocks) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:8px;align-items:center;border:1px solid var(--line);border-radius:8px;padding:8px';
        const txt = document.createElement('div');
        txt.style.cssText = 'flex:1;min-width:0';
        const nm = document.createElement('b');
        nm.textContent = b.name;
        const pv = document.createElement('div');
        pv.className = 've-note';
        pv.style.cssText = 'display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;overflow-wrap:anywhere';
        pv.textContent = b.preview.length > 60 ? b.preview.slice(0, 60).trim() + '…' : b.preview;
        txt.append(nm, pv);
        const ins = document.createElement('button');
        ins.type = 'button';
        ins.textContent = 'Insert';
        ins.className = 'primary';
        ins.addEventListener('click', async () => {
          try {
            const full = await opts.getBlock(b.id);
            if (!insertBlockHtml(full.html, place.get())) opts.toast('Could not find a place for it.', true);
            else opts.toast('Added “' + b.name + '”.');
            done();
          } catch (err) { opts.toast(err.message, true); }
        });
        const del = document.createElement('button');
        del.type = 'button';
        del.textContent = 'Delete';
        del.className = 've-danger';
        del.addEventListener('click', async () => {
          if (!confirm('Remove “' + b.name + '” from the library? Emails that already use it are not changed.')) return;
          try { await opts.deleteBlock(b.id); row.remove(); } catch (err) { opts.toast(err.message, true); }
        });
        const btns = document.createElement('div');
        btns.style.cssText = 'display:flex;flex-direction:column;gap:6px;flex:none';
        btns.append(ins, del);
        row.append(btns, txt);   // buttons on the left, always visible
        list.appendChild(row);
      }
    }

    /* ---------- toolbar actions ---------- */
    // Keep the email's text selection when a toolbar button is pressed.
    const keepSelection = (e) => {
      if (e.target.closest('button')) e.preventDefault();
    };
    bar.addEventListener('mousedown', keepSelection);
    dock.addEventListener('mousedown', keepSelection);

    const onBarClick = (e) => {
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
        case 'btnEdit': if (curBtn) openButtonDialog(curBtn); break;
        case 'btnUp': moveButton(-1); break;
        case 'btnDown': moveButton(1); break;
        case 'btnDup': duplicateButton(); break;
        case 'btnDel': deleteButton(); break;
        case 'btnUndo': undoDeleteButton(); break;
        case 'addButton': openButtonDialog(null); break;
        case 'fmtToggle': {
          const row = bar.querySelector('.ve-row');
          const on = !row.classList.contains('ve-open');
          row.classList.toggle('ve-open', on);
          b.setAttribute('aria-pressed', on ? 'true' : 'false');
          break;
        }
        case 'txtUp': moveText(-1); break;
        case 'txtDown': moveText(1); break;
        case 'txtDup': duplicateText(); break;
        case 'txtDel': deleteText(); break;
        case 'txtUndo': undoDeleteText(); break;
        case 'blkSave': saveCurrentBlock(); break;
        case 'blocks': openBlocks(); break;
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
    };
    bar.addEventListener('click', onBarClick);
    dock.addEventListener('click', onBarClick);

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
        undoTxt = null;
        undoBtn = null;
        trackBlock(img);
        trackText(img);
        trackButton(img);
        return;
      }
      if (closestEl(e.target, 'a')) e.preventDefault(); // never navigate the preview
      selectImage(null);
      undoOp = null;
      undoTxt = null;
      undoBtn = null;
      trackBlock(e.target);
      trackText(e.target);
      trackButton(e.target);
      // Clicking somewhere that can't hold text: forget the old cursor spot, so a picture
      // is never dropped somewhere the person didn't pick.
      if (!closestEl(e.target, '[data-es-edit]')) lastRange = null;
    }

    // Figure out which section / paragraph / button the person is in and show its tools. Phones
    // are unreliable about telling a page inside a page that a tap or a cursor move happened
    // (click and selectionchange can both go missing), so this is also run from touches,
    // focus and typing, using the cursor's position as well as the thing that was tapped.
    function trackAt(node) {
      if (!doc) return;
      let n = node && node.nodeType ? node : null;
      const sel = doc.getSelection();
      const a = sel && sel.rangeCount && sel.anchorNode && doc.contains(sel.anchorNode) ? sel.anchorNode : null;
      if (!n) n = a;   // no tap to go by (typing, arrow keys): use the cursor
      if (!n) return;
      trackBlock(n);
      trackText(a && closestEl(a, '[data-es-edit]') ? a : n);
      trackButton(n);
      placeDock();
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
      // Formatting shortcuts. Safari keeps some of these for itself (Cmd+I is "Mail This Page"), so the
      // editor claims them. On a Mac only the Cmd key counts, so Ctrl-based text-editing keys still work.
      if (!e.isComposing && !e.altKey && (IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)) {
        const k = (e.key || '').toLowerCase();
        const fmt = { b: 'bold', i: 'italic', u: 'underline' }[k];
        const inText = !!closestEl(e.target, '[data-es-edit]');
        if (inText && ((fmt && !e.shiftKey) || k === 'z' || (k === 'y' && !IS_MAC))) {
          e.preventDefault();
          if (fmt) doc.execCommand(fmt, false, null);
          else doc.execCommand(k === 'y' || e.shiftKey ? 'redo' : 'undo', false, null);
          scheduleChange();
          updateState();
          return;
        }
      }
      if (tryJoin(e)) return;
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
    const HOST_ATTRS = ['style', 'color', 'bgcolor', 'face', 'size'];
    function snapshot(host) {
      const set = new Set(host.querySelectorAll('*'));
      set.hostAttrs = HOST_ATTRS.map((a) => [a, host.getAttribute(a)]);
      return set;
    }
    function sanitizeInserted(host, before) {
      if (!host || !host.isConnected) return;
      // Some browsers (iOS Safari especially) put the pasted text's color on the paragraph itself
      // instead of on a new element. Put the paragraph's own look back exactly as it was.
      if (before.hostAttrs) {
        for (const [a, v] of before.hostAttrs) {
          if (host.getAttribute(a) !== v) { if (v === null) host.removeAttribute(a); else host.setAttribute(a, v); }
        }
      }
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
      const before = snapshot(host);
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
    // True when the cursor sits in a bullet list, where Enter should make a new bullet.
    function inListContext(host) {
      if (!host || host.tagName === 'UL' || host.tagName === 'OL') return true;
      const sel = doc.getSelection();
      return !!(sel && sel.anchorNode && closestEl(sel.anchorNode, 'li'));
    }

    function onBeforeInput(e) {
      // Phone keyboards often skip the normal Enter key event and ask for a "new paragraph"
      // instead. Left alone, the browser would wrap the new line in a <div>, which later turns
      // into a separate text area. Treat it exactly like Enter: a line break in the same paragraph.
      if (e.inputType === 'insertParagraph') {
        const host = closestEl(e.target, '[data-es-edit]');
        if (host && !inListContext(host)) {
          e.preventDefault();
          if (!doc.execCommand('insertLineBreak')) doc.execCommand('insertHTML', false, '<br>');
          scheduleChange();
        }
        return;
      }
      if (e.inputType === 'deleteContentBackward' || e.inputType === 'deleteContentForward') {
        if (tryJoinAt(closestEl(e.target, '[data-es-edit]'), e.inputType === 'deleteContentBackward')) e.preventDefault();
        return;
      }
      if (!/^insertFrom(Paste|Drop|Yank|PasteAsQuotation)$/.test(e.inputType || '')) return;
      const host = closestEl(e.target, '[data-es-edit]');
      if (host) sanitizeNext = { host, before: snapshot(host) };
    }
    // A browser that still added <div>/<p> wrappers inside a text area: turn them into line breaks.
    function flattenBlocks(host) {
      if (!host || !host.isConnected || host.tagName === 'UL' || host.tagName === 'OL') return;
      const blocks = [...host.children].filter((c) => c.tagName === 'DIV' || c.tagName === 'P');
      let last = null;
      for (const el of blocks) {
        const parts = [];
        if (el.previousSibling && !(el.previousSibling.nodeType === 1 && el.previousSibling.tagName === 'BR')) parts.push(doc.createElement('br'));
        const kids = [...el.childNodes].filter((n) => !(n.nodeType === 1 && n.tagName === 'BR' && el.childNodes.length === 1));
        parts.push(...kids);
        if (!kids.length && !parts.length) parts.push(doc.createElement('br'));
        el.replaceWith(...parts);
        if (kids.length) last = kids[kids.length - 1];
      }
      if (last) {
        const r = doc.createRange();
        if (last.nodeType === 3) r.setStart(last, last.length); else r.setStartAfter(last);
        r.collapse(true);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(r);
      }
    }

    // Backspace at the very start of a text area (or Delete at the very end) joins it with its
    // neighbour, like any word processor. Only text areas that sit side by side are joined.
    function atEdge(host, sel, atStart) {
      if (!sel || !sel.rangeCount || !sel.isCollapsed) return false;
      const r = sel.getRangeAt(0).cloneRange();
      if (!host.contains(r.startContainer)) return false;
      const probe = doc.createRange();
      probe.selectNodeContents(host);
      if (atStart) probe.setEnd(r.startContainer, r.startOffset); else probe.setStart(r.startContainer, r.startOffset);
      const frag = probe.cloneContents();
      return !frag.textContent.length && !frag.querySelector('img');
    }
    function neighbourHost(host, dir) {
      const other = neighbourHostAny(host, dir);
      // only like with like: a paragraph never melts into the heading above it
      return other && other.tagName === host.tagName && (other.getAttribute('class') || '') === (host.getAttribute('class') || '') ? other : null;
    }
    function neighbourHostAny(host, dir) {
      let n = dir < 0 ? host.previousSibling : host.nextSibling;
      while (n && ((n.nodeType === 3 && !n.nodeValue.trim()) || n.nodeType === 8)) n = dir < 0 ? n.previousSibling : n.nextSibling;
      if (!n || n.nodeType !== 1 || !n.hasAttribute('data-es-edit')) return null;
      if (/^(UL|OL)$/.test(n.tagName) || n.hasAttribute('data-es-loose')) return null;
      return n;
    }
    function joinHosts(first, second) {
      const at = first.childNodes.length;
      first.append(...second.childNodes);
      second.remove();
      const r = doc.createRange();
      r.setStart(first, Math.min(at, first.childNodes.length));
      r.collapse(true);
      const sel = doc.getSelection();
      sel.removeAllRanges();
      sel.addRange(r);
      first.normalize(); // the cursor moves along with the words it sits between
      showText(first);
      scheduleChange();
    }
    function tryJoinAt(host, back) {
      if (!host || /^(UL|OL)$/.test(host.tagName) || host.hasAttribute('data-es-loose')) return false;
      if (!atEdge(host, doc.getSelection(), back)) return false;
      const other = neighbourHost(host, back ? -1 : 1);
      if (!other) return false;
      if (back) joinHosts(other, host); else joinHosts(host, other);
      return true;
    }
    function tryJoin(e) {
      if (e.key !== 'Backspace' && e.key !== 'Delete') return false;
      if (e.isComposing || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return false;
      if (!tryJoinAt(closestEl(e.target, '[data-es-edit]'), e.key === 'Backspace')) return false;
      e.preventDefault();
      return true;
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
      d.addEventListener('input', (e) => {
        onInputSanitize();
        if (e.inputType === 'insertParagraph') flattenBlocks(closestEl(e.target, '[data-es-edit]'));
        scheduleChange();
      });
      d.addEventListener('paste', onPaste);
      d.addEventListener('dragover', onDragOver);
      d.addEventListener('dragleave', (e) => { if (!e.relatedTarget) clearDropMark(); });
      d.addEventListener('drop', onDrop);
      d.addEventListener('selectionchange', () => {
        rememberRange(); dropStalePicture(); updateState();
        const s = d.getSelection();
        if (s && s.rangeCount && s.anchorNode) { const t = textOf(s.anchorNode); if (t && t !== curText) showText(t); const bt = btnOf(s.anchorNode); if (bt !== curBtn) showButton(bt); }
      });
      d.addEventListener('mousedown', () => { if (opts.onFocus) opts.onFocus(); });
      d.addEventListener('focusin', (e) => { if (opts.onFocus) opts.onFocus(); trackAt(e.target); });
      d.addEventListener('focusout', () => setTimeout(placeDock, 150));
      // taps on a phone: look at where the cursor ended up once the browser has placed it
      const afterTap = (e) => {
        if (e.pointerType === 'mouse') return;   // a mouse click is already handled
        if (e.target && closestEl(e.target, 'a')) return;
        const t = e.target;
        setTimeout(() => trackAt(t), 60);
        setTimeout(() => trackAt(t), 350);
      };
      d.addEventListener('touchend', afterTap, { passive: true });
      d.addEventListener('pointerup', afterTap);
      d.addEventListener('keyup', () => trackAt(null));
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
      curText = null;
      undoTxt = null;
      curBtn = null;
      undoBtn = null;
      try {
        showButton(null);
        showText(null);
        showBlock(null);
        darkRules = null;
        applyScheme();
        ui.imgRow.hidden = true;
      } catch (e) { /* never let a toolbar problem stop editing from working */ }

      const st = doc.createElement('style');
      st.setAttribute('data-es-style', '');
      st.textContent = IFRAME_CSS;
      doc.head.appendChild(st);

      markEditable(doc.body);
      try { doc.execCommand('styleWithCSS', false, false); } catch (e) { /* ignore */ }
      bind(doc);
      try { updateState(); } catch (e) { /* ignore */ }
      loaded = true;
      lastOut = serialize();
      watch();
    }

    iframe.addEventListener('load', init);

    /* ---------- public API ---------- */
    return {
      // Show this HTML in the preview and make it editable.
      render(html) {
        clearTimeout(timer);
        clearTimeout(watchTimer);
        pending = false;
        loaded = false;
        const m = String(html).match(/^\s*(<!doctype[^>]*>)/i);
        doctype = m ? m[1] : '<!doctype html>';
        iframe.srcdoc = guardHtml(html);
      },
      // Write any not-yet-saved visual edits back to the code now.
      flush,
      // Put a library picture at the cursor, or into the selected picture.
      insertImage(rec, mode) { return insertImage(rec, null, mode); },
      setScheme(s) { scheme = s === 'dark' ? 'dark' : 'light'; applyScheme(); },
      hasDarkStyles() { return getDarkRules().length > 0; },
      hasSelectedImage() { return !!(selectedImg && selectedImg.isConnected); },
    };
  };
})();
