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
      #fmt .ve-sep{width:1px;height:18px;background:var(--line)}
      #fmt .ve-img{background:#e6f2f0;border-top:1px solid #bfe0db;border-bottom:1px solid #bfe0db}
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
        <button type="button" data-cmd="bold" title="Bold (Ctrl+B)"><b>B</b></button>
        <button type="button" data-cmd="italic" title="Italic (Ctrl+I)"><i>I</i></button>
        <button type="button" data-cmd="underline" title="Underline (Ctrl+U)"><u>U</u></button>
        <span class="ve-sep"></span>
        <button type="button" data-act="link" title="Turn the selected words into a link">Link</button>
        <button type="button" data-cmd="insertUnorderedList" title="Bulleted list">&bull; List</button>
        <button type="button" data-cmd="removeFormat" title="Remove bold, italics, etc. from the selected words">Clear</button>
        <span class="ve-sep"></span>
        <button type="button" data-act="undo" title="Undo (Ctrl+Z)">&#8630;</button>
        <button type="button" data-act="redo" title="Redo (Ctrl+Y)">&#8631;</button>
        <span class="ve-sep"></span>
        <button type="button" data-act="addImage" title="Add a picture where your cursor is">+ Picture</button>
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
      <div class="ve-hint">Click any text to edit it. Click a picture to change it.</div>`;
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
    }

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
      clone.querySelectorAll('[data-es-loose]').forEach((s) => s.replaceWith(...s.childNodes));
      ['data-es-edit', 'data-es-sel', 'data-es-drop', 'data-es-new'].forEach((a) =>
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
      scheduleChange();
    }

    function insertImage(rec, atRange) {
      if (!doc) return false;
      if (!atRange && selectedImg && selectedImg.isConnected) {
        setImageSrc(selectedImg, rec);
        return true;
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
        doc.execCommand(b.dataset.cmd, false, null);
        scheduleChange();
        updateState();
        return;
      }

      switch (b.dataset.act) {
        case 'link':
          openTextLink();
          break;
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
        return;
      }
      if (closestEl(e.target, 'a')) e.preventDefault(); // never navigate the preview
      selectImage(null);
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
      if (inList) {
        doc.execCommand('insertText', false, text.replace(/\s*\r?\n+\s*/g, ' ').trim());
      } else if (html) {
        doc.execCommand('insertHTML', false, cleanPaste(html) || textToHtml(text));
      } else {
        doc.execCommand('insertHTML', false, textToHtml(text));
      }
      scheduleChange();
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
      d.addEventListener('input', scheduleChange);
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
      insertImage(rec) { return insertImage(rec); },
      hasSelectedImage() { return !!(selectedImg && selectedImg.isConnected); },
    };
  };
})();
