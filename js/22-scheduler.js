/* @gobbonet-split js/22-scheduler.js
   Moved verbatim from chat.html lines 11916-12143.
   timed prompts
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SCHEDULER — send prompts at specific times
================================================================ */
let editingSchedId = null;

function openScheduler() {
  editingSchedId = null;
  document.getElementById('sched-editor').style.display = 'none';
  document.getElementById('sched-footer').style.display = '';
  renderSchedList();
  document.getElementById('sched-modal').classList.add('open');
}

function closeScheduler() {
  document.getElementById('sched-modal').classList.remove('open');
}

function renderSchedList() {
  const list = document.getElementById('sched-list');
  if (state.schedules.length === 0) {
    list.innerHTML = '<div style="text-align:center;color:var(--cyan-dim);padding:16px;font-size:13px;">No scheduled prompts.<br>Schedules run while the chat is open.</div>';
    return;
  }
  list.innerHTML = state.schedules.map(s => {
    const thread = state.threads.find(t => t.id === s.threadId);
    const threadName = thread ? escapeHtml(thread.name) : '(deleted thread)';
    const typeLabel = s.recurring === 'daily' ? 'DAILY' : 'ONCE';
    const searchLabel = s.useSearch ? ' 🔍' : '';
    return `
      <div class="card-item" onclick="editSchedItem('${s.id}')">
        <div class="card-info">
          <div class="card-name">${s.time} — ${typeLabel}${searchLabel}</div>
          <div class="card-desc">${escapeHtml(s.prompt.slice(0, 60))} → ${threadName}</div>
        </div>
        <div class="card-actions">
          <button class="msg-action-btn btn-edit" onclick="event.stopPropagation();editSchedItem('${s.id}')">Edit</button>
          <button class="msg-action-btn" onclick="event.stopPropagation();copySched('${s.id}')" title="Duplicate this schedule">Copy</button>
          <button class="msg-action-btn btn-delete" onclick="event.stopPropagation();deleteSched('${s.id}')">Del</button>
        </div>
      </div>`;
  }).join('');
}

function createSched() {
  editingSchedId = '__new__';
  document.getElementById('sched-time').value = '';
  document.getElementById('sched-prompt').value = '';
  document.getElementById('sched-recurring').value = 'once';
  document.getElementById('sched-search').value = 'off';

  // Populate thread dropdown
  const sel = document.getElementById('sched-thread');
  sel.innerHTML = state.threads.map(t =>
    `<option value="${t.id}" ${t.id === state.activeThreadId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  document.getElementById('sched-editor').style.display = '';
  document.getElementById('sched-footer').style.display = 'none';
}

function editSchedItem(id) {
  const s = state.schedules.find(x => x.id === id);
  if (!s) return;
  editingSchedId = id;
  document.getElementById('sched-time').value = s.time;
  document.getElementById('sched-prompt').value = s.prompt;
  document.getElementById('sched-recurring').value = s.recurring || 'once';
  document.getElementById('sched-search').value = s.useSearch ? 'on' : 'off';

  const sel = document.getElementById('sched-thread');
  sel.innerHTML = state.threads.map(t =>
    `<option value="${t.id}" ${t.id === s.threadId ? 'selected' : ''}>${escapeHtml(t.name)}</option>`
  ).join('');

  document.getElementById('sched-editor').style.display = '';
  document.getElementById('sched-footer').style.display = 'none';
}

function saveSched() {
  const time = document.getElementById('sched-time').value;
  const prompt = document.getElementById('sched-prompt').value.trim();
  const threadId = document.getElementById('sched-thread').value;
  const recurring = document.getElementById('sched-recurring').value;
  const useSearch = document.getElementById('sched-search').value === 'on';

  if (!time || !prompt || !threadId) return;

  if (editingSchedId === '__new__') {
    state.schedules.push({
      id: generateId(),
      time,
      prompt,
      threadId,
      recurring,
      useSearch,
      lastFired: null
    });
  } else {
    const s = state.schedules.find(x => x.id === editingSchedId);
    if (s) {
      s.time = time;
      s.prompt = prompt;
      s.threadId = threadId;
      s.recurring = recurring;
      s.useSearch = useSearch;
    }
  }

  editingSchedId = null;
  saveState();
  document.getElementById('sched-editor').style.display = 'none';
  document.getElementById('sched-footer').style.display = '';
  renderSchedList();
  updateSchedCount();
}

function cancelSchedEdit() {
  editingSchedId = null;
  document.getElementById('sched-editor').style.display = 'none';
  document.getElementById('sched-footer').style.display = '';
}

function deleteSched(id) {
  state.schedules = state.schedules.filter(s => s.id !== id);
  saveState();
  renderSchedList();
  updateSchedCount();
}

function copySched(id) {
  const src = state.schedules.find(s => s.id === id);
  if (!src) return;
  const copy = { ...src, id: generateId(), lastFired: null };
  state.schedules.push(copy);
  saveState();
  renderSchedList();
  updateSchedCount();
}

function updateSchedCount() {
  const el = document.getElementById('sched-count');
  if (el) el.textContent = state.schedules.length > 0 ? `(${state.schedules.length})` : '';
}

// Timer: checks every 30s if any schedule is due
function checkSchedules() {
  if (isGenerating || !serverConnected) return;

  const now = new Date();
  const currentTime = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
  const today = now.toDateString();

  for (const s of state.schedules) {
    if (s.time !== currentTime) continue;
    if (s.lastFired === today) continue;

    // Time match and hasn't fired today — execute
    const thread = state.threads.find(t => t.id === s.threadId);
    if (!thread) continue;

    s.lastFired = today;

    // Switch to the target thread
    state.activeThreadId = s.threadId;

    // Inject the prompt as a user message
    thread.messages.push({ role: 'user', content: s.prompt, timestamp: Date.now(), scheduled: true });

    // Auto-name if first message
    if (thread.messages.length === 1) {
      thread.name = s.prompt.slice(0, 50) + (s.prompt.length > 50 ? '...' : '');
    }

    saveState();
    render();
    scrollToBottom();

    // Send to AI (with optional search)
    const schedRef = s;
    (async () => {
      await regenerateFromThread({ withSearch: schedRef.useSearch });
      // Remove one-time schedules after firing
      if (schedRef.recurring !== 'daily') {
        state.schedules = state.schedules.filter(x => x.id !== schedRef.id);
        saveState();
        updateSchedCount();
      }
    })();

    break; // Only fire one per check cycle
  }
}

// Close modals
// Close popover on outside click
document.addEventListener('click', e => {
  if (_popover && !_popover.contains(e.target)) closePopover();
});

document.getElementById('settings-modal').addEventListener('click', (e) => {
  if (e.target.id === 'settings-modal') closeSettings();
});
document.getElementById('char-modal').addEventListener('click', (e) => {
  if (e.target.id === 'char-modal') closeCharacters();
});
document.getElementById('sched-modal').addEventListener('click', (e) => {
  if (e.target.id === 'sched-modal') closeScheduler();
});
document.getElementById('ext-modal').addEventListener('click', (e) => {
  if (e.target.id === 'ext-modal') closeExtensions();
});
document.getElementById('data-modal').addEventListener('click', (e) => {
  if (e.target.id === 'data-modal') closeDataManager();
});
document.getElementById('about-modal').addEventListener('click', (e) => {
  if (e.target.id === 'about-modal') closeAbout();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { closeSettings(); closeCharacters(); closeScheduler(); closeExtensions(); closeDataManager(); closeAbout(); }
});

function openAbout() {
  document.getElementById('about-modal').classList.add('open');
}
function closeAbout() {
  document.getElementById('about-modal').classList.remove('open');
}

