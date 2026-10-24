import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getDatabase, ref, set, update, get, onValue, runTransaction } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-database.js";

/* ===== CONFIG FIREBASE ====== */
const firebaseConfig = {
  apiKey: "AIzaSyDlbO2DM_mTjSaCFLU75jHUZbB_dpbtqGc",
  authDomain: "urban-hunt-game.firebaseapp.com",
  // url bdd
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
  CAPTURE_M: 20, DEGRESSIVE_MS: 5 * 60000, MIN_PING_MS: 15000, MAX_JAMS: 2, BONUS_M: 20, ITEM_M: 20, ITEM_MIN_M: 300, JAM_MS: 4 * 60000, PUSH_MS: 3000, FRESH_MS: 30000
};

const db = getDatabase(initializeApp(firebaseConfig));
const $ = id => document.getElementById(id);
const store = SIM ? sessionStorage : localStorage;
const uid = store.uid || (store.uid = Math.random().toString(36).slice(2, 10));
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

let offset = 0, code = null, game = null, players = {}, myRole = null, unsub = null;
let pos = null, speedKmh = 0, follow = true, shownRole = null, assigning = false;
let jamFlushed = 0, lastPush = 0, lastPing = -1, zoneEnd = null, speedOverSince = null, speedEnd = null, eliminated = false;
let photos = {}, unsubPhotos = null;
let zoneKey = "", zoneLayers = [], lastSnap = 0, online = true;
onValue(ref(db, ".info/connected"), s => online = !!s.val());
const gameRef = () => ref(db, `games/${code}`);
const now = () => Date.now() + offset;
onValue(ref(db, ".info/serverTimeOffset"), s => offset = s.val() || 0);

/* ---------- Carte ---------- */
const map = L.map("map", { zoomControl: false, attributionControl: false, maxZoom: 21, zoomSnap: 0.5, zoomDelta: 0.5 }).setView([48.8426, 2.5033], 16);
L.control.attribution({ prefix: false, position: "bottomleft" }).addTo(map);
const CARTO_KEY = "cb1_4pbh_1_eedd6ef45052e29b67a035ce";
L.tileLayer(`https://basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png?key=${CARTO_KEY}`, {
  maxZoom: 21, maxNativeZoom: 19, // au-delà de 19 les tuiles sont simplement agrandies
  attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>, &copy; <a href="https://carto.com/attributions">CARTO</a>'
}).addTo(map);
map.on("dragstart", () => follow = false);
let zoomInit = false, lastSuper = 0, claiming = false;
$("recenter").onclick = () => { follow = true; if (pos) map.panTo([pos.lat, pos.lng]); };

const markers = {}; let keep = new Set();
function mk(id, p, cls, label, photo) {
  keep.add(id);
  const icon = () => L.divIcon({
    className: "mk " + cls,
    html: `<div class="dot${photo ? " ph" : ""}"${photo ? ` style="background-image:url(${photo})"` : ""}></div><b>${esc(label)}</b>`,
    iconSize: [0, 0]
  });
  const key = cls + label + (photo ? 1 : 0);
  let m = markers[id];
  if (!m) { m = markers[id] = L.marker([p.lat, p.lng], { icon: icon(), interactive: false }).addTo(map); m._k = key; }
  else { m.setLatLng([p.lat, p.lng]); if (m._k !== key) { m.setIcon(icon()); m._k = key; } }
}
function draw() {
  keep = new Set();
  if (pos) mk("me", pos, "me", "", store.photo);
  if (game && game.state === "hunt") {
    for (const [id, p] of Object.entries(players)) {
      if (id === uid || p.alive === false) continue;
      const jam = p.role === "proie" && p.jamUntil > now();
      // SUPER GPS : les chasseurs voient la proie en direct (sauf si elle est brouillée)
      if (p.role === "proie" && myRole === "chasseur" && superActive() && !jam && fresh(p)) { mk(id, p, "prey", `${p.name} · LIVE`, photos[id]); continue; }
      if (!p.ping) continue; // position publiée à intervalle régulier (pour tous les joueurs)
      const age = Math.round((now() - p.ping.ts) / 60000);
      const cls = p.role === "chasseur" ? "hunter" : "ping" + (jam ? " jam" : "");
      mk(id, p.ping, cls, jam ? "BROUILLÉ" : `${p.name} · ${age} min`, photos[id]);
    }
  }
  const kind = myRole === "proie" ? "prey" : myRole === "chasseur" ? "hunter" : null;
  const it = game && game.state === "hunt" && kind && game.items && game.items[kind];
  if (it && !it.taken && !eliminated) mk("item", it, "item " + kind, kind === "prey" ? "⚡ BROUILLAGE" : "📡 SUPER GPS");
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
function overlay(title, sub, cls = "", btn = "OK", onclick, btn2, onclick2) {
  const o = $("overlay"); o.className = cls; $("ovTitle").textContent = title; $("ovSub").textContent = sub;
  $("ovBtn").textContent = btn; $("ovBtn").onclick = () => { o.className = "hidden"; onclick && onclick(); };
  const b2 = $("ovBtn2"); b2.classList.toggle("hidden", !btn2);
  if (btn2) { b2.textContent = btn2; b2.onclick = () => { o.className = "hidden"; onclick2 && onclick2(); }; }
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
  if (follow && !$("game").classList.contains("hidden")) {
    // Zoom initial 18 une seule fois ; ensuite on garde le zoom choisi par le joueur (pincer / double-tap)
    if (!zoomInit) { map.setView([pos.lat, pos.lng], 18); zoomInit = true; } else map.panTo([pos.lat, pos.lng], { animate: true });
  }
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

/* ---------- Photo de profil (miniature 96 px stockée dans la base, sans Storage) ---------- */
async function resizePhoto(file) {
  const img = new Image(); img.src = URL.createObjectURL(file); await img.decode();
  const S = 96, c = document.createElement("canvas"); c.width = c.height = S;
  const m = Math.min(img.width, img.height);
  c.getContext("2d").drawImage(img, (img.width - m) / 2, (img.height - m) / 2, m, m, 0, 0, S, S);
  URL.revokeObjectURL(img.src);
  return c.toDataURL("image/jpeg", .7);
}
function takePhoto() {
  const i = document.createElement("input"); i.type = "file"; i.accept = "image/*"; i.setAttribute("capture", "user");
  i.onchange = async () => {
    if (!i.files[0]) return;
    store.photo = await resizePhoto(i.files[0]); updateAvatar();
    if (code) set(ref(db, `games/${code}_photos/${uid}`), store.photo);
  };
  i.click();
}
function updateAvatar() {
  const bg = store.photo ? `url(${store.photo})` : "none";
  $("avatar").style.backgroundImage = bg; $("avatar2").style.backgroundImage = bg;
  $("btnPhoto").textContent = store.photo ? "Changer ma photo" : "Prendre ma photo (obligatoire)";
}
$("btnPhoto").onclick = takePhoto; $("btnPhoto2").onclick = takePhoto;
updateAvatar();

/* ---------- Lobby / création / rejoindre ---------- */
const genCode = () => Array.from({ length: 5 }, () => "ABCDEFGHJKLMNPQRSTUVWXYZ"[Math.random() * 24 | 0]).join("");
const pseudo = () => $("name").value.trim().slice(0, 14);
$("radius").oninput = e => $("rLabel").textContent = e.target.value >= 1000 ? (e.target.value / 1000) + " km" : e.target.value + " m";
$("name").value = store.name || "";

$("btnCreate").onclick = async () => {
  if (!pseudo()) return alert("Choisis un pseudo");
  if (!store.photo) return alert("Prends d'abord une photo de profil");
  if (!pos && !SIM) return alert("Attends que le GPS soit prêt (zone centrée sur ta position)");
  const center = pos ? { lat: pos.lat, lng: pos.lng } : { lat: 48.8426, lng: 2.5033 };
  code = genCode();
  await set(gameRef(), {
    host: uid, state: "lobby", center, radius: +$("radius").value,
    durationMin: +$("duration").value, dispersionMin: +$("dispersion").value || 5, lostSec: +$("lostSec").value, jamMin: +$("jamMin").value || 4, superMin: +$("superMin").value || 3, pingMin: +$("pingMin").value, preys: +$("preys").value, created: Date.now()
  });
  await enter();
};
$("btnJoin").onclick = async () => {
  if (!pseudo()) return alert("Choisis un pseudo");
  if (!store.photo) return alert("Prends d'abord une photo de profil");
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
  // Photos stockées à part (games/CODE_photos : couvert par la règle "$code" existante) pour ne pas alourdir les mises à jour
  if (store.photo) set(ref(db, `games/${code}_photos/${uid}`), store.photo);
  unsubPhotos = onValue(ref(db, `games/${code}_photos`), s => { photos = s.val() || {}; if (game) { renderLobby(); renderLegend(); draw(); } });
  unsub = onValue(gameRef(), s => { lastSnap = Date.now(); game = s.val(); if (!game) return leave(); route(); });
}
function leave() {
  unsub && unsub(); unsub = null; unsubPhotos && unsubPhotos(); unsubPhotos = null; photos = {}; code = null; game = null; players = {}; myRole = null; shownRole = null;
  eliminated = false; zoneEnd = speedEnd = speedOverSince = null; assigning = false; zoneKey = ""; zoomInit = false; degShown = false;
  delete store.code; zoneLayers.forEach(l => map.removeLayer(l)); zoneLayers = [];
  $("overlay").className = "hidden"; show("home"); draw();
}
$("btnQuit").onclick = async () => { if (code) { await set(ref(db, `games/${code}/players/${uid}`), null); await set(ref(db, `games/${code}_photos/${uid}`), null); } leave(); };
$("btnShare").onclick = () => {
  const txt = `Rejoins ma traque MANHUNT ! Code : ${code} — ${location.origin}${location.pathname}`;
  navigator.share ? navigator.share({ text: txt }) : navigator.clipboard.writeText(txt).then(() => toast("Lien copié"));
};
$("btnStart").onclick = () => update(gameRef(), { state: "dispersion", phaseEnd: now() + (FAST ? C.DISPERSION_MS : (game.dispersionMin || 5) * 60000) });

/* ---------- Routage selon l'état de la partie ---------- */
function resetLocal() { // remise à zéro locale (nouvelle partie / revanche)
  eliminated = false; shownRole = null; assigning = false; zoneEnd = speedEnd = speedOverSince = null;
  lastPing = -1; lastPush = 0; jamFlushed = 0; lastSuper = 0; zoomInit = false; degShown = false; $("banner").classList.add("hidden");
}
function renderLobby() {
  if (!game || game.state !== "lobby") return;
  $("codeBig").textContent = code;
  $("lobbyInfo").textContent = `Zone ${game.radius} m · dispersion ${game.dispersionMin || 5} min · traque ${game.durationMin} min · positions toutes les ${game.pingMin} min · ${game.preys} proie(s) · brouillage ${game.jamMin || 4} min · super GPS ${game.superMin || 3} min`;
  const ul = $("plist"); ul.innerHTML = "";
  Object.entries(players).forEach(([id, p]) => {
    const li = document.createElement("li"), av = document.createElement("span"); av.className = "lav";
    if (photos[id]) av.style.backgroundImage = `url(${photos[id]})`;
    li.append(av, document.createTextNode(p.name + (id === game.host ? " 👑" : ""))); ul.appendChild(li);
  });
  const isHost = game.host === uid;
  $("btnStart").classList.toggle("hidden", !isHost); $("waitHost").classList.toggle("hidden", isHost);
  $("btnStart").disabled = Object.keys(players).length < 2;
}
// Légende : qui est proie / chasseur (visible pendant la traque)
function renderLegend() {
  const on = game && ["hunt"].includes(game.state);
  $("legend").classList.toggle("hidden", !on); if (!on) return;
  const list = $("legendList"); list.innerHTML = "";
  Object.entries(players).sort((a, b) => (a[1].role === "proie" ? 0 : 1) - (b[1].role === "proie" ? 0 : 1)).forEach(([id, p]) => {
    const row = document.createElement("div"), av = document.createElement("span"), t = document.createElement("small");
    row.className = "lrow " + (p.role === "proie" ? "prey" : "hunter") + (p.alive === false ? " dead" : "");
    av.className = "lav"; if (photos[id]) av.style.backgroundImage = `url(${photos[id]})`;
    t.textContent = (p.role === "proie" ? "PROIE" : "CHASSEUR") + (id === uid ? " (toi)" : "");
    row.append(av, document.createTextNode(p.name + " "), t); list.appendChild(row);
  });
}
$("legendBtn").onclick = () => $("legendList").classList.toggle("hidden");
// Revanche : même joueurs, même réglages, tout le monde repasse au lobby
function rematch() {
  const u = { state: "lobby", winner: null, huntEnd: null, phaseEnd: null, items: null, superUntil: null, superBy: null };
  if (!players[game.host]) u.host = uid;
  for (const id in players) {
    for (const k of ["role", "reason", "lat", "lng", "ts", "acc", "ping", "jamUntil", "jamPos", "bonus", "jamsUsed"]) u[`players/${id}/${k}`] = null;
    u[`players/${id}/alive`] = true;
  }
  update(gameRef(), u);
}
function route() {
  players = game.players || {};
  const me = players[uid];
  if (!me) { alert("Tu as été retiré de la partie"); return leave(); }
  myRole = me.role || null;
  drawZone();
  if (game.state === "lobby") {
    show("lobby"); $("overlay").className = "hidden"; resetLocal(); renderLobby();
  } else {
    show("game");
    if (game.state === "dispersion") { $("phase").textContent = "DISPERSION"; $("role").textContent = "???"; $("ping").textContent = "--:--"; }
    if (game.state === "hunt") {
      $("phase").textContent = "TRAQUE"; $("role").textContent = myRole === "proie" ? "🎯 PROIE" : "🔫 CHASSEUR";
      if (myRole && shownRole !== myRole) {
        shownRole = myRole; lastPush = 0; lastPing = -1; follow = true;
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
        game.winner === "annulée" ? "Pas assez de joueurs" : (won ? "🏆 Victoire" : "Défaite") + "\n\n" + summary(), "", "Quitter", leave, "🔁 REJOUER (mêmes joueurs)", rematch);
    }
  }
  checkEnd(); renderLegend(); draw();
}
// Récapitulatif de fin de partie : qui a été capturé par qui, éliminations, survivants
function summary() {
  const arr = Object.values(players), out = [];
  arr.filter(p => p.role === "proie").forEach(p => out.push(p.alive === false ? `🎯 ${p.name} (proie) : ${p.reason || "éliminé"}` : `🎯 ${p.name} (proie) : a survécu`));
  arr.filter(p => p.role === "chasseur" && p.alive === false).forEach(p => out.push(`🔫 ${p.name} : ${p.reason || "éliminé"}`));
  return out.join("\n");
}
function endGame(winner) { if (game && game.state === "hunt") update(gameRef(), { state: "ended", winner }); }
function checkEnd() {
  if (!game || game.state !== "hunt") return;
  const arr = Object.values(players), preys = arr.filter(p => p.role === "proie"), hunters = arr.filter(p => p.role === "chasseur");
  if (preys.length && preys.every(p => p.alive === false)) endGame("chasseurs");
  else if (hunters.length && hunters.every(p => p.alive === false)) endGame("proies");
}
function randPoint(c, R) { // point aléatoire dans la zone (marge de 25 % avec le bord)
  const r = R * .75 * Math.sqrt(Math.random()), a = Math.random() * 2 * Math.PI;
  return { lat: c.lat + r * Math.cos(a) / 111320, lng: c.lng + r * Math.sin(a) / (111320 * Math.cos(c.lat * Math.PI / 180)) };
}
// Place les objets loin de l'équipe concernée (≥ ITEM_MIN_M, au plus 60 % du rayon) et loin l'un de l'autre (≥ 50 % du rayon)
function pickItem(teamPts, other) {
  const R = game.radius, minD = Math.min(C.ITEM_MIN_M, R * .6), gap = R * .5;
  let best = null, bs = -1;
  for (let i = 0; i < 300; i++) {
    const p = randPoint(game.center, R);
    const dT = teamPts.length ? Math.min(...teamPts.map(q => dist(p, q))) : Infinity, dO = other ? dist(p, other) : Infinity;
    if (dT >= minD && dO >= gap) return p;
    const sc = Math.min(dT / minD, dO / gap); if (sc > bs) { bs = sc; best = p; } // repli : le meilleur candidat
  }
  return best;
}
function placeItems(ids, np) {
  const pts = list => list.map(id => players[id]).filter(p => p && p.lat);
  const prey = pickItem(pts(ids.slice(0, np)), null);
  return { prey, hunter: pickItem(pts(ids.slice(np)), prey) };
}
async function assignRoles() {
  if (assigning) return; assigning = true;
  const ids = Object.keys(players).filter(i => players[i].alive !== false);
  if (ids.length < 2) return update(gameRef(), { state: "ended", winner: "annulée" });
  for (let i = ids.length - 1; i > 0; i--) { const j = Math.random() * (i + 1) | 0;[ids[i], ids[j]] = [ids[j], ids[i]]; }
  const np = Math.min(game.preys || 1, ids.length - 1);
  const u = { state: "hunt", huntEnd: now() + game.durationMin * 60000, superUntil: null,
    items: placeItems(ids, np) };
  ids.forEach((id, i) => u[`players/${id}/role`] = i < np ? "proie" : "chasseur");
  await update(gameRef(), u);
}

/* ---------- Objets cachés dans la zone ---------- */
// Proie : le point débloque 1 brouillage. Chasseurs : le point active le SUPER GPS (proie en direct, pour toute l'équipe).
async function claimItem(kind) {
  if (claiming) return; claiming = true;
  try {
    const r = await runTransaction(ref(db, `games/${code}/items/${kind}/taken`), cur => cur ? undefined : uid); // un seul gagnant
    if (!r.committed) return;
    const me = players[uid] || {};
    if (kind === "prey") {
      const used = me.jamsUsed || 0;
      update(ref(db, `games/${code}/players/${uid}`), { bonus: true, jamsUsed: used >= C.MAX_JAMS ? used - 1 : used });
      toast("⚡ Objet trouvé : 1 BROUILLAGE GPS débloqué"); beep(1000, .15, 2);
    } else {
      update(gameRef(), { superUntil: now() + (game.superMin || 3) * 60000, superBy: me.name || "" });
    }
  } finally { claiming = false; }
}
function superActive() { return game && game.superUntil > now(); }

/* ---------- Actions : capture, brouillage, proximité ---------- */
const fresh = p => p.lat && now() - p.ts < C.FRESH_MS;
// Distance "effective" : on retire la marge d'erreur GPS cumulée des deux téléphones (max 20 m)
// pour que deux joueurs côte à côte soient bien détectés malgré l'imprécision.
const effDist = p => Math.max(0, dist(pos, p) - Math.min(((pos.acc || 0) + (p.acc || 0)) / 2, 20));
let captureTarget = null;
function proximity() {
  if (!game || game.state !== "hunt" || !pos || eliminated) return;
  const me = players[uid]; if (!me) return;
  const n = now();
  const kind = myRole === "proie" ? "prey" : myRole === "chasseur" ? "hunter" : null;
  const it = kind && game.items && game.items[kind];
  if (it && !it.taken && Math.max(0, dist(pos, it) - Math.min(pos.acc || 0, 20)) <= C.ITEM_M) claimItem(kind);
  $("btnCapture").classList.toggle("hidden", myRole !== "chasseur");
  $("btnJam").classList.toggle("hidden", myRole !== "proie");
  if (myRole === "chasseur") {
    captureTarget = null; let best = Infinity;
    for (const [id, p] of Object.entries(players)) {
      if (p.role !== "proie" || p.alive === false || !fresh(p)) continue;
      const d = effDist(p); if (d < best) { best = d; captureTarget = id; }
    }
    const ok = best <= C.CAPTURE_M; $("btnCapture").disabled = !ok;
    $("btnCapture").textContent = ok ? "🔴 CAPTURER" : best <= 60 ? "CAPTURER (cible proche…)" : "CAPTURER (cible hors de portée)";
  } else if (myRole === "proie") {
    if (!me.bonus && !(me.jamUntil > n) && (me.jamsUsed || 0) < C.MAX_JAMS) {
      for (const p of Object.values(players))
        if (p.role === "chasseur" && p.alive !== false && fresh(p) && effDist(p) <= C.BONUS_M) {
          update(ref(db, `games/${code}/players/${uid}`), { bonus: true }); toast("⚡ Capacité débloquée : BROUILLAGE GPS"); beep(1000, .15, 2); break;
        }
    }
    const jam = me.jamUntil > n, b = $("btnJam");
    const left = C.MAX_JAMS - (me.jamsUsed || 0);
    b.disabled = !me.bonus || jam;
    b.textContent = jam ? `📡 BROUILLÉ — ${fmt(me.jamUntil - n)}`
      : left <= 0 ? "🚫 Brouillage épuisé"
      : me.bonus ? `⚡ ACTIVER LE BROUILLAGE GPS (${left} restant${left > 1 ? "s" : ""})`
      : `🔒 Frôle un chasseur (< 20 m) pour débloquer (${left} restant${left > 1 ? "s" : ""})`;
  }
}
$("btnCapture").onclick = () => {
  const t = captureTarget && players[captureTarget];
  if (t && t.alive !== false && fresh(t) && effDist(t) <= C.CAPTURE_M + 5) update(ref(db, `games/${code}/players/${captureTarget}`), { alive: false, reason: "Capturé par " + players[uid].name });
};
$("btnJam").onclick = () => (players[uid].jamsUsed || 0) < C.MAX_JAMS && update(ref(db, `games/${code}/players/${uid}`), { bonus: false, jamsUsed: (players[uid].jamsUsed || 0) + 1, jamUntil: now() + (game.jamMin || 4) * 60000, jamPos: { lat: pos.lat, lng: pos.lng } });

/* ---------- Publication des positions ---------- */
const huntStart = () => game.huntEnd - game.durationMin * 60000;
// Planning des pings (identique chez tous les joueurs). Normal : toutes les pingMin minutes.
// Pendant les 5 dernières minutes : l'intervalle diminue progressivement jusqu'à MIN_PING_MS.
let sched = { key: "", times: [] }, degShown = false;
function pingTimes() {
  const key = game.huntEnd + "|" + game.pingMin + "|" + game.durationMin;
  if (sched.key === key) return sched.times;
  const start = huntStart(), end = game.huntEnd, pm = game.pingMin * 60000, T = C.DEGRESSIVE_MS, MIN = Math.min(C.MIN_PING_MS, pm);
  const times = []; let t = start;
  while (t < end) {
    times.push(t);
    if (end - t > T) t = Math.min(t + pm, Math.max(t + 1000, end - T)); // un ping tombe exactement à 5 min de la fin
    else t += Math.max(MIN, Math.min(pm, MIN + (pm - MIN) * ((end - t) / T) ** 2));
  }
  sched = { key, times }; return times;
}
const pingIdx = n => pingTimes().filter(t => t <= n).length - 1;
function publish() {
  if (!game || !["dispersion", "hunt"].includes(game.state) || !pos || eliminated) return;
  const n = now(), u = {};
  if (game.state === "dispersion") { // simple battement de cœur (position non affichée)
    if (n - lastPush >= C.PUSH_MS) { update(ref(db, `games/${code}/players/${uid}`), { ts: n, lat: pos.lat, lng: pos.lng, acc: Math.round(pos.acc || 0) }); lastPush = n; }
    return;
  }
  if (!myRole) return;
  if (n - lastPush >= C.PUSH_MS) { u[`players/${uid}/lat`] = pos.lat; u[`players/${uid}/lng`] = pos.lng; u[`players/${uid}/ts`] = n; u[`players/${uid}/acc`] = Math.round(pos.acc || 0); lastPush = n; }
  const me = players[uid] || {};
  // Position "affichée" : publiée pour tous à intervalle régulier ; figée pendant le brouillage de la proie
  // Fin du brouillage : la position se met à jour immédiatement, sans attendre le prochain ping
  if (myRole === "proie" && me.jamUntil && n >= me.jamUntil && jamFlushed !== me.jamUntil) {
    jamFlushed = me.jamUntil;
    u[`players/${uid}/ping`] = { lat: pos.lat, lng: pos.lng, ts: n };
  }
  // Pings synchronisés pour tous : à huntStart + k × intervalle
  const idx = pingIdx(n);
  if (idx > lastPing) {
    lastPing = idx;
    if (!(myRole === "proie" && me.jamUntil > n)) u[`players/${uid}/ping`] = { lat: pos.lat, lng: pos.lng, ts: n };
  }
  if (Object.keys(u).length) update(gameRef(), u);
}

/* ---------- Perte de contact : joueur sans signal => éliminé ---------- */
function checkLost() {
  if (!game || !["dispersion", "hunt"].includes(game.state) || eliminated || !game.lostSec) return;
  const n = now(), lostMs = game.lostSec * 1000;
  const start = game.state === "hunt" ? game.huntEnd - game.durationMin * 60000
    : game.phaseEnd - (FAST ? C.DISPERSION_MS : (game.dispersionMin || 5) * 60000);
  const mine = players[uid] && players[uid].ts;
  // On n'agit que si NOTRE connexion est saine (sinon on éliminerait tout le monde à tort)
  if (!online || Date.now() - lastSnap > 15000 || !mine || n - mine > 20000) return;
  for (const [id, p] of Object.entries(players)) {
    if (id === uid || p.alive === false) continue;
    if (n - Math.max(p.ts || 0, start) > lostMs)
      update(ref(db, `games/${code}/players/${id}`), { alive: false, reason: `Connexion perdue (${game.lostSec} s sans signal)` });
  }
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
    const nxt = pingTimes().find(t => t > n);
    $("ping").textContent = nxt ? fmt(nxt - n) : "--:--";
    if (r <= C.DEGRESSIVE_MS && !degShown) { degShown = true; toast("⚡ 5 dernières minutes : les positions se rafraîchissent de plus en plus vite !"); beep(880, .12, 3); }
    if (game.superUntil && game.superUntil !== lastSuper && game.superUntil > n) {
      lastSuper = game.superUntil;
      toast(myRole === "chasseur" ? `📡 SUPER GPS ! La proie est visible en direct pendant ${game.superMin || 3} min` : `⚠️ Les chasseurs ont un SUPER GPS pendant ${game.superMin || 3} min`);
      beep(myRole === "chasseur" ? 1000 : 300, .2, 3);
    }
    const sb = $("badge"), on = game.superUntil > n;
    sb.classList.toggle("hidden", !on);
    if (on) sb.textContent = (myRole === "chasseur" ? "📡 SUPER GPS " : "⚠️ SUPER GPS ENNEMI ") + fmt(game.superUntil - n);
    if (r <= 0) endGame("proies");
  }
  rules(); proximity(); publish(); checkLost(); draw();

}, 1000);

/* ---------- Démarrage ---------- */
const keepAwake = () => navigator.wakeLock && navigator.wakeLock.request("screen").catch(() => {});
document.addEventListener("click", keepAwake, { once: true });
document.addEventListener("visibilitychange", () => { if (!document.hidden) { keepAwake(); if (game && ["dispersion", "hunt"].includes(game.state)) toast("⚠️ Garde l'appli au premier plan et l'écran allumé"); } });
if ("serviceWorker" in navigator) navigator.serviceWorker.register("sw.js");
if (store.code) { code = store.code; get(gameRef()).then(s => { if (s.exists() && s.val().players && s.val().players[uid]) enter(); else { code = null; } }); }
