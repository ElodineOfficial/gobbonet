/* @gobbonet-split js/17-personas.js
   Moved verbatim from chat.html lines 10516-10767.
   personas, {{char}} / {{user}} translation
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   PERSONAS — character cards for {{user}}
   Mirror of the character card system. Stores name/avatar/colors and
   a description that gets injected as a system message every N user
   messages (see buildContextMessages for the injection cadence).
================================================================ */
let editingPersonaId = null;

function renderPersonaGrid() {
  const grid = document.getElementById('persona-grid');
  if (!grid) return;
  if (!Array.isArray(state.personaCards) || state.personaCards.length === 0) {
    grid.innerHTML = '<div class="landing-empty" style="padding:10px 4px;">No personas yet. Click below to add one.</div>';
    return;
  }
  grid.innerHTML = state.personaCards.map(p => {
    const av = renderAvatar(p.avatar, p.name);
    const freq = (typeof p.injectionFrequency === 'number') ? p.injectionFrequency : 5;
    const freqLabel = freq === 0
      ? 'description silent'
      : freq === 1
        ? 'shared every turn'
        : `shared every ${freq} msgs`;
    const desc = (p.description || '').trim();
    const subline = desc
      ? `${escapeHtml(desc.slice(0, 50))}${desc.length > 50 ? '\u2026' : ''} \u00b7 ${freqLabel}`
      : freqLabel;
    return `
    <div class="card-item ${p.id === state.activePersonaId ? 'active' : ''}" onclick="activatePersona('${p.id}')">
      <div class="card-avatar">${av}</div>
      <div class="card-info">
        <div class="card-name">${escapeHtml(p.name || 'Unnamed')}</div>
        <div class="card-desc">${subline}</div>
      </div>
      <div class="card-actions">
        <button class="msg-action-btn btn-edit" onclick="event.stopPropagation();editPersona('${p.id}')">Edit</button>
        <button class="msg-action-btn" onclick="event.stopPropagation();copyPersona('${p.id}')" title="Duplicate this persona">Copy</button>
        ${state.personaCards.length > 1 ? `<button class="msg-action-btn btn-delete" onclick="event.stopPropagation();deletePersonaById('${p.id}')" title="Delete this persona">Del</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function activatePersona(id) {
  state.activePersonaId = id;
  saveState();
  renderPersonaGrid();
  renderMessages();
}

function createPersona() {
  const persona = {
    ...DEFAULT_PERSONA,
    id: generateId(),
    name: 'New Persona',
    description: '',
    injectionFrequency: 5
  };
  state.personaCards.push(persona);
  saveState();
  editPersona(persona.id);
}

function editPersona(id) {
  const persona = state.personaCards.find(p => p.id === id);
  if (!persona) return;
  editingPersonaId = id;
  document.getElementById('persona-name').value = persona.name || '';
  document.getElementById('persona-avatar').value = persona.avatar || '';
  document.getElementById('persona-description').value = persona.description || '';
  const freq = (typeof persona.injectionFrequency === 'number') ? persona.injectionFrequency : 5;
  document.getElementById('persona-frequency').value = freq;
  // Color pickers
  const ptc = persona.textColor || '#00b8ff';
  const pdc = persona.dialogColor || '#00f3ff';
  document.getElementById('persona-textcolor').value = ptc;
  document.getElementById('persona-textcolor-hex').value = ptc;
  document.getElementById('persona-dialogcolor').value = pdc;
  document.getElementById('persona-dialogcolor-hex').value = pdc;
  previewPersonaColors();
  // Reveal editor, hide list
  document.getElementById('char-modal-list').style.display = 'none';
  document.getElementById('persona-editor').style.display = '';
  document.getElementById('char-close-row').style.display = 'none';
  document.getElementById('persona-delete-btn').style.display = state.personaCards.length > 1 ? '' : 'none';
  previewAvatar('persona-avatar', 'persona-avatar-preview');
}

function savePersona() {
  const persona = state.personaCards.find(p => p.id === editingPersonaId);
  if (!persona) return;
  persona.name = document.getElementById('persona-name').value.trim() || 'Anonymous';
  persona.avatar = document.getElementById('persona-avatar').value.trim();
  persona.description = document.getElementById('persona-description').value;
  // Clamp frequency to a sane range. 0 disables injection but keeps identity.
  const rawFreq = parseInt(document.getElementById('persona-frequency').value, 10);
  persona.injectionFrequency = Number.isFinite(rawFreq) ? Math.max(0, Math.min(50, rawFreq)) : 5;
  persona.textColor = document.getElementById('persona-textcolor').value;
  persona.dialogColor = document.getElementById('persona-dialogcolor').value;
  editingPersonaId = null;
  saveState();
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function cancelPersonaEdit() {
  // Discard a freshly-created persona that the user backed out of without
  // touching anything — matches the same nicety we have for character cards.
  const persona = state.personaCards.find(p => p.id === editingPersonaId);
  if (persona && !persona.description && persona.name === 'New Persona') {
    state.personaCards = state.personaCards.filter(p => p.id !== editingPersonaId);
    saveState();
  }
  editingPersonaId = null;
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function deletePersona() {
  if (state.personaCards.length <= 1) return;
  state.personaCards = state.personaCards.filter(p => p.id !== editingPersonaId);
  if (state.activePersonaId === editingPersonaId) state.activePersonaId = state.personaCards[0].id;
  editingPersonaId = null;
  saveState();
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function copyPersona(id) {
  const src = state.personaCards.find(p => p.id === id);
  if (!src) return;
  const copy = { ...src, id: generateId(), name: src.name + ' (Copy)' };
  state.personaCards.push(copy);
  saveState();
  renderPersonaGrid();
}

function deletePersonaById(id) {
  if (state.personaCards.length <= 1) return;
  state.personaCards = state.personaCards.filter(p => p.id !== id);
  if (state.activePersonaId === id) state.activePersonaId = state.personaCards[0].id;
  saveState();
  renderPersonaGrid();
  renderMessages();
}

function pickCardBg(color) {
  // Legacy — no longer used
}

function previewBg() {
  const url = document.getElementById('card-bg').value.trim();
  const preview = document.getElementById('card-bg-preview');
  if (url) {
    preview.innerHTML = `<img src="${escapeHtml(url)}" alt="" style="width:100%;height:100%;object-fit:cover;">`;
  } else {
    preview.innerHTML = '--';
  }
}

function handleBgFile(fileInput) {
  const file = fileInput.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('card-bg').value = e.target.result;
    previewBg();
  };
  reader.readAsDataURL(file);
}

/* ================================================================
   TEMPLATE TRANSLATION — {{char}} and {{user}}
   Applied to all content sent to the API so character prompts
   can be written with universal placeholders.
   Pass charName/userName explicitly to avoid race conditions
   with async card switching.
================================================================ */
function getCurrentDateTimeString() {
  const now = new Date();
  return now.toLocaleString(undefined, {
    weekday: 'long', year: 'numeric', month: 'long', day: 'numeric',
    hour: '2-digit', minute: '2-digit', second: '2-digit'
  });
}

/**
 * Resolves all user-defined custom macros in text.
 * Called after the hardcoded macros so user macros can't shadow them.
 */
function resolveMacros(text) {
  if (!text || !state.macros || !state.macros.length) return text;
  for (const macro of state.macros) {
    // Escape any regex special chars in the trigger name (underscores are safe, but be defensive)
    const escaped = macro.trigger.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp('\\{\\{' + escaped + '\\}\\}', 'gi');
    text = text.replace(re, macro.text);
  }
  return text;
}

function translateTemplates(text, charName, userName, forDisplay) {
  if (!text) return text;
  charName = charName || (getActiveCard().name) || 'Assistant';
  userName = userName || getActivePersona().name || 'Anonymous';

  // Identity/time built-ins always resolve — the user wants to *see* the
  // real name and date filled in, in both the bubble and the model context.
  let out = text
    .replace(/\{\{char\}\}/gi, charName)
    .replace(/\{\{user\}\}/gi, userName)
    .replace(/\{\{current_DAT\}\}/gi, getCurrentDateTimeString());

  // Display mode: leave user-defined macros and {{auto_continue}} as their
  // short tag form. The user already knows what a macro expands to, so the
  // bubble stays compact instead of dumping the full long-form prompt. The
  // model still receives the full expansion (forDisplay is false on the
  // context-build path), so behavior is unchanged for the LLM.
  if (forDisplay) return out;

  // Model path: expand everything. {{auto_continue}}/{{auto_continue_N}} →
  // full chain prompt; then user-defined macros.
  return resolveMacros(
    out.replace(/\{\{auto_continue(?:_\d+)?\}\}/gi, AUTO_CONTINUE_TEXT)
  );
}

function applyActiveCardBackground() {
  const card = getActiveCard();
  const msgArea = document.getElementById('messages');
  if (!msgArea) return;
  if (card.background && (card.background.startsWith('http') || card.background.startsWith('data:') || card.background.startsWith('file:'))) {
    msgArea.style.backgroundImage = `url('${card.background}')`;
    msgArea.style.backgroundSize = 'cover';
    msgArea.style.backgroundPosition = 'center';
    msgArea.style.backgroundRepeat = 'no-repeat';
    msgArea.style.backgroundColor = 'var(--black)';
  } else {
    msgArea.style.backgroundImage = '';
    msgArea.style.backgroundColor = 'var(--black)';
  }
}

