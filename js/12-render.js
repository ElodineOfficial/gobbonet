/* @gobbonet-split js/12-render.js
   Moved verbatim from chat.html lines 8066-8534.
   render entry, folders/tags/pins, sidebar, drag and drop
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   RENDERING
================================================================ */
function render() {
  renderSidebar();
  renderMessages();
  updateSidebarVisibility();
  updateInputState();
  updateContextInfo();
  updatePrivacyBadge();
  updateLoreChip();
}

function updatePrivacyBadge() {
  const badge = document.getElementById('privacy-badge');
  if (!badge) return;
  badge.style.display = '';
  badge.title = 'llama.cpp — fully offline, zero telemetry';
}

/* ================================================================
   FOLDER / TAG / PIN HELPERS
================================================================ */
const TAG_PALETTE = ['#00ff73','#00b8ff','#d900ff','#ff4d6d','#fbbf24','#a78bfa','#34d399','#f97316'];
function getTagColor(name) {
  let h = 5381;
  for (let i = 0; i < name.length; i++) h = ((h << 5) + h) ^ name.charCodeAt(i);
  return TAG_PALETTE[Math.abs(h) % TAG_PALETTE.length];
}

/* ── Floating popover ──────────────────────────────────────────── */
let _popover = null;
function openPopover(anchorEl, html) {
  closePopover();
  const rect = anchorEl.getBoundingClientRect();
  const d = document.createElement('div');
  d.className = 'sidebar-popover';
  d.innerHTML = html;
  d.style.top  = (rect.bottom + 4) + 'px';
  d.style.left = rect.left + 'px';
  document.body.appendChild(d);
  _popover = d;
  requestAnimationFrame(() => {
    const pr = d.getBoundingClientRect();
    if (pr.right > window.innerWidth - 8)
      d.style.left = Math.max(8, window.innerWidth - pr.width - 8) + 'px';
    if (pr.bottom > window.innerHeight - 8)
      d.style.top  = Math.max(8, rect.top - pr.height - 4) + 'px';
  });
}
function closePopover() {
  if (_popover) { _popover.remove(); _popover = null; }
}

/* ── Folder management ─────────────────────────────────────────── */
function createFolder(name) {
  const folder = { id: generateId(), name: (name || 'New Folder').trim(), collapsed: false };
  state.folders.push(folder);
  saveState(); renderSidebar();
  return folder;
}

function deleteFolder(id, event) {
  if (event) event.stopPropagation();
  for (const t of state.threads) { if (t.folderId === id) t.folderId = null; }
  state.folders = state.folders.filter(f => f.id !== id);
  saveState(); renderSidebar();
}

function toggleFolderCollapse(id) {
  const f = state.folders.find(f => f.id === id);
  if (f) f.collapsed = !f.collapsed;
  saveState(); renderSidebar();
}

function startFolderRename(id, event) {
  event.stopPropagation(); closePopover();
  const el = document.querySelector(`[data-folder-id="${id}"] .folder-name-text`);
  const folder = state.folders.find(f => f.id === id);
  if (!el || !folder) return;
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input';
  input.value = folder.name;
  input.addEventListener('blur', () => finishFolderRename(id, input.value));
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = folder.name; input.blur(); }
    e.stopPropagation();
  });
  el.replaceWith(input);
  input.focus(); input.select();
}

function finishFolderRename(id, newName) {
  const folder = state.folders.find(f => f.id === id);
  if (folder && newName.trim()) folder.name = newName.trim();
  saveState(); renderSidebar();
}

function startNewFolder() {
  const list = document.getElementById('thread-list');
  const existing = list.querySelector('.new-folder-input');
  if (existing) { existing.focus(); return; }
  const wrap = document.createElement('div');
  wrap.className = 'new-folder-input-wrap';
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'rename-input new-folder-input';
  input.placeholder = 'Folder name...';
  wrap.appendChild(input);
  const btn = list.querySelector('.new-folder-btn');
  if (btn) list.insertBefore(wrap, btn);
  else list.appendChild(wrap);
  input.focus();
  input.addEventListener('blur', () => {
    const name = input.value.trim();
    if (name) createFolder(name); else renderSidebar();
  });
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = ''; input.blur(); }
    e.stopPropagation();
  });
}

/* ── Pin ───────────────────────────────────────────────────────── */
function togglePin(threadId, event) {
  event.stopPropagation(); closePopover();
  const t = state.threads.find(t => t.id === threadId);
  if (t) { t.pinned = !t.pinned; saveState(); renderSidebar(); }
}

/* ── Move to folder ────────────────────────────────────────────── */
function openFolderPicker(threadId, event) {
  event.stopPropagation();
  const t = state.threads.find(t => t.id === threadId);
  if (!t) return;
  const mkItem = (id, name, active) =>
    `<button class="pop-item${active?' pop-item-active':''}" onclick="moveThread('${threadId}','${id}')">&#128193; ${escapeHtml(name)}</button>`;
  let items = mkItem('__none__', 'No folder', !t.folderId);
  if (state.folders.length === 0)
    items += `<div class="pop-hint">No folders yet — click + FOLDER</div>`;
  else
    items += state.folders.map(f => mkItem(f.id, f.name, t.folderId === f.id)).join('');
  openPopover(event.currentTarget, `<div class="pop-list">${items}</div>`);
}

function moveThread(threadId, folderId) {
  const t = state.threads.find(t => t.id === threadId);
  if (!t) return;
  t.folderId = folderId === '__none__' ? null : folderId;
  saveState(); closePopover(); renderSidebar();
}

/* ── Tags ──────────────────────────────────────────────────────── */
function openTagEditor(threadId, event) {
  event.stopPropagation();
  const t = state.threads.find(t => t.id === threadId);
  if (!t) return;
  if (!t.tags) t.tags = [];
  const allTags = [...new Set(state.threads.flatMap(th => th.tags || []))];
  const suggestions = allTags.filter(tag => !t.tags.includes(tag));

  const currentHtml = t.tags.length > 0
    ? t.tags.map(tag =>
        `<span class="tag-pill pop-tag" style="--tc:${getTagColor(tag)}" onclick="removeTag('${threadId}','${tag}')">${escapeHtml(tag)} <span class="tag-x">×</span></span>`
      ).join('')
    : `<span class="pop-empty">none yet</span>`;

  const suggestHtml = suggestions.length > 0
    ? `<div class="pop-label">SUGGESTIONS</div><div class="pop-tags-row">${
        suggestions.map(tag =>
          `<span class="tag-pill pop-tag-sug" style="--tc:${getTagColor(tag)}" onclick="addTag('${threadId}','${tag}')">${escapeHtml(tag)}</span>`
        ).join('')
      }</div>`
    : '';

  openPopover(event.currentTarget, `
    <div class="pop-tag-editor">
      <div class="pop-label">TAGS &mdash; click to remove</div>
      <div class="pop-tags-row" id="pop-cur-tags">${currentHtml}</div>
      ${suggestHtml}
      <div class="pop-add-row">
        <input class="pop-tag-input" id="pop-tag-input" placeholder="new tag..." maxlength="24"
               onkeydown="handleTagKey('${threadId}',event)" autocomplete="off">
        <button class="pop-add-btn" onclick="addTagFromInput('${threadId}')">+</button>
      </div>
      <div class="pop-hint">Enter to add &nbsp;&middot;&nbsp; type #tag in search to filter</div>
    </div>`);
  document.getElementById('pop-tag-input')?.focus();
}

function handleTagKey(threadId, event) {
  if (event.key === 'Enter') addTagFromInput(threadId);
  if (event.key === 'Escape') closePopover();
  event.stopPropagation();
}

function addTagFromInput(threadId) {
  const input = document.getElementById('pop-tag-input');
  if (!input) return;
  const raw = input.value.trim().toLowerCase().replace(/[^a-z0-9_\-]/g, '').slice(0, 24);
  if (raw) addTag(threadId, raw);
}

function addTag(threadId, tag) {
  const t = state.threads.find(t => t.id === threadId);
  if (!t) return;
  if (!t.tags) t.tags = [];
  if (!t.tags.includes(tag)) t.tags.push(tag);
  saveState(); renderSidebar();
  const btn = document.querySelector(`[data-thread-id="${threadId}"] .thread-tag-btn`);
  if (btn) openTagEditor(threadId, { stopPropagation: ()=>{}, currentTarget: btn });
}

function removeTag(threadId, tag) {
  const t = state.threads.find(t => t.id === threadId);
  if (!t || !t.tags) return;
  t.tags = t.tags.filter(tg => tg !== tag);
  saveState(); renderSidebar();
  const btn = document.querySelector(`[data-thread-id="${threadId}"] .thread-tag-btn`);
  if (btn) openTagEditor(threadId, { stopPropagation: ()=>{}, currentTarget: btn });
}

/* ================================================================
   SIDEBAR RENDERING
================================================================ */
function renderThreadItem(t) {
  const isActive = t.id === state.activeThreadId;
  const tagPills = (t.tags && t.tags.length > 0)
    ? `<div class="thread-tags-row">${t.tags.map(tag =>
        `<span class="tag-pill" style="--tc:${getTagColor(tag)}">${escapeHtml(tag)}</span>`
      ).join('')}</div>`
    : '';
  // Pin badge: visible at rest, hidden when controls appear on hover
  const pinBadge = t.pinned ? `<span class="thread-pin-badge" title="Pinned">&#128204;</span>` : '';
  // Branch badge
  const branchBadge = t.forkSource ? `<span class="thread-branch-badge" title="Branched conversation">⑂</span>` : '';
  // Detached-generation badge: this thread has a reply cooking on the server
  // (visible even if it was started before a page reload — that's the point).
  const genBadge = t.pendingJob ? `<span class="thread-gen-badge" title="Reply generating in the background">●</span>` : '';
  // Fork count badge (how many branches off THIS thread)
  const forkCount = getAllForksOf(t.id).length;
  const forkBadge = forkCount > 0 ? `<span class="thread-fork-count" title="${forkCount} branch${forkCount > 1 ? 'es' : ''}">⑂${forkCount}</span>` : '';
  return `<div class="thread-item${isActive?' active':''}${t.pinned?' thread-pinned':''}"
       data-thread-id="${t.id}"
       draggable="true"
       onclick="switchThread('${t.id}')"
       ondragstart="onThreadDragStart('${t.id}',event)"
       ondragover="onThreadDragOver('${t.id}',event)"
       ondragleave="onThreadDragLeave('${t.id}',event)"
       ondrop="onThreadDrop('${t.id}',event)"
       ondragend="onThreadDragEnd(event)">
    <div class="thread-body">
      <div class="thread-name-row">
        <span class="thread-name" title="${escapeHtml(t.name)}">${escapeHtml(t.name)}</span>
        ${genBadge}${pinBadge}${branchBadge}${forkBadge}
      </div>
      ${tagPills}
    </div>
    <div class="thread-ctrl">
      <button class="thread-ctrl-btn thread-pin-btn${t.pinned?' is-pinned':''}" onclick="togglePin('${t.id}',event)" title="${t.pinned?'Unpin':'Pin'}">&#128204;</button>
      <button class="thread-ctrl-btn thread-folder-btn" onclick="openFolderPicker('${t.id}',event)" title="Move to folder">&#128193;</button>
      <button class="thread-ctrl-btn thread-tag-btn" onclick="openTagEditor('${t.id}',event)" title="Tags">&#127991;</button>
      <button class="thread-ctrl-btn thread-edit-btn" onclick="startRename('${t.id}',event)" title="Rename">&#9998;</button>
      <button class="thread-ctrl-btn thread-del-btn" onclick="deleteThread('${t.id}',event)" title="Delete">&times;</button>
    </div>
  </div>`;
}

function renderSidebar() {
  const list = document.getElementById('thread-list');
  const searchInput = document.getElementById('thread-search');
  const query = searchInput ? searchInput.value.trim().toLowerCase() : '';

  const isTagFilter = query.startsWith('#');
  const tagQ = isTagFilter ? query.slice(1) : '';

  const matches = t => {
    if (!query) return true;
    if (isTagFilter) return (t.tags || []).some(tag => tag.includes(tagQ));
    return t.name.toLowerCase().includes(query);
  };

  const pinned  = state.threads.filter(t =>  t.pinned && matches(t));
  const unfiled = state.threads.filter(t => !t.pinned && !t.folderId && matches(t));

  let html = '';

  // ── Pinned section ──────────────────────────────────────────────
  if (pinned.length > 0) {
    html += `<div class="folder-section">
      <div class="folder-hdr pinned-hdr"><span>&#128204; PINNED</span></div>
      <div class="folder-threads">${pinned.map(renderThreadItem).join('')}</div>
    </div>`;
  }

  // ── Folders ─────────────────────────────────────────────────────
  for (const folder of state.folders) {
    const fThreads = state.threads.filter(t => t.folderId === folder.id && !t.pinned && matches(t));
    const totalInFolder = state.threads.filter(t => t.folderId === folder.id).length;
    if (query && fThreads.length === 0) continue;
    const isOpen = !folder.collapsed || !!query;
    html += `<div class="folder-section${folder.collapsed&&!query?' folder-collapsed':''}" data-folder-id="${folder.id}">
      <div class="folder-hdr" onclick="toggleFolderCollapse('${folder.id}')" ondragover="onFolderDragOver('${folder.id}',event)" ondragleave="onFolderDragLeave(event)" ondrop="onFolderDrop('${folder.id}',event)">
        <span class="folder-chevron">${isOpen?'&#9660;':'&#9658;'}</span>
        <span class="folder-icon">&#128193;</span>
        <span class="folder-name-text">${escapeHtml(folder.name)}</span>
        <span class="folder-count">${totalInFolder}</span>
        <div class="folder-hdr-btns">
          <button class="folder-btn" onclick="startFolderRename('${folder.id}',event)" title="Rename">&#9998;</button>
          <button class="folder-btn folder-del" onclick="deleteFolder('${folder.id}',event)" title="Delete">&times;</button>
        </div>
      </div>
      ${isOpen ? `<div class="folder-threads">${fThreads.length > 0 ? fThreads.map(renderThreadItem).join('') : '<div class="folder-empty">// empty</div>'}</div>` : ''}
    </div>`;
  }

  // ── Unfiled ──────────────────────────────────────────────────────
  if (state.threads.length === 0) {
    html += '<div class="empty-threads">No threads yet.<br>Click "+ NEW_THREAD" to start.</div>';
  } else if (unfiled.length > 0) {
    if (state.folders.length > 0 && !query)
      html += `<div class="unfiled-label" ondragover="onUnfiledDragOver(event)" ondragleave="onUnfiledDragLeave(event)" ondrop="onUnfiledDrop(event)">// UNFILED</div>`;
    html += `<div class="folder-threads">${unfiled.map(renderThreadItem).join('')}</div>`;
  }

  // ── No results message ───────────────────────────────────────────
  const totalVisible = pinned.length + unfiled.length +
    state.folders.reduce((s, f) =>
      s + state.threads.filter(t => t.folderId === f.id && !t.pinned && matches(t)).length, 0);
  if (query && totalVisible === 0 && state.threads.length > 0) {
    html += `<div class="empty-threads">No threads match<br>"${escapeHtml(query)}"</div>`;
  }

  // ── New folder button ────────────────────────────────────────────
  html += `<button class="new-folder-btn" onclick="startNewFolder()">+ FOLDER</button>`;

  list.innerHTML = html;
}

function filterThreads() {
  const input = document.getElementById('thread-search');
  const clearBtn = document.getElementById('thread-search-clear');
  if (clearBtn) clearBtn.style.display = input.value ? '' : 'none';
  renderSidebar();
}

function clearThreadSearch() {
  const input = document.getElementById('thread-search');
  const clearBtn = document.getElementById('thread-search-clear');
  if (input) input.value = '';
  if (clearBtn) clearBtn.style.display = 'none';
  renderSidebar();
  if (input) input.focus();
}
/* ================================================================
   DRAG AND DROP — thread reordering & folder assignment
================================================================ */
let _dragThreadId = null;

function onThreadDragStart(threadId, event) {
  _dragThreadId = threadId;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData('text/plain', threadId);
  // Delay adding class so the drag image captures the normal look
  requestAnimationFrame(() => {
    const el = document.querySelector(`[data-thread-id="${threadId}"]`);
    if (el) el.classList.add('dragging');
  });
}

function onThreadDragOver(threadId, event) {
  if (!_dragThreadId || _dragThreadId === threadId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  // Clear all existing indicators
  document.querySelectorAll('.drag-over-before,.drag-over-after')
    .forEach(el => el.classList.remove('drag-over-before','drag-over-after'));
  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  el.classList.add(event.clientY < rect.top + rect.height / 2 ? 'drag-over-before' : 'drag-over-after');
}

function onThreadDragLeave(threadId, event) {
  if (!event.currentTarget.contains(event.relatedTarget))
    event.currentTarget.classList.remove('drag-over-before','drag-over-after');
}

function onThreadDrop(threadId, event) {
  event.preventDefault();
  if (!_dragThreadId || _dragThreadId === threadId) return;

  const el = event.currentTarget;
  const rect = el.getBoundingClientRect();
  const pos = event.clientY < rect.top + rect.height / 2 ? 'before' : 'after';

  const fromIdx = state.threads.findIndex(t => t.id === _dragThreadId);
  const toIdx   = state.threads.findIndex(t => t.id === threadId);
  if (fromIdx === -1 || toIdx === -1) return;

  const [moved] = state.threads.splice(fromIdx, 1);
  // After removal, adjust target index if it was after the removed item
  let insertIdx = fromIdx < toIdx ? toIdx - 1 : toIdx;
  if (pos === 'after') insertIdx++;
  insertIdx = Math.max(0, Math.min(insertIdx, state.threads.length));
  state.threads.splice(insertIdx, 0, moved);

  // Inherit the dropped-onto thread's folder so the move feels natural
  const targetThread = state.threads.find(t => t.id === threadId);
  if (targetThread) moved.folderId = targetThread.folderId;

  saveState(); renderSidebar();
  _dragThreadId = null;
}

function onThreadDragEnd(event) {
  _dragThreadId = null;
  document.querySelectorAll('.dragging,.drag-over-before,.drag-over-after')
    .forEach(el => el.classList.remove('dragging','drag-over-before','drag-over-after'));
  document.querySelectorAll('.drag-folder-over')
    .forEach(el => el.classList.remove('drag-folder-over'));
}

function onFolderDragOver(folderId, event) {
  if (!_dragThreadId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  document.querySelectorAll('.drag-folder-over').forEach(el => el.classList.remove('drag-folder-over'));
  document.querySelectorAll('.drag-over-before,.drag-over-after')
    .forEach(el => el.classList.remove('drag-over-before','drag-over-after'));
  event.currentTarget.classList.add('drag-folder-over');
}

function onFolderDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget))
    event.currentTarget.classList.remove('drag-folder-over');
}

function onFolderDrop(folderId, event) {
  event.preventDefault();
  if (!_dragThreadId) return;
  const t = state.threads.find(t => t.id === _dragThreadId);
  if (t) { t.folderId = folderId; saveState(); renderSidebar(); }
  _dragThreadId = null;
}

function onUnfiledDragOver(event) {
  if (!_dragThreadId) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
  event.currentTarget.classList.add('drag-folder-over');
}

function onUnfiledDragLeave(event) {
  if (!event.currentTarget.contains(event.relatedTarget))
    event.currentTarget.classList.remove('drag-folder-over');
}

function onUnfiledDrop(event) {
  event.preventDefault();
  if (!_dragThreadId) return;
  const t = state.threads.find(t => t.id === _dragThreadId);
  if (t) { t.folderId = null; saveState(); renderSidebar(); }
  _dragThreadId = null;
}



