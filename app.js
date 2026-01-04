// ---------- A2HS (iOS) ----------
const A2HS_KEY = "sober_a2hs_dismissed_v1";

function isStandalone() {
  // iOS (navigator.standalone) + allgemeiner Standard
  return window.navigator.standalone === true ||
         window.matchMedia("(display-mode: standalone)").matches;
}

function isIphoneSafari() {
  const ua = navigator.userAgent || "";
  const isIOS = /iPhone|iPad|iPod/i.test(ua);
  const isSafari = /Safari/i.test(ua) && !/CriOS|FxiOS|EdgiOS/i.test(ua);
  return isIOS && isSafari;
}

function showA2HS() {
  const el = document.getElementById("a2hs");
  if (!el) return;
  el.classList.remove("hidden");
  el.classList.add("flex");
}

function hideA2HS(remember = true) {
  const el = document.getElementById("a2hs");
  if (!el) return;
  el.classList.add("hidden");
  el.classList.remove("flex");
  if (remember) localStorage.setItem(A2HS_KEY, "1");
}

function maybeShowA2HS() {
  const dismissed = localStorage.getItem(A2HS_KEY) === "1";
  if (dismissed) return;
  if (isStandalone()) return;          // schon installiert
  if (!isIphoneSafari()) return;       // nur iPhone Safari
  // Zeig nach kurzem Delay, damit es nicht "in your face" ist
  setTimeout(showA2HS, 900);
}

function wireA2HSButtons() {
  const closeBtn = document.getElementById("a2hs-close");
  const laterBtn = document.getElementById("a2hs-later");
  if (closeBtn) closeBtn.addEventListener("click", () => hideA2HS(true));
  if (laterBtn) laterBtn.addEventListener("click", () => hideA2HS(false)); // nicht merken
}

// Beim Laden einmal ausführen
window.addEventListener("load", () => {
  wireA2HSButtons();
  maybeShowA2HS();
});
