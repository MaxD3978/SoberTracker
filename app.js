import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* =========================
   0) SUPABASE CONFIG
   ========================= */
const SUPABASE_URL = "https://iuyunzybggaofiryncak.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_EVhNmgA6RjiNSZFAVvpzMQ_P-OC4WAd";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =========================
   1) HELPERS / STATE
   ========================= */
const LS = {
  deviceId: "sober_device_id",
  roomCode: "sober_room_code",
  nickname: "sober_nickname",
  playerId: "sober_player_id",
};

const TOKEN_OPTIONS = [
  { id: "Bob", emoji: "🤖", label: "TechnoBob" },
  { id: "Kirbus", emoji: "🎃", label: "Kirbus" },
  { id: "Unterwasser", emoji: "🤓", label: "Druffi" },
  { id: "Joa", emoji: "🤠", label: "Yeeha" },
];

function tokenEmoji(tokenId) {
  return TOKEN_OPTIONS.find((t) => t.id === tokenId)?.emoji ?? "🙂";
}

function getDeviceId() {
  let id = localStorage.getItem(LS.deviceId);
  if (!id) {
    id =
      crypto?.randomUUID?.() ??
      `dev_${Math.random().toString(16).slice(2)}_${Date.now()}`;
    localStorage.setItem(LS.deviceId, id);
  }
  return id;
}

function normalizeRoomCode(code) {
  return (code || "").toUpperCase().replace(/\s+/g, "").slice(0, 16);
}

function randomRoomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++)
    out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

function formatDateLocal(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function monthDays(year, monthIndex) {
  const d = new Date(year, monthIndex, 1);
  const days = [];
  while (d.getMonth() === monthIndex) {
    days.push(new Date(d));
    d.setDate(d.getDate() + 1);
  }
  return days;
}

function getWeekRangeMonSun(date = new Date()) {
  const d = new Date(date);
  const day = d.getDay();
  const diffToMon = day === 0 ? -6 : 1 - day;
  const mon = new Date(d);
  mon.setDate(d.getDate() + diffToMon);
  mon.setHours(0, 0, 0, 0);

  const sun = new Date(mon);
  sun.setDate(mon.getDate() + 6);
  sun.setHours(23, 59, 59, 999);

  return { mon, sun };
}

const STATE = {
  room: null,
  me: null,
  players: [],
  checkins: new Map(), // key: `${player_id}:${YYYY-MM-DD}` => done boolean
  channel: null,
};

// Februar fix
const TRACK_MONTH_INDEX = 1; // 0=Jan, 1=Feb
const TRACK_YEAR = new Date().getFullYear();

// Board Layout
const BOARD_COLS = 4;

/* =========================
   2) DATA ACCESS
   ========================= */
async function getRoomByCode(code) {
  const { data, error } = await supabase
    .from("rooms")
    .select("*")
    .eq("code", code)
    .maybeSingle();
  if (error) throw error;
  return data;
}

async function createRoom(code) {
  const { data, error } = await supabase
    .from("rooms")
    .insert({ code })
    .select("*")
    .single();
  if (error) throw error;
  return data;
}

async function upsertPlayer(roomId, nickname, avatar = {}) {
  const device_id = getDeviceId();

  const { data, error } = await supabase
    .from("players")
    .upsert(
      { room_id: roomId, nickname, device_id, avatar },
      { onConflict: "room_id,device_id" }
    )
    .select("*")
    .single();

  if (error) throw error;
  return data;
}

async function loadPlayers(roomId) {
  const { data, error } = await supabase
    .from("players")
    .select("*")
    .eq("room_id", roomId)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function loadCheckins(roomId) {
  const start = `${TRACK_YEAR}-${String(TRACK_MONTH_INDEX + 1).padStart(
    2,
    "0"
  )}-01`;
  const endDate = new Date(TRACK_YEAR, TRACK_MONTH_INDEX + 1, 1);
  const end = formatDateLocal(endDate);

  const { data, error } = await supabase
    .from("checkins")
    .select("*")
    .eq("room_id", roomId)
    .gte("day", start)
    .lt("day", end);

  if (error) throw error;

  const map = new Map();
  for (const row of data ?? []) {
    map.set(`${row.player_id}:${row.day}`, !!row.done);
  }
  return map;
}

async function toggleMyDay(dayStr) {
  const room = STATE.room;
  const me = STATE.me;
  if (!room || !me) return;

  const key = `${me.id}:${dayStr}`;
  const current = STATE.checkins.get(key) === true;
  const next = !current;

  const { error } = await supabase.from("checkins").upsert(
    {
      room_id: room.id,
      player_id: me.id,
      day: dayStr,
      done: next,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "room_id,player_id,day" }
  );

  if (error) throw error;
}

async function setMyToken(tokenId) {
  if (!STATE.room || !STATE.me) return;
  const nextAvatar = { ...(STATE.me.avatar || {}), token: tokenId };
  const updated = await upsertPlayer(
    STATE.room.id,
    STATE.me.nickname,
    nextAvatar
  );
  STATE.me = updated;
  STATE.players = await loadPlayers(STATE.room.id);
}

/* =========================
   3) REALTIME
   ========================= */
function subscribeRoom(roomId) {
  if (STATE.channel) {
    supabase.removeChannel(STATE.channel);
    STATE.channel = null;
  }

  STATE.channel = supabase
    .channel(`room:${roomId}`)
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "checkins",
        filter: `room_id=eq.${roomId}`,
      },
      async () => {
        STATE.checkins = await loadCheckins(roomId);
        STATE.players = await loadPlayers(roomId);
        renderDashboard();
      }
    )
    .on(
      "postgres_changes",
      {
        event: "*",
        schema: "public",
        table: "players",
        filter: `room_id=eq.${roomId}`,
      },
      async () => {
        STATE.players = await loadPlayers(roomId);
        renderDashboard();
      }
    )
    .subscribe();
}

/* =========================
   4) UI HELPERS
   ========================= */
function setApp(html) {
  const root = document.getElementById("app");
  if (root) root.innerHTML = html;
}

function toast(text) {
  alert(text);
}

/* ===== Confetti + Finish Banner ===== */
function ensureConfettiRoot() {
  let root = document.getElementById("confetti");
  if (!root) {
    root = document.createElement("div");
    root.id = "confetti";
    root.style.position = "fixed";
    root.style.inset = "0";
    root.style.zIndex = "9999";
    root.style.pointerEvents = "none";
    root.style.overflow = "hidden";
    root.style.display = "none";
    document.body.appendChild(root);
  }
  return root;
}

function burstConfetti(pieces = 70) {
  const root = ensureConfettiRoot();
  root.innerHTML = "";
  root.style.display = "block";

  const duration = 1400;

  for (let i = 0; i < pieces; i++) {
    const p = document.createElement("div");
    p.style.position = "absolute";
    p.style.left = `${Math.random() * 100}vw`;
    p.style.top = `-10px`;
    p.style.width = `${6 + Math.random() * 6}px`;
    p.style.height = `${8 + Math.random() * 10}px`;
    p.style.borderRadius = "2px";
    p.style.opacity = "0.95";
    p.style.background = `hsl(${Math.floor(Math.random() * 360)}, 90%, 60%)`;

    const fall = 70 + Math.random() * 50;
    const drift = -20 + Math.random() * 40;
    const rot = -360 + Math.random() * 720;

    p.animate(
      [
        { transform: `translate(0, 0) rotate(0deg)` },
        { transform: `translate(${drift}vw, ${fall}vh) rotate(${rot}deg)` },
      ],
      {
        duration: duration + Math.random() * 500,
        easing: "cubic-bezier(.2,.8,.2,1)",
      }
    );

    root.appendChild(p);
  }

  setTimeout(() => {
    root.style.display = "none";
    root.innerHTML = "";
  }, duration + 700);
}

function ensureFinishBanner() {
  let b = document.getElementById("finishBanner");
  if (!b) {
    b = document.createElement("div");
    b.id = "finishBanner";
    b.style.position = "fixed";
    b.style.left = "50%";
    b.style.top = "16px";
    b.style.transform = "translate(-50%, -120px)";
    b.style.zIndex = "10000";
    b.style.pointerEvents = "none";
    b.style.opacity = "0";
    b.style.transition = "transform 420ms cubic-bezier(.2,.9,.2,1), opacity 220ms ease";
    b.style.maxWidth = "92vw";
    b.innerHTML = `
      <div style="
        display:flex; align-items:center; gap:10px;
        padding:12px 16px;
        border-radius:16px;
        background: rgba(15, 23, 42, 0.88);
        color: white;
        border: 1px solid rgba(148, 163, 184, 0.35);
        backdrop-filter: blur(6px);
        box-shadow: 0 18px 40px rgba(0,0,0,0.35);
        font-weight: 800;
        letter-spacing: 0.2px;
      ">
        <span style="font-size:22px;">🏁</span>
        <span style="font-size:14px; line-height:1.2;">
          ZIEL ERREICHT! <span style="opacity:.8; font-weight:700;">Du hast den Monat durchgezogen.</span>
        </span>
      </div>
    `;
    document.body.appendChild(b);
  }
  return b;
}

function showFinishBanner() {
  const b = ensureFinishBanner();
  // reinfliegen
  requestAnimationFrame(() => {
    b.style.opacity = "1";
    b.style.transform = "translate(-50%, 0)";
  });

  // kurz halten, dann raus
  setTimeout(() => {
    b.style.opacity = "0";
    b.style.transform = "translate(-50%, -120px)";
  }, 1800);
}

function computeProgress(playerId, daysArr) {
  let done = 0;
  for (const d of daysArr) {
    const k = `${playerId}:${formatDateLocal(d)}`;
    if (STATE.checkins.get(k) === true) done++;
  }
  return done;
}

function computeStreak(playerId, daysArr) {
  const todayKey = formatDateLocal(new Date());
  const filtered = daysArr
    .map((d) => formatDateLocal(d))
    .filter((k) => k <= todayKey)
    .reverse();

  let streak = 0;
  for (const dayKey of filtered) {
    const k = `${playerId}:${dayKey}`;
    if (STATE.checkins.get(k) === true) streak++;
    else break;
  }
  return streak;
}

function computeWeekCount(playerId) {
  const { mon, sun } = getWeekRangeMonSun(new Date());
  let c = 0;
  for (const [k, v] of STATE.checkins.entries()) {
    if (!v) continue;
    const [pid, dayStr] = k.split(":");
    if (pid !== playerId) continue;
    const d = new Date(dayStr + "T00:00:00");
    if (d >= mon && d <= sun) c++;
  }
  return c;
}

/* =========================
   5) SCREENS
   ========================= */
function renderJoin() {
  const savedCode = localStorage.getItem(LS.roomCode) ?? "";
  const savedNick = localStorage.getItem(LS.nickname) ?? "";

  setApp(`
    <div class="grid gap-4">
      <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
        <p class="font-extrabold text-lg">Room beitreten / erstellen</p>
        <p class="text-sm mt-1 text-slate-600 dark:text-slate-300">
          Gleicher Room Code = gleicher Fortschritt (live).
        </p>

        <div class="mt-4 grid gap-3">
          <label class="text-sm font-semibold">Room Code</label>
          <input id="roomCode" value="${savedCode}"
            class="w-full rounded-xl px-4 py-3 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 outline-none"
            placeholder="z.B. SOBER23" />

          <label class="text-sm font-semibold mt-2">Dein Name</label>
          <input id="nickname" value="${savedNick}"
            class="w-full rounded-xl px-4 py-3 border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 outline-none"
            placeholder="z.B. Max" />

          <div class="mt-3 flex gap-2">
            <button id="btnJoin" type="button"
              class="flex-1 rounded-2xl px-4 py-3 font-bold bg-slate-900 text-white hover:opacity-90">
              Beitreten
            </button>
            <button id="btnCreate" type="button"
              class="rounded-2xl px-4 py-3 font-semibold border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800">
              Neuer Room
            </button>
          </div>

          <p class="text-xs text-slate-500 dark:text-slate-400 mt-2">
            Tipp: Einer erstellt den Room, der andere tritt mit dem Code bei.
          </p>
        </div>
      </div>
    </div>
  `);
}

async function joinRoomFlow() {
  try {
    const codeRaw = document.getElementById("roomCode")?.value ?? "";
    const nickRaw = document.getElementById("nickname")?.value ?? "";
    const code = normalizeRoomCode(codeRaw);
    const nickname = nickRaw.trim();

    if (!code) return toast("Bitte Room Code eingeben.");
    if (!nickname) return toast("Bitte deinen Namen eingeben.");

    const room = await getRoomByCode(code);
    if (!room) return toast("Room nicht gefunden. (Dann 'Neuer Room' nutzen)");

    await enterRoom(room, nickname);
  } catch (e) {
    console.error(e);
    toast("Join fehlgeschlagen.");
  }
}

async function createRoomFlow() {
  try {
    const nickRaw = document.getElementById("nickname")?.value ?? "";
    const nickname = nickRaw.trim();
    if (!nickname) return toast("Bitte deinen Namen eingeben.");

    const codeRaw = document.getElementById("roomCode")?.value ?? "";
    const desired = normalizeRoomCode(codeRaw);
    const code = desired || randomRoomCode(6);

    const exists = await getRoomByCode(code);
    if (exists)
      return toast("Code schon vergeben. Bitte anderen Code oder leer lassen.");

    const room = await createRoom(code);
    await enterRoom(room, nickname);
  } catch (e) {
    console.error(e);
    toast("Room erstellen fehlgeschlagen.");
  }
}

async function enterRoom(room, nickname) {
  localStorage.setItem(LS.roomCode, room.code);
  localStorage.setItem(LS.nickname, nickname);

  // Token default: wenn keiner gesetzt, nehmen wir "Bob"
  const existingToken = STATE.me?.avatar?.token;
  const initialAvatar = existingToken
    ? { token: existingToken }
    : { token: "Bob" };

  const me = await upsertPlayer(room.id, nickname, initialAvatar);
  localStorage.setItem(LS.playerId, me.id);

  STATE.room = room;
  STATE.me = me;
  STATE.players = await loadPlayers(room.id);
  STATE.checkins = await loadCheckins(room.id);

  subscribeRoom(room.id);
  renderDashboard();
}

function renderDashboard() {
  const room = STATE.room;
  const me = STATE.me;
  if (!room || !me) return renderJoin();

  const monthArr = monthDays(TRACK_YEAR, TRACK_MONTH_INDEX);
  const totalDays = monthArr.length;

  const players = STATE.players.slice(0, 2);
  const meRow = players.find((p) => p.id === me.id) ?? me;
  const other = players.find((p) => p.id !== me.id) ?? null;

  const meDone = computeProgress(meRow.id, monthArr);
  const otherDone = other ? computeProgress(other.id, monthArr) : 0;

  const meStreak = computeStreak(meRow.id, monthArr);
  const otherStreak = other ? computeStreak(other.id, monthArr) : 0;

  const meWeek = computeWeekCount(meRow.id);
  const otherWeek = other ? computeWeekCount(other.id) : 0;

  const leader =
    other
      ? meDone === otherDone
        ? "Gleichstand 🤝"
        : meDone > otherDone
        ? `${meRow.nickname} führt 🏁`
        : `${other.nickname} führt 🏁`
      : "Warte auf Mitspieler…";

  const tiles = [
    { type: "start" },
    ...monthArr.map((d) => ({ type: "day", d })),
    { type: "finish" },
  ];
  const totalTiles = tiles.length;

  const mePos = Math.min(totalTiles - 1, Math.max(0, meDone));
  const otherPos = other
    ? Math.min(totalTiles - 1, Math.max(0, otherDone))
    : -1;

  const meToken = tokenEmoji(meRow.avatar?.token);
  const otherToken = other ? tokenEmoji(other.avatar?.token) : "👤";

  const boardTiles = tiles
    .map((t, i) => {
      const row = Math.floor(i / BOARD_COLS);
      const col = i % BOARD_COLS;
      const serpCol = row % 2 === 0 ? col : BOARD_COLS - 1 - col;

      const gridCol = serpCol + 1;
      const gridRow = row + 1;

      const showMe = i === mePos;
      const showOther = other && i === otherPos;

      if (t.type === "start") {
        return `
        <div style="grid-column:${gridCol}; grid-row:${gridRow};"
          class="relative rounded-2xl border p-2 sm:p-3 bg-slate-900 text-white border-slate-700">
          <div class="text-xs font-semibold text-white/80">START</div>
          <div class="text-2xl font-extrabold mt-1">🚦</div>
          <div class="absolute -top-3 left-3 flex gap-1 text-2xl select-none">
            ${showMe ? `<span title="Du">${meToken}</span>` : ""}
            ${
              showOther
                ? `<span title="${other?.nickname ?? "Mitspieler"}">${otherToken}</span>`
                : ""
            }
          </div>
        </div>
      `;
      }

      if (t.type === "finish") {
        return `
        <div style="grid-column:${gridCol}; grid-row:${gridRow};"
          class="relative rounded-2xl border p-2 sm:p-3 bg-purple-600 text-white border-purple-400">
          <div class="text-xs font-semibold text-white/80">FINISH</div>
          <div class="text-2xl font-extrabold mt-1">🏁</div>
          <div class="absolute -top-3 left-3 flex gap-1 text-2xl select-none">
            ${showMe ? `<span title="Du">${meToken}</span>` : ""}
            ${
              showOther
                ? `<span title="${other?.nickname ?? "Mitspieler"}">${otherToken}</span>`
                : ""
            }
          </div>
        </div>
      `;
      }

      const d = t.d;
      const dayKey = formatDateLocal(d);
      const dayNum = d.getDate();

      const meK = `${meRow.id}:${dayKey}`;
      const otherK = other ? `${other.id}:${dayKey}` : null;

      const meOn = STATE.checkins.get(meK) === true;
      const otherOn = otherK ? STATE.checkins.get(otherK) === true : false;

      const isMonday = d.getDay() === 1;

      return `
      <button type="button" data-day="${dayKey}"
        style="grid-column:${gridCol}; grid-row:${gridRow};"
        class="relative rounded-2xl border p-2 sm:p-3 text-left touch-manipulation
          ${
            meOn
              ? "bg-emerald-500 text-white border-emerald-400"
              : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
          }
          ${isMonday ? "ring-2 ring-purple-400/70" : ""}">
        <div class="text-xs font-semibold ${
          meOn ? "text-white/80" : "text-slate-400"
        }">TAG</div>
        <div class="text-xl sm:text-2xl font-extrabold mt-1">${dayNum}</div>

        <div class="mt-3 flex items-center gap-2">
          <span class="hidden sm:inline text-xs font-bold ${
            meOn ? "text-white" : "text-slate-600 dark:text-slate-300"
          }">Du</span>
          <span class="w-3 h-3 rounded-full ${
            meOn ? "bg-white" : "bg-slate-200 dark:bg-slate-700"
          }"></span>

          <span class="hidden sm:inline ml-3 text-xs font-bold ${
            meOn ? "text-white" : "text-slate-600 dark:text-slate-300"
          }">${other ? other.nickname : "—"}</span>
          <span class="w-3 h-3 rounded-full ${
            otherOn
              ? meOn
                ? "bg-white/90"
                : "bg-purple-500"
              : "bg-slate-200 dark:bg-slate-700"
          }"></span>
        </div>

        <div class="absolute -top-3 left-3 flex gap-1 text-2xl select-none">
          ${showMe ? `<span title="Du">${meToken}</span>` : ""}
          ${
            showOther
              ? `<span title="${other?.nickname ?? "Mitspieler"}">${otherToken}</span>`
              : ""
          }
        </div>

        <div class="absolute top-2 right-2 text-sm ${
          meOn ? "opacity-100" : "opacity-30"
        }">✅</div>
      </button>
    `;
    })
    .join("");

  const myTokenId = meRow.avatar?.token ?? "Bob";
  const tokenModalCards = TOKEN_OPTIONS
    .map((t) => {
      const active = t.id === myTokenId;
      return `
      <button type="button" data-token="${t.id}"
        class="flex items-center justify-between rounded-2xl border px-4 py-3
          ${
            active
              ? "bg-emerald-500 text-white border-emerald-400"
              : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"
          }">
        <span class="text-lg font-extrabold">${t.emoji} <span class="text-sm font-semibold">${t.label}</span></span>
        <span class="text-xs font-bold opacity-70">${t.id}</span>
      </button>
    `;
    })
    .join("");

  setApp(`
    <div class="grid gap-4">
      <div class="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div>
          <p class="text-sm text-slate-500 dark:text-slate-400">Room Code</p>
          <p class="text-2xl font-extrabold tracking-wider">${room.code}</p>
        </div>

        <div class="flex gap-2 flex-wrap">
          <button id="btnCopy" type="button"
            class="rounded-2xl px-4 py-3 font-semibold border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800">
            Code kopieren
          </button>
          <button id="btnToken" type="button"
            class="rounded-2xl px-4 py-3 font-semibold border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800">
            Figur wählen ${tokenEmoji(myTokenId)}
          </button>
          <button id="btnReset" type="button"
            class="rounded-2xl px-4 py-3 font-bold bg-slate-900 text-white hover:opacity-90">
            Room wechseln
          </button>
        </div>
      </div>

      <div class="grid md:grid-cols-3 gap-3">
        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <p class="text-sm text-slate-500 dark:text-slate-400">Dein Fortschritt</p>
          <p class="text-2xl font-extrabold mt-1">${meDone}/${totalDays}</p>
          <p class="text-sm mt-2">Streak: <span class="font-bold">${meStreak}</span> 🔥</p>
          <p class="text-sm">Woche: <span class="font-bold">${meWeek}</span></p>
        </div>

        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <p class="text-sm text-slate-500 dark:text-slate-400">${
            other ? other.nickname : "Mitspieler"
          }</p>
          <p class="text-2xl font-extrabold mt-1">${
            other ? `${otherDone}/${totalDays}` : "—"
          }</p>
          <p class="text-sm mt-2">Streak: <span class="font-bold">${
            other ? otherStreak : "—"
          }</span> 🔥</p>
          <p class="text-sm">Woche: <span class="font-bold">${
            other ? otherWeek : "—"
          }</span></p>
        </div>

        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <p class="text-sm text-slate-500 dark:text-slate-400">Ranking</p>
          <p class="text-xl font-extrabold mt-1">${leader}</p>
        </div>
      </div>

      <div id="daysGrid" class="grid gap-2 sm:gap-3"
        style="grid-template-columns: repeat(${BOARD_COLS}, minmax(0, 1fr));">
        ${boardTiles}
      </div>

      <p class="text-xs text-slate-500 dark:text-slate-400 text-center mt-2">
        Tippe auf ein Feld (Tag), um <b>deinen</b> Status zu toggeln. Mitspieler ist read-only.
      </p>

      <div id="tokenModal"
        class="fixed inset-0 z-50 hidden items-end md:items-center justify-center p-4 pointer-events-none">
        <div class="absolute inset-0 bg-black/40"></div>

        <div class="relative w-full max-w-md rounded-3xl border border-slate-200 dark:border-slate-800 bg-white dark:bg-slate-900 p-5 pointer-events-auto">
          <div class="flex items-center justify-between">
            <p class="font-extrabold text-lg">Figur wählen</p>
            <button id="btnTokenClose" type="button"
              class="rounded-xl px-3 py-2 font-semibold border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800">
              ✕
            </button>
          </div>

          <p class="text-sm text-slate-500 dark:text-slate-400 mt-1">
            Du kannst jederzeit wechseln.
          </p>

          <div class="mt-4 grid gap-2">
            ${tokenModalCards}
          </div>

          <button id="btnTokenClose2" type="button"
            class="mt-4 w-full rounded-2xl px-4 py-3 font-bold bg-slate-900 text-white hover:opacity-90">
            Fertig
          </button>
        </div>
      </div>
    </div>
  `);
}

/* =========================
   6) EVENTS (DELEGATION)
   ========================= */
let lastPointerTs = 0;

function openTokenModal() {
  const m = document.getElementById("tokenModal");
  if (!m) return;
  m.classList.remove("hidden");
  m.classList.add("flex");
  m.classList.remove("pointer-events-none");
}

function closeTokenModal() {
  const m = document.getElementById("tokenModal");
  if (!m) return;
  m.classList.add("hidden");
  m.classList.remove("flex");
  m.classList.add("pointer-events-none");
}

async function handleActionFromEvent(ev) {
  const t = ev.target;

  if (t?.id === "btnJoin") return joinRoomFlow();
  if (t?.id === "btnCreate") return createRoomFlow();

  if (t?.id === "btnCopy") {
    try {
      await navigator.clipboard.writeText(STATE.room?.code ?? "");
      return toast("Room Code kopiert ✅");
    } catch {
      return toast("Kopieren ging nicht. Code manuell markieren.");
    }
  }

  if (t?.id === "btnReset") {
    localStorage.removeItem(LS.roomCode);
    localStorage.removeItem(LS.nickname);
    localStorage.removeItem(LS.playerId);
    STATE.room = null;
    STATE.me = null;
    STATE.players = [];
    STATE.checkins = new Map();
    if (STATE.channel) supabase.removeChannel(STATE.channel);
    STATE.channel = null;
    return renderJoin();
  }

  if (t?.id === "btnToken") return openTokenModal();
  if (t?.id === "btnTokenClose" || t?.id === "btnTokenClose2")
    return closeTokenModal();

  const tokenBtn = t.closest?.("[data-token]");
  if (tokenBtn) {
    const tokenId = tokenBtn.getAttribute("data-token");
    if (!TOKEN_OPTIONS.some((x) => x.id === tokenId)) return;
    try {
      await setMyToken(tokenId);
      closeTokenModal();
      renderDashboard();
    } catch (e) {
      console.error(e);
      toast("Token speichern fehlgeschlagen.");
    }
    return;
  }

  const dayBtn = t.closest?.("[data-day]");
  if (dayBtn) {
    const dayStr = dayBtn.getAttribute("data-day");
    if (!dayStr) return;

    try {
      const monthArr = monthDays(TRACK_YEAR, TRACK_MONTH_INDEX);
      const totalDays = monthArr.length;
      const beforeDone = computeProgress(STATE.me.id, monthArr);

      await toggleMyDay(dayStr);

      const k = `${STATE.me.id}:${dayStr}`;
      STATE.checkins.set(k, !(STATE.checkins.get(k) === true));

      const afterDone = computeProgress(STATE.me.id, monthArr);

      // FINISH: nur wenn du das Ziel neu erreichst
      if (afterDone > beforeDone && afterDone === totalDays) {
        showFinishBanner();
        burstConfetti(180); // mehr Wumms am Ende
      }
      // Milestones: jede 7 Tage (aber nicht am Finish doppelt)
      else if (afterDone > beforeDone && afterDone % 7 === 0) {
        burstConfetti(70);
      }

      renderDashboard();
    } catch (e) {
      console.error(e);
      toast("Speichern fehlgeschlagen.");
    }
  }
}

document.addEventListener(
  "pointerup",
  (ev) => {
    lastPointerTs = Date.now();
    handleActionFromEvent(ev);
  },
  { passive: true }
);

document.addEventListener("click", (ev) => {
  if (Date.now() - lastPointerTs < 500) return;
  handleActionFromEvent(ev);
});

/* =========================
   7) BOOT
   ========================= */
window.addEventListener("load", async () => {
  const savedCode = normalizeRoomCode(localStorage.getItem(LS.roomCode) ?? "");
  const savedNick = (localStorage.getItem(LS.nickname) ?? "").trim();

  if (savedCode && savedNick) {
    try {
      const room = await getRoomByCode(savedCode);
      if (room) {
        await enterRoom(room, savedNick);
        return;
      }
    } catch (e) {
      console.error(e);
    }
  }

  renderJoin();
});
