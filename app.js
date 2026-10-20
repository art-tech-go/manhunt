import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, set, update, get, onValue } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

/* ====== 1. COLLE ICI TA CONFIG FIREBASE (voir instructions) ====== */
const firebaseConfig = {
  apiKey: "AIzaSyDlbO2DM_mTjSaCFLU75jHUZbB_dpbtqGc",
  authDomain: "urban-hunt-game.firebaseapp.com",
  // ⚠️ À vérifier : copie l'URL exacte affichée en haut de Realtime Database dans la console
  databaseURL: "https://urban-hunt-game-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "urban-hunt-game",
  storageBucket: "urban-hunt-game.firebasestorage.app",
  messagingSenderId: "266333152705",
  appId: "1:266333152705:web:1c5c7ee70905467d95fb40"
};
/* ================================================================ */

const Q = new URLSearchParams(location.search);
const SIM = Q.has("sim");   // ?sim  : clic sur la carte = déplacement (test sur PC)
const FAST = Q.has("fast"); // ?fast : dispersion de 20 s au lieu de 5 min
const C = {
  SPEED_LIMIT_KMH: 25, SPEED_GRACE_MS: 8000, SPEED_COUNTDOWN: 20,
  ZONE_COUNTDOWN: 30, DISPERSION_MS: FAST ? 20000 : 300000,
  CAPTURE_M: 15, BONUS_M: 20, JAM_MS: 4 * 60000, PUSH_MS: 3000, FRESH_MS: 30000
};

const db = getDatabase(initializeApp(firebaseConfig));
const $ = id => document.getElementById(id);
const store = SIM ? sessionStorage : localStorage;
const uid = store.uid || (store.uid = Math.random().toString(36).slice(2, 10));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let offset = 0, code = null, game = null, players = {}, myRole = null, unsub = null;
let pos = null, speedKmh = 0, follow = true, shownRole = null, assigning = false;
let lastPush = 0, lastPing = 0, zoneEnd = null, speedOverSince = null, speedEnd = null, eliminated = false;
let zoneKey = "", zoneLayers = [];
const gameRef = () => ref(db, `games/${code}`);
const now = () => Date.now() + offset;
onValue(ref(db, ".info/serverTimeOffset"), s => offset = s.val() || 0);

/* ---------- Carte ---------- */
const map = L.map("map", { zoomControl: false, attributionControl: false }).setView([48.8426, 2.5033], 16);
L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);
const CARTO_KEY = "cb1_4pbh_1_eedd6ef45052e29b67a035ce";
L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`, {
  maxZoom: 19,
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);
map.on("dragstart", () => follow = false);
$("recenter").onclick = () => { follow = true; if (pos) map.setView([pos.lat, pos.lng], 17); };

const markers = {}; let keep = new Set();
function mk(id, p, cls, label) {
  keep.add(id);
  const icon = () => L.divIcon({ className: "mk " + cls, html: `<div class="dot"></div><b>${esc(label)}</b>`, iconSize: [0, 0] });
  let m = markers[id];
  if (!m) { m = markers[id] = L.marker([p.lat, p.lng], { icon: icon(), interactive: false }).addTo(map); m._k = cls + label; }
  else { m.setLatLng([p.lat, p.lng]); if (m._k !== cls + label) { m.setIcon(icon()); m._k = cls + label; } }
}
function draw() {
  keep = new Set();
  if (pos) mk("me", pos, "me", "");
  if (game && game.state === "hunt") {
    for (const [id, p] of Object.entries(players)) {
      if (id === uid || p.alive === false) continue;
      if (!p.ping) continue; // position publiée à intervalle régulier (pour tous les joueurs)
      const jam = p.role === "proie" && p.jamUntil > now();
      const age = Math.round((now() - p.ping.ts) / 60000);
      const cls = p.role === "chasseur" ? "hunter" : "ping" + (jam ? " jam" : "");
      mk(id, p.ping, cls, jam ? "BROUILLÉ" : `${p.name} · ${age} min`);
    }
  }
  for (const id in markers) if (!keep.has(id)) { map.removeLayer(markers[id]); delete markers[id]; }
}
function drawZone() {
  const key = code + game.center.lat + game.radius;
  if (key === zoneKey) return; zoneKey = key;
  zoneLayers.forEach(l => map.removeLayer(l));
  const { lat, lng } = game.center, r = game.radius, ring = [];
  for (let i = 0; i < 72; i++) {
    const a = i / 72 * 2 * Math.PI;
    ring.push([lat + r / 111320 * Math.cos(a), lng + r / (111320 * Math.cos(lat * Math.PI / 180)) * Math.sin(a)]);
  }
  const circle = L.circle([lat, lng], { radius: r, color: "#ff1744", weight: 2, dashArray: "8 6", fill: false, interactive: false });
  zoneLayers = [
    L.polygon([[[85, -180], [85, 180], [-85, 180], [-85, -180]], ring], { stroke: false, fillColor: "#ff1744", fillOpacity: .22, interactive: false }),
    circle
  ].map(l => l.addTo(map));
  map.fitBounds(circle.getBounds());
}

/* ---------- Utilitaires ---------- */
function dist(a, b) {
  const R = 6371000, t = Math.PI / 180, dLa = (b.lat - a.lat) * t, dLo = (b.lng - a.lng) * t;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(a.lat * t) * Math.cos(b.lat * t) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
const fmt = ms => { const s = Math.max(0, Math.ceil(ms / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
const show = id => ["home", "lobby", "game"].forEach(s => $(s).classList.toggle("hidden", s !== id));
let actx;
function beep(freq = 880, dur = .15, n = 1) {
  try {
    actx = actx || new AudioContext();
    for (let i = 0; i < n; i++) {
      const o = actx.createOscillator(), g = actx.createGain(), t = actx.currentTime + i * (dur + .08);
      o.frequency.value = freq; o.connect(g); g.connect(actx.destination);
      g.gain.setValueAtTime(.3, t); g.gain.exponentialRampToValueAtTime(.001, t + dur);
      o.start(t); o.stop(t + dur);
    }
  } catch (e) {}
  navigator.vibrate && navigator.vibrate(n > 1 ? [200, 100, 200, 100, 200] : 200);
}
function overlay(title, sub, cls = "", btn = "OK", onclick) {
  const o = $("overlay"); o.className = cls; $("ovTitle").textContent = title; $("ovSub").textContent = sub;
  $("ovBtn").textContent = btn; $("ovBtn").onclick = () => { o.className = "hidden"; onclick && onclick(); };
}
function toast(msg) { const t = $("toast"); t.textContent = msg; t.classList.remove("hidden"); setTimeout(() => t.classList.add("hidden"), 4000); }

/* ---------- GPS + anti-véhicule ---------- */
function onPos(p) {
  const c = p.coords, t = Date.now(), np = { lat: c.latitude, lng: c.longitude, acc: c.accuracy, t };
  let kmh = null;
  if (c.speed != null && !isNaN(c.speed)) kmh = c.speed * 3.6;
  else if (pos && c.accuracy < 30 && t - pos.t >= 1000) kmh = dist(pos, np) / ((t - pos.t) / 1000) * 3.6; // repli si speed indisponible
  if (kmh != null) speedKmh = speedKmh * .4 + kmh * .6;
  pos = np;
  $("gps").textContent = `📡 GPS OK (±${Math.round(c.accuracy)} m)`;
  $("speed").textContent = Math.round(speedKmh) + " km/h";
  if (follow && !$("game").classList.contains("hidden")) map.setView([pos.lat, pos.lng], Math.max(map.getZoom(), 16), { animate: true });
  draw();
}
if (SIM) map.on("click", e => onPos({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: 5, speed: 0 } }));
else if (navigator.geolocation) navigator.geolocation.watchPosition(onPos,
  e => $("gps").textContent = "📡 GPS refusé/indisponible : " + e.message,
  { enableHighAccuracy: true, maximumAge: 0, timeout: 20000 });
else $("gps").textContent = "📡 Géolocalisation non supportée";

/* ---------- Règles : geofencing + vitesse ---------- */
function rules() {
  const live = game && ["dispersion", "hunt"].includes(game.state) && !eliminated && pos;
  if (!live) { $("banner").classList.add("hidden"); return; }
  const t = Date.now();
  // Zone
  if (dist(pos, game.center) > game.radius) { if (!zoneEnd) zoneEnd = t + C.ZONE_COUNTDOWN * 1000; } else zoneEnd = null;
  // Vitesse
  if (speedKmh > C.SPEED_LIMIT_KMH) {
    speedOverSince = speedOverSince || t;
    if (!speedEnd && t - speedOverSince >= C.SPEED_GRACE_MS) speedEnd = t + C.SPEED_COUNTDOWN * 1000;
  } else { speedOverSince = null; speedEnd = null; }

  const b = $("banner");
  if (speedEnd) {
    b.textContent = `🚫 ${Math.round(speedKmh)} km/h : véhicule interdit ! Ralentis — élimination dans ${Math.ceil((speedEnd - t) / 1000)} s`;
  } else if (zoneEnd) {
    b.textContent = `⚠️ ZONE ROUGE : reviens dans le cercle — élimination dans ${Math.ceil((zoneEnd - t) / 1000)} s`;
  } else { b.classList.add("hidden"); return; }
  b.classList.remove("hidden"); beep(speedEnd ? 520 : 700, .12);
  if (speedEnd && t >= speedEnd) eliminate("Vitesse excessive (véhicule)");
  else if (!speedEnd && t >= zoneEnd) eliminate("Sortie de la zone de jeu");
}
function eliminate(reason) {
  if (eliminated) return; eliminated = true;
  update(ref(db, `games/${code}/players/${uid}`), { alive: false, reason });
  $("banner").classList.add("hidden");
  beep(300, .4, 3);
  overlay("ÉLIMINÉ", reason, "elim", "Quitter", leave);
}

/* ---------- Lobby / création / rejoindre ---------- */
const genCode = () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.random() * 24 | 0]).join("");
const pseudo = () => $("name").value.trim().slice(0, 14);
$("radius").oninput = e => $("rLabel").textContent = e.target.value >= 1000 ? (e.target.value / 1000) + " km" : e.target.value + " m";
$("name").value = store.name || "";

$("btnCreate").onclick = async () => {
  if (!pseudo()) return alert("Choisis un pseudo");
  if (!pos && !SIM) return alert("Attends que le GPS soit prêt (zone centrée sur ta position)");
  const center = pos ? { lat: pos.lat, lng: pos.lng } : { lat: 48.8426, lng: 2.5033 };
  code = genCode();
  await set(gameRef(), {
    host: uid, state: "lobby", center, radius: +$("radius").value,
    durationMin: +$("duration").value, pingMin: +$("pingMin").value, preys: +$("preys").value, created: Date.now()
  });
  await enter();
};
$("btnJoin").onclick = async () => {
  if (!pseudo()) return alert("Choisis un pseudo");
  code = $("joinCode").value.trim().toUpperCase();
  const s = await get(gameRef());
  if (!s.exists()) { code = null; return alert("Code inconnu"); }
  const g = s.val();
  if (g.state !== "lobby" && !(g.players && g.players[uid])) { code = null; return alert("Partie déjà commencée"); }
  await enter();
};
async function enter() {
  store.name = pseudo(); store.code = code;
  const exists = (await get(ref(db, `games/${code}/players/${uid}`))).exists();
  if (!exists) await set(ref(db, `games/${code}/players/${uid}`), { name: pseudo(), alive: true });
  unsub = onValue(gameRef(), s => { game = s.val(); if (!game) return leave(); route(); });
}
function leave() {
  unsub && unsub(); unsub = null; code = null; game = null; players = {}; myRole = null; shownRole = null;
  eliminated = false; zoneEnd = speedEnd = speedOverSince = null; assigning = false; zoneKey = "";
  delete store.code; zoneLayers.forEach(l => map.removeLayer(l)); zoneLayers = [];
  $("overlay").className = "hidden"; show("home"); draw();
}
$("btnQuit").onclick = async () => { if (code) await set(ref(db, `games/${code}/players/${uid}`), null); leave(); };
$("btnShare").onclick = () => {
  const txt = `Rejoins ma traque MANHUNT ! Code : ${code} — ${location.origin}${location.pathname}`;
  navigator.share ? navigator.share({ text: txt }) : navigator.clipboard.writeText(txt).then(() => toast("Lien copié"));
};
$("btnStart").onclick = () => update(gameRef(), { state: "dispersion", phaseEnd: now() + C.DISPERSION_MS });

/* ---------- Routage selon l'état de la partie ---------- */
function route() {
  players = game.players || {};
  const me = players[uid];
  if (!me) { alert("Tu as été retiré de la partie"); return leave(); }
  myRole = me.role || null;
  drawZone();
  if (game.state === "lobby") {
    show("lobby"); $("codeBig").textContent = code;
    $("lobbyInfo").textContent = `Zone ${game.radius} m · ${game.durationMin} min · ping proie ${game.pingMin} min · ${game.preys} proie(s)`;
    const ul = $("plist"); ul.innerHTML = "";
    Object.values(players).forEach(p => { const li = document.createElement("li"); li.textContent = p.name + (p === players[game.host] ? " 👑" : ""); ul.appendChild(li); });
    const isHost = game.host === uid;
    $("btnStart").classList.toggle("hidden", !isHost); $("waitHost").classList.toggle("hidden", isHost);
    $("btnStart").disabled = Object.keys(players).length < 2;
  } else {
    show("game");
    if (game.state === "dispersion") { $("phase").textContent = "DISPERSION"; $("role").textContent = "???"; }
    if (game.state === "hunt") {
      $("phase").textContent = "TRAQUE"; $("role").textContent = myRole === "proie" ? "🎯 PROIE" : "🔫 CHASSEUR";
      if (myRole && shownRole !== myRole) {
        shownRole = myRole; lastPush = 0; lastPing = 0; follow = true;
        beep(myRole === "proie" ? 440 : 880, .25, 3);
        overlay(myRole === "proie" ? "TU ES UNE PROIE" : "TU ES UN CHASSEUR",
          myRole === "proie" ? "Fuis, reste dans la zone et frôle un chasseur pour débloquer le brouillage GPS." : "Traque les pings rouges et capture la proie à moins de " + C.CAPTURE_M + " m.",
          myRole === "proie" ? "prey" : "hunter", "C'EST PARTI");
      }
    }
    if (me.alive === false && !eliminated) { eliminated = true; overlay("ÉLIMINÉ", me.reason || "", "elim", "Quitter", leave); }
    if (game.state === "ended") {
      const won = (game.winner === "chasseurs") === (myRole === "chasseur");
      overlay(game.winner === "chasseurs" ? "LES CHASSEURS GAGNENT" : game.winner === "proies" ? "LA PROIE S'EST ÉCHAPPÉE" : "PARTIE ANNULÉE",
        game.winner === "annulée" ? "Pas assez de joueurs" : won ? "🏆 Victoire" : "Défaite", "", "Quitter", leave);
    }
  }
  checkEnd(); draw();
}
function endGame(winner) { if (game && game.state === "hunt") update(gameRef(), { state: "ended", winner }); }
function checkEnd() {
  if (!game || game.state !== "hunt") return;
  const arr = Object.values(players), preys = arr.filter(p => p.role === "proie"), hunters = arr.filter(p => p.role === "chasseur");
  if (preys.length && preys.every(p => p.alive === false)) endGame("chasseurs");
  else if (hunters.length && hunters.every(p => p.alive === false)) endGame("proies");
}
async function assignRoles() {
  if (assigning) return; assigning = true;
  const ids = Object.keys(players).filter(i => players[i].alive !== false);
  if (ids.length < 2) return update(gameRef(), { state: "ended", winner: "annulée" });
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[ids[i], ids[j]] = [ids[j], ids[i]]; }
  const np = Math.min(game.preys || 1, ids.length - 1);
  const u = { state: "hunt", huntEnd: now() + game.durationMin * 60000 };
  ids.forEach((id, i) => u[`players/${id}/role`] = i < np ? "proie" : "chasseur");
  await update(gameRef(), u);
}

/* ---------- Actions : capture, brouillage, proximité ---------- */
const fresh = p => p.lat && now() - p.ts < C.FRESH_MS;
let captureTarget = null;
function proximity() {
  if (!game || game.state !== "hunt" || !pos || eliminated) return;
  const me = players[uid]; if (!me) return;
  const n = now();
  $("btnCapture").classList.toggle("hidden", myRole !== "chasseur");
  $("btnJam").classList.toggle("hidden", myRole !== "proie");
  if (myRole === "chasseur") {
    captureTarget = null; let best = Infinity;
    for (const [id, p] of Object.entries(players)) {
      if (p.role !== "proie" || p.alive === false || !fresh(p)) continue;
      const d = dist(pos, p); if (d < best) { best = d; captureTarget = id; }
    }
    const ok = best <= C.CAPTURE_M; $("btnCapture").disabled = !ok;
    $("btnCapture").textContent = ok ? "🔴 CAPTURER" : "CAPTURER (cible hors de portée)";
  } else if (myRole === "proie") {
    if (!me.bonus && !(me.jamUntil > n)) {
      for (const p of Object.values(players))
        if (p.role === "chasseur" && p.alive !== false && fresh(p) && dist(pos, p) <= C.BONUS_M) {
          update(ref(db, `games/${code}/players/${uid}`), { bonus: true }); toast("⚡ Capacité débloquée : BROUILLAGE GPS"); beep(1000, .15, 2); break;
        }
    }
    const jam = me.jamUntil > n, b = $("btnJam");
    b.disabled = !me.bonus || jam;
    b.textContent = jam ? `📡 BROUILLÉ — ${fmt(me.jamUntil - n)}` : me.bonus ? "⚡ ACTIVER LE BROUILLAGE GPS" : "🔒 Frôle un chasseur (< 20 m) pour débloquer";
  }
}
$("btnCapture").onclick = () => {
  if (captureTarget) update(ref(db, `games/${code}/players/${captureTarget}`), { alive: false, reason: "Capturé par " + players[uid].name });
};
$("btnJam").onclick = () => update(ref(db, `games/${code}/players/${uid}`), { bonus: false, jamUntil: now() + C.JAM_MS, jamPos: { lat: pos.lat, lng: pos.lng } });

/* ---------- Publication des positions ---------- */
function publish() {
  if (!game || game.state !== "hunt" || !pos || eliminated || !myRole) return;
  const n = now(), u = {};
  if (n - lastPush >= C.PUSH_MS) { u[`players/${uid}/lat`] = pos.lat; u[`players/${uid}/lng`] = pos.lng; u[`players/${uid}/ts`] = n; lastPush = n; }
  const me = players[uid] || {};
  // Position "affichée" : publiée pour tous à intervalle régulier ; figée pendant le brouillage de la proie
  if (!(myRole === "proie" && me.jamUntil > n) && n - lastPing >= game.pingMin * 60000) {
    u[`players/${uid}/ping`] = { lat: pos.lat, lng: pos.lng, ts: n }; lastPing = n;
  }
  if (Object.keys(u).length) update(gameRef(), u);
}

/* ---------- Boucle principale (1 s) ---------- */
setInterval(() => {
  if (!game) return;
  const n = now();
  if (game.state === "dispersion") {
    const r = game.phaseEnd - n; $("timer").textContent = fmt(r);
    if (r <= 0 && game.host === uid) assignRoles();
  } else if (game.state === "hunt") {
    const r = game.huntEnd - n; $("timer").textContent = fmt(r);
    if (r <= 0) endGame("proies");
  }
  rules(); proximity(); publish(); draw();
}, 1000);

/* ---------- Démarrage ---------- */
navigator.wakeLock && document.addEventListener("click", () => navigator.wakeLock.request("screen").catch(() => {}), { once: true });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
if (store.code) { code = store.code; get(gameRef()).then(s => { if (s.exists() && s.val().players && s.val().players[uid]) enter(); else { code = null; } }); }
