function isStandalone() {
  return window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
}

function maybeShowA2HS() {
  if (isStandalone()) return;
  // zeig Overlay: "Teilen-Icon → Zum Home-Bildschirm"
}
