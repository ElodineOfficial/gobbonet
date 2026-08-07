/* @gobbonet-split js/19-extensions.js
   Moved verbatim from chat.html lines 11311-11554.
   custom CSS / JS overrides
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   EXTENSIONS — custom CSS + JS overrides
   Users can inject a stylesheet (URL or raw CSS) and a script
   (URL or inline JS) that are persisted in localStorage and
   re-applied every boot. All injected elements get the class
   'gobbonet-ext' so they can be cleanly removed/replaced.
================================================================ */

/**
 * Apply saved extensions to the page.
 * Removes any previously-injected extension elements first,
 * then re-injects according to current state.extensions.
 */
function applyExtensions() {
  // Remove any previously injected extension elements
  document.querySelectorAll('.gobbonet-ext').forEach(el => el.remove());

  const ext = state.extensions;
  if (!ext || !ext.enabled) {
    updateExtStatusDot();
    return;
  }

  const styles  = Array.isArray(ext.styles)  ? ext.styles  : [];
  const scripts = Array.isArray(ext.scripts) ? ext.scripts : [];

  // ── Stylesheets (in order). Each entry: URL <link> then inline <style>. ──
  styles.forEach((entry, i) => {
    const label = entry.name || ('stylesheet ' + (i + 1));
    if (entry.url && entry.url.trim()) {
      const link = document.createElement('link');
      link.rel = 'stylesheet';
      link.href = entry.url.trim();
      link.className = 'gobbonet-ext';
      link.setAttribute('data-ext-type', 'css-url');
      link.setAttribute('data-ext-name', label);
      document.head.appendChild(link);
      console.log('[ext] Loaded CSS URL:', entry.url.trim());
    }
    if (entry.raw && entry.raw.trim()) {
      const style = document.createElement('style');
      style.className = 'gobbonet-ext';
      style.setAttribute('data-ext-type', 'css-raw');
      style.setAttribute('data-ext-name', label);
      style.textContent = entry.raw;
      document.head.appendChild(style);
      console.log('[ext] Injected inline CSS (' + entry.raw.length + ' chars)');
    }
  });

  // ── Scripts (in order). URL <script src defer> then inline <script>. ──
  scripts.forEach((entry, i) => {
    const label = entry.name || ('script ' + (i + 1));
    if (entry.url && entry.url.trim()) {
      const script = document.createElement('script');
      script.src = entry.url.trim();
      script.className = 'gobbonet-ext';
      script.setAttribute('data-ext-type', 'js-url');
      script.setAttribute('data-ext-name', label);
      script.defer = true;
      script.onerror = () => console.error('[ext] Failed to load script URL:', entry.url.trim());
      document.head.appendChild(script);
      console.log('[ext] Loading script URL:', entry.url.trim());
    }
    if (entry.raw && entry.raw.trim()) {
      const script = document.createElement('script');
      script.className = 'gobbonet-ext';
      script.setAttribute('data-ext-type', 'js-raw');
      script.setAttribute('data-ext-name', label);
      script.textContent = entry.raw;
      document.head.appendChild(script);
      console.log('[ext] Executed inline script (' + entry.raw.length + ' chars)');
    }
  });

  updateExtStatusDot();
}

/** Count of non-empty entries across both lists. */
function extEntryCount(ext) {
  if (!ext) return 0;
  const live = e => e && ((e.url && e.url.trim()) || (e.raw && e.raw.trim()));
  return (Array.isArray(ext.styles)  ? ext.styles.filter(live).length  : 0)
       + (Array.isArray(ext.scripts) ? ext.scripts.filter(live).length : 0);
}

/** Dot in the sidebar EXT button — green when extensions are active. */
function updateExtStatusDot() {
  const dot = document.getElementById('ext-status-dot');
  if (!dot) return;
  const active = state.extensions && state.extensions.enabled && extEntryCount(state.extensions) > 0;
  dot.textContent = active ? ' ●' : '';
  dot.style.color = 'var(--green-neon)';
}

// Working copy of the entry lists while the modal is open. Edits mutate the
// draft; SAVE commits it to state, CANCEL discards it.
let _extDraft = { styles: [], scripts: [] };

function openExtensions() {
  const ext = state.extensions || DEFAULT_EXTENSIONS;
  document.getElementById('ext-enabled').checked = !!ext.enabled;
  // Deep-clone entries into the draft so cancelling leaves state untouched.
  _extDraft = {
    styles:  (Array.isArray(ext.styles)  ? ext.styles  : []).map(e => ({ ...e })),
    scripts: (Array.isArray(ext.scripts) ? ext.scripts : []).map(e => ({ ...e }))
  };
  updateExtStatusLabel();
  renderExtEntries();
  renderExtStatusList();
  renderMacroList();
  document.getElementById('ext-modal').classList.add('open');
}

function closeExtensions() {
  document.getElementById('ext-modal').classList.remove('open');
}

function saveExtensions() {
  syncExtDraftFromDOM();
  const trim = e => ({
    id:   e.id || generateId(),
    name: (e.name || '').trim(),
    url:  (e.url || '').trim(),
    raw:  e.raw || ''
  });
  const live = e => e.url.trim() || e.raw.trim() || e.name;
  state.extensions = {
    enabled: document.getElementById('ext-enabled').checked,
    styles:  _extDraft.styles.map(trim).filter(live),
    scripts: _extDraft.scripts.map(trim).filter(live)
  };
  saveState();
  applyExtensions();
  closeExtensions();
}

function clearAllExtensions() {
  if (!confirm('Clear all extension data? This removes every stylesheet and script.')) return;
  state.extensions = { enabled: false, styles: [], scripts: [] };
  saveState();
  applyExtensions();
  openExtensions(); // re-open with cleared fields
}

/* ── Multi-entry list management (Stylesheets / Scripts) ── */

/** Read every entry's current field values out of the DOM into the draft. */
function syncExtDraftFromDOM() {
  ['styles', 'scripts'].forEach(kind => {
    const listEl = document.getElementById(kind === 'styles' ? 'ext-styles-list' : 'ext-scripts-list');
    if (!listEl) return;
    listEl.querySelectorAll('.ext-entry').forEach(card => {
      const id = card.getAttribute('data-ext-entry');
      const entry = _extDraft[kind].find(e => e.id === id);
      if (!entry) return;
      const nameEl = card.querySelector('.ext-entry-name');
      const urlEl  = card.querySelector('.ext-entry-url');
      const rawEl  = card.querySelector('.ext-entry-raw');
      if (nameEl) entry.name = nameEl.value;
      if (urlEl)  entry.url  = urlEl.value;
      if (rawEl)  entry.raw  = rawEl.value;
    });
  });
}

function addExtEntry(kind) {
  syncExtDraftFromDOM();
  _extDraft[kind].push({ id: generateId(), name: '', url: '', raw: '' });
  renderExtEntries();
}

function removeExtEntry(kind, id) {
  syncExtDraftFromDOM();
  _extDraft[kind] = _extDraft[kind].filter(e => e.id !== id);
  renderExtEntries();
}

/** In-place field update (used by file loader, which then re-renders). */
function updateExtEntry(kind, id, field, value) {
  const entry = _extDraft[kind].find(e => e.id === id);
  if (entry) entry[field] = value;
}

/** Load a .css/.js file into a specific entry's inline area. */
function handleExtFileEntry(fileInput, kind, id) {
  const file = fileInput.files[0];
  if (!file) return;
  syncExtDraftFromDOM();
  const reader = new FileReader();
  reader.onload = function(e) {
    const entry = _extDraft[kind].find(x => x.id === id);
    if (!entry) return;
    entry.raw = e.target.result;
    if (!entry.name || !entry.name.trim()) entry.name = file.name;
    renderExtEntries();
  };
  reader.readAsText(file);
}

/** Render both entry lists from the draft. */
function renderExtEntries() {
  renderExtEntryList('styles');
  renderExtEntryList('scripts');
}

function renderExtEntryList(kind) {
  const isStyle = kind === 'styles';
  const listEl = document.getElementById(isStyle ? 'ext-styles-list' : 'ext-scripts-list');
  if (!listEl) return;
  const entries = _extDraft[kind] || [];
  if (entries.length === 0) {
    listEl.innerHTML = `<div class="ext-entry-empty">// no ${isStyle ? 'stylesheets' : 'scripts'} yet — click "Add ${isStyle ? 'stylesheet' : 'script'}" below</div>`;
    return;
  }
  const urlPh = isStyle
    ? 'http://192.168.1.x:PORT/mytheme.css  or  https://...'
    : 'http://192.168.1.x:PORT/myextension.js';
  const rawPh = isStyle
    ? ':root { --magenta: #ff6600; }&#10;.message-user { background: rgba(255,100,0,0.08); }'
    : "// Full DOM + state access&#10;document.getElementById('send-btn').textContent = 'EXECUTE';";
  const accept = isStyle ? '.css,text/css' : '.js,text/javascript';
  const fileLabel = isStyle ? 'Load .css file...' : 'Load .js file...';
  const rows = isStyle ? 5 : 6;

  listEl.innerHTML = entries.map((e, i) => `
    <div class="ext-entry ${isStyle ? '' : 'ext-entry-script'}" data-ext-entry="${escapeHtml(e.id)}">
      <div class="ext-entry-head">
        <input type="text" class="ext-entry-name" placeholder="${isStyle ? 'Stylesheet' : 'Script'} ${i + 1} name (optional)" value="${escapeHtml(e.name || '')}">
        <button class="btn btn-sm btn-danger" onclick="removeExtEntry('${kind}','${escapeHtml(e.id)}')">Remove</button>
      </div>
      <input type="text" class="ext-entry-url" placeholder="${urlPh}" value="${escapeHtml(e.url || '')}">
      <textarea class="ext-code-area ext-entry-raw" rows="${rows}" placeholder="${rawPh}">${escapeHtml(e.raw || '')}</textarea>
      <div style="display:flex;gap:8px;margin-top:6px;align-items:center;">
        <label class="avatar-file-btn" style="margin:0;">
          ${fileLabel}
          <input type="file" accept="${accept}" style="display:none" onchange="handleExtFileEntry(this,'${kind}','${escapeHtml(e.id)}')">
        </label>
        <button class="btn btn-sm" onclick="updateExtEntry('${kind}','${escapeHtml(e.id)}','raw','');renderExtEntries()">Clear inline</button>
      </div>
    </div>
  `).join('');
}

