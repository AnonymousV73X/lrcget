/* ============================================================
   LyricVault — vanilla JS (v6 — perf edition)
   No build step, no dependencies. Talks to LRCLIB directly.
   ============================================================ */

(() => {
  "use strict";

  // ---------------- Config ----------------
  const LRCLIB = "https://lrclib.net/api";
  const SEARCH_DEBOUNCE_MS = 120;
  const PREFETCH_DELAY_MS = 120;
  const CACHE_TTL_MS = 30 * 60 * 1000; // 30 min in-memory
  const PUBLISH_CHALLENGE_TIMEOUT_MS = 30000;
  const MOBILE_BREAKPOINT = 560;

  // ---------------- State ----------------
  const state = {
    currentSearchController: null,
    cache: new Map(),
    prefetchTimers: new Map(),
    // Indexed cache of lyric line DOM nodes — rebuilt on each modal open
    // so updatePlayerUI never queries the DOM per-frame.
    lyricLineEls: [],
    player: {
      timer: null,
      current: null,
      currentTime: 0,
      playing: false,
      lastActiveIdx: -1,
      mode: "highlight",
    },
  };

  // ---------------- DOM helpers ----------------
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  // ============================================================
  // sessionStorage-backed cache (survives page reload on surge.sh)
  // ============================================================
  const SS_PREFIX = "lv:";

  function cacheKey(method, url) {
    return `${method}:${url}`;
  }

  function cacheGet(key) {
    // 1. in-memory first (fastest)
    const mem = state.cache.get(key);
    if (mem) {
      if (Date.now() < mem.expireAt) return mem.value;
      state.cache.delete(key);
    }
    // 2. sessionStorage fallback
    try {
      const raw = sessionStorage.getItem(SS_PREFIX + key);
      if (raw) {
        const entry = JSON.parse(raw);
        if (Date.now() < entry.expireAt) {
          // Promote back to memory
          state.cache.set(key, entry);
          return entry.value;
        }
        sessionStorage.removeItem(SS_PREFIX + key);
      }
    } catch (_) {}
    return null;
  }

  function cacheSet(key, value) {
    const entry = { value, expireAt: Date.now() + CACHE_TTL_MS };
    state.cache.set(key, entry);
    try {
      sessionStorage.setItem(SS_PREFIX + key, JSON.stringify(entry));
    } catch (_) {}
  }

  // ============================================================
  // Utilities
  // ============================================================

  function debounce(fn, ms) {
    let t;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), ms);
    };
  }

  function formatTime(sec) {
    if (!sec || sec < 0 || isNaN(sec)) return "0:00";
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  const ESC_MAP = {
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  };
  function escapeHtml(s) {
    if (s == null) return "";
    return String(s).replace(/[&<>"']/g, (c) => ESC_MAP[c]);
  }

  let _toastTimer;
  function showToast(message, type = "info") {
    const toast = $("#toast");
    toast.textContent = message;
    toast.className = `toast ${type}`;
    toast.hidden = false;
    requestAnimationFrame(() => toast.classList.add("show"));
    clearTimeout(_toastTimer);
    _toastTimer = setTimeout(() => {
      toast.classList.remove("show");
      setTimeout(() => {
        toast.hidden = true;
      }, 300);
    }, 3200);
  }

  // ============================================================
  // LRCLIB client
  // ============================================================

  async function lrclibFetch(
    path,
    { method = "GET", body, signal, headers } = {},
  ) {
    const url = `${LRCLIB}${path}`;
    const opts = {
      method,
      signal,
      headers: { Accept: "application/json", ...(headers || {}) },
    };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try {
        const e = await res.json();
        if (e.message || e.error) msg = e.message || e.error;
      } catch (_) {}
      const err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function searchLRCLIB(query) {
    if (!query || !query.trim()) return [];
    const params = new URLSearchParams({ q: query.trim() });
    const path = `/search?${params}`;
    const key = cacheKey("GET", path);

    if (state.currentSearchController) state.currentSearchController.abort();
    const controller = new AbortController();
    state.currentSearchController = controller;

    const cached = cacheGet(key);
    if (cached) {
      // Serve cache instantly, revalidate in background
      const revalidate = lrclibFetch(path, { signal: controller.signal })
        .then((fresh) => {
          cacheSet(key, fresh);
          return fresh;
        })
        .catch(() => cached);
      return { data: cached, fromCache: true, revalidate };
    }

    const data = await lrclibFetch(path, { signal: controller.signal });
    cacheSet(key, data);
    return { data, fromCache: false, revalidate: null };
  }

  async function getBySignature({
    artist,
    title,
    album,
    duration,
    cached = false,
  }) {
    const params = new URLSearchParams({
      artist_name: artist,
      track_name: title,
    });
    if (album) params.set("album_name", album);
    if (duration) params.set("duration", String(duration));
    const path = `${cached ? "/get-cached" : "/get"}?${params}`;
    const key = cacheKey("GET", path);
    const hit = cacheGet(key);
    if (hit) return { data: hit, fromCache: true };
    const data = await lrclibFetch(path);
    if (data) cacheSet(key, data);
    return { data, fromCache: false };
  }

  async function getById(id) {
    const path = `/get/${encodeURIComponent(id)}`;
    const key = cacheKey("GET", path);
    const hit = cacheGet(key);
    if (hit) return { data: hit, fromCache: true };
    const data = await lrclibFetch(path);
    if (data) cacheSet(key, data);
    return { data, fromCache: false };
  }

  function prefetchRecord(record) {
    if (!record?.id) return;
    if (state.prefetchTimers.has(record.id)) return;
    const path = `/get/${record.id}`;
    const key = cacheKey("GET", path);
    if (cacheGet(key)) return;
    const t = setTimeout(() => {
      state.prefetchTimers.delete(record.id);
      lrclibFetch(path)
        .then((data) => {
          if (data) cacheSet(key, data);
        })
        .catch(() => {});
    }, PREFETCH_DELAY_MS);
    state.prefetchTimers.set(record.id, t);
  }

  function cancelPrefetch(id) {
    const t = state.prefetchTimers.get(id);
    if (t) {
      clearTimeout(t);
      state.prefetchTimers.delete(id);
    }
  }

  // ============================================================
  // Synced lyrics parser
  // ============================================================

  function parseSyncedLyrics(raw) {
    if (!raw || typeof raw !== "string") return null;
    const regex = /\[(\d{1,2}):(\d{2})(?:[.:](\d{1,3}))?\]\s*(.*)/;
    const out = [];
    for (const line of raw.split(/\r?\n/)) {
      const m = line.match(regex);
      if (!m) continue;
      const fracStr = m[3] || "0";
      let frac = parseInt(fracStr, 10);
      if (fracStr.length === 1) frac *= 100;
      else if (fracStr.length === 2) frac *= 10;
      out.push({
        time: parseInt(m[1], 10) * 60 + parseInt(m[2], 10) + frac / 1000,
        text: (m[4] || "").trim(),
      });
    }
    if (!out.length) return null;
    out.sort((a, b) => a.time - b.time);
    return out;
  }

  // ============================================================
  // Proof-of-work
  // ============================================================

  async function solveChallenge(prefix, target) {
    const targetHex = target.toLowerCase();
    let nonce = 0;
    const encoder = new TextEncoder();
    const deadline = Date.now() + PUBLISH_CHALLENGE_TIMEOUT_MS;
    const BATCH = 5000;
    while (Date.now() < deadline) {
      const promises = [];
      for (let i = 0; i < BATCH; i++) {
        promises.push(
          crypto.subtle
            .digest("SHA-256", encoder.encode(`${prefix}:${nonce + i}`))
            .then((buf) => {
              const h = bufToHex(buf);
              return h < targetHex ? nonce + i : -1;
            }),
        );
      }
      const results = await Promise.all(promises);
      for (const r of results) {
        if (r >= 0) return r;
      }
      nonce += BATCH;
      await new Promise((r) => setTimeout(r, 0));
    }
    throw new Error("Challenge timed out. Please try again.");
  }

  function bufToHex(buf) {
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // ============================================================
  // Search tab
  // ============================================================

  const searchInput = $("#search-input");
  const searchClear = $("#search-clear");
  const resultsEl = $("#search-results");
  const skeletonEl = $("#search-skeleton");
  const emptyEl = $("#search-empty");
  const countEl = $("#result-count");
  const timeEl = $("#search-time");
  const cacheEl = $("#cache-status");

  // Record map keyed by id for O(1) lookup in event handlers
  let _lastRecords = new Map();

  const performSearch = debounce(async (q) => {
    if (!q.trim()) {
      resultsEl.innerHTML = "";
      emptyEl.hidden = true;
      skeletonEl.hidden = true;
      countEl.textContent = "";
      timeEl.textContent = "";
      cacheEl.textContent = "";
      cacheEl.classList.remove("hit");
      return;
    }

    skeletonEl.hidden = false;
    emptyEl.hidden = true;
    resultsEl.innerHTML = "";
    renderSkeletons(4);

    const t0 = performance.now();
    try {
      const result = await searchLRCLIB(q);
      const data = result.data || [];
      const elapsed = Math.round(performance.now() - t0);
      skeletonEl.hidden = true;
      countEl.textContent = `${data.length} result${data.length === 1 ? "" : "s"}`;
      timeEl.textContent = `${elapsed}ms`;
      cacheEl.textContent = result.fromCache ? "cache hit" : "live";
      cacheEl.classList.toggle("hit", result.fromCache);
      if (!data.length) {
        emptyEl.hidden = false;
        return;
      }
      renderResults(data);
      if (result.revalidate) {
        result.revalidate.then((fresh) => {
          if (
            fresh &&
            Array.isArray(fresh) &&
            !state.currentSearchController?.signal?.aborted
          ) {
            renderResults(fresh);
            countEl.textContent = `${fresh.length} result${fresh.length === 1 ? "" : "s"}`;
          }
        });
      }
    } catch (err) {
      if (err.name === "AbortError") return;
      skeletonEl.hidden = true;
      resultsEl.innerHTML = "";
      emptyEl.hidden = false;
      emptyEl.querySelector("p").textContent = `Search failed: ${err.message}`;
      countEl.textContent = "";
      timeEl.textContent = "";
      cacheEl.textContent = "";
    }
  }, SEARCH_DEBOUNCE_MS);

  function renderSkeletons(n) {
    skeletonEl.innerHTML = Array.from({ length: n })
      .map(() => '<div class="skeleton-card"></div>')
      .join("");
  }

  function renderResults(records) {
    // Build record map for O(1) click lookups
    _lastRecords = new Map(records.map((r) => [String(r.id), r]));

    // Use DocumentFragment to batch DOM insertion — single reflow
    const frag = document.createDocumentFragment();
    records.forEach((r, i) => {
      const el = document.createElement("article");
      el.className = "result-card";
      el.dataset.id = r.id;
      el.style.animationDelay = `${Math.min(i * 20, 200)}ms`;
      el.tabIndex = 0;
      el.setAttribute("role", "button");
      const title = escapeHtml(r.trackName || "Untitled");
      const artist = escapeHtml(r.artistName || "Unknown artist");
      const album = r.albumName ? escapeHtml(r.albumName) : "";
      const duration = r.duration ? formatTime(r.duration) : "";
      const initial = (r.trackName || "?").trim().charAt(0).toUpperCase();
      const synced = !!r.syncedLyrics;
      const plain = !synced && !!r.plainLyrics;
      const tags = [
        synced ? '<span class="tag synced">Synced</span>' : "",
        plain ? '<span class="tag plain">Plain</span>' : "",
        album ? `<span class="tag">${album}</span>` : "",
      ].join("");
      el.innerHTML = `
        <div class="card-header">
          <div class="card-art">${escapeHtml(initial)}</div>
          <div class="card-text">
            <h3 class="card-title">${title}</h3>
            <p class="card-artist">${artist}</p>
          </div>
        </div>
        <div class="card-meta">${tags}${duration ? `<span class="card-duration">· ${duration}</span>` : ""}</div>`;
      frag.appendChild(el);
    });

    resultsEl.innerHTML = "";
    resultsEl.appendChild(frag);

    // Event delegation — single listener on the grid, O(1) lookup
    resultsEl.onclick = (e) => {
      const card = e.target.closest(".result-card");
      if (!card) return;
      const record = _lastRecords.get(card.dataset.id);
      if (record) openLyricsModal(record);
    };
    resultsEl.addEventListener(
      "mouseover",
      (e) => {
        const card = e.target.closest(".result-card");
        if (card) prefetchRecord(_lastRecords.get(card.dataset.id));
      },
      { passive: true },
    );
    resultsEl.addEventListener(
      "mouseout",
      (e) => {
        const card = e.target.closest(".result-card");
        if (card) cancelPrefetch(card.dataset.id);
      },
      { passive: true },
    );
  }

  searchInput.addEventListener("input", (e) => {
    const v = e.target.value;
    searchClear.hidden = !v;
    performSearch(v);
  });
  searchClear.addEventListener("click", () => {
    searchInput.value = "";
    searchClear.hidden = true;
    performSearch("");
    searchInput.focus();
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault();
      switchTab("search");
      searchInput.focus();
      searchInput.select();
    }
    if (e.key === "Escape") closeModal();
  });

  // ============================================================
  // Lookup tab
  // ============================================================

  $("#lookup-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(e.target);
    const params = {
      artist: fd.get("artist").trim(),
      title: fd.get("title").trim(),
      album: fd.get("album").trim() || undefined,
      duration: fd.get("duration") ? Number(fd.get("duration")) : undefined,
      cached: fd.get("cached") === "on",
    };
    if (!params.artist || !params.title) {
      showToast("Artist and title are required", "error");
      return;
    }
    const out = $("#lookup-result");
    out.innerHTML = loadingHtml();
    try {
      const { data, fromCache } = await getBySignature(params);
      if (!data) {
        out.innerHTML = notFoundHtml(
          "No matching record. Try the cached endpoint or refine album/duration.",
        );
        return;
      }
      out.innerHTML = detailPanelHtml(data, fromCache);
      wireDetailPanel(out, data);
    } catch (err) {
      if (err.status === 404)
        out.innerHTML = notFoundHtml("No matching record found (404).");
      else
        out.innerHTML = `<div class="detail-panel"><p style="color:var(--danger)">Error: ${escapeHtml(err.message)}</p></div>`;
    }
  });

  // ============================================================
  // By ID tab
  // ============================================================

  $("#byid-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const id = new FormData(e.target).get("id").trim();
    if (!id) return;
    const out = $("#byid-result");
    out.innerHTML = loadingHtml();
    try {
      const { data, fromCache } = await getById(id);
      if (!data) {
        out.innerHTML = notFoundHtml(`No record with ID ${id}.`);
        return;
      }
      out.innerHTML = detailPanelHtml(data, fromCache);
      wireDetailPanel(out, data);
    } catch (err) {
      if (err.status === 404)
        out.innerHTML = notFoundHtml(`No record with ID ${id} (404).`);
      else
        out.innerHTML = `<div class="detail-panel"><p style="color:var(--danger)">Error: ${escapeHtml(err.message)}</p></div>`;
    }
  });

  function loadingHtml() {
    return `<div class="detail-panel" style="text-align:center;color:var(--text-muted)"><div class="empty-icon">⏳</div><p>Fetching from LRCLIB…</p></div>`;
  }
  function notFoundHtml(msg) {
    return `<div class="detail-panel" style="text-align:center"><div class="empty-icon">🔍</div><p style="color:var(--text-muted)">${escapeHtml(msg)}</p></div>`;
  }
  function detailPanelHtml(r, fromCache) {
    const title = escapeHtml(r.trackName || "Untitled");
    const artist = escapeHtml(r.artistName || "Unknown");
    const album = r.albumName ? escapeHtml(r.albumName) : "";
    const duration = r.duration ? formatTime(r.duration) : "";
    const initial = (r.trackName || "?").trim().charAt(0).toUpperCase();
    const synced = !!r.syncedLyrics,
      plain = !synced && !!r.plainLyrics;
    return `
      <div class="detail-panel">
        <div class="detail-head">
          <div class="detail-art">${escapeHtml(initial)}</div>
          <div style="flex:1;min-width:0">
            <h3 class="detail-title">${title}</h3>
            <p class="detail-sub">${artist}${album ? ` · ${album}` : ""}${duration ? ` · ${duration}` : ""}</p>
            <div class="detail-tags">
              ${synced ? '<span class="tag synced">Synced</span>' : ""}
              ${plain ? '<span class="tag plain">Plain</span>' : ""}
              <span class="tag">ID ${escapeHtml(r.id)}</span>
              ${fromCache ? '<span class="tag">cache</span>' : ""}
            </div>
          </div>
        </div>
        <div class="detail-actions">
          <button class="btn btn-primary" data-open-lyrics>View lyrics</button>
          <a class="btn" href="https://lrclib.net/api/get/${encodeURIComponent(r.id)}" target="_blank" rel="noopener">Raw JSON ↗</a>
        </div>
      </div>`;
  }
  function wireDetailPanel(root, record) {
    const btn = root.querySelector("[data-open-lyrics]");
    if (btn) btn.addEventListener("click", () => openLyricsModal(record));
  }

  // ============================================================
  // Publish tab
  // ============================================================

  $("#publish-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target;
    const fd = new FormData(form);
    const submitBtn = $("#publish-submit");
    const statusEl = $("#publish-status");
    const payload = {
      track_name: fd.get("track_name").trim(),
      artist_name: fd.get("artist_name").trim(),
      album_name: fd.get("album_name").trim() || null,
      duration: Number(fd.get("duration")),
      plain_lyrics: fd.get("plain_lyrics").trim() || null,
      synced_lyrics: fd.get("synced_lyrics").trim() || null,
    };
    if (!payload.track_name || !payload.artist_name || !payload.duration) {
      showToast("Track name, artist, and duration are required", "error");
      return;
    }
    if (!payload.plain_lyrics && !payload.synced_lyrics) {
      showToast("Provide either plain or synced lyrics", "error");
      return;
    }
    submitBtn.disabled = true;
    statusEl.textContent = "Requesting proof-of-work challenge…";
    try {
      const challenge = await lrclibFetch("/request-challenge", {
        method: "POST",
        body: {
          track_name: payload.track_name,
          artist_name: payload.artist_name,
          album_name: payload.album_name || "",
          duration: payload.duration,
        },
      });
      statusEl.textContent = "Solving challenge… this may take a moment.";
      const nonce = await solveChallenge(challenge.prefix, challenge.target);
      statusEl.textContent = "Challenge solved ✓ · publishing…";
      const result = await lrclibFetch("/publish", {
        method: "POST",
        headers: {
          "X-Publish-Token": challenge.token,
          "X-Publish-Challenge": `${challenge.prefix}:${nonce}`,
        },
        body: payload,
      });
      submitBtn.disabled = false;
      statusEl.textContent = "";
      showToast("Lyrics published successfully 🎉", "success");
      form.reset();
      if (result?.id) setTimeout(() => openLyricsModal(result), 600);
    } catch (err) {
      submitBtn.disabled = false;
      statusEl.textContent = "";
      showToast(`Publish failed: ${err.message}`, "error");
    }
  });

  // ============================================================
  // Lyrics modal + player
  // ============================================================

  const modal = $("#lyrics-modal");
  const modalTitle = $("#modal-title");
  const modalSubtitle = $("#modal-subtitle");
  const modalId = $("#modal-id");
  const modalLink = $("#modal-link");
  const copyLyricsBtn = $("#copy-lyrics-btn");
  const downloadLrcBtn = $("#download-lrc-btn");
  const lyricsInner = $("#lyrics-inner");
  const lyricsScroll = $("#lyrics-scroll");
  const playToggle = $("#play-toggle");
  const restartBtn = $("#restart-btn");
  const progress = $("#progress");
  const currentTimeEl = $("#current-time");
  const totalTimeEl = $("#total-time");
  const iconPlay = playToggle.querySelector(".icon-play");
  const iconPause = playToggle.querySelector(".icon-pause");

  function openLyricsModal(record) {
    const path = `/get/${record.id}`;
    const full = cacheGet(cacheKey("GET", path)) || record;

    state.player.current = null;
    state.player.currentTime = 0;
    state.player.playing = false;
    stopPlayer();

    modalTitle.textContent = full.trackName || "Untitled";
    modalSubtitle.textContent = `${full.artistName || "Unknown"}${full.albumName ? " · " + full.albumName : ""}${full.duration ? " · " + formatTime(full.duration) : ""}`;
    modalId.textContent = `#${full.id}`;
    modalLink.href = `https://lrclib.net/api/get/${encodeURIComponent(full.id)}`;

    const lyricsText = full.syncedLyrics || full.plainLyrics || "";
    if (copyLyricsBtn) {
      copyLyricsBtn.onclick = () => {
        navigator.clipboard
          .writeText(lyricsText)
          .then(() => showToast("Lyrics copied ✓", "success"))
          .catch(() => showToast("Copy failed", "error"));
      };
      copyLyricsBtn.style.display = lyricsText ? "" : "none";
    }
    if (downloadLrcBtn) {
      if (full.syncedLyrics) {
        const blob = new Blob([full.syncedLyrics], { type: "text/plain" });
        downloadLrcBtn.href = URL.createObjectURL(blob);
        downloadLrcBtn.download =
          `${full.trackName || "lyrics"} - ${full.artistName || "unknown"}.lrc`.replace(
            /[/\\?%*:|"<>]/g,
            "-",
          );
        downloadLrcBtn.style.display = "";
      } else {
        downloadLrcBtn.style.display = "none";
      }
    }

    const lines = parseSyncedLyrics(full.syncedLyrics);
    const duration =
      full.duration || (lines?.length ? lines[lines.length - 1].time + 5 : 0);

    if (lines?.length) {
      // Build DOM via fragment — single reflow
      const frag = document.createDocumentFragment();
      state.lyricLineEls = [];
      lines.forEach((l, i) => {
        const p = document.createElement("p");
        p.className = `lyric-line${l.text ? "" : " empty"}`;
        p.dataset.time = l.time.toFixed(2);
        p.dataset.index = i;
        p.textContent = l.text || "·";
        p.addEventListener("click", () => seekTo(l.time), { passive: true });
        frag.appendChild(p);
        state.lyricLineEls.push(p);
      });
      lyricsInner.innerHTML = "";
      lyricsInner.appendChild(frag);
      lyricsInner.setAttribute("data-mode", "highlight");
      state.player.current = { lines, duration, plain: false };
    } else if (full.plainLyrics) {
      const frag = document.createDocumentFragment();
      state.lyricLineEls = [];
      for (const l of full.plainLyrics.split(/\r?\n/)) {
        const p = document.createElement("p");
        p.className = "lyric-line plain";
        p.textContent = l || "\u00A0";
        frag.appendChild(p);
        state.lyricLineEls.push(p);
      }
      lyricsInner.innerHTML = "";
      lyricsInner.appendChild(frag);
      lyricsInner.removeAttribute("data-mode");
      state.player.current = { lines: null, duration, plain: true };
    } else {
      lyricsInner.innerHTML =
        '<p class="lyrics-empty">No lyrics available for this track.</p>';
      state.lyricLineEls = [];
      state.player.current = null;
      lyricsInner.removeAttribute("data-mode");
    }

    // Hide mode/speed controls (typewriter removed)
    const modeToggle = $("#mode-toggle");
    const speedSel = $("#speed-select");
    if (modeToggle) modeToggle.style.display = "none";
    if (speedSel) speedSel.parentElement.style.display = "none";

    progress.value = 0;
    progress.max = duration || 100;
    currentTimeEl.textContent = "0:00";
    totalTimeEl.textContent = formatTime(duration);
    iconPlay.hidden = false;
    iconPause.hidden = true;
    playToggle.classList.remove("is-playing");

    modal.hidden = false;
    document.body.style.overflow = "hidden";

    if (state.player.current && !state.player.current.plain) {
      setTimeout(() => togglePlay(), 350);
    }
  }

  function closeModal() {
    modal.hidden = true;
    document.body.style.overflow = "";
    stopPlayer();
    state.player.current = null;
    state.player.playing = false;
  }

  $$("[data-close]", modal).forEach((el) =>
    el.addEventListener("click", closeModal),
  );

  function togglePlay() {
    if (!state.player.current || state.player.current.plain) return;
    state.player.playing ? pausePlayer() : startPlayer();
  }

  function startPlayer() {
    if (!state.player.current) return;
    state.player.playing = true;
    iconPlay.hidden = true;
    iconPause.hidden = false;
    playToggle.classList.add("is-playing");
    let last = performance.now();
    const tick = (now) => {
      if (!state.player.playing) return;
      state.player.currentTime += (now - last) / 1000;
      last = now;
      const dur = state.player.current?.duration || 0;
      if (state.player.currentTime >= dur) {
        state.player.currentTime = dur;
        pausePlayer();
      }
      updatePlayerUI();
      state.player.timer = requestAnimationFrame(tick);
    };
    state.player.timer = requestAnimationFrame(tick);
  }

  function pausePlayer() {
    state.player.playing = false;
    iconPlay.hidden = false;
    iconPause.hidden = true;
    playToggle.classList.remove("is-playing");
    if (state.player.timer) {
      cancelAnimationFrame(state.player.timer);
      state.player.timer = null;
    }
  }

  function stopPlayer() {
    pausePlayer();
    state.player.currentTime = 0;
    state.player.lastActiveIdx = -1;
    progress.value = 0;
    currentTimeEl.textContent = "0:00";
    state.lyricLineEls.forEach((el) => el.classList.remove("active"));
  }

  function seekTo(t) {
    state.player.currentTime = Math.max(
      0,
      Math.min(t, state.player.current?.duration || t),
    );
    state.player.lastActiveIdx = -1;
    updatePlayerUI();
    if (state.player.playing) {
      pausePlayer();
      startPlayer();
    }
  }

  // Smooth scroll helper — rAF-based easing, no layout thrash
  let _scrollRaf = null;
  function smoothScrollTo(container, targetTop) {
    if (_scrollRaf) cancelAnimationFrame(_scrollRaf);
    const start = container.scrollTop;
    const delta = targetTop - start;
    if (Math.abs(delta) < 2) return;
    const duration = 280;
    const startTime = performance.now();
    const ease = (t) => (t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t); // easeInOutQuad
    const step = (now) => {
      const elapsed = now - startTime;
      const progress = Math.min(elapsed / duration, 1);
      container.scrollTop = start + delta * ease(progress);
      if (progress < 1) _scrollRaf = requestAnimationFrame(step);
    };
    _scrollRaf = requestAnimationFrame(step);
  }

  function updatePlayerUI() {
    const cur = state.player.current;
    if (!cur) return;
    const t = state.player.currentTime;
    progress.value = Math.min(t, cur.duration || 0);
    currentTimeEl.textContent = formatTime(t);

    if (!cur.plain && cur.lines) {
      // Binary search — O(log n) instead of O(n)
      let lo = 0,
        hi = cur.lines.length - 1,
        activeIdx = -1;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (cur.lines[mid].time <= t) {
          activeIdx = mid;
          lo = mid + 1;
        } else hi = mid - 1;
      }

      if (activeIdx !== state.player.lastActiveIdx) {
        const prev = state.player.lastActiveIdx;
        state.player.lastActiveIdx = activeIdx;

        // Only touch changed elements — no full-list iteration
        if (prev >= 0 && prev < state.lyricLineEls.length)
          state.lyricLineEls[prev].classList.remove("active");
        let activeEl = null;
        if (activeIdx >= 0 && activeIdx < state.lyricLineEls.length) {
          state.lyricLineEls[activeIdx].classList.add("active");
          activeEl = state.lyricLineEls[activeIdx];
        }

        if (activeEl) {
          const scrollRect = lyricsScroll.getBoundingClientRect();
          const elRect = activeEl.getBoundingClientRect();
          const target =
            lyricsScroll.scrollTop +
            (elRect.top - scrollRect.top) -
            scrollRect.height / 2 +
            elRect.height / 2;
          smoothScrollTo(lyricsScroll, target);
        }
      }
    }
  }

  playToggle.addEventListener("click", togglePlay);
  restartBtn.addEventListener("click", () => {
    state.player.currentTime = 0;
    state.player.lastActiveIdx = -1;
    updatePlayerUI();
  });
  progress.addEventListener("input", (e) => seekTo(parseFloat(e.target.value)));

  // Keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    if (!modal || modal.hidden) return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea" || tag === "select") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.code === "Space" || e.key === " ") {
      e.preventDefault();
      togglePlay();
    } else if (e.key.toLowerCase() === "r") {
      e.preventDefault();
      state.player.currentTime = 0;
      state.player.lastActiveIdx = -1;
      updatePlayerUI();
    }
  });

  // ============================================================
  // Tabs
  // ============================================================

  function switchTab(name) {
    $$(".tab").forEach((t) => {
      const active = t.dataset.tab === name;
      t.classList.toggle("active", active);
      t.setAttribute("aria-selected", active ? "true" : "false");
    });
    $$(".tab-panel").forEach((p) => {
      const active = p.id === `tab-${name}`;
      p.classList.toggle("active", active);
      p.hidden = !active;
    });
    if (name === "search") setTimeout(() => searchInput.focus(), 80);
  }
  $$(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      switchTab(t.dataset.tab);
      closeMobileMenu();
    }),
  );

  // ============================================================
  // Mobile menu
  // ============================================================

  const menuToggle = $("#menu-toggle");
  const tabsNav = $("#primary-tabs");

  function openMobileMenu() {
    if (!menuToggle || !tabsNav) return;
    menuToggle.classList.add("is-open");
    menuToggle.setAttribute("aria-expanded", "true");
    tabsNav.classList.add("is-open");
  }
  function closeMobileMenu() {
    if (!menuToggle || !tabsNav) return;
    menuToggle.classList.remove("is-open");
    menuToggle.setAttribute("aria-expanded", "false");
    tabsNav.classList.remove("is-open");
  }
  function isMobile() {
    return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT}px)`).matches;
  }

  if (menuToggle) {
    menuToggle.addEventListener("click", (e) => {
      e.stopPropagation();
      menuToggle.classList.contains("is-open")
        ? closeMobileMenu()
        : openMobileMenu();
    });
    document.addEventListener("click", (e) => {
      if (!isMobile() || !menuToggle.classList.contains("is-open")) return;
      if (!tabsNav.contains(e.target) && !menuToggle.contains(e.target))
        closeMobileMenu();
    });
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape" && menuToggle.classList.contains("is-open"))
        closeMobileMenu();
    });
    window.addEventListener(
      "resize",
      () => {
        if (!isMobile()) closeMobileMenu();
      },
      { passive: true },
    );
  }

  // ============================================================
  // Theme toggle
  // ============================================================

  const themeBtn = $("#theme-toggle");
  try {
    const saved = localStorage.getItem("lv-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (_) {}
  themeBtn.addEventListener("click", () => {
    const next =
      document.documentElement.getAttribute("data-theme") === "dark"
        ? "light"
        : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("lv-theme", next);
    } catch (_) {}
  });

  // ============================================================
  // Init
  // ============================================================

  function init() {
    emptyEl.hidden = false;
    if (!isMobile()) searchInput.focus();
  }
  init();

  window.LyricVault = {
    cache: state.cache,
    search: searchLRCLIB,
    getById,
    getBySignature,
    openLyricsModal,
  };
})();
