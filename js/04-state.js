/* @gobbonet-split js/04-state.js
   Moved verbatim from chat.html lines 3135-3352.
   the state object and all defaults
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   STATE
================================================================ */
// Storage key — 'gobbonet_chat_state' going forward; migrate from old key if needed.
const STORAGE_KEY = 'gobbonet_chat_state';
const LEGACY_STORAGE_KEY = 'gemma4_chat_state';
const DEFAULT_CARD = {
  id: 'default',
  name: 'Assistant',
  avatar: '',
  writingStyle: 'You are a helpful, friendly, and knowledgeable assistant running fully offline on your local machine. Be concise when the question is simple. Be thorough when the question is complex. Use markdown formatting when it aids readability. When asked to create a file, output it in a code block tagged with the filename like: ```file:example.json followed by the content and closing ```. The user will see a Save button to download it.',
  personality: 'Stay focused, helpful, and accurate. If you are unsure about something, say so rather than guessing.',
  loreEnabled: true,
  startingLore: '',
  // RAG Storybook — the big, hand-authored character/world bible. Accepts
  // structured weighted-tag lines (Retriever B) AND/OR plain prose chunks
  // (Retriever A), in the same field; the parser routes by shape. Unlike
  // startingLore (small, always-on), the storybook is large and retrieved
  // ON DEMAND — only the entity/subtree a scene needs enters context. See
  // parseStorybook() and the RAG ENGINE block for the full grammar.
  ragStorybook: '',
  // Pre-set opening message injected into new threads as the character's
  // first assistant turn. NOT model-generated — verbatim from this field.
  // {{char}} / {{user}} / macros are resolved at thread-creation time.
  greeting: '',
  // Optional pool of alternate openings. When altGreetingsEnabled is true
  // and at least one non-empty entry is present, the greeting is stored as
  // msg.variants on the injected message so the user can flip between
  // openings using the existing ◀ ▶ variant navigator. Blank-line
  // separated so individual greetings can span multiple paragraphs.
  altGreetingsEnabled: false,
  altGreetings: '',
  background: '',
  textColor: '',
  dialogColor: '',
  temperature: 0.7,
  minP: 0.05,
  topK: 40,
  topP: 0.95,
  repeatPenalty: 1.1,
  repeatLastN: 64,
  xtcProbability: 0,
  xtcThreshold: 0.1,
  dryMultiplier: 0,
  bannedPhrases: '',
  // Per-card custom code. Opt-in, off by default, and never enabled by an
  // import -- see applyImportedCardCode in 23-card-code.js.
  customCode: '',
  customCodeEnabled: false,
  logitBiasStrength: -20
};
const DEFAULT_SETTINGS = {
  modelName: 'auto',
  reminderFrequency: 3,
  tokenLimit: 24576,
  apiKey: '',
  cotTimeoutEnabled: false,
  cotTimeoutMinutes: 2,
  smartLimitEnabled: false,   // cap AI reply length (rough token estimate, sentence-end cut)
  smartLimitTokens: 300,      // max estimated tokens per reply when the cap is on
  avatarScale: 1,             // avatar size multiplier (CONFIG slider; 1 = default)
  // ---- RAG retrieval knobs (Stage 1) ----
  // Full snapshot of these rides into every telemetry record's `config`
  // block so any turn is reproducible. Tune one knob at a time; the shadow
  // recompute in the record covers most of the "what if" exploration.
  retrievalEnabled: true,      // master switch for the dual retriever
  retrieverA: true,            // general semantic (needs the embed server)
  retrieverB: true,            // structured weighted-tag firing
  fireThreshold: 1.0,          // summed tag weight needed to fire a thematic pull
  warmthTurns: 3,              // turns a fired entity stays "warm" (anti-flicker)
  expansionDepth: 1,           // relational one-hop expansion (0 disables)
  semanticBackstop: true,      // A also scores B's entities for allusive scenes
  topKA: 5,                    // top-k semantic results from Retriever A
  retrievalBudgetTokens: 6000, // ceiling carved from the existing context budget
  retrievalWindowMsgs: 4       // how many recent messages form the trigger window
};

// Extensions: custom stylesheets and scripts the user can inject.
// `styles` and `scripts` are arrays so you can load more than one of each.
// Each entry: { id, name, url, raw } — url and/or inline raw, both optional
// (raw applies after the url for that entry). Legacy single-field saves
// (cssUrl/cssRaw/jsUrl/jsRaw) are migrated on load by migrateExtensions().
const DEFAULT_EXTENSIONS = {
  enabled: false,
  styles: [],
  scripts: []
};

// Normalize any saved/imported extensions blob into the array-based shape,
// upgrading the old single-stylesheet/single-script format in place.
function migrateExtensions(raw) {
  const ext = { enabled: false, styles: [], scripts: [] };
  if (!raw || typeof raw !== 'object') return ext;
  ext.enabled = !!raw.enabled;

  if (Array.isArray(raw.styles) || Array.isArray(raw.scripts)) {
    // Already new format — sanitize entries.
    const clean = (arr, label) => (Array.isArray(arr) ? arr : [])
      .map((e, i) => ({
        id:   e && e.id ? String(e.id) : ('ext_' + Date.now().toString(36) + '_' + i),
        name: e && typeof e.name === 'string' ? e.name : '',
        url:  e && typeof e.url  === 'string' ? e.url  : '',
        raw:  e && typeof e.raw  === 'string' ? e.raw  : ''
      }))
      .filter(e => e.url.trim() || e.raw.trim() || e.name.trim());
    ext.styles  = clean(raw.styles,  'css');
    ext.scripts = clean(raw.scripts, 'js');
    return ext;
  }

  // Legacy format: cssUrl / cssRaw / jsUrl / jsRaw → one entry each.
  if ((raw.cssUrl && raw.cssUrl.trim()) || (raw.cssRaw && raw.cssRaw.trim())) {
    ext.styles.push({
      id: 'ext_' + Date.now().toString(36) + '_css',
      name: 'Imported stylesheet',
      url: (raw.cssUrl || '').trim(),
      raw: raw.cssRaw || ''
    });
  }
  if ((raw.jsUrl && raw.jsUrl.trim()) || (raw.jsRaw && raw.jsRaw.trim())) {
    ext.scripts.push({
      id: 'ext_' + Date.now().toString(36) + '_js',
      name: 'Imported script',
      url: (raw.jsUrl || '').trim(),
      raw: raw.jsRaw || ''
    });
  }
  return ext;
}

// Personas are character cards for {{user}} — a saved bundle of identity
// (name, avatar, colors) plus a description that gets shared with the model
// on a configurable cadence. Lets you switch between "Sir Lancelot" for
// fantasy RP and "Dr. Smith" for medical Q&A without manually retyping
// your name/avatar each time.
//
// injectionFrequency:
//   0 = never share the description (name/avatar still apply)
//   N = share on user message 1, then every Nth message after
const DEFAULT_PERSONA = {
  id: 'default-persona',
  name: 'Anonymous',
  avatar: '',
  description: '',
  injectionFrequency: 5,
  textColor: '',
  dialogColor: ''
};

// Built-in macro names — users cannot define macros that shadow these.
// auto_continue is reserved both as a bare form (the static expansion) and
// as a count form (the chain trigger); listing the prefix only catches the
// bare one but the chain pattern doesn't go through the custom-macro list
// anyway — it's handled in sendMessage.
const RESERVED_MACROS = new Set(['char', 'user', 'current_dat', 'auto_continue']);

// Default macros pre-seeded on first load (serve as working examples).
// New entries here are also seeded onto existing users via the migration
// in loadState — see seededDefaultMacros below.
//
// Note on {{auto_continue_N}}: this is NOT a regular macro and won't be
// found here. It's a special pattern detected in sendMessage that kicks
// off an automated chain of N sends with a 20s gap. The expansion text
// lives in AUTO_CONTINUE_TEXT and is wired through translateTemplates so
// the LLM sees the prompt even though the stored user message keeps the
// short {{auto_continue}} form for clean rendering.
const DEFAULT_MACROS = [
  {
    trigger: 'continue',
    text: 'Please continue the scene as all characters involved.'
  },
  {
    trigger: 'fast_forward',
    text: 'Please fast-forward to a new scene that continues the storyline naturally and appropriately.'
  }
];

let state = {
  threads: [],
  activeThreadId: null,
  settings: { ...DEFAULT_SETTINGS },
  characterCards: [{ ...DEFAULT_CARD }],
  activeCardId: 'default',
  personaCards: [{ ...DEFAULT_PERSONA }],
  activePersonaId: 'default-persona',
  schedules: [],
  sidebarOpen: true,
  searchEnabled: false,
  folders: [],
  extensions: { ...DEFAULT_EXTENSIONS },
  macros: DEFAULT_MACROS.map(m => ({ ...m })),
  // Tracks which DEFAULT_MACROS triggers have already been seeded onto
  // this user's state. Lets us add new default macros in future versions
  // without re-adding ones the user intentionally deleted. See loadState.
  seededDefaultMacros: DEFAULT_MACROS.map(m => m.trigger)
};

let isGenerating = false;
let abortController = null;
let serverConnected = false;
// Smart auto-scroll: tracks whether the user is currently pinned at the
// bottom of the messages container. Streaming-tick scroll calls check
// this before auto-scrolling — if the user scrolled up to read history,
// we leave them alone until they scroll back down. Set by the scroll
// listener attached in attachScrollPinTracking(); only the user can
// "unpin" by scrolling away, since our own auto-scrolls end at the
// bottom and the resulting scroll event just re-confirms pinned=true.
// Starts true so the very first stream auto-follows before any user
// scroll has happened.
let scrollPinnedToBottom = true;
// When lore compression fires during a turn, this holds {count: N, threadId}
// until the next user input. Read by renderMessages to inject a persistent
// banner just above the streaming assistant message, so the user sees BOTH
// the compression event AND the new reply's COT instead of the transient
// "compressing..." indicator vanishing the moment summarization completes.
let pendingLoreCompressionNote = null;
state.editingIndex = null;

// Default characters loaded from default-characters.json at boot.
// Falls back to empty array gracefully if file is missing or fetch fails.
let defaultCharacters = [];

