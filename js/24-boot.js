/* @gobbonet-split js/24-boot.js
   Moved verbatim from chat.html lines 12144-12289.
   boot, page lifecycle, all addEventListener wiring
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   BOOT
================================================================ */
// Storage is now async (IndexedDB), so everything that reads `state` for the
// first paint must wait until the backend is opened, migrated if needed, and
// `state` is populated. The whole boot tail therefore lives inside this awaited
// IIFE. The landing markup stays on screen until render() runs — the IDB open
// + read is fast but not zero.
(async function boot() {
  await loadState();

  // Check if the server has newer state than our local copy (handles the
  // LAN-IP-rotated case where each origin has its own localStorage / IDB).
  // Fire-and-forget; on conflict it'll prompt the user.
  // Sequenced: if the conflict check decides to restore, it reloads the page
  // and this boot (including the resume pass) reruns against the restored
  // state. Otherwise resume follows any pendingJob breadcrumbs — finished
  // replies get folded in silently, a still-running one re-attaches live.
  // Only after that first pass settles do wake-driven resumes arm
  // (_appBooted gates handleAppWake — see the page-lifecycle block).
  checkServerStateOnBoot().catch(() => {})
    .then(() => resumePendingJobs()).catch(() => {})
    .then(() => { _appBooted = true; });
  loadActiveModel().then(loadModelsList); // fetch model info + populate header dropdown

  // Always open on the landing page — threads are accessible from the sidebar.
  // This fixes mobile "no input visible" on first load and gives the dashboard
  // a consistent entry point. The active thread is preserved in state for quick
  // return but we don't auto-resume it on load.
  state.activeThreadId = null;
  // On mobile, always start with sidebar closed.
  if (window.innerWidth <= 700) {
    state.sidebarOpen = false;
  }
  searchEnabled = state.searchEnabled || false;
  document.getElementById('search-toggle').classList.toggle('active', searchEnabled);
  setupInput();
  applyExtensions(); // Apply any saved CSS/JS extensions
  // Load the active character's own code, if it has any and it is
  // switched on. Must come after state is restored and before render.
  try { applyCardCode(); } catch (e) { console.error('[card-code] boot:', e); }
  applyAvatarScale(); // restore saved avatar size preference

  // Load default characters from JSON, then render the landing page.
  // fetch() works when served via launch.bat; fails silently on file:// (no CORS).
  let chars = [];
  try {
    const r = await fetch('default-characters.json');
    if (r.ok) chars = await r.json();
  } catch (_) { /* file:// or missing file — render with whatever defaults exist */ }
  if (Array.isArray(chars)) defaultCharacters = chars;
  render();

  scrollToBottom();
  attachScrollPinTracking();
  applyActiveCardBackground();
  updateSchedCount();
  checkConnection().then(() => {
    // Re-render landing page after connection check so status pill updates.
    const title = document.getElementById('thread-title');
    if (title.textContent === 'GOBBONET') render();
  });
  setInterval(() => {
    checkConnection().then(() => {
      const title = document.getElementById('thread-title');
      if (title.textContent === 'GOBBONET') render();
    });
  }, 5000);
  // Scheduler timer — checks every 30 seconds
  setInterval(checkSchedules, 30000);
})();

/* ================================================================
   PAGE-LIFECYCLE PERSISTENCE

   Historical context: these handlers were born when the browser owned
   the streaming fetch, so a hidden/torn-down page could genuinely LOSE
   the in-flight reply (on mobile the socket died within seconds).

   With detached generation jobs, the server-side spool is the source
   of truth and resume replays it verbatim — navigation no longer
   threatens the reply. The handlers stay for three cheaper reasons:
   the legacy direct-stream path (file://, old fileserver) still needs
   them, the pendingJob breadcrumb should hit disk before teardown, and
   a flushed partial keeps sidebar previews honest while away.

   visibilitychange→hidden: fires on every tab/app switch, the earliest
   reliable "user left" signal on mobile. Local save only (no beacon), and
   only while generating — when idle, localStorage is already current (every
   state mutation saves), so the only thing that can be lost is in-flight
   streaming progress. Skipping the idle case avoids re-serializing a
   multi-MB blob on every routine tab toggle.

   pagehide: fires on real navigation, tab close, and bfcache entry. Local
   save AND a sendBeacon to /state when the state is settled, so a completed
   turn reaches the server backup even if the user navigates inside the
   debounce window. (beforeunload/unload are deliberately not used — they're
   unreliable on mobile and disqualify the page from bfcache.)

   ---- The return trip (handleAppWake) ----
   The handlers above cover leaving; these cover coming BACK — the half
   that used to be missing. Four signals, one handler:
     visibilitychange→visible / pageshow / focus — the user returned
       (app switch back, bfcache restore, window refocus);
     online — connectivity returned while the page was up.
   On any of them: parked poll sleeps resolve immediately (an attached
   generation catches up NOW instead of whenever the throttled timer
   lands), the header status dot refreshes (its 5s interval was throttled
   while hidden), and — when idle — resumePendingJobs() re-follows any
   breadcrumbs. That last one is the real win: it revives generations
   whose poll loop gave up as 'unreachable' during a Wi-Fi blip or server
   restart (previously dead until a manual reload), and it folds in
   replies that finished while away in OTHER threads after a bfcache
   restore, where no boot pass runs.
   Guards: _appBooted (the boot pass owns the first resume — resuming
   against a state blob checkServerStateOnBoot may be about to replace
   would stream into thread objects about to be swapped out), a 1s
   cooldown (the signals burst together on return), and never while a
   generation is attached (a resume pass sets currentJob; clobbering the
   live one would point the Stop button at the wrong job).
================================================================ */
let _lastWakeResumeAt = 0;

function handleAppWake(reason) {
  // Always: unpark the poll loop. Cheap, idempotent, and exactly what a
  // reconnect needs — the next poll (or failure retry) fires immediately.
  wakePendingPolls();
  if (!_appBooted) return;
  // 'online' can fire while the page is hidden — resuming into a background
  // tab wastes radio and races the eventual visible-wake; polls are enough.
  if (document.visibilityState === 'hidden') return;
  const now = Date.now();
  if (now - _lastWakeResumeAt < 1000) return;   // pageshow + visibility + focus arrive together
  _lastWakeResumeAt = now;
  try { checkConnection().catch(() => {}); } catch (_) {}
  if (!isGenerating) {
    console.log(`[wake] app returned (${reason}) — re-checking pending generations`);
    resumePendingJobs();
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden' && isGenerating) flushBeforeExit({ beacon: false });
  if (document.visibilityState === 'visible') handleAppWake('visibility');
});
window.addEventListener('pagehide', () => flushBeforeExit({ beacon: true }));
window.addEventListener('pageshow', (e) => handleAppWake(e && e.persisted ? 'bfcache' : 'pageshow'));
window.addEventListener('focus', () => handleAppWake('focus'));
window.addEventListener('online', () => handleAppWake('online'));
