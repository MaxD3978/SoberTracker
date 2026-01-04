import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";

const SUPABASE_URL = "https://iuyunzybggaofiryncak.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_EVhNmgA6RjiNSZFAVvpzMQ_P-OC4WAd";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

function setApp(html) {
  const root = document.getElementById("app");
  if (root) root.innerHTML = html;
}

function randomRoomCode(len = 6) {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"; // ohne I,O,1,0
  let out = "";
  for (let i = 0; i < len; i++) out += chars[Math.floor(Math.random() * chars.length)];
  return out;
}

window.addEventListener("load", async () => {
  setApp(`
    <div class="p-4 rounded-2xl border border-slate-200 dark:border-slate-800 bg-slate-50 dark:bg-slate-950">
      <p class="font-extrabold text-lg">Supabase Verbindungstest</p>
      <p class="text-sm text-slate-600 dark:text-slate-300 mt-1">
        Wenn das klappt, wird ein Room in die Tabelle <code>rooms</code> geschrieben.
      </p>

      <button id="btn"
        class="mt-4 w-full rounded-2xl px-4 py-3 font-bold bg-slate-900 text-white hover:opacity-90">
        Test: Room anlegen
      </button>

      <div id="out" class="mt-4 text-sm text-slate-700 dark:text-slate-200"></div>
    </div>
  `);

  const out = document.getElementById("out");
  const btn = document.getElementById("btn");

  btn.addEventListener("click", async () => {
    try {
      btn.disabled = true;
      btn.textContent = "Teste…";

      const code = randomRoomCode(6);

      const { data, error } = await supabase
        .from("rooms")
        .insert({ code })
        .select("*")
        .single();

      if (error) throw error;

      out.innerHTML = `
        ✅ Erfolg! Room erstellt:<br>
        <code>${JSON.stringify(data, null, 2)}</code>
      `;
      btn.textContent = "Nochmal testen";
      btn.disabled = false;
    } catch (e) {
      console.error(e);
      out.innerHTML = `
        ❌ Fehler:<br>
        <code>${(e?.message ?? String(e))}</code>
      `;
      btn.textContent = "Erneut versuchen";
      btn.disabled = false;
    }
  });
});
