/* @gobbonet-split js/21-data.js
   Moved verbatim from chat.html lines 11703-11915.
   export / import / purge
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   DATA MANAGEMENT — Export / Import / Purge
   Threads and character cards can be exported individually or as
   part of a full backup. Import merges threads/cards by ID so
   existing data is preserved. Full backup replaces everything.
================================================================ */

/** Trigger a JSON file download. */
function downloadJSON(data, filename) {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

function exportData(type) {
  const ts = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  if (type === 'threads') {
    downloadJSON({ gobbonet_export: 'threads', version: 1, exported: Date.now(), threads: state.threads },
      `gobbonet-threads-${ts}.json`);
  } else if (type === 'cards') {
    downloadJSON({ gobbonet_export: 'cards', version: 1, exported: Date.now(), characterCards: state.characterCards },
      `gobbonet-characters-${ts}.json`);
  } else if (type === 'personas') {
    downloadJSON({ gobbonet_export: 'personas', version: 1, exported: Date.now(), personaCards: state.personaCards },
      `gobbonet-personas-${ts}.json`);
  } else if (type === 'all') {
    // Full state snapshot — strip nothing, keep it complete
    downloadJSON({
      gobbonet_export: 'full',
      version: 1,
      exported: Date.now(),
      threads: state.threads,
      activeThreadId: state.activeThreadId,
      settings: state.settings,
      characterCards: state.characterCards,
      activeCardId: state.activeCardId,
      personaCards: state.personaCards,
      activePersonaId: state.activePersonaId,
      schedules: state.schedules,
      folders: state.folders,
      extensions: state.extensions,
      searchEnabled: state.searchEnabled,
      macros: state.macros
    }, `gobbonet-backup-${ts}.json`);
  }
}

function importData(fileInput, type) {
  const file = fileInput.files[0];
  if (!file) return;
  const statusEl = document.getElementById('import-status');

  const showStatus = (msg, ok) => {
    statusEl.style.display = '';
    statusEl.textContent = msg;
    statusEl.className = 'data-import-status ' + (ok ? 'data-import-ok' : 'data-import-err');
    setTimeout(() => { statusEl.style.display = 'none'; }, 5000);
  };

  const reader = new FileReader();
  reader.onload = function(e) {
    let data;
    try {
      data = JSON.parse(e.target.result);
    } catch(err) {
      showStatus('✗ Invalid JSON file: ' + err.message, false);
      return;
    }

    if (!data.gobbonet_export) {
      showStatus('✗ Not a Gobbonet export file.', false);
      return;
    }

    if (type === 'threads') {
      if (!Array.isArray(data.threads)) { showStatus('✗ No threads array found.', false); return; }
      // Merge: add threads whose ID doesn't already exist
      const existingIds = new Set(state.threads.map(t => t.id));
      const newThreads = data.threads.filter(t => !existingIds.has(t.id));
      state.threads = [...state.threads, ...newThreads];
      saveState(); render();
      showStatus(`✓ Imported ${newThreads.length} thread(s). ${data.threads.length - newThreads.length} skipped (already exist).`, true);

    } else if (type === 'cards') {
      if (!Array.isArray(data.characterCards)) { showStatus('✗ No characterCards array found.', false); return; }
      // Merge: add cards whose ID doesn't already exist
      const existingIds = new Set(state.characterCards.map(c => c.id));
      const newCards = data.characterCards.filter(c => !existingIds.has(c.id));
      state.characterCards = [...state.characterCards, ...newCards];
      saveState(); render();
      showStatus(`✓ Imported ${newCards.length} character(s). ${data.characterCards.length - newCards.length} skipped (already exist).`, true);

    } else if (type === 'personas') {
      if (!Array.isArray(data.personaCards)) { showStatus('✗ No personaCards array found.', false); return; }
      const existingIds = new Set(state.personaCards.map(p => p.id));
      const newPersonas = data.personaCards
        .filter(p => !existingIds.has(p.id))
        // Patch incoming entries with any missing defaults so older exports
        // don't drop us into an editor with undefined fields.
        .map(p => ({ ...DEFAULT_PERSONA, ...p }));
      state.personaCards = [...state.personaCards, ...newPersonas];
      saveState(); render();
      showStatus(`✓ Imported ${newPersonas.length} persona(s). ${data.personaCards.length - newPersonas.length} skipped (already exist).`, true);

    } else if (type === 'all') {
      if (data.gobbonet_export !== 'full') {
        showStatus('✗ This file is not a full backup (use the specific import buttons for threads/characters/personas).', false);
        return;
      }
      if (!confirm('Full backup import will REPLACE all your current threads, characters, personas, settings, and schedules. Continue?')) return;
      state.threads        = data.threads        || [];
      state.activeThreadId = data.activeThreadId || null;
      state.settings       = { ...DEFAULT_SETTINGS, ...(data.settings || {}) };
      state.characterCards = data.characterCards || [{ ...DEFAULT_CARD }];
      state.activeCardId   = data.activeCardId   || 'default';
      // Personas: honor whatever's in the backup; if a pre-persona backup
      // is imported, run the same identity migration the loader uses so
      // the user's name/avatar/colors carry over instead of being lost.
      if (Array.isArray(data.personaCards) && data.personaCards.length > 0) {
        state.personaCards = data.personaCards.map(p => ({ ...DEFAULT_PERSONA, ...p }));
        state.activePersonaId = data.activePersonaId || state.personaCards[0].id;
      } else {
        const legacy = data.settings || {};
        const legacyName = legacy.userName;
        const personaName = (legacyName && legacyName !== 'Guest') ? legacyName : 'Anonymous';
        state.personaCards = [{
          ...DEFAULT_PERSONA,
          name: personaName,
          avatar: legacy.userAvatar || '',
          textColor: legacy.userTextColor || '',
          dialogColor: legacy.userDialogColor || ''
        }];
        state.activePersonaId = state.personaCards[0].id;
        // Strip the moved-out fields from the imported settings too.
        delete state.settings.userName;
        delete state.settings.userAvatar;
        delete state.settings.userTextColor;
        delete state.settings.userDialogColor;
      }
      state.schedules      = data.schedules      || [];
      state.folders        = data.folders        || [];
      state.extensions     = migrateExtensions(data.extensions);
      state.macros         = Array.isArray(data.macros) ? data.macros : DEFAULT_MACROS.map(m => ({ ...m }));
      state.searchEnabled  = data.searchEnabled  || false;
      saveState();
      applyExtensions();
      render();
      showStatus('✓ Full backup restored successfully.', true);
    }

    // Reset the file input so the same file can be re-imported if needed
    fileInput.value = '';
  };
  reader.readAsText(file);
}

function purgeData(type) {
  if (type === 'threads') {
    if (!confirm(`Delete ALL ${state.threads.length} thread(s)? This cannot be undone.`)) return;
    state.threads = [];
    state.activeThreadId = null;
    saveState(); render();
  } else if (type === 'cards') {
    if (!confirm('Reset all character cards to the built-in default? This cannot be undone.')) return;
    state.characterCards = [{ ...DEFAULT_CARD }];
    state.activeCardId = 'default';
    saveState(); render();
  } else if (type === 'personas') {
    if (!confirm('Reset all personas to the built-in Anonymous default? This cannot be undone.')) return;
    state.personaCards = [{ ...DEFAULT_PERSONA }];
    state.activePersonaId = 'default-persona';
    saveState(); render();
  } else if (type === 'all') {
    if (!confirm('PURGE ALL DATA? This will delete every thread, character, persona, schedule, folder, setting, and extension. Full factory reset. Cannot be undone.\n\nAre you absolutely sure?')) return;
    state.threads        = [];
    state.activeThreadId = null;
    state.settings       = { ...DEFAULT_SETTINGS };
    state.characterCards = [{ ...DEFAULT_CARD }];
    state.activeCardId   = 'default';
    state.personaCards   = [{ ...DEFAULT_PERSONA }];
    state.activePersonaId = 'default-persona';
    state.schedules      = [];
    state.folders        = [];
    state.extensions     = { ...DEFAULT_EXTENSIONS };
    state.searchEnabled  = false;
    saveState();
    applyExtensions();
    render();
    // Close modal after full purge so the user sees the clean state
    closeDataManager();
  }
}

/* ================================================================
   DATA MANAGER MODAL
================================================================ */
function openDataManager() {
  // Reset import status each time the modal opens
  const statusEl = document.getElementById('import-status');
  if (statusEl) statusEl.style.display = 'none';
  document.getElementById('data-modal').classList.add('open');
}

function closeDataManager() {
  document.getElementById('data-modal').classList.remove('open');
}

