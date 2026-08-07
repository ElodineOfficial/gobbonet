/* @gobbonet-split js/15-cards.js
   Moved verbatim from chat.html lines 9482-9803.
   settings, character cards
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   SETTINGS
================================================================ */
function openSettings() {
  // Model dropdown is in the header — loadModelsList() handles it on startup
  document.getElementById('set-frequency').value = state.settings.reminderFrequency;
  document.getElementById('set-tokens').value = state.settings.tokenLimit;
  document.getElementById('set-apikey').value = state.settings.apiKey || '';
  // COT timeout
  document.getElementById('set-cot-timeout-enabled').checked = !!state.settings.cotTimeoutEnabled;
  document.getElementById('set-cot-timeout-minutes').value = state.settings.cotTimeoutMinutes || 2;
  updateCotTimeoutRow();
  // Smart response limit
  document.getElementById('set-smart-limit-enabled').checked = !!state.settings.smartLimitEnabled;
  document.getElementById('set-smart-limit-tokens').value = state.settings.smartLimitTokens || 300;
  updateSmartLimitRow();
  const aScale = state.settings.avatarScale || 1;
  document.getElementById('set-avatar-scale').value = aScale;
  document.getElementById('avatar-scale-val').textContent = Math.round(aScale * 100) + '%';
  document.getElementById('settings-modal').classList.add('open');
}

function closeSettings() {
  document.getElementById('settings-modal').classList.remove('open');
  applyAvatarScale(); // revert any unsaved live-preview drag back to the saved value
}

function saveSettings() {
  // Model selection is now in the header dropdown — no longer saved in settings
  state.settings.reminderFrequency = parseInt(document.getElementById('set-frequency').value) || 3;
  state.settings.tokenLimit = parseInt(document.getElementById('set-tokens').value) || 24576;
  state.settings.apiKey = document.getElementById('set-apikey').value.trim();
  state.settings.cotTimeoutEnabled = document.getElementById('set-cot-timeout-enabled').checked;
  state.settings.cotTimeoutMinutes = parseInt(document.getElementById('set-cot-timeout-minutes').value) || 2;
  state.settings.smartLimitEnabled = document.getElementById('set-smart-limit-enabled').checked;
  state.settings.smartLimitTokens = Math.min(8192, Math.max(25, parseInt(document.getElementById('set-smart-limit-tokens').value) || 300));
  state.settings.avatarScale = parseFloat(document.getElementById('set-avatar-scale').value) || 1;
  saveState();
  closeSettings();
  renderMessages();
  updateContextInfo();
  updatePrivacyBadge();
}

/* Avatar size — a single CSS var (--avatar-scale) multiplies every avatar's
   base dimension at every breakpoint. previewAvatarScale() runs live as the
   CONFIG slider moves; applyAvatarScale() restores the saved value (on boot,
   and on Cancel to discard an unsaved drag). */
function previewAvatarScale(val) {
  const scale = parseFloat(val) || 1;
  document.documentElement.style.setProperty('--avatar-scale', scale);
  const lbl = document.getElementById('avatar-scale-val');
  if (lbl) lbl.textContent = Math.round(scale * 100) + '%';
}
function applyAvatarScale() {
  const scale = (state.settings && state.settings.avatarScale) || 1;
  document.documentElement.style.setProperty('--avatar-scale', scale);
}

/* ================================================================
   CHARACTER CARDS
================================================================ */
let editingCardId = null;

function openCharacters() {
  editingCardId = null;
  editingPersonaId = null;
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('persona-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
  document.getElementById('char-modal').classList.add('open');
}

function closeCharacters() {
  document.getElementById('char-modal').classList.remove('open');
  applyActiveCardBackground();
  renderMessages();
}

function renderCardGrid() {
  const grid = document.getElementById('card-grid');
  grid.innerHTML = state.characterCards.map(c => {
    const av = renderAvatar(c.avatar, c.name);
    return `
    <div class="card-item ${c.id === state.activeCardId ? 'active' : ''}" onclick="activateCard('${c.id}')">
      <div class="card-avatar">${av}</div>
      <div class="card-info">
        <div class="card-name">${escapeHtml(c.name)}</div>
        <div class="card-desc">${escapeHtml((c.writingStyle || '').slice(0, 60))}</div>
      </div>
      <div class="card-actions">
        <button class="msg-action-btn btn-edit" onclick="event.stopPropagation();editCard('${c.id}')">Edit</button>
        <button class="msg-action-btn" onclick="event.stopPropagation();copyCard('${c.id}')" title="Duplicate this character">Copy</button>
        ${state.characterCards.length > 1 ? `<button class="msg-action-btn btn-delete" onclick="event.stopPropagation();deleteCardById('${c.id}')" title="Delete this character">Del</button>` : ''}
      </div>
    </div>`;
  }).join('');
}

function activateCard(id) {
  state.activeCardId = id;
  saveState();
  // Swap the running card code along with the card. Anything the previous
  // card registered is discarded here, which is what keeps one character's
  // logic from leaking into the next.
  try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  renderCardGrid();
  renderMessages();
  applyActiveCardBackground();
}

function createCard() {
  const card = {
    id: generateId(),
    name: 'New Character',
    avatar: '',
    writingStyle: '',
    personality: '',
    loreEnabled: true,
    startingLore: '',
    ragStorybook: '',
    greeting: '',
    altGreetingsEnabled: false,
    altGreetings: '',
    background: '#000000',
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
    logitBiasStrength: -20,
    carouselEnabled: false,
    carouselPrompts: '',
    carouselMode: 'random',
    carouselIndex: 0,
    customCode: '',
    customCodeEnabled: false
  };
  state.characterCards.push(card);
  saveState();
  editCard(card.id);
}

function editCard(id) {
  const card = state.characterCards.find(c => c.id === id);
  if (!card) return;
  editingCardId = id;
  document.getElementById('card-name').value = card.name;
  document.getElementById('card-avatar').value = card.avatar || '';
  document.getElementById('card-style').value = card.writingStyle;
  document.getElementById('card-personality').value = card.personality;
  document.getElementById('card-lore-toggle').value = card.loreEnabled !== false ? 'on' : 'off';
  document.getElementById('card-starting-lore').value = card.startingLore || '';
  document.getElementById('card-rag-storybook').value = card.ragStorybook || '';
  updateStorybookReadout();
  // Greeting + alt greetings — mirror the carousel toggle pattern so
  // the body opens/closes cleanly when the user re-edits.
  document.getElementById('card-greeting').value = card.greeting || '';
  const altGreetingsEnabled = !!card.altGreetingsEnabled;
  document.getElementById('card-alt-greetings-enabled').checked = altGreetingsEnabled;
  document.getElementById('card-alt-greetings').value = card.altGreetings || '';
  const altGreetingsBody = document.getElementById('alt-greetings-body');
  altGreetingsBody.classList.toggle('open', altGreetingsEnabled);
  document.getElementById('alt-greetings-toggle-label').classList.toggle('active', altGreetingsEnabled);
  updateAltGreetingsCounter();
  document.getElementById('card-bg').value = card.background || '';
  // Populate card text color pickers
  const ctc = card.textColor || '#e0f8ff';
  const cdc = card.dialogColor || '#d900ff';
  document.getElementById('card-textcolor').value = ctc;
  document.getElementById('card-textcolor-hex').value = ctc;
  document.getElementById('card-dialogcolor').value = cdc;
  document.getElementById('card-dialogcolor-hex').value = cdc;
  previewCardColors();
  // Populate sampler parameters
  const temp = card.temperature !== undefined ? card.temperature : 0.7;
  const minp = card.minP !== undefined ? card.minP : 0.05;
  const topk = card.topK !== undefined ? card.topK : 40;
  const topp = card.topP !== undefined ? card.topP : 0.95;
  const reppen = card.repeatPenalty !== undefined ? card.repeatPenalty : 1.1;
  const repn = card.repeatLastN !== undefined ? card.repeatLastN : 64;
  document.getElementById('card-temperature').value = temp;
  document.getElementById('card-temp-val').textContent = temp;
  document.getElementById('card-min-p').value = minp;
  document.getElementById('card-minp-val').textContent = minp;
  document.getElementById('card-top-k').value = topk;
  document.getElementById('card-top-p').value = topp;
  document.getElementById('card-topp-val').textContent = topp;
  document.getElementById('card-repeat-penalty').value = reppen;
  document.getElementById('card-rep-val').textContent = reppen;
  document.getElementById('card-repeat-last-n').value = repn;
  // XTC + DRY (default to off for cards saved before these existed)
  const xtcProb = card.xtcProbability !== undefined ? card.xtcProbability : 0;
  const xtcThr  = card.xtcThreshold !== undefined ? card.xtcThreshold : 0.1;
  const dryMult = card.dryMultiplier !== undefined ? card.dryMultiplier : 0;
  document.getElementById('card-xtc-prob').value = xtcProb;
  document.getElementById('card-xtc-prob-val').textContent = xtcProb;
  document.getElementById('card-xtc-threshold').value = xtcThr;
  document.getElementById('card-xtc-threshold-val').textContent = xtcThr;
  document.getElementById('card-dry-mult').value = dryMult;
  document.getElementById('card-dry-mult-val').textContent = dryMult;
  // Banned phrases / logit bias
  document.getElementById('card-banned-phrases').value = card.bannedPhrases || '';
  const lbStrength = card.logitBiasStrength !== undefined ? card.logitBiasStrength : -20;
  document.getElementById('card-logit-strength').value = lbStrength;
  document.getElementById('card-logit-strength-val').textContent = lbStrength;
  // Carousel prompt
  const carouselEnabled = !!card.carouselEnabled;
  document.getElementById('card-carousel-enabled').checked = carouselEnabled;
  document.getElementById('card-carousel-prompts').value = card.carouselPrompts || '';
  const carouselMode = card.carouselMode || 'random';
  document.getElementById('carousel-mode-random').checked = carouselMode === 'random';
  document.getElementById('carousel-mode-sequential').checked = carouselMode === 'sequential';
  const carouselBody = document.getElementById('carousel-body');
  carouselBody.classList.toggle('open', carouselEnabled);
  document.getElementById('carousel-toggle-label').classList.toggle('active', carouselEnabled);
  updateCarouselCounter(card);
  document.getElementById('char-modal-list').style.display = 'none';
  document.getElementById('card-editor').style.display = '';
  document.getElementById('char-close-row').style.display = 'none';
  document.getElementById('card-delete-btn').style.display = state.characterCards.length > 1 ? '' : 'none';
  document.getElementById('card-custom-code').value = card.customCode || '';
  document.getElementById('card-code-enabled').checked = !!card.customCodeEnabled;
  updateCardCodeStatus();
  previewAvatar('card-avatar', 'card-avatar-preview');
  previewBg();
}

function saveCard() {
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (!card) return;
  card.customCode = document.getElementById('card-custom-code').value;
  card.customCodeEnabled = document.getElementById('card-code-enabled').checked;
  card.name = document.getElementById('card-name').value.trim() || 'Unnamed';
  card.avatar = document.getElementById('card-avatar').value.trim();
  card.writingStyle = document.getElementById('card-style').value;
  card.personality = document.getElementById('card-personality').value;
  card.loreEnabled = document.getElementById('card-lore-toggle').value === 'on';
  card.startingLore = document.getElementById('card-starting-lore').value;
  const _prevStorybook = card.ragStorybook || '';
  card.ragStorybook = document.getElementById('card-rag-storybook').value;
  // Invalidate the parse cache and, if the storybook text changed, embed its
  // docs now (fire-and-forget) so the first chat turn isn't the one paying the
  // indexing cost. Silently no-ops if the embed server is unavailable.
  if (card._storybook) { try { delete card._storybook; } catch (e) { card._storybook = null; } }
  if (card.ragStorybook !== _prevStorybook && card.ragStorybook.trim()) {
    try { ragIngestCard(card); } catch (e) {}
  }
  card.greeting = document.getElementById('card-greeting').value;
  card.altGreetingsEnabled = document.getElementById('card-alt-greetings-enabled').checked;
  card.altGreetings = document.getElementById('card-alt-greetings').value;
  card.background = document.getElementById('card-bg').value.trim();
  card.textColor = document.getElementById('card-textcolor').value;
  card.dialogColor = document.getElementById('card-dialogcolor').value;
  card.temperature = safeParse(document.getElementById('card-temperature').value, 0.7);
  card.minP = safeParse(document.getElementById('card-min-p').value, 0.05);
  card.topK = safeParse(document.getElementById('card-top-k').value, 40, true);
  card.topP = safeParse(document.getElementById('card-top-p').value, 0.95);
  card.repeatPenalty = safeParse(document.getElementById('card-repeat-penalty').value, 1.1);
  card.repeatLastN = safeParse(document.getElementById('card-repeat-last-n').value, 64, true);
  card.xtcProbability = safeParse(document.getElementById('card-xtc-prob').value, 0);
  card.xtcThreshold = safeParse(document.getElementById('card-xtc-threshold').value, 0.1);
  card.dryMultiplier = safeParse(document.getElementById('card-dry-mult').value, 0);
  card.bannedPhrases = document.getElementById('card-banned-phrases').value;
  card.logitBiasStrength = safeParse(document.getElementById('card-logit-strength').value, -20);
  card.carouselEnabled = document.getElementById('card-carousel-enabled').checked;
  card.carouselPrompts = document.getElementById('card-carousel-prompts').value;
  card.carouselMode = document.getElementById('carousel-mode-random').checked ? 'random' : 'sequential';
  // Preserve existing index on save (don't reset it)
  if (card.carouselIndex === undefined) card.carouselIndex = 0;
  const _wasActive = (card.id === state.activeCardId);
  editingCardId = null;
  saveState();
  // If you just edited the card you are chatting with, reload its code now
  // rather than making you switch away and back to see the change.
  if (_wasActive) {
    try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  }
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function cancelCardEdit() {
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (card && !card.writingStyle && card.name === 'New Character') {
    state.characterCards = state.characterCards.filter(c => c.id !== editingCardId);
    saveState();
  }
  editingCardId = null;
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function deleteCard() {
  if (state.characterCards.length <= 1) return;
  const _deletedId = editingCardId;
  state.characterCards = state.characterCards.filter(c => c.id !== editingCardId);
  if (state.activeCardId === editingCardId) state.activeCardId = state.characterCards[0].id;
  editingCardId = null;
  // Drop the deleted card's code scratch space, then load whatever card
  // just became active. Without this, a deleted card's hooks would keep
  // running against a character that no longer exists.
  if (state._cardCodeStore) delete state._cardCodeStore[_deletedId];
  saveState();
  try { applyCardCode(); } catch (e) { console.error('[card-code]', e); }
  document.getElementById('card-editor').style.display = 'none';
  document.getElementById('char-modal-list').style.display = '';
  document.getElementById('char-close-row').style.display = '';
  renderCardGrid();
  renderPersonaGrid();
}

function copyCard(id) {
  const src = state.characterCards.find(c => c.id === id);
  if (!src) return;
  const copy = { ...src, id: generateId(), name: src.name + ' (Copy)' };
  state.characterCards.push(copy);
  saveState();
  renderCardGrid();
}

function deleteCardById(id) {
  if (state.characterCards.length <= 1) return;
  state.characterCards = state.characterCards.filter(c => c.id !== id);
  if (state.activeCardId === id) state.activeCardId = state.characterCards[0].id;
  saveState();
  renderCardGrid();
}

