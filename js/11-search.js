/* @gobbonet-split js/11-search.js
   Moved verbatim from chat.html lines 7849-8065.
   web search, llama.cpp connection check
   Load order is a contract -- see REFACTOR-PLAN.md before reordering.
   @end-split-header */
/* ================================================================
   WEB SEARCH
================================================================ */
let searchEnabled = false;

function toggleSearch() {
  searchEnabled = !searchEnabled;
  state.searchEnabled = searchEnabled;
  saveState();
  document.getElementById('search-toggle').classList.toggle('active', searchEnabled);
}

async function webSearch(query) {
  const apiKey = state.settings.apiKey;
  if (!apiKey) {
    console.warn('[search] No API key set in settings');
    return null;
  }

  console.log(`[search] Starting search for: "${query}"`);
  console.log(`[search] API key present: ${apiKey.slice(0, 6)}...`);

  // Step 1: Check if proxy is reachable
  try {
    const healthCheck = await fetch(SEARCH_PROXY_URL + '/health');
    if (!healthCheck.ok) {
      console.error(`[search] Proxy health check failed: HTTP ${healthCheck.status}`);
      return null;
    }
    console.log('[search] Proxy is healthy');
  } catch (e) {
    console.error('[search] Proxy unreachable at ' + SEARCH_PROXY_URL + ' — ' + e.message);
    console.error('[search] Make sure launch.bat is running (it starts the proxy)');
    return null;
  }

  // Step 2: Send search request through proxy
  try {
    console.log('[search] Sending POST to proxy...');
    const resp = await fetch(SEARCH_PROXY_URL + '/web_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query, max_results: 5 })
    });

    console.log(`[search] Proxy responded: HTTP ${resp.status}`);
    const rawText = await resp.text();
    console.log(`[search] Raw response (first 500 chars): ${rawText.slice(0, 500)}`);

    if (!resp.ok) {
      console.error(`[search] Non-OK status ${resp.status}: ${rawText}`);
      return null;
    }

    let data;
    try {
      data = JSON.parse(rawText);
    } catch (parseErr) {
      console.error(`[search] Response is not valid JSON: ${parseErr.message}`);
      return null;
    }

    if (data.error) {
      console.error(`[search] API returned error: ${data.error}`);
      return null;
    }

    if (data.results && data.results.length > 0) {
      console.log(`[search] Got ${data.results.length} results`);
      return data.results;
    } else {
      console.warn('[search] Response parsed OK but no results array:', data);
      return null;
    }
  } catch (e) {
    console.error(`[search] Fetch failed: ${e.name}: ${e.message}`);
    return null;
  }
}

/* Test connection — called from settings */
async function testSearchConnection() {
  const statusEl = document.getElementById('search-test-status');
  const outputEl = document.getElementById('search-test-output');
  const apiKey = document.getElementById('set-apikey').value.trim();

  statusEl.textContent = 'Testing...';
  statusEl.style.color = 'var(--cyan-mid)';
  outputEl.style.display = 'block';
  outputEl.textContent = '';

  let log = '';
  const addLog = (msg) => { log += msg + '\n'; outputEl.textContent = log; };

  // Test 1: Proxy health
  addLog('>>> Step 1: Check proxy at ' + SEARCH_PROXY_URL + '/health');
  try {
    const h = await fetch(SEARCH_PROXY_URL + '/health');
    const hText = await h.text();
    addLog(`    Status: ${h.status} — ${hText}`);
    if (!h.ok) {
      statusEl.textContent = 'Proxy unhealthy';
      statusEl.style.color = 'var(--red-neon)';
      return;
    }
    addLog('    Proxy is alive!');
  } catch (e) {
    addLog(`    FAILED: ${e.message}`);
    addLog('    The search proxy is not running.');
    addLog('    Make sure you launched via launch.bat.');
    statusEl.textContent = 'Proxy not reachable';
    statusEl.style.color = 'var(--red-neon)';
    return;
  }

  // Test 2: API key check
  addLog('');
  addLog('>>> Step 2: Test search API via proxy');
  if (!apiKey) {
    addLog('    No API key entered. Paste one above first.');
    statusEl.textContent = 'No API key';
    statusEl.style.color = 'var(--red-neon)';
    return;
  }
  addLog(`    Key: ${apiKey.slice(0, 8)}...`);

  try {
    const resp = await fetch(SEARCH_PROXY_URL + '/web_search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${apiKey}`
      },
      body: JSON.stringify({ query: 'test', max_results: 2 })
    });

    addLog(`    HTTP Status: ${resp.status}`);
    const raw = await resp.text();
    addLog(`    Response body:`);
    addLog('    ' + raw.slice(0, 800));

    if (!resp.ok) {
      statusEl.textContent = `Failed: HTTP ${resp.status}`;
      statusEl.style.color = 'var(--red-neon)';
      return;
    }

    try {
      const data = JSON.parse(raw);
      if (data.error) {
        addLog(`    API Error: ${data.error}`);
        statusEl.textContent = 'API error (see below)';
        statusEl.style.color = 'var(--red-neon)';
      } else if (data.results && data.results.length > 0) {
        addLog(`    Got ${data.results.length} results — search is working!`);
        statusEl.textContent = `Working! (${data.results.length} results)`;
        statusEl.style.color = 'var(--green-neon)';
      } else {
        addLog('    Parsed OK but no results array found.');
        addLog('    Keys in response: ' + Object.keys(data).join(', '));
        statusEl.textContent = 'Unexpected response format';
        statusEl.style.color = 'var(--red-neon)';
      }
    } catch (pe) {
      addLog(`    Response is not valid JSON: ${pe.message}`);
      statusEl.textContent = 'Invalid JSON response';
      statusEl.style.color = 'var(--red-neon)';
    }
  } catch (e) {
    addLog(`    Fetch failed: ${e.message}`);
    statusEl.textContent = 'Request failed';
    statusEl.style.color = 'var(--red-neon)';
  }
}

function formatSearchResults(results) {
  if (!results || results.length === 0) return '';
  let text = '\n\n[Web Search Results]\n';
  for (const r of results) text += `- ${r.title}: ${r.content}\n  Source: ${r.url}\n`;
  text += '[End of Search Results]\n\nUse the search results above to inform your response. Cite sources when relevant.';
  return text;
}

/* ================================================================
   LLAMA.CPP CONNECTION CHECK
================================================================ */
async function checkConnection() {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-label');
  try {
    const resp = await privacyFetch(LLAMA_URL + '/health');
    if (resp.ok) {
      const data = await resp.json();
      serverConnected = true;
      dot.classList.add('connected');
      // llama.cpp /health returns {"status":"ok"} when model is loaded
      const ready = data.status === 'ok';
      label.textContent = ready ? 'Connected' : `Loading model...`;
      label.style.color = ready ? '' : 'var(--magenta)';
      return;
    }
    serverConnected = false;
    dot.classList.remove('connected');
    label.textContent = `Error: HTTP ${resp.status}`;
    label.style.color = 'var(--red-neon)';
  } catch (e) {
    serverConnected = false;
    dot.classList.remove('connected');
    label.textContent = (e.message === 'Failed to fetch' || e.name === 'TypeError')
      ? 'No connection' : `Error: ${e.message.slice(0, 30)}`;
    label.style.color = 'var(--red-neon)';
  }
}

