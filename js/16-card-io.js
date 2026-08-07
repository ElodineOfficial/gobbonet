/* @gobbonet-split js/16-card-io.js
   Moved verbatim from chat.html lines 9804-10515.
   SillyTavern/Tavern import, Character Card V3 export
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   CHARACTER CARD IMPORT — SillyTavern / TavernAI V1, V2, V3
   ----------------------------------------------------------------
   Accepts three carriers:
     • .json  — a card object (V1 flat, or V2/V3 wrapped under .data)
     • .png   — JSON embedded in a tEXt/zTXt/iTXt chunk keyed 'ccv3'
                (V3, preferred) or 'chara' (V2), base64(utf-8). The
                image itself becomes the avatar.
     • .charx — a ZIP (V3) holding card.json (+ optional asset images)
   Everything is parsed locally — no network, no libraries — to keep
   the single-file / fully-offline guarantee intact.

   Field mapping onto this app's card model (see DEFAULT_CARD):
     name                  -> name
     system_prompt +
       description +
       scenario +
       mes_example +
       post_history_instr. -> writingStyle   (always-on system prompt)
     personality           -> personality    (periodic reminder) AND is
                              also woven into writingStyle so the
                              character is fully defined from turn 1
                              regardless of reminder cadence
     first_mes             -> greeting
     alternate_greetings +
       group_only_greetings-> altGreetings    (blank-line separated)
     character_book        -> startingLore    (LOSSY: entries are
                              flattened to always-on lore; this app has
                              no keyword-triggered lorebook engine)
   Non-prompt metadata (creator, tags, character_version, creator_notes,
   original spec) is preserved on card._import so nothing the spec says
   we "must never destroy" is lost, even though the prompt builder
   ignores it.
================================================================ */

/** Decode a base64 string (possibly whitespace-wrapped) into a UTF-8
 *  JS string. atob yields one byte per char; we reinterpret those
 *  bytes as UTF-8 so multibyte glyphs in card text survive. */
function _b64ToUtf8(b64) {
  const bin = atob(String(b64).replace(/\s+/g, ''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder('utf-8').decode(bytes);
}

/** Bytes -> binary (latin1) string, chunked to avoid blowing the call
 *  stack on large arrays via String.fromCharCode(...huge). */
function _bytesToBinaryString(bytes) {
  let out = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    out += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return out;
}

/** Inflate bytes using the browser's built-in DecompressionStream.
 *  format: 'deflate' (zlib-wrapped, for zTXt/iTXt) or 'deflate-raw'
 *  (for ZIP entries). No external dependency. */
async function _inflate(bytes, format) {
  if (typeof DecompressionStream === 'undefined') {
    throw new Error('This browser cannot read compressed card data (needs DecompressionStream).');
  }
  const ds = new DecompressionStream(format);
  const stream = new Blob([bytes]).stream().pipeThrough(ds);
  const ab = await new Response(stream).arrayBuffer();
  return new Uint8Array(ab);
}

/** Walk a PNG, returning its chunks as [{type, data:Uint8Array}]. */
function _parsePngChunks(buffer) {
  const u8 = new Uint8Array(buffer);
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (u8[i] !== SIG[i]) throw new Error('Not a PNG file.');
  }
  const dv = new DataView(buffer);
  const chunks = [];
  let off = 8;
  while (off + 8 <= u8.length) {
    const len = dv.getUint32(off); off += 4;
    const type = String.fromCharCode(u8[off], u8[off + 1], u8[off + 2], u8[off + 3]); off += 4;
    if (off + len > u8.length) break;
    chunks.push({ type, data: u8.subarray(off, off + len) });
    off += len + 4; // skip data + CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

/** Decode a single PNG text chunk (tEXt / zTXt / iTXt) to
 *  {keyword, text}. text is returned as a latin1 string — fine here
 *  because the card payload is ASCII base64. Returns null if unusable. */
async function _decodePngTextChunk(chunk) {
  const d = chunk.data;
  const firstNul = d.indexOf(0);
  if (firstNul < 0) return null;
  const keyword = _bytesToBinaryString(d.subarray(0, firstNul));

  if (chunk.type === 'tEXt') {
    return { keyword, text: _bytesToBinaryString(d.subarray(firstNul + 1)) };
  }
  if (chunk.type === 'zTXt') {
    // [keyword]\0[compression method=1 byte][zlib stream]
    const comp = d.subarray(firstNul + 2);
    const raw = await _inflate(comp, 'deflate');
    return { keyword, text: _bytesToBinaryString(raw) };
  }
  if (chunk.type === 'iTXt') {
    // [keyword]\0[compFlag][compMethod][langTag]\0[transKeyword]\0[text]
    const compFlag = d[firstNul + 1];
    let p = firstNul + 3;
    const langEnd = d.indexOf(0, p); if (langEnd < 0) return null;
    p = langEnd + 1;
    const transEnd = d.indexOf(0, p); if (transEnd < 0) return null;
    p = transEnd + 1;
    const textBytes = d.subarray(p);
    if (compFlag === 1) {
      const raw = await _inflate(textBytes, 'deflate');
      return { keyword, text: _bytesToBinaryString(raw) };
    }
    return { keyword, text: _bytesToBinaryString(textBytes) };
  }
  return null;
}

/** Pull the character JSON string out of a PNG buffer. Prefers the
 *  V3 'ccv3' chunk over the V2 'chara' chunk when both are present. */
async function _readCardJsonFromPng(buffer) {
  const chunks = _parsePngChunks(buffer);
  let chara = null, ccv3 = null;
  for (const c of chunks) {
    if (c.type !== 'tEXt' && c.type !== 'zTXt' && c.type !== 'iTXt') continue;
    let parsed;
    try { parsed = await _decodePngTextChunk(c); } catch (e) { continue; }
    if (!parsed) continue;
    const kw = (parsed.keyword || '').toLowerCase();
    if (kw === 'ccv3') ccv3 = parsed.text;
    else if (kw === 'chara') chara = parsed.text;
  }
  const payload = ccv3 || chara;
  if (!payload) throw new Error('This PNG has no embedded character data (no chara/ccv3 chunk).');
  return _b64ToUtf8(payload.trim());
}

/* ---- Minimal ZIP reader for .charx (V3) ------------------------- */

/** Read a ZIP central directory into { name -> {method, compSize, localOff} }. */
function _readZipDirectory(buffer) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  // Locate End Of Central Directory (scan back; comment can be up to 64KB).
  let eocd = -1;
  const minPos = Math.max(0, u8.length - 22 - 65536);
  for (let i = u8.length - 22; i >= minPos; i--) {
    if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new Error('Not a valid .charx archive (no ZIP end record).');
  const count = dv.getUint16(eocd + 10, true);
  let p = dv.getUint32(eocd + 16, true);
  const entries = {};
  for (let n = 0; n < count; n++) {
    if (dv.getUint32(p, true) !== 0x02014b50) break;
    const method  = dv.getUint16(p + 10, true);
    const compSize = dv.getUint32(p + 20, true);
    const nameLen = dv.getUint16(p + 28, true);
    const extraLen = dv.getUint16(p + 30, true);
    const commentLen = dv.getUint16(p + 32, true);
    const localOff = dv.getUint32(p + 42, true);
    const name = new TextDecoder('utf-8').decode(u8.subarray(p + 46, p + 46 + nameLen));
    entries[name] = { method, compSize, localOff };
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

/** Extract one ZIP entry's raw bytes (stored or deflated). */
async function _readZipEntry(buffer, entry) {
  const u8 = new Uint8Array(buffer);
  const dv = new DataView(buffer);
  let p = entry.localOff;
  if (dv.getUint32(p, true) !== 0x04034b50) throw new Error('Corrupt .charx (bad local header).');
  const nameLen = dv.getUint16(p + 26, true);
  const extraLen = dv.getUint16(p + 28, true);
  const start = p + 30 + nameLen + extraLen;
  const comp = u8.subarray(start, start + entry.compSize);
  if (entry.method === 0) return comp.slice();
  if (entry.method === 8) return await _inflate(comp, 'deflate-raw');
  throw new Error('Unsupported compression in .charx (method ' + entry.method + ').');
}

/** Case-insensitive lookup of a ZIP entry by basename or suffix. */
function _findZipEntry(entries, predicate) {
  for (const name of Object.keys(entries)) {
    if (predicate(name.toLowerCase(), name)) return { name, entry: entries[name] };
  }
  return null;
}

/** Parse a .charx archive: returns { json, imageDataUrl }. */
async function _readCardFromCharx(buffer) {
  const entries = _readZipDirectory(buffer);
  // The card definition lives in card.json at the archive root.
  const hit = _findZipEntry(entries, (lc) => lc === 'card.json' || lc.endsWith('/card.json'));
  if (!hit) throw new Error('.charx archive is missing card.json.');
  const jsonBytes = await _readZipEntry(buffer, hit.entry);
  const json = new TextDecoder('utf-8').decode(jsonBytes);

  // Best-effort avatar: the icon asset, else any image under assets/.
  let imageDataUrl = '';
  try {
    let imgHit = _findZipEntry(entries, (lc) =>
      /(^|\/)assets\/.*(icon|main|avatar).*\.(png|jpe?g|webp)$/.test(lc));
    if (!imgHit) {
      imgHit = _findZipEntry(entries, (lc) => /\.(png|jpe?g|webp)$/.test(lc));
    }
    if (imgHit) {
      const imgBytes = await _readZipEntry(buffer, imgHit.entry);
      const ext = imgHit.name.toLowerCase().split('.').pop();
      const mime = ext === 'png' ? 'image/png' : (ext === 'webp' ? 'image/webp' : 'image/jpeg');
      imageDataUrl = await _shrinkImageToDataUrl(new Blob([imgBytes], { type: mime }), 256);
    }
  } catch (e) { /* avatar is optional — ignore */ }

  return { json, imageDataUrl };
}

/* ---- Avatar thumbnailing ---------------------------------------- */

/** Draw an image source (Blob or data/blob URL) onto a canvas capped
 *  at maxDim on its longest side, returning a PNG data URL. Keeps
 *  embedded avatars small enough not to bloat localStorage / sync. */
function _shrinkImageToDataUrl(source, maxDim) {
  return new Promise((resolve, reject) => {
    const url = (typeof source === 'string') ? source : URL.createObjectURL(source);
    const cleanup = () => { if (url !== source) URL.revokeObjectURL(url); };
    const img = new Image();
    img.onload = () => {
      try {
        let w = img.naturalWidth || img.width;
        let h = img.naturalHeight || img.height;
        if (!w || !h) { cleanup(); return reject(new Error('Empty image.')); }
        if (w > maxDim || h > maxDim) {
          const s = maxDim / Math.max(w, h);
          w = Math.max(1, Math.round(w * s));
          h = Math.max(1, Math.round(h * s));
        }
        const canvas = document.createElement('canvas');
        canvas.width = w; canvas.height = h;
        canvas.getContext('2d').drawImage(img, 0, 0, w, h);
        cleanup();
        resolve(canvas.toDataURL('image/png'));
      } catch (e) { cleanup(); reject(e); }
    };
    img.onerror = () => { cleanup(); reject(new Error('Could not decode card image.')); };
    img.src = url;
  });
}

/* ---- Normalization: card object -> internal card ---------------- */

/** Detect the spec generation and return the inner data object plus a
 *  spec label. Tolerates spec-less wrappers that still nest under .data. */
function _unwrapCardObject(obj) {
  if (!obj || typeof obj !== 'object') throw new Error('Card file is not a JSON object.');
  const spec = (obj.spec || '').toLowerCase();
  if (spec === 'chara_card_v3' && obj.data) return { data: obj.data, spec: 'v3' };
  if (spec === 'chara_card_v2' && obj.data) return { data: obj.data, spec: 'v2' };
  // Some exporters drop the spec string but still wrap under .data.
  if (obj.data && typeof obj.data === 'object' && (obj.data.name || obj.data.description || obj.data.first_mes)) {
    return { data: obj.data, spec: 'v2?' };
  }
  // Flat V1.
  if (obj.name || obj.description || obj.first_mes) return { data: obj, spec: 'v1' };
  throw new Error('Unrecognized character card format.');
}

/** Strip the {{original}} macro (means "the host's default prompt" in
 *  SillyTavern — meaningless here, so it would render as literal noise). */
function _stripOriginalMacro(s) {
  return String(s || '').replace(/\{\{\s*original\s*\}\}/gi, '').trim();
}

/** Flatten a V2/V3 character_book into a single always-on lore block.
 *  Lossy by design — see module header. */
function _lorebookToText(book) {
  if (!book || !Array.isArray(book.entries) || book.entries.length === 0) return '';
  const entries = book.entries
    .filter(e => e && e.enabled !== false && (e.content || '').trim())
    .sort((a, b) => (a.insertion_order || 0) - (b.insertion_order || 0));
  if (entries.length === 0) return '';
  const blocks = entries.map(e => {
    const keys = Array.isArray(e.keys) ? e.keys.filter(Boolean).join(', ') : '';
    const head = (e.comment && e.comment.trim()) ? e.comment.trim()
               : (keys ? keys : (e.name || '').trim());
    return (head ? `[${head}]\n` : '') + e.content.trim();
  });
  return '[Imported lorebook — flattened to always-on lore]\n\n' + blocks.join('\n\n');
}

/** Map an unwrapped card data object onto a fresh internal card. */
function _cardDataToInternal(data, spec, imageDataUrl) {
  const get = (k) => (typeof data[k] === 'string' ? data[k] : '');
  const name = (get('name') || data.nickname || 'Imported Character').trim() || 'Imported Character';
  const description = get('description').trim();
  const personality = get('personality').trim();
  const scenario = get('scenario').trim();
  const systemPrompt = _stripOriginalMacro(get('system_prompt'));
  const postHistory = _stripOriginalMacro(get('post_history_instructions'));
  const mesExample = get('mes_example').trim();

  // Always-on system prompt. Order: explicit system prompt, who they
  // are, their traits, the setting, example dialogue, then any
  // post-history steering. Each section is lightly labeled so a local
  // model can tell them apart.
  const parts = [];
  if (systemPrompt) parts.push(systemPrompt);
  if (description) parts.push(description);
  if (personality) parts.push('Personality:\n' + personality);
  if (scenario) parts.push('Scenario:\n' + scenario);
  if (mesExample) parts.push('Example dialogue:\n' + mesExample);
  if (postHistory) parts.push('Instructions:\n' + postHistory);
  const writingStyle = parts.join('\n\n');

  // Greetings: first_mes is primary; alternates + V3 group-only
  // greetings become the alt pool (blank-line separated to match
  // parseAltGreetings).
  const greeting = get('first_mes').trim();
  const altList = []
    .concat(Array.isArray(data.alternate_greetings) ? data.alternate_greetings : [])
    .concat(Array.isArray(data.group_only_greetings) ? data.group_only_greetings : [])
    .map(g => (g || '').trim())
    .filter(Boolean);
  const altGreetings = altList.join('\n\n');

  const startingLore = _lorebookToText(data.character_book);

  // Pull our namespaced RAG storybook back out of extensions if present, so a
  // card exported by Gobbonet round-trips its weighted-tag / prose bible.
  let ragStorybook = '';
  try {
    const ext = data.extensions && data.extensions.gobbonet;
    if (ext && typeof ext.ragStorybook === 'string') ragStorybook = ext.ragStorybook;
  } catch (e) {}

  const card = {
    ...DEFAULT_CARD,
    id: generateId(),
    name: name,
    avatar: imageDataUrl || '',
    writingStyle: writingStyle,
    personality: personality,              // also drives the periodic reminder
    loreEnabled: true,
    startingLore: startingLore,
    ragStorybook: ragStorybook,
    greeting: greeting,
    altGreetingsEnabled: altList.length > 0,
    altGreetings: altGreetings,
    carouselIndex: 0,
    // Preserve everything the spec tells us not to destroy. Ignored by
    // the prompt builder; useful for provenance / future round-trips.
    _import: {
      spec: data.spec || spec,
      creator: get('creator'),
      character_version: get('character_version'),
      tags: Array.isArray(data.tags) ? data.tags : [],
      creator_notes: get('creator_notes'),
      importedAt: Date.now()
    }
  };
  // Custom code may ride along in the V3 `extensions` bag. Carry it across
  // so the card is not silently lopped, but NEVER honour an enabled flag
  // from a file -- a downloaded character must not run its author's
  // JavaScript the moment you activate it. applyImportedCardCode always
  // leaves it switched off, whatever the file claimed.
  try {
    const ext = (data.extensions && data.extensions.gobbonet) || {};
    applyImportedCardCode(card, typeof ext.customCode === 'string' ? ext.customCode : '');
  } catch (e) {
    card.customCode = '';
    card.customCodeEnabled = false;
  }
  return card;
}

/** Give an imported card a name that doesn't collide with an existing one. */
function _uniqueCardName(base) {
  const taken = new Set(state.characterCards.map(c => c.name));
  if (!taken.has(base)) return base;
  let candidate = base + ' (Imported)';
  let i = 2;
  while (taken.has(candidate)) candidate = `${base} (Imported ${i++})`;
  return candidate;
}

/* ---- Entry point: file input -> reviewed card ------------------- */

async function importCharacterCard(fileInput) {
  const file = fileInput && fileInput.files && fileInput.files[0];
  // Reset the input so re-picking the same file fires onchange again.
  if (fileInput) fileInput.value = '';
  if (!file) return;

  try {
    const lower = (file.name || '').toLowerCase();
    const isPng = file.type === 'image/png' || lower.endsWith('.png') || lower.endsWith('.apng');
    const isCharx = lower.endsWith('.charx');
    const isJson = file.type === 'application/json' || lower.endsWith('.json');

    let jsonStr, imageDataUrl = '';

    if (isCharx) {
      const buf = await file.arrayBuffer();
      const res = await _readCardFromCharx(buf);
      jsonStr = res.json;
      imageDataUrl = res.imageDataUrl;
    } else if (isPng) {
      const buf = await file.arrayBuffer();
      jsonStr = await _readCardJsonFromPng(buf);
      // The PNG itself is the portrait — downscale it for the avatar.
      try {
        imageDataUrl = await _shrinkImageToDataUrl(new Blob([buf], { type: 'image/png' }), 256);
      } catch (e) { imageDataUrl = ''; }
    } else if (isJson) {
      jsonStr = await file.text();
    } else {
      // Unknown extension — try to sniff: PNG magic bytes, else JSON.
      const buf = await file.arrayBuffer();
      const head = new Uint8Array(buf.slice(0, 8));
      const isPngMagic = head[0] === 137 && head[1] === 80 && head[2] === 78 && head[3] === 71;
      if (isPngMagic) {
        jsonStr = await _readCardJsonFromPng(buf);
        try { imageDataUrl = await _shrinkImageToDataUrl(new Blob([buf], { type: 'image/png' }), 256); } catch (e) {}
      } else {
        jsonStr = new TextDecoder('utf-8').decode(new Uint8Array(buf));
      }
    }

    let obj;
    try { obj = JSON.parse(jsonStr); }
    catch (e) { throw new Error('Embedded card data is not valid JSON.'); }

    const { data, spec } = _unwrapCardObject(obj);
    const card = _cardDataToInternal(data, spec, imageDataUrl);

    if (!card.writingStyle && !card.greeting && !card.personality) {
      throw new Error('Card had no usable description, greeting, or personality.');
    }

    card.name = _uniqueCardName(card.name);
    state.characterCards.push(card);
    saveState();

    // Drop straight into the editor so the user can review the mapping
    // (and the lossy lore flattening) before relying on it. The card is
    // already committed, so cancelling keeps it as-is.
    renderCardGrid();
    editCard(card.id);

    const specLabel = (card._import.spec || spec || '').toString().toUpperCase().replace('CHARA_CARD_', 'V');
    showModelSwitchToast(`Imported "${card.name}"${specLabel ? ' (' + specLabel + ')' : ''} — review & save.`, 'ok');
  } catch (err) {
    console.error('[import] character card failed:', err);
    showModelSwitchToast('Import failed: ' + (err && err.message ? err.message : 'unknown error'), 'err');
  }
}

/* ================================================================
   CHARACTER CARD EXPORT — Character Card V3 (with V2 backfill)
   ----------------------------------------------------------------
   Produces a PNG carrying the character JSON in two tEXt chunks:
     • ccv3  — CharacterCardV3 (forward compatibility, V3-aware apps)
     • chara — CharacterCardV2 (backward compatibility, V2-only apps)
   That dual-chunk PNG is the de-facto interchange format (SillyTavern,
   Chub, RisuAI, Agnai all read it), so an exported card loads anywhere.

   This is a best-effort inverse of the import mapping, not a perfect
   round-trip: import FLATTENS several spec fields (system_prompt,
   scenario, mes_example, post_history) into writingStyle, so on the way
   out they all live in `description`. Everything stored on card._import
   (creator, tags, version, notes) is restored to its proper field.
================================================================ */

/** CRC-32 (IEEE 802.3) for PNG chunk integrity. Table built once. */
let _crc32Table = null;
function _crc32(bytes) {
  if (!_crc32Table) {
    _crc32Table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      _crc32Table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = _crc32Table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** UTF-8 string -> base64, chunked so large payloads don't overflow
 *  the call stack in String.fromCharCode. */
function _utf8ToB64(str) {
  const bytes = new TextEncoder().encode(str);
  let bin = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  }
  return btoa(bin);
}

/** Build a complete PNG tEXt chunk: [len][type 'tEXt'][keyword\0text][crc]. */
function _pngTextChunk(keyword, text) {
  const kw = new TextEncoder().encode(keyword);
  const tx = new TextEncoder().encode(text);
  const data = new Uint8Array(kw.length + 1 + tx.length);
  data.set(kw, 0); data[kw.length] = 0; data.set(tx, kw.length + 1);
  const type = new Uint8Array([0x74, 0x45, 0x58, 0x74]); // 'tEXt'
  const crcInput = new Uint8Array(type.length + data.length);
  crcInput.set(type, 0); crcInput.set(data, type.length);
  const out = new Uint8Array(4 + 4 + data.length + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(type, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, _crc32(crcInput) >>> 0);
  return out;
}

/** Splice extra chunks into a PNG byte stream, just before IEND. */
function _injectPngChunks(pngBytes, chunks) {
  const dv = new DataView(pngBytes.buffer, pngBytes.byteOffset, pngBytes.byteLength);
  let off = 8, iend = -1;
  while (off + 8 <= pngBytes.length) {
    const len = dv.getUint32(off);
    const type = String.fromCharCode(pngBytes[off + 4], pngBytes[off + 5], pngBytes[off + 6], pngBytes[off + 7]);
    if (type === 'IEND') { iend = off; break; }
    off += 12 + len;
  }
  if (iend < 0) throw new Error('Base image is not a valid PNG.');
  const extra = chunks.reduce((s, c) => s + c.length, 0);
  const out = new Uint8Array(pngBytes.length + extra);
  out.set(pngBytes.subarray(0, iend), 0);
  let p = iend;
  for (const c of chunks) { out.set(c, p); p += c.length; }
  out.set(pngBytes.subarray(iend), p);
  return out;
}

/** Load an image src for export. http(s) avatars get crossOrigin so the
 *  canvas isn't tainted (best-effort; falls back to a placeholder). */
function _loadImageForExport(src) {
  return new Promise((res, rej) => {
    const img = new Image();
    if (src.startsWith('http')) img.crossOrigin = 'anonymous';
    img.onload = () => res(img);
    img.onerror = () => rej(new Error('Could not load avatar image.'));
    img.src = src;
  });
}

/** Produce PNG bytes for the card's portrait. Uses the avatar if it can
 *  be drawn safely; otherwise renders a neon placeholder so the export
 *  is always a valid, shareable PNG. */
async function _cardImagePngBytes(card) {
  const MAX = 512;
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');

  const drawPlaceholder = () => {
    const w = 400, h = 600;
    canvas.width = w; canvas.height = h;
    ctx.fillStyle = '#0a0e12'; ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#00f3ff';
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.font = 'bold 220px monospace';
    ctx.fillText((card.name || '?').charAt(0).toUpperCase(), w / 2, h / 2 - 30);
    ctx.fillStyle = '#7c8a99'; ctx.font = '26px monospace';
    ctx.fillText((card.name || '').slice(0, 26), w / 2, h - 56);
  };

  const av = (card.avatar || '').trim();
  let drewAvatar = false;
  if (av && (av.startsWith('data:') || av.startsWith('http') || av.startsWith('file:'))) {
    try {
      const img = await _loadImageForExport(av);
      let w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
      if (w && h) {
        if (w > MAX || h > MAX) { const s = MAX / Math.max(w, h); w = Math.round(w * s); h = Math.round(h * s); }
        canvas.width = w; canvas.height = h;
        ctx.drawImage(img, 0, 0, w, h);
        drewAvatar = true;
      }
    } catch (e) { /* fall through to placeholder */ }
  }
  if (!drewAvatar) drawPlaceholder();

  let dataUrl;
  try {
    dataUrl = canvas.toDataURL('image/png');
  } catch (e) {
    // Avatar tainted the canvas (cross-origin) — redraw a clean placeholder.
    drawPlaceholder();
    dataUrl = canvas.toDataURL('image/png');
  }
  const b64 = dataUrl.split(',')[1];
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Internal card -> CharacterCardV3 object. */
function _cardToV3(card) {
  const imp = card._import || {};
  const alts = card.altGreetingsEnabled ? parseAltGreetings(card.altGreetings || '') : [];
  // Drop the header our importer prepends so re-exported lore stays clean.
  let lore = (card.startingLore || '').trim()
    .replace(/^\[Imported lorebook[^\]]*\]\s*\n+/, '').trim();
  const now = Date.now();

  const data = {
    name: card.name || 'Character',
    description: card.writingStyle || '',
    personality: card.personality || '',
    scenario: '',
    first_mes: card.greeting || '',
    mes_example: '',
    creator_notes: imp.creator_notes || '',
    system_prompt: '',
    post_history_instructions: '',
    alternate_greetings: alts,
    tags: Array.isArray(imp.tags) ? imp.tags : [],
    creator: imp.creator || '',
    character_version: imp.character_version || '',
    // Gobbonet RAG storybook rides in extensions so a shared card carries its
    // weighted-tag / prose bible. Namespaced to avoid colliding with other
    // tools' extension data; ignored by apps that don't understand it.
    // Custom code travels with the card so your own backups round-trip.
    // The enabled flag deliberately does NOT travel: on the way back in,
    // applyImportedCardCode forces it off, so a shared card can never run
    // its author's JavaScript without the recipient opting in first.
    extensions: (() => {
      const g = {};
      if (card.ragStorybook && card.ragStorybook.trim()) g.ragStorybook = card.ragStorybook;
      if (card.customCode && card.customCode.trim()) g.customCode = card.customCode;
      return Object.keys(g).length ? { gobbonet: g } : {};
    })(),
    group_only_greetings: [],
    assets: [{ type: 'icon', uri: 'ccdefault:', name: 'main', ext: 'png' }],
    creation_date: imp.importedAt || now,
    modification_date: now
  };

  if (lore) {
    data.character_book = {
      name: (card.name || 'Character') + ' lore',
      scan_depth: 4,
      token_budget: 512,
      recursive_scanning: false,
      extensions: {},
      entries: [{
        keys: [], content: lore, extensions: {}, enabled: true, insertion_order: 0,
        case_sensitive: false, name: 'Imported lore', priority: 10, id: 0,
        comment: 'Flattened from startingLore on export', selective: false,
        secondary_keys: [], constant: true, position: 'before_char'
      }]
    };
  }
  return { spec: 'chara_card_v3', spec_version: '3.0', data };
}

/** Derive a CharacterCardV2 backfill from a V3 object. */
function _v3ToV2(v3) {
  const v2 = JSON.parse(JSON.stringify(v3));
  v2.spec = 'chara_card_v2';
  v2.spec_version = '2.0';
  ['group_only_greetings', 'assets', 'nickname', 'creation_date',
   'modification_date', 'creator_notes_multilingual', 'source']
    .forEach(k => { delete v2.data[k]; });
  return v2;
}

/** Trigger a browser download for a Blob. */
function _downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** Export the card currently open in the editor as a V3 PNG (V2-compatible).
 *  Reads live form values so unsaved edits are included — without closing
 *  the editor. */
async function exportCardAsV3() {
  const card = state.characterCards.find(c => c.id === editingCardId);
  if (!card) { showModelSwitchToast('No character selected to export.', 'err'); return; }

  const val = (id) => { const el = document.getElementById(id); return el ? el.value : undefined; };
  const chk = (id) => { const el = document.getElementById(id); return el ? el.checked : undefined; };
  const snap = {
    ...card,
    name: ((val('card-name') || card.name || '').trim()) || 'Character',
    avatar: (val('card-avatar') ?? card.avatar ?? '').trim(),
    writingStyle: val('card-style') ?? card.writingStyle,
    personality: val('card-personality') ?? card.personality,
    greeting: val('card-greeting') ?? card.greeting,
    altGreetingsEnabled: chk('card-alt-greetings-enabled') ?? card.altGreetingsEnabled,
    altGreetings: val('card-alt-greetings') ?? card.altGreetings,
    startingLore: val('card-starting-lore') ?? card.startingLore,
    ragStorybook: val('card-rag-storybook') ?? card.ragStorybook
  };

  try {
    const v3 = _cardToV3(snap);
    const v2 = _v3ToV2(v3);
    const imgBytes = await _cardImagePngBytes(snap);
    const png = _injectPngChunks(imgBytes, [
      _pngTextChunk('ccv3', _utf8ToB64(JSON.stringify(v3))),
      _pngTextChunk('chara', _utf8ToB64(JSON.stringify(v2)))
    ]);
    const fname = (snap.name || 'character').toLowerCase()
      .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'character';
    _downloadBlob(new Blob([png], { type: 'image/png' }), fname + '.png');
    showModelSwitchToast(`Exported "${snap.name}" as a V3 card (PNG, V2-compatible).`, 'ok');
  } catch (err) {
    console.error('[export] character card failed:', err);
    showModelSwitchToast('Export failed: ' + (err && err.message ? err.message : 'unknown error'), 'err');
  }
}

