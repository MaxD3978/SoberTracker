import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

/* =========================
   0) SUPABASE CONFIG
   ========================= */
const SUPABASE_URL = "https://iuyunzybggaofiryncak.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_EVhNmgA6RjiNSZFAVvpzMQ_P-OC4WAd";
const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

/* =========================
   1) A2HS (iOS)
   ========================= */
const A2HS_KEY = "sober_a2hs_dismissed_v1";

/* =========================
   2) HELPERS / STATE
   ========================= */
const LS = {
  deviceId: "sober_device_id",
  roomCode: "sober_room_code",
  nickname: "sober_nickname",
  playerId: "sober_player_id",
};

function getDeviceId() {
  let id = localStorage.getItem(LS.deviceId);
  if (!id) {
    id = (crypto?.randomUUID?.() ?? `dev_${Math.random().toString(16).slice(2)}_${Date.now()}`);
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
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
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
  const diffToMon = (day === 0 ? -6 : 1 - day);
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

// Februar fix (du kannst es später dynamisch machen)
const TRACK_MONTH_INDEX = 1; // 0=Jan, 1=Feb
const TRACK_YEAR = new Date().getFullYear();

/* =========================
   3) DATA ACCESS
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

async function upsertPlayer(roomId, nickname) {
  const device_id = getDeviceId();

  const { data, error } = await supabase
    .from("players")
    .upsert(
      { room_id: roomId, nickname, device_id, avatar: {} },
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
  const start = `${TRACK_YEAR}-${String(TRACK_MONTH_INDEX + 1).padStart(2, "0")}-01`;
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
  for (const row of (data ?? [])) {
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

  const { error } = await supabase
    .from("checkins")
    .upsert(
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

/* =========================
   4) REALTIME
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
    .subscribe();
}

/* =========================
   5) UI
   ========================= */
function setApp(html) {
  const root = document.getElementById("app");
  if (root) root.innerHTML = html;
}

function toast(text) {
  alert(text);
}

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
            <button id="btnJoin"
              class="flex-1 rounded-2xl px-4 py-3 font-bold bg-slate-900 text-white hover:opacity-90">
              Beitreten
            </button>
            <button id="btnCreate"
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

  document.getElementById("btnJoin")?.addEventListener("click", joinRoomFlow);
  document.getElementById("btnCreate")?.addEventListener("click", createRoomFlow);
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
    if (exists) return toast("Code schon vergeben. Bitte anderen Code oder leer lassen.");

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

  const me = await upsertPlayer(room.id, nickname);
  localStorage.setItem(LS.playerId, me.id);

  STATE.room = room;
  STATE.me = me;
  STATE.players = await loadPlayers(room.id);
  STATE.checkins = await loadCheckins(room.id);

  subscribeRoom(room.id);
  renderDashboard();
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
    .map(d => formatDateLocal(d))
    .filter(k => k <= todayKey)
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

function renderDashboard() {
  const room = STATE.room;
  const me = STATE.me;
  if (!room || !me) return renderJoin();

  const daysArr = monthDays(TRACK_YEAR, TRACK_MONTH_INDEX);
  const totalDays = daysArr.length;

  const players = STATE.players.slice(0, 2);
  const meRow = players.find(p => p.id === me.id) ?? me;
  const other = players.find(p => p.id !== me.id) ?? null;

  const meDone = computeProgress(meRow.id, daysArr);
  const otherDone = other ? computeProgress(other.id, daysArr) : 0;

  const meStreak = computeStreak(meRow.id, daysArr);
  const otherStreak = other ? computeStreak(other.id, daysArr) : 0;

  const meWeek = computeWeekCount(meRow.id);
  const otherWeek = other ? computeWeekCount(other.id) : 0;

  const leader =
  other
    ? (meDone === otherDone
        ? "Gleichstand 🤝"
        : (meDone > otherDone ? `${meRow.nickname} führt 🏁` : `${other.nickname} führt 🏁`))
    : "Warte auf Mitspieler…";

  const dayCards = daysArr.map(d => {
    const dayKey = formatDateLocal(d);
    const dayNum = d.getDate();

    const meK = `${meRow.id}:${dayKey}`;
    const otherK = other ? `${other.id}:${dayKey}` : null;

    const meOn = STATE.checkins.get(meK) === true;
    const otherOn = otherK ? (STATE.checkins.get(otherK) === true) : false;

    return `
      <button data-day="${dayKey}"
        class="day-card group relative p-3 rounded-2xl border text-left touch-manipulation
          ${meOn ? "bg-emerald-500 text-white border-emerald-400" : "bg-white dark:bg-slate-900 border-slate-200 dark:border-slate-800 hover:bg-slate-50 dark:hover:bg-slate-800"}
        ">
        <div class="text-xs font-semibold ${meOn ? "text-white/80" : "text-slate-400"}">TAG</div>
        <div class="text-2xl font-extrabold mt-1">${dayNum}</div>

        <div class="mt-3 flex items-center gap-2">
          <span class="text-xs font-bold ${meOn ? "text-white" : "text-slate-600 dark:text-slate-300"}">Du</span>
          <span class="w-3 h-3 rounded-full ${meOn ? "bg-white" : "bg-slate-200 dark:bg-slate-700"}"></span>

          <span class="ml-3 text-xs font-bold ${meOn ? "text-white" : "text-slate-600 dark:text-slate-300"}">${other ? other.nickname : "—"}</span>
          <span class="w-3 h-3 rounded-full ${otherOn ? (meOn ? "bg-white/90" : "bg-purple-500") : "bg-slate-200 dark:bg-slate-700"}"></span>
        </div>

        <div class="absolute top-2 right-2 text-sm ${meOn ? "opacity-100" : "opacity-30"}">✅</div>
      </button>
    `;
  }).join("");

  setApp(`
    <div class="grid gap-4">
      <div class="flex flex-col md:flex-row gap-3 md:items-center md:justify-between">
        <div>
          <p class="text-sm text-slate-500 dark:text-slate-400">Room Code</p>
          <p class="text-2xl font-extrabold tracking-wider">${room.code}</p>
        </div>

        <div class="flex gap-2">
          <button id="btnCopy"
            class="rounded-2xl px-4 py-3 font-semibold border border-slate-200 dark:border-slate-800 hover:bg-slate-100 dark:hover:bg-slate-800">
            Code kopieren
          </button>
          <button id="btnReset"
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
          <p class="text-sm text-slate-500 dark:text-slate-400">${other ? other.nickname : "Mitspieler"}</p>
          <p class="text-2xl font-extrabold mt-1">${other ? `${otherDone}/${totalDays}` : "—"}</p>
          <p class="text-sm mt-2">Streak: <span class="font-bold">${other ? otherStreak : "—"}</span> 🔥</p>
          <p class="text-sm">Woche: <span class="font-bold">${other ? otherWeek : "—"}</span></p>
        </div>

        <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
          <p class="text-sm text-slate-500 dark:text-slate-400">Mini-Ranking (diese Woche)</p>
          <p class="text-xl font-extrabold mt-1">${leader}</p>
          <p class="text-xs text-slate-500 dark:text-slate-400 mt-2">
            (Montag–Sonntag, zählt erledigte Tage)
          </p>
        </div>
      </div>

      <div id="daysGrid" class="grid grid-cols-3 sm:grid-cols-5 md:grid-cols-7 gap-3">
        ${dayCards}
      </div>

      <p class="text-xs text-slate-500 dark:text-slate-400 text-center mt-2">
        Tippe auf einen Tag, um <b>deinen</b> Status zu toggeln. Mitspieler ist read-only.
      </p>
    </div>
  `);

  document.getElementById("btnCopy")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(room.code);
      toast("Room Code kopiert ✅");
    } catch {
      toast("Kopieren ging nicht. Code manuell markieren.");
    }
  });

  document.getElementById("btnReset")?.addEventListener("click", () => {
    localStorage.removeItem(LS.roomCode);
    localStorage.removeItem(LS.nickname);
    localStorage.removeItem(LS.playerId);
    STATE.room = null;
    STATE.me = null;
    STATE.players = [];
    STATE.checkins = new Map();
    if (STATE.channel) supabase.removeChannel(STATE.channel);
    STATE.channel = null;
    renderJoin();
  });

  // iOS Tap-Fix: Event Delegation + Touchstart
(function wireDayGrid() {
  const grid = document.getElementById("daysGrid");
  if (!grid) return;

  let lastTouchTs = 0;

  const handler = async (ev) => {
    const btn = ev.target.closest("[data-day]");
    if (!btn) return;

    // iOS: touchstart löst oft zusätzlich click aus → doppelt verhindern
    if (ev.type === "touchstart") {
      lastTouchTs = Date.now();
      ev.preventDefault();
    } else if (ev.type === "click" && Date.now() - lastTouchTs < 600) {
      return; // click ignorieren, wenn gerade touchstart kam
    }

    const dayStr = btn.getAttribute("data-day");
    if (!dayStr) return;

    try {
      await toggleMyDay(dayStr);

      // Optimistic UI
      const k = `${STATE.me.id}:${dayStr}`;
      STATE.checkins.set(k, !(STATE.checkins.get(k) === true));
      renderDashboard();
    } catch (e) {
      console.error(e);
      toast("Speichern fehlgeschlagen.");
    }
  };

  grid.addEventListener("touchstart", handler, { passive: false });
  grid.addEventListener("click", handler);
})();
}

/* =========================
   6) BOOT
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
