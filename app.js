(function () {
  "use strict";

  // ---------- Constants ----------
  const IMPOSTOR_START_WEIGHT = 0.5;
  const WORD_HISTORY_MAX = 40;
  const MIN_PLAYERS = 3;
  const TROLL_ROUND_PROBABILITY = 0.2;
  const TROLL_COOLDOWN_ROUNDS = 2;
  const SAME_TROLL_TYPE_REPEAT_WEIGHT = 0.3;
  const TARGET_IS_IMPOSTOR_PROBABILITY = 0.85;

  const TROLL_TYPES = ["everyoneImpostor", "differentWords", "nameWord"];

  const STORAGE_KEYS = {
    players: "impostor_players",
    settings: "impostor_settings",
    wordHistory: "impostor_wordHistory",
    roundState: "impostor_roundState",
    trollState: "impostor_trollState"
  };

  const DEFAULT_SETTINGS = {
    impostorCount: 1,
    impostorsKnowEachOther: false,
    impostorCanStart: true,
    trollRoundsEnabled: false,
    categories: { generic: true, israeli: true }
  };

  // ---------- Storage helpers ----------
  function loadJSON(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function saveJSON(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch (e) {
      /* storage unavailable — fail silently */
    }
  }

  // ---------- State ----------
  let players = loadJSON(STORAGE_KEYS.players, []);
  let settings = Object.assign(
    {},
    DEFAULT_SETTINGS,
    loadJSON(STORAGE_KEYS.settings, {})
  );
  if (!settings.categories) settings.categories = { generic: true, israeli: true };
  let wordHistory = loadJSON(STORAGE_KEYS.wordHistory, []);
  let roundState = loadJSON(STORAGE_KEYS.roundState, null);
  let trollState = Object.assign(
    { roundsSinceLastTroll: TROLL_COOLDOWN_ROUNDS, lastTrollType: null },
    loadJSON(STORAGE_KEYS.trollState, {})
  );

  function savePlayers() {
    saveJSON(STORAGE_KEYS.players, players);
  }
  function saveSettings() {
    saveJSON(STORAGE_KEYS.settings, settings);
  }
  function saveWordHistory() {
    saveJSON(STORAGE_KEYS.wordHistory, wordHistory);
  }
  function saveRoundState() {
    saveJSON(STORAGE_KEYS.roundState, roundState);
  }
  function saveTrollState() {
    saveJSON(STORAGE_KEYS.trollState, trollState);
  }

  // ---------- UI-only (non-persisted) state ----------
  let editingPlayerId = null;
  let settingsOpen = false;
  let startHint = "";
  let revealedCurrent = false; // resets on every fresh handoff / page load
  let confirmingExit = false;

  // ---------- Secure randomness ----------
  function secureRandomUint32() {
    const buf = new Uint32Array(1);
    crypto.getRandomValues(buf);
    return buf[0];
  }

  function secureRandomInt(maxExclusive) {
    if (maxExclusive <= 0) return 0;
    const range = maxExclusive;
    const limit = Math.floor(0x100000000 / range) * range;
    let x;
    do {
      x = secureRandomUint32();
    } while (x >= limit);
    return x % range;
  }

  function secureRandomFloat() {
    return secureRandomUint32() / 0x100000000;
  }

  function secureShuffledIndices(n) {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
      const j = secureRandomInt(i + 1);
      const tmp = arr[i];
      arr[i] = arr[j];
      arr[j] = tmp;
    }
    return arr;
  }

  function weightedRandomPick(items, weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    if (total <= 0) {
      return items[secureRandomInt(items.length)];
    }
    const r = secureRandomFloat() * total;
    let cumulative = 0;
    for (let i = 0; i < items.length; i++) {
      cumulative += weights[i];
      if (r < cumulative) return items[i];
    }
    return items[items.length - 1];
  }

  // ---------- Game logic ----------
  function uid() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "id-" + Date.now() + "-" + Math.random().toString(16).slice(2);
  }

  function pickImpostors(playerList, count) {
    const order = secureShuffledIndices(playerList.length);
    return order.slice(0, count).map((i) => playerList[i].id);
  }

  function pickWord(categories, history, exclude) {
    exclude = exclude || [];
    let pool = [];
    if (categories.generic) pool = pool.concat(WORDS_GENERIC_FULL);
    if (categories.israeli) pool = pool.concat(WORDS_ISRAELI_FULL);
    pool = pool.filter((w) => exclude.indexOf(w) === -1);

    let filtered = pool.filter((w) => history.indexOf(w) === -1);
    let effectiveHistory = history;
    if (filtered.length === 0) {
      effectiveHistory = [];
      filtered = pool;
    }
    const word = filtered[secureRandomInt(filtered.length)];
    const newHistory = effectiveHistory
      .concat([word])
      .slice(-WORD_HISTORY_MAX);
    return { word, newHistory };
  }

  function pickDistinctWords(categories, history, count) {
    const words = [];
    let h = history;
    for (let i = 0; i < count; i++) {
      const r = pickWord(categories, h, words);
      words.push(r.word);
      h = r.newHistory;
    }
    return { words, newHistory: h };
  }

  function maxImpostors() {
    return Math.max(1, Math.floor(players.length / 2));
  }

  function chooseRoundType() {
    if (!settings.trollRoundsEnabled) return "classic";
    if (trollState.roundsSinceLastTroll < TROLL_COOLDOWN_ROUNDS) return "classic";
    if (secureRandomFloat() >= TROLL_ROUND_PROBABILITY) return "classic";
    const weights = TROLL_TYPES.map((t) =>
      t === trollState.lastTrollType ? SAME_TROLL_TYPE_REPEAT_WEIGHT : 1.0
    );
    return weightedRandomPick(TROLL_TYPES, weights);
  }

  function pickStarter(playerList, impostorIds, impostorCanStart) {
    const weights = playerList.map((p) =>
      impostorIds.indexOf(p.id) !== -1
        ? (impostorCanStart ? IMPOSTOR_START_WEIGHT : 0)
        : 1.0
    );
    return weightedRandomPick(playerList, weights).id;
  }

  function enforceSettingsConstraints() {
    const max = maxImpostors();
    if (!(settings.impostorCount >= 1)) settings.impostorCount = 1;
    if (settings.impostorCount > max) {
      settings.impostorCount = max;
      saveSettings();
    }
  }

  function computeDisplayNames(playerList) {
    const counts = {};
    return playerList.map((p) => {
      counts[p.name] = (counts[p.name] || 0) + 1;
      const n = counts[p.name];
      return Object.assign({}, p, {
        displayName: n === 1 ? p.name : p.name + " (" + n + ")"
      });
    });
  }

  function beginRound() {
    enforceSettingsConstraints();
    const type = chooseRoundType();
    if (type === "classic") {
      trollState.roundsSinceLastTroll += 1;
    } else {
      trollState.roundsSinceLastTroll = 0;
      trollState.lastTrollType = type;
    }
    saveTrollState();

    let impostorIds = [];
    let word = null;
    let words = null;
    let targetId = null;
    let starterId;

    if (type === "everyoneImpostor") {
      impostorIds = players.map((p) => p.id);
      starterId = players[secureRandomInt(players.length)].id;
    } else if (type === "differentWords") {
      const r = pickDistinctWords(settings.categories, wordHistory, players.length);
      wordHistory = r.newHistory;
      saveWordHistory();
      words = {};
      players.forEach((p, i) => (words[p.id] = r.words[i]));
      starterId = players[secureRandomInt(players.length)].id;
    } else if (type === "nameWord") {
      const named = computeDisplayNames(players);
      const target = named[secureRandomInt(named.length)];
      targetId = target.id;
      word = target.displayName;
      if (secureRandomFloat() < TARGET_IS_IMPOSTOR_PROBABILITY) {
        impostorIds = [targetId];
      } else {
        const others = players.filter((p) => p.id !== targetId);
        impostorIds = [others[secureRandomInt(others.length)].id];
      }
      starterId = pickStarter(players, impostorIds, settings.impostorCanStart);
    } else {
      impostorIds = pickImpostors(players, settings.impostorCount);
      const r = pickWord(settings.categories, wordHistory);
      word = r.word;
      wordHistory = r.newHistory;
      saveWordHistory();
      starterId = pickStarter(players, impostorIds, settings.impostorCanStart);
    }

    roundState = {
      type: type,
      word: word,
      words: words,
      targetId: targetId,
      impostorIds: impostorIds,
      starterId: starterId,
      order: players.map((p) => p.id),
      currentIndex: 0,
      phase: "reveal"
    };
    saveRoundState();
    revealedCurrent = false;
    confirmingExit = false;
    render();
  }

  function advanceRound() {
    if (!roundState) return;
    vibrate(15);
    if (roundState.currentIndex >= roundState.order.length - 1) {
      roundState.phase = "announce";
    } else {
      roundState.currentIndex += 1;
    }
    saveRoundState();
    revealedCurrent = false;
    render();
  }

  function returnHome() {
    roundState = null;
    confirmingExit = false;
    saveRoundState();
    releaseWakeLock();
    render();
  }

  // ---------- Haptics ----------
  function vibrate(pattern) {
    try {
      if (navigator.vibrate) navigator.vibrate(pattern);
    } catch (e) {
      /* ignore */
    }
  }

  // ---------- Wake Lock ----------
  let wakeLockSentinel = null;
  async function requestWakeLock() {
    if (wakeLockSentinel) return; // already held
    try {
      if ("wakeLock" in navigator) {
        wakeLockSentinel = await navigator.wakeLock.request("screen");
        wakeLockSentinel.addEventListener("release", function () {
          wakeLockSentinel = null;
        });
      }
    } catch (e) {
      /* ignore — fail silently */
    }
  }
  function releaseWakeLock() {
    try {
      if (wakeLockSentinel) {
        wakeLockSentinel.release();
        wakeLockSentinel = null;
      }
    } catch (e) {
      /* ignore */
    }
  }
  document.addEventListener("visibilitychange", function () {
    if (document.visibilityState === "visible" && roundState) {
      requestWakeLock();
    }
  });

  // ---------- Utility ----------
  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : String(str);
    return div.innerHTML;
  }

  function el(id) {
    return document.getElementById(id);
  }

  // ---------- Rendering ----------
  const app = document.getElementById("app");

  function render() {
    if (roundState) {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }

    if (!roundState) {
      renderSetup();
    } else if (roundState.phase === "reveal") {
      renderReveal();
    } else if (roundState.phase === "impostor-reveal") {
      renderImpostorReveal();
    } else {
      renderAnnounce();
    }
  }

  // ----- Setup screen -----
  function renderSetup() {
    enforceSettingsConstraints();
    const named = computeDisplayNames(players);
    const canStart = players.length >= MIN_PLAYERS;
    const maxImp = maxImpostors();

    let rowsHtml = named
      .map((p, idx) => {
        const isEditing = editingPlayerId === p.id;
        return (
          '<div class="player-row" data-id="' + p.id + '">' +
          '<span class="player-order">' + (idx + 1) + "</span>" +
          (isEditing
            ? '<input class="player-name-input" data-role="rename-input" data-id="' +
              p.id +
              '" value="' +
              escapeHtml(p.name) +
              '" maxlength="30">'
            : '<span class="player-name">' + escapeHtml(p.displayName) + "</span>") +
          '<div class="player-actions">' +
          '<button class="icon-btn" data-action="move-up" data-id="' + p.id + '" ' + (idx === 0 ? "disabled" : "") + ' aria-label="הזז למעלה">▲</button>' +
          '<button class="icon-btn" data-action="move-down" data-id="' + p.id + '" ' + (idx === named.length - 1 ? "disabled" : "") + ' aria-label="הזז למטה">▼</button>' +
          (isEditing
            ? '<button class="icon-btn" data-action="save-rename" data-id="' + p.id + '" aria-label="שמור">✓</button>'
            : '<button class="icon-btn" data-action="edit" data-id="' + p.id + '" aria-label="ערוך שם">✎</button>') +
          '<button class="icon-btn danger" data-action="delete" data-id="' + p.id + '" aria-label="מחק שחקן">✕</button>' +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    const startDisabledAttr = canStart ? "" : "disabled";
    const hintHtml = !canStart
      ? '<div class="hint error">נדרשים לפחות ' + MIN_PLAYERS + ' שחקנים כדי להתחיל</div>'
      : startHint
      ? '<div class="hint error">' + escapeHtml(startHint) + "</div>"
      : "";

    app.innerHTML =
      '<div class="screen">' +
      "<h1>אימפוסטר</h1>" +
      '<p class="subtitle">משחק מסיבות להעברה מיד ליד</p>' +
      '<div class="player-list" id="player-list">' +
      rowsHtml +
      "</div>" +
      '<div class="add-player-row">' +
      '<input class="text-input" id="add-player-input" type="text" placeholder="שם שחקן חדש" maxlength="30">' +
      '<button class="btn btn-icon btn-primary" id="add-player-btn" aria-label="הוסף שחקן">+</button>' +
      "</div>" +

      '<div class="settings-section">' +
      '<div class="settings-toggle-header" id="settings-toggle">' +
      "<h2>הגדרות</h2>" +
      '<span class="chevron">' + (settingsOpen ? "▲" : "▼") + "</span>" +
      "</div>" +
      '<div class="settings-body" id="settings-body" ' + (settingsOpen ? "" : "hidden") + ">" +

      '<div class="setting-group">' +
      '<div class="setting-label">מספר אימפוסטרים</div>' +
      '<div class="stepper">' +
      '<button data-action="impostor-minus" aria-label="פחות אימפוסטרים" ' + (settings.impostorCount <= 1 ? "disabled" : "") + ">−</button>" +
      '<span class="stepper-value">' + settings.impostorCount + "</span>" +
      '<button data-action="impostor-plus" aria-label="יותר אימפוסטרים" ' + (settings.impostorCount >= maxImp ? "disabled" : "") + ">+</button>" +
      "</div>" +
      '<div class="setting-note">עד ' + maxImp + " (חצי ממספר השחקנים)</div>" +
      "</div>" +

      '<div class="setting-group">' +
      '<div class="toggle-row">' +
      '<span class="toggle-text">האימפוסטרים יודעים אחד על השני</span>' +
      '<button class="switch ' + (settings.impostorsKnowEachOther ? "on" : "") + '" data-action="toggle-know" aria-label="האימפוסטרים יודעים אחד על השני"></button>' +
      "</div>" +
      "</div>" +

      '<div class="setting-group">' +
      '<div class="toggle-row">' +
      '<span class="toggle-text">האימפוסטר יכול להתחיל</span>' +
      '<button class="switch ' + (settings.impostorCanStart ? "on" : "") + '" data-action="toggle-can-start" aria-label="האימפוסטר יכול להתחיל"></button>' +
      "</div>" +
      "</div>" +

      '<div class="setting-group">' +
      '<div class="toggle-row">' +
      '<span class="toggle-text">אפשר סבבי הטרלה</span>' +
      '<button class="switch ' + (settings.trollRoundsEnabled ? "on" : "") + '" data-action="toggle-troll" aria-label="אפשר סבבי הטרלה"></button>' +
      "</div>" +
      "</div>" +

      '<div class="setting-group">' +
      '<div class="setting-label">קטגוריות מילים</div>' +
      '<div class="toggle-row">' +
      '<span class="toggle-text">כלליות</span>' +
      '<button class="switch ' + (settings.categories.generic ? "on" : "") + '" data-action="toggle-cat-generic" aria-label="קטגוריה כללית"></button>' +
      "</div>" +
      '<div class="toggle-row">' +
      '<span class="toggle-text">ישראליות</span>' +
      '<button class="switch ' + (settings.categories.israeli ? "on" : "") + '" data-action="toggle-cat-israeli" aria-label="קטגוריה ישראלית"></button>' +
      "</div>" +
      "</div>" +

      "</div>" +
      "</div>" +

      hintHtml +
      '<button class="btn btn-primary btn-block" id="start-round-btn" ' + startDisabledAttr + ">התחל סבב</button>" +
      "</div>";

    wireSetupEvents();
  }

  function wireSetupEvents() {
    const addInput = el("add-player-input");
    const addBtn = el("add-player-btn");

    function doAdd() {
      const name = addInput.value.trim();
      if (!name) return;
      players.push({ id: uid(), name: name });
      savePlayers();
      startHint = "";
      render();
      const freshInput = el("add-player-input");
      if (freshInput) freshInput.focus();
    }

    if (addBtn) addBtn.addEventListener("click", doAdd);
    if (addInput) {
      addInput.addEventListener("keydown", function (e) {
        if (e.key === "Enter") {
          e.preventDefault();
          doAdd();
        }
      });
    }

    const list = el("player-list");
    if (list) {
      list.addEventListener("click", function (e) {
        const btn = e.target.closest("button[data-action]");
        if (!btn) return;
        const id = btn.getAttribute("data-id");
        const action = btn.getAttribute("data-action");
        if (action === "move-up") movePlayer(id, -1);
        else if (action === "move-down") movePlayer(id, 1);
        else if (action === "delete") deletePlayer(id);
        else if (action === "edit") {
          editingPlayerId = id;
          render();
          const input = list.querySelector('[data-role="rename-input"]');
          if (input) {
            input.focus();
            input.select();
          }
        } else if (action === "save-rename") {
          const input = list.querySelector(
            '[data-role="rename-input"][data-id="' + id + '"]'
          );
          if (input) renamePlayer(id, input.value);
        }
      });

      list.addEventListener("keydown", function (e) {
        if (e.target.matches('[data-role="rename-input"]') && e.key === "Enter") {
          e.preventDefault();
          renamePlayer(e.target.getAttribute("data-id"), e.target.value);
        }
      });

      list.addEventListener(
        "blur",
        function (e) {
          if (e.target.matches('[data-role="rename-input"]')) {
            renamePlayer(e.target.getAttribute("data-id"), e.target.value);
          }
        },
        true
      );
    }

    const settingsToggle = el("settings-toggle");
    if (settingsToggle) {
      settingsToggle.addEventListener("click", function () {
        settingsOpen = !settingsOpen;
        render();
      });
    }

    [["impostor-minus", -1], ["impostor-plus", 1]].forEach(function (pair) {
      const btn = app.querySelector('[data-action="' + pair[0] + '"]');
      if (!btn) return;
      btn.addEventListener("click", function () {
        const next = settings.impostorCount + pair[1];
        if (next < 1 || next > maxImpostors()) return;
        settings.impostorCount = next;
        saveSettings();
        render();
      });
    });

    const trollBtn = app.querySelector('[data-action="toggle-troll"]');
    if (trollBtn) {
      trollBtn.addEventListener("click", function () {
        settings.trollRoundsEnabled = !settings.trollRoundsEnabled;
        saveSettings();
        render();
      });
    }

    const knowBtn = app.querySelector('[data-action="toggle-know"]');
    if (knowBtn) {
      knowBtn.addEventListener("click", function () {
        settings.impostorsKnowEachOther = !settings.impostorsKnowEachOther;
        saveSettings();
        render();
      });
    }

    const canStartBtn = app.querySelector('[data-action="toggle-can-start"]');
    if (canStartBtn) {
      canStartBtn.addEventListener("click", function () {
        settings.impostorCanStart = !settings.impostorCanStart;
        saveSettings();
        render();
      });
    }

    const catGenericBtn = app.querySelector('[data-action="toggle-cat-generic"]');
    if (catGenericBtn) {
      catGenericBtn.addEventListener("click", function () {
        toggleCategory("generic");
      });
    }
    const catIsraeliBtn = app.querySelector('[data-action="toggle-cat-israeli"]');
    if (catIsraeliBtn) {
      catIsraeliBtn.addEventListener("click", function () {
        toggleCategory("israeli");
      });
    }

    const startBtn = el("start-round-btn");
    if (startBtn) {
      startBtn.addEventListener("click", function () {
        if (players.length < MIN_PLAYERS) {
          startHint = "נדרשים לפחות " + MIN_PLAYERS + " שחקנים כדי להתחיל";
          render();
          return;
        }
        startHint = "";
        beginRound();
      });
    }
  }

  function toggleCategory(key) {
    const other = key === "generic" ? "israeli" : "generic";
    if (settings.categories[key] && !settings.categories[other]) return; // keep at least one on
    settings.categories[key] = !settings.categories[key];
    saveSettings();
    render();
  }

  function movePlayer(id, dir) {
    const idx = players.findIndex((p) => p.id === id);
    if (idx === -1) return;
    const newIdx = idx + dir;
    if (newIdx < 0 || newIdx >= players.length) return;
    const tmp = players[idx];
    players[idx] = players[newIdx];
    players[newIdx] = tmp;
    savePlayers();
    render();
  }

  function deletePlayer(id) {
    players = players.filter((p) => p.id !== id);
    if (editingPlayerId === id) editingPlayerId = null;
    savePlayers();
    enforceSettingsConstraints();
    render();
  }

  function renamePlayer(id, newName) {
    newName = newName.trim();
    const p = players.find((p) => p.id === id);
    if (p && newName) {
      p.name = newName;
      savePlayers();
    }
    editingPlayerId = null;
    render();
  }

  // ----- Reveal screen -----
  function renderReveal() {
    const orderIds = roundState.order;
    const currentId = orderIds[roundState.currentIndex];
    const namedPlayers = computeDisplayNames(players);
    const byId = {};
    namedPlayers.forEach((p) => (byId[p.id] = p));
    const current = byId[currentId] || { displayName: "" };

    const dotsHtml = orderIds
      .map((id, i) =>
        '<span class="progress-dot ' + (i < roundState.currentIndex ? "done" : "") + '"></span>'
      )
      .join("");

    const isLast = roundState.currentIndex === orderIds.length - 1;
    const nextLabel = isLast ? "סיום — מי מתחיל?" : "העבר לשחקן הבא";

    app.innerHTML =
      '<button class="home-corner-btn" id="home-corner-btn" aria-label="בית">⌂ בית</button>' +
      '<div class="screen screen-center">' +
      '<div class="progress-dots">' + dotsHtml + "</div>" +
      '<div class="player-cue">תן/י את הטלפון ל<span class="player-cue-name">' +
      escapeHtml(current.displayName) +
      "</span></div>" +
      '<p class="tap-hint" id="tap-hint">געו בקלף כדי לחשוף</p>' +
      '<div class="card-wrap">' +
      '<div class="card" id="reveal-card">' +
      '<div class="card-face card-front"><div class="card-mark">?</div></div>' +
      '<div class="card-face card-back" id="card-back"></div>' +
      "</div>" +
      "</div>" +
      '<button class="btn btn-primary btn-block" id="next-player-btn" hidden>' + nextLabel + "</button>" +
      "</div>";

    const card = el("reveal-card");
    const nextBtn = el("next-player-btn");
    const cardBack = el("card-back");
    const tapHint = el("tap-hint");

    if (revealedCurrent) {
      // Should not normally happen (state resets on render), but keep consistent if it does.
      populateCardBack(cardBack, currentId, namedPlayers);
      card.classList.add("flipped");
      nextBtn.hidden = false;
      tapHint.style.visibility = "hidden";
    } else {
      card.addEventListener("click", function onReveal() {
        card.removeEventListener("click", onReveal);
        populateCardBack(cardBack, currentId, namedPlayers);
        requestAnimationFrame(function () {
          card.classList.add("flipped");
        });
        vibrate(25);
        revealedCurrent = true;
        nextBtn.hidden = false;
        if (tapHint) tapHint.style.visibility = "hidden";
      });
    }

    nextBtn.addEventListener("click", function () {
      advanceRound();
    });

    el("home-corner-btn").addEventListener("click", showExitDialog);
    if (confirmingExit) showExitDialog();
  }

  function showExitDialog() {
    confirmingExit = true;
    if (el("exit-dialog")) return;
    const wrap = document.createElement("div");
    wrap.className = "modal-backdrop";
    wrap.id = "exit-dialog";
    wrap.innerHTML =
      '<div class="modal" role="dialog" aria-modal="true">' +
      "<p>לצאת מהסבב הנוכחי? ההתקדמות בסבב תאבד.</p>" +
      '<div class="modal-actions">' +
      '<button class="btn btn-ghost" id="exit-cancel">ביטול</button>' +
      '<button class="btn btn-primary" id="exit-confirm">אישור</button>' +
      "</div></div>";
    document.body.appendChild(wrap);
    el("exit-cancel").addEventListener("click", function () {
      confirmingExit = false;
      wrap.remove();
    });
    el("exit-confirm").addEventListener("click", function () {
      wrap.remove();
      returnHome();
    });
  }

  function populateCardBack(cardBack, currentId, namedPlayers) {
    const type = roundState.type || "classic";
    const isImpostor = roundState.impostorIds.indexOf(currentId) !== -1;
    let html = "";
    if (type === "differentWords") {
      html += '<div class="card-word">' + escapeHtml(roundState.words[currentId]) + "</div>";
    } else if (isImpostor) {
      html += '<div class="card-word">אימפוסטר</div>';
      if (
        type === "classic" &&
        settings.impostorsKnowEachOther &&
        roundState.impostorIds.length > 1
      ) {
        roundState.impostorIds
          .filter((id) => id !== currentId)
          .forEach(function (id) {
            const other = namedPlayers.find((p) => p.id === id);
            if (other) {
              html += '<div class="card-subtext">' + escapeHtml(other.displayName) + "</div>";
            }
          });
      }
    } else {
      html += '<div class="card-word">' + escapeHtml(roundState.word) + "</div>";
    }
    cardBack.innerHTML = html;
  }

  // ----- Announce screen -----
  function renderAnnounce() {
    const namedPlayers = computeDisplayNames(players);
    const starter = namedPlayers.find((p) => p.id === roundState.starterId);
    vibrate([20, 40, 20]);

    app.innerHTML =
      '<div class="screen screen-center">' +
      "<h2>מתחיל/ה</h2>" +
      '<div class="announce-name">' + escapeHtml(starter ? starter.displayName : "") + "</div>" +
      '<div class="stack">' +
      '<button class="btn btn-primary btn-block" id="new-round-btn">סבב חדש</button>' +
      '<button class="btn btn-ghost btn-block" id="home-btn">חזרה למסך הבית</button>' +
      '<button class="btn btn-link btn-block" id="reveal-impostors-btn">גילוי אימפוסטרים</button>' +
      "</div>" +
      "</div>";

    el("new-round-btn").addEventListener("click", function () {
      beginRound();
    });
    el("home-btn").addEventListener("click", function () {
      returnHome();
    });
    el("reveal-impostors-btn").addEventListener("click", function () {
      roundState.phase = "impostor-reveal";
      saveRoundState();
      render();
    });
  }

  // ----- Impostor reveal screen -----
  function renderImpostorReveal() {
    const namedPlayers = computeDisplayNames(players);
    const type = roundState.type || "classic";
    let bodyHtml;

    if (type === "everyoneImpostor") {
      bodyHtml =
        "<h2>סבב הטרלה!</h2>" +
        '<p class="impostor-reveal-note">לא היה אימפוסטר אמיתי — כולם היו "אימפוסטר".</p>';
    } else if (type === "differentWords") {
      bodyHtml =
        "<h2>סבב הטרלה!</h2>" +
        '<p class="impostor-reveal-note">כולם קיבלו מילה שונה — לא היה אימפוסטר.</p>';
    } else {
      const impostors = roundState.impostorIds
        .map((id) => namedPlayers.find((p) => p.id === id))
        .filter(Boolean);
      const title = impostors.length >= 2 ? "האימפוסטרים היו:" : "האימפוסטר היה:";
      const namesHtml = impostors
        .map((p) => '<div class="impostor-reveal-name">' + escapeHtml(p.displayName) + "</div>")
        .join("");
      let wordHtml =
        '<p class="impostor-reveal-word">המילה הייתה: <strong>' + escapeHtml(roundState.word) + "</strong></p>";
      if (type === "nameWord" && roundState.impostorIds[0] !== roundState.targetId) {
        const target = namedPlayers.find((p) => p.id === roundState.targetId);
        wordHtml =
          '<p class="impostor-reveal-word">השם ששימש כמילה: <strong>' +
          escapeHtml(target ? target.displayName : roundState.word) +
          "</strong>. האימפוסטר בפועל: <strong>" +
          escapeHtml(impostors[0] ? impostors[0].displayName : "") +
          "</strong></p>";
      }
      bodyHtml =
        "<h2>" + title + "</h2>" +
        '<div class="impostor-reveal-names">' + namesHtml + "</div>" +
        wordHtml;
    }

    app.innerHTML =
      '<div class="screen screen-center">' +
      bodyHtml +
      '<div class="stack">' +
      '<button class="btn btn-primary btn-block" id="new-round-btn-2">סבב חדש</button>' +
      '<button class="btn btn-ghost btn-block" id="home-btn-2">חזרה למסך הבית</button>' +
      "</div>" +
      "</div>";

    el("new-round-btn-2").addEventListener("click", function () {
      beginRound();
    });
    el("home-btn-2").addEventListener("click", function () {
      returnHome();
    });
  }

  // ---------- Init ----------
  function init() {
    // Any in-progress round always resumes face-down on the current player.
    revealedCurrent = false;
    render();

    if ("serviceWorker" in navigator) {
      window.addEventListener("load", function () {
        navigator.serviceWorker.register("sw.js").catch(function () {
          /* ignore */
        });
      });
    }
  }

  init();
})();
