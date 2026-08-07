/* @gobbonet-split js/20-macros.js
   Moved verbatim from chat.html lines 11555-11702.
   custom macros
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CUSTOM MACROS — CRUD
================================================================ */
let _editingMacroTrigger = null; // null = new macro, string = editing existing

function renderMacroList() {
  const list = document.getElementById('macro-list');
  if (!list) return;
  const macros = state.macros || [];
  if (macros.length === 0) {
    list.innerHTML = '<div class="ext-status-empty">// no custom macros — add one below</div>';
    return;
  }
  list.innerHTML = macros.map(m => `
    <div class="macro-row">
      <span class="macro-trigger">{{${escapeHtml(m.trigger)}}}</span>
      <span class="macro-preview">${escapeHtml(m.text.length > 64 ? m.text.slice(0, 61) + '...' : m.text)}</span>
      <div class="macro-actions">
        <button class="btn btn-sm" onclick="editMacro('${escapeHtml(m.trigger)}')">Edit</button>
        <button class="btn btn-sm btn-danger" onclick="deleteMacro('${escapeHtml(m.trigger)}')">Del</button>
      </div>
    </div>
  `).join('');
}

function showMacroEditor(triggerName) {
  _editingMacroTrigger = triggerName || null;
  const triggerInput = document.getElementById('macro-trigger');
  const textInput    = document.getElementById('macro-text');
  if (triggerName) {
    const m = (state.macros || []).find(x => x.trigger === triggerName);
    triggerInput.value    = m ? m.trigger : '';
    triggerInput.readOnly = true; // trigger is the key — rename = delete + add
    textInput.value       = m ? m.text : '';
  } else {
    triggerInput.value    = '';
    triggerInput.readOnly = false;
    textInput.value       = '';
  }
  document.getElementById('macro-editor').style.display = '';
  document.getElementById('macro-add-btn').style.display = 'none';
  triggerInput.focus();
}

function editMacro(trigger) {
  showMacroEditor(trigger);
}

function saveMacroEdit() {
  const trigger = document.getElementById('macro-trigger').value.trim();
  const text    = document.getElementById('macro-text').value.trim();

  if (!trigger) { alert('Trigger name cannot be empty.'); return; }
  if (!/^[a-zA-Z0-9_]+$/.test(trigger)) {
    alert('Trigger may only contain letters, numbers, and underscores.\nExample: fast_forward');
    return;
  }
  if (RESERVED_MACROS.has(trigger.toLowerCase())) {
    alert(`"{{${trigger}}}" is a built-in macro and cannot be overridden.`);
    return;
  }
  if (!text) { alert('Expansion text cannot be empty.'); return; }

  if (!state.macros) state.macros = [];

  if (_editingMacroTrigger) {
    // Update text of existing macro
    const m = state.macros.find(x => x.trigger === _editingMacroTrigger);
    if (m) m.text = text;
  } else {
    // New macro — guard against duplicate trigger names
    if (state.macros.find(x => x.trigger.toLowerCase() === trigger.toLowerCase())) {
      alert(`A macro named "{{${trigger}}}" already exists. Edit it to change its text.`);
      return;
    }
    state.macros.push({ trigger, text });
  }

  saveState();
  cancelMacroEdit();
  renderMacroList();
}

function cancelMacroEdit() {
  _editingMacroTrigger = null;
  document.getElementById('macro-editor').style.display = 'none';
  document.getElementById('macro-add-btn').style.display = '';
  document.getElementById('macro-trigger').readOnly = false;
}

function deleteMacro(trigger) {
  if (!confirm(`Delete macro {{${trigger}}}? This cannot be undone.`)) return;
  state.macros = (state.macros || []).filter(m => m.trigger !== trigger);
  saveState();
  renderMacroList();
}

function updateExtStatusLabel() {
  const enabled = document.getElementById('ext-enabled').checked;
  const label = document.getElementById('ext-toggle-label');
  if (label) label.textContent = enabled ? 'Enabled' : 'Disabled';
}

/** Preview all inline CSS from the draft stylesheets — live, without saving. */
function previewExtCSS() {
  syncExtDraftFromDOM();
  // Remove any existing preview tags
  document.querySelectorAll('.gobbonet-ext-preview').forEach(el => el.remove());
  const combined = (_extDraft.styles || [])
    .map(e => e.raw || '')
    .filter(s => s.trim())
    .join('\n\n');
  if (!combined.trim()) return;
  const style = document.createElement('style');
  style.className = 'gobbonet-ext-preview';
  style.textContent = combined;
  document.head.appendChild(style);
}

/** Build the "currently loaded extensions" status list in the modal */
function renderExtStatusList() {
  const list = document.getElementById('ext-status-list');
  if (!list) return;
  const loaded = document.querySelectorAll('.gobbonet-ext');
  if (loaded.length === 0) {
    list.innerHTML = '<div class="ext-status-empty">// no extensions currently applied</div>';
    return;
  }
  list.innerHTML = Array.from(loaded).map(el => {
    const type = el.getAttribute('data-ext-type') || el.tagName.toLowerCase();
    const name = el.getAttribute('data-ext-name') || '';
    const src = el.src || el.href || '(inline)';
    const len = el.textContent ? ` — ${el.textContent.length} chars` : '';
    const typeLabel = {
      'css-url': '&#127912; CSS URL',
      'css-raw': '&#127912; CSS inline',
      'js-url':  '&#9889; Script URL',
      'js-raw':  '&#9889; Script inline'
    }[type] || type;
    const srcText = src === '(inline)' ? '(inline)' + len : src;
    const label = name ? `${escapeHtml(name)} — ${escapeHtml(srcText)}` : escapeHtml(srcText);
    return `<div class="ext-status-item">
      <span class="ext-status-type">${typeLabel}</span>
      <span class="ext-status-src">${label}</span>
    </div>`;
  }).join('');
}

