/* @gobbonet-split js/18-utils.js
   Moved verbatim from chat.html lines 10768-11310.
   utilities, colour picker, attachments, input, file blocks
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   UTILITIES
================================================================ */
function copyMessage(index) {
  const thread = getActiveThread();
  if (!thread || !thread.messages[index]) return;
  const m = thread.messages[index];
  const text = m.content || m.reasoning || '';

  // Find the Copy button for this message so we can flash feedback on it.
  // The button lives inside .message[data-index] or we fall back to the event target.
  function flashBtn(success) {
    const msgEl = document.querySelector(`.message[data-index="${index}"]`);
    const btn = msgEl && msgEl.querySelector('.msg-action-btn[onclick*="copyMessage"]');
    if (!btn) return;
    const orig = btn.textContent;
    btn.textContent = success ? '✓ OK' : '✗ ERR';
    btn.style.opacity = '0.7';
    setTimeout(() => { btn.textContent = orig; btn.style.opacity = ''; }, 1400);
  }

  // Modern async API (HTTPS / secure contexts)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flashBtn(true)).catch(() => {
      execCommandFallback();
    });
    return;
  }
  execCommandFallback();

  // Legacy fallback — works on HTTP and older mobile browsers
  function execCommandFallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flashBtn(ok);
    } catch (e) {
      flashBtn(false);
    }
  }
}

/**
 * Copy the text of a code/file block to the clipboard.
 * `btn` is the clicked Copy button; we read the sibling <pre><code> within
 * the same .code-block / .file-block container. Reading from the DOM (rather
 * than passing the code as an onclick arg) sidesteps any escaping headaches
 * with code that contains quotes, backticks, or angle brackets.
 */
function copyCodeBlock(btn) {
  const block = btn.closest('.code-block, .file-block');
  const codeEl = block && block.querySelector('pre code');
  if (!codeEl) return;
  const text = codeEl.textContent;

  function flash(success) {
    const orig = btn.textContent;
    btn.textContent = success ? '✓ Copied' : '✗ Failed';
    btn.classList.toggle('code-copy-ok', success);
    btn.classList.toggle('code-copy-err', !success);
    setTimeout(() => {
      btn.textContent = orig;
      btn.classList.remove('code-copy-ok', 'code-copy-err');
    }, 1400);
  }

  // Modern async clipboard (secure contexts)
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => flash(true)).catch(execCommandFallback);
    return;
  }
  execCommandFallback();

  // Legacy fallback — works on plain HTTP / older mobile browsers, which
  // matters here since Gobbonet is typically served over LAN http://.
  function execCommandFallback() {
    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      flash(ok);
    } catch (e) {
      flash(false);
    }
  }
}

function escapeHtml(str) {
  // textContent -> innerHTML handles &, <, > but NOT " or ' -- the HTML5
  // text-node serializer deliberately leaves attribute-delimiter characters
  // alone (they're only special in attribute context, not text). We add
  // them ourselves so the same escaped string is safe in BOTH contexts:
  // inside <span>...</span> and inside href="...". Browsers decode &quot;
  // and &#39; back to " and ' in either context, so no display regression.
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function parseSearchData(raw) {
  if (!raw) return '';
  // Parse the structured format: - Title: content\n  Source: url\n
  const lines = raw.split('\n');
  let html = '';
  let currentTitle = '';
  let currentContent = '';
  
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('- ')) {
      // Flush previous entry
      if (currentTitle) html += buildSearchEntry(currentTitle, currentContent, '');
      // Parse "- Title: content"
      const colonIdx = trimmed.indexOf(':');
      if (colonIdx > 2) {
        currentTitle = trimmed.slice(2, colonIdx).trim();
        currentContent = trimmed.slice(colonIdx + 1).trim();
      } else {
        currentTitle = trimmed.slice(2);
        currentContent = '';
      }
    } else if (trimmed.startsWith('Source:')) {
      const url = trimmed.slice(7).trim();
      html += buildSearchEntry(currentTitle, currentContent, url);
      currentTitle = '';
      currentContent = '';
    }
  }
  // Flush last entry if no Source line
  if (currentTitle) html += buildSearchEntry(currentTitle, currentContent, '');
  
  return html || escapeHtml(raw).replace(/\n/g, '<br>');
}

function buildSearchEntry(title, content, url) {
  const safeTitle = escapeHtml(title);
  const safeContent = escapeHtml(content);
  if (url) {
    const safeUrl = escapeHtml(url);
    // Only allow http(s) URLs to prevent javascript: XSS.
    // Use safeUrl (HTML-escaped) in the href so a literal " in the URL
    // can't break out of the attribute and inject event handlers.
    // The browser decodes entities natively inside href, so &amp; etc.
    // still navigate correctly.
    if (/^https?:\/\//i.test(url)) {
      return `<div class="search-entry"><a href="${safeUrl}" target="_blank" rel="noopener" class="search-entry-title">${safeTitle}</a><div class="search-entry-content">${safeContent}</div><div class="search-entry-url">${safeUrl}</div></div>`;
    }
    return `<div class="search-entry"><div class="search-entry-title">${safeTitle}</div><div class="search-entry-content">${safeContent}</div><div class="search-entry-url">${safeUrl}</div></div>`;
  }
  return `<div class="search-entry"><div class="search-entry-title">${safeTitle}</div><div class="search-entry-content">${safeContent}</div></div>`;
}

function parseMarkdown(text, dialogColor) {
  if (!text) return '';
  let html = escapeHtml(text);

  // File blocks: ```file:filename.ext → rendered with download + copy buttons
  html = html.replace(/```file:([^\n]+)\n([\s\S]*?)```/g, (_, filename, content) => {
    const fn = filename.trim();
    const raw = content.trim();
    const id = 'file_' + Math.random().toString(36).slice(2, 8);
    return `<div class="file-block"><div class="file-header"><span class="file-name">&#128196; ${fn}</span><div class="code-btns"><button class="btn btn-sm code-copy-btn" onclick="copyCodeBlock(this)">Copy</button><button class="btn btn-sm" onclick="downloadFile('${id}','${fn}')">Save</button></div></div><pre><code id="${id}">${raw}</code></pre></div>`;
  });

  // Regular code blocks → wrapped with a header bar carrying a Copy button.
  // The label shows the language tag when one was given (```js etc).
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
    const label = lang ? lang.toLowerCase() : 'code';
    return `<div class="code-block"><div class="code-block-header"><span class="code-lang">${label}</span><button class="btn btn-sm code-copy-btn" onclick="copyCodeBlock(this)">Copy</button></div><pre><code>${code.trim()}</code></pre></div>`;
  });
  // Inline code: `snippet` — but only outside already-rendered block code.
  // Walk tags vs text (same approach as the dialog pass below) so backticks
  // that appear *inside* a fenced block's <pre><code> aren't turned into
  // nested <code> tags.
  {
    let inBlock = false;
    html = html.replace(/(<[^>]*>)|([^<]+)/g, (m, tag, txt) => {
      if (tag) {
        if (/<pre/i.test(tag) || /<code/i.test(tag)) inBlock = true;
        if (/<\/pre/i.test(tag) || /<\/code/i.test(tag)) inBlock = false;
        return tag;
      }
      if (inBlock) return txt;
      return txt.replace(/`([^`]+)`/g, '<code>$1</code>');
    });
  }

  // Dialog text: "quoted speech" → bold + dialog color
  // Must run AFTER code blocks to avoid matching inside code
  if (dialogColor) {
    // Split into HTML tags vs text segments; only apply dialog to text outside code blocks
    let inCode = false;
    html = html.replace(/(<[^>]*>)|([^<]+)/g, (match, tag, text) => {
      if (tag) {
        // Track whether we're inside a <code> or <pre> block
        if (/<code/i.test(tag)) inCode = true;
        if (/<\/code/i.test(tag) || /<\/pre/i.test(tag)) inCode = false;
        return tag; // HTML tag — pass through untouched
      }
      // Text node inside code — pass through untouched
      if (inCode) return text;
      // Text node — wrap "quoted dialog" in styled span.
      // NOTE: escapeHtml() has already converted every raw " into the
      // &quot; entity (needed so the same escaped string is safe inside
      // href="..." attributes elsewhere). So we must match &quot; here,
      // not a literal " — otherwise this never fires and speech loses its
      // dialog color. Lazy [\s\S]+? pairs each opening &quot; with the
      // next one and tolerates other entities (&amp;, &#39;, …) inside.
      return text.replace(/&quot;([\s\S]+?)&quot;/g, (_, inner) => {
        return `<span class="dialog-text" style="color:${dialogColor};">&quot;${inner}&quot;</span>`;
      });
    });
  }

  // Markdown links: [text](url)
  html = html.replace(/\[([^\]]+)\]\((https?:\/\/[^\s\)]+)\)/g, (_, text, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    return `<a href="${cleanUrl}" target="_blank" rel="noopener">${text}</a>`;
  });

  // Bare URLs — auto-link any https?:// not already inside an <a> tag
  html = html.replace(/(^|[^"'>\/])(https?:\/\/[^\s<\)\]"'`,]+)/g, (_, before, url) => {
    const cleanUrl = url.replace(/&amp;/g, '&');
    // Trim trailing punctuation that's probably not part of the URL
    const trimmed = cleanUrl.replace(/[.,;:!?\)]+$/, '');
    const remainder = cleanUrl.slice(trimmed.length);
    const displayUrl = url.replace(/[.,;:!?\)]+$/, '');
    return `${before}<a href="${trimmed}" target="_blank" rel="noopener">${displayUrl}</a>${remainder}`;
  });

  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/(?<!\*)\*([^*]+?)\*(?!\*)/g, '<em>$1</em>');
  html = html.replace(/^### (.+)$/gm, '<strong style="font-size:1.05em;color:var(--label);">$1</strong>');
  html = html.replace(/^## (.+)$/gm, '<strong style="font-size:1.1em;color:var(--magenta);">$1</strong>');
  html = html.replace(/^# (.+)$/gm, '<strong style="font-size:1.2em;color:var(--green-neon);">$1</strong>');
  html = html.replace(/^\- (.+)$/gm, '&bull; $1');
  html = html.replace(/^(\d+)\. (.+)$/gm, '$1. $2');
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  html = '<p>' + html + '</p>';
  html = html.replace(/<p>\s*<pre>/g, '<pre>');
  html = html.replace(/<\/pre>\s*<\/p>/g, '</pre>');
  html = html.replace(/<p>\s*<div class="file-block">/g, '<div class="file-block">');
  html = html.replace(/<p>\s*<div class="code-block">/g, '<div class="code-block">');
  html = html.replace(/<\/div>\s*<\/p>/g, '</div>');
  return html;
}

/* ================================================================
   COLOR PICKER HELPERS
================================================================ */
function syncColorHex(swatchEl, hexInputId) {
  document.getElementById(hexInputId).value = swatchEl.value;
}

function syncColorSwatch(hexEl, swatchId) {
  let val = hexEl.value.trim();
  if (val && !val.startsWith('#')) val = '#' + val;
  if (/^#[0-9a-fA-F]{6}$/.test(val)) {
    document.getElementById(swatchId).value = val;
  }
}

function previewCardColors() {
  const tc = document.getElementById('card-textcolor')?.value || '#e0f8ff';
  const dc = document.getElementById('card-dialogcolor')?.value || '#d900ff';
  const el = document.getElementById('card-color-preview');
  if (el) {
    el.style.color = tc;
    const dialogSpan = el.querySelector('.dialog-text');
    if (dialogSpan) dialogSpan.style.color = dc;
  }
}

function previewPersonaColors() {
  const tc = document.getElementById('persona-textcolor')?.value || '#00b8ff';
  const dc = document.getElementById('persona-dialogcolor')?.value || '#00f3ff';
  const el = document.getElementById('persona-color-preview');
  if (el) {
    el.style.color = tc;
    const dialogSpan = el.querySelector('.dialog-text');
    if (dialogSpan) dialogSpan.style.color = dc;
  }
}

/* ================================================================
   FILE ATTACHMENTS — drag & drop + click-to-attach
   This is a local text model (llama.cpp), so "attaching" a text file
   means its contents get embedded into the outgoing message so the
   model can read it. Images can be attached for the human record but
   are NOT sent to the model — we mark them clearly. Everything stays
   in-browser; nothing is uploaded anywhere.
================================================================ */

// Files staged for the next send. Each: { id, name, kind, size, text|dataUrl, skipped }
let _pendingAttachments = [];

// Max characters of file text embedded per file (keeps a runaway log from
// blowing the context window). The chip notes when a file was truncated.
const ATTACH_TEXT_LIMIT = 100000;
const ATTACH_MAX_BYTES  = 8 * 1024 * 1024; // 8MB per file guard

// Extensions/MIME we treat as readable text. Anything else that isn't an
// image is attached as a reference-only chip (name recorded, not read).
const TEXT_EXT = /\.(txt|md|markdown|json|jsonl|csv|tsv|log|xml|yaml|yml|ini|cfg|conf|toml|html?|css|js|mjs|cjs|ts|tsx|jsx|py|rb|go|rs|java|c|h|cpp|hpp|cc|cs|php|sh|bash|zsh|sql|r|lua|pl|swift|kt|scala|dart|vue|svelte|tex|env|gitignore|dockerfile|makefile)$/i;

function isTextFile(file) {
  if (file.type && (file.type.startsWith('text/') ||
      /(json|javascript|xml|x-sh|x-python|csv)/i.test(file.type))) return true;
  if (TEXT_EXT.test(file.name)) return true;
  // Extensionless common names
  if (/^(dockerfile|makefile|readme|license)$/i.test(file.name)) return true;
  return false;
}

function formatBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
  return (n / (1024 * 1024)).toFixed(1) + ' MB';
}

/** Read a list of File objects into _pendingAttachments, then re-render. */
function addAttachments(fileList) {
  const files = Array.from(fileList || []);
  if (files.length === 0) return;

  files.forEach(file => {
    const id = generateId();
    const isImg = file.type && file.type.startsWith('image/');
    const base = { id, name: file.name, size: file.size };

    if (file.size > ATTACH_MAX_BYTES) {
      _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'too large (>8MB)' });
      renderAttachTray();
      return;
    }

    if (isImg) {
      // Stored for display only — local text model can't see it.
      const reader = new FileReader();
      reader.onload = e => {
        _pendingAttachments.push({ ...base, kind: 'image', dataUrl: e.target.result });
        renderAttachTray();
      };
      reader.onerror = () => { _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'read error' }); renderAttachTray(); };
      reader.readAsDataURL(file);
    } else if (isTextFile(file)) {
      const reader = new FileReader();
      reader.onload = e => {
        let text = e.target.result || '';
        let truncated = false;
        if (text.length > ATTACH_TEXT_LIMIT) {
          text = text.slice(0, ATTACH_TEXT_LIMIT);
          truncated = true;
        }
        _pendingAttachments.push({ ...base, kind: 'text', text, truncated });
        renderAttachTray();
      };
      reader.onerror = () => { _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'read error' }); renderAttachTray(); };
      reader.readAsText(file);
    } else {
      // Unknown binary — record the name only, not sent to model.
      _pendingAttachments.push({ ...base, kind: 'skip', skipped: 'binary — not sent to model' });
      renderAttachTray();
    }
  });
}

function removeAttachment(id) {
  _pendingAttachments = _pendingAttachments.filter(a => a.id !== id);
  renderAttachTray();
}

function clearAttachments() {
  _pendingAttachments = [];
  renderAttachTray();
}

/** Render the pending-attachments tray + update the attach button state. */
function renderAttachTray() {
  const tray = document.getElementById('attach-tray');
  const btn  = document.getElementById('attach-btn');
  if (!tray) return;

  if (_pendingAttachments.length === 0) {
    tray.style.display = 'none';
    tray.innerHTML = '';
    if (btn) btn.classList.remove('has-files');
    return;
  }

  tray.style.display = 'flex';
  if (btn) btn.classList.add('has-files');

  tray.innerHTML = _pendingAttachments.map(a => {
    let cls = 'attach-chip', icon = '📄', meta = formatBytes(a.size);
    if (a.kind === 'image') { cls += ' attach-chip-img'; icon = '🖼️'; meta = 'image · not sent to model'; }
    else if (a.kind === 'skip') { cls += ' attach-chip-skip'; icon = '⚠️'; meta = a.skipped; }
    else if (a.truncated) { meta = formatBytes(a.size) + ' · truncated'; }
    return `<span class="${cls}" title="${escapeHtml(a.name)}">
      <span class="attach-chip-icon">${icon}</span>
      <span class="attach-chip-name">${escapeHtml(a.name)}</span>
      <span class="attach-chip-meta">${escapeHtml(meta)}</span>
      <button class="attach-chip-x" onclick="removeAttachment('${a.id}')" title="Remove">×</button>
    </span>`;
  }).join('');
}

/** Triggered by the hidden <input type=file>. */
function onAttachInput(inputEl) {
  addAttachments(inputEl.files);
  inputEl.value = ''; // allow re-selecting the same file
}

/**
 * Build the text block that gets prepended to the outgoing message so the
 * model can read attached text files. Returns '' when nothing is readable.
 * Also returns the lightweight metadata array to store on the message for
 * display chips. Call once at send time.
 */
function consumeAttachmentsForSend() {
  const atts = _pendingAttachments.slice();
  if (atts.length === 0) return { embed: '', meta: [] };

  const textParts = [];
  const meta = [];
  atts.forEach(a => {
    if (a.kind === 'text') {
      textParts.push(`----- FILE: ${a.name} -----\n${a.text}${a.truncated ? '\n[...truncated]' : ''}\n----- END FILE: ${a.name} -----`);
      meta.push({ name: a.name, kind: 'text', size: a.size, truncated: !!a.truncated });
    } else if (a.kind === 'image') {
      meta.push({ name: a.name, kind: 'image', size: a.size, dataUrl: a.dataUrl });
    } else {
      meta.push({ name: a.name, kind: 'skip', size: a.size, note: a.skipped });
    }
  });

  const embed = textParts.length
    ? `[Attached file${textParts.length > 1 ? 's' : ''}]\n${textParts.join('\n\n')}\n\n`
    : '';
  return { embed, meta };
}

/* ================================================================
   INPUT HANDLING
================================================================ */
function setupInput() {
  const input = document.getElementById('msg-input');
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 200) + 'px';
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
  });

  // Paste images straight from the clipboard into attachments.
  input.addEventListener('paste', (e) => {
    const items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    const files = [];
    for (const it of items) {
      if (it.kind === 'file') { const f = it.getAsFile(); if (f) files.push(f); }
    }
    if (files.length) { e.preventDefault(); addAttachments(files); }
  });

  setupDragAndDrop();
}

/**
 * Wire drag & drop over the chat area. We use a counter to handle the
 * dragenter/dragleave storm that fires as the cursor moves over child
 * elements — the overlay only hides when the count returns to zero, so it
 * doesn't flicker. dragover must call preventDefault on the document or the
 * browser treats the drop as a navigation and opens the file instead.
 */
function setupDragAndDrop() {
  const chat = document.getElementById('chat');
  const overlay = document.getElementById('drop-overlay');
  if (!chat || !overlay) return;

  let depth = 0;
  const hasFiles = e => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files');

  // Prevent the browser from opening dropped files anywhere on the page.
  ['dragover', 'drop'].forEach(evt =>
    window.addEventListener(evt, e => { if (hasFiles(e)) e.preventDefault(); })
  );

  chat.addEventListener('dragenter', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth++;
    overlay.classList.add('active');
  });
  chat.addEventListener('dragover', e => {
    if (hasFiles(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; }
  });
  chat.addEventListener('dragleave', e => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (depth === 0) overlay.classList.remove('active');
  });
  chat.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    overlay.classList.remove('active');
    addAttachments(e.dataTransfer.files);
  });
}

/* ================================================================
   FILE GENERATION — download .txt/.json to browser downloads
   AI outputs ```file:filename.ext blocks, rendered with Save button.
================================================================ */
function downloadFile(elementId, filename) {
  const el = document.getElementById(elementId);
  if (!el) return;
  const content = el.textContent;
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

