// Pregen LOD 1.5 - pre-gera chunks com ticking areas temporarias e grava o mapa de LOD.
//
// Comandos (precisam de cheats/operador; tambem funcionam pelo console do servidor):
//   /scriptevent pregen:start [raio] [x z] [fast|normal|gentle] [nolod]
//        raio em chunks; x z = centro em BLOCOS (sem x z usa a posicao do jogador, ou 0 0 sem jogador)
//        sem argumentos retoma o que estava pausado
//   /scriptevent pregen:grow [extra]   amplia o raio ja gerado (padrao +10, perfil gentle), pula o miolo pronto
//   /scriptevent pregen:stop           pausa (o progresso fica salvo no mundo)
//   /scriptevent pregen:status         mostra o andamento
//   /scriptevent pregen:reset [lod]    apaga o progresso salvo (com "lod" apaga tambem o mapa de LOD)
//
// Perfis de velocidade:
//   fast   - blocos grandes, sem pausa: servidor dedicado / GitHub Actions (padrao sem jogador)
//   normal - blocos medios, pausa proporcional ao tempo do bloco, respeita lag (padrao com jogador)
//   gentle - blocos pequenos, pausa longa: gerar aos poucos no celular
//
// Contrato com o servidor dedicado (o workflow le o log): linhas "[PREGEN] START", "[PREGEN] PROGRESS i/n",
// "[PREGEN] DONE" e "[PREGEN] ABORT".
import * as mc from "@minecraft/server";
const { world, system } = mc;

const CONFIG = {
  autoStart: true,        // inicia sozinho na primeira vez que um jogador entra no mundo
  autoRadius: 20,         // raio, em chunks, do quadrado gerado no auto-start
  autoProfile: "normal",
  maxRadius: 100,
  lod: true,              // grava o mapa de LOD (use "nolod" no comando para desligar numa execucao)
  tileTimeout: 1200,      // ticks esperando uma ticking area carregar antes de contar como falha
  tileAttempts: 3,        // tentativas por bloco antes de adiar para a passada final
  abortAfterFails: 8,     // falhas seguidas que interrompem a geracao
};
const PROFILES = {
  fast:   { side: 12, duty: 1,    minPause: 2,  maxPause: 2,   guard: false, protect: false },
  normal: { side: 8,  duty: 0.7,  minPause: 4,  maxPause: 100, guard: true,  protect: true },
  gentle: { side: 4,  duty: 0.25, minPause: 10, maxPause: 400, guard: true,  protect: true },
};
const hasProfile = (n) => Object.prototype.hasOwnProperty.call(PROFILES, n);

const PROP = "pregen_state";
const AREA_ID = "pregen_tmp";
const PAL_PROP = "lod_pal";
const WATER = /water/;
const ON_PROP = "lodforge_on";   // "1" quando /lodforge:start foi dado; o mod nativo le isto do disco
const POS_PROP = "lodforge_pos"; // "x,y,z,dim" do jogador: o mod nativo le isto (com atraso) para saber onde desenhar o LOD
const isLodOn = () => world.getDynamicProperty(ON_PROP) === "1";

// Nomes que nao contam como "topo" do terreno. "air" so casa com air/cave_air/void_air
// (antes casava com qualquer nome que contivesse "air", como "stairs").
// Se o leitor nativo do LodForge usa a mesma lista, ajuste la tambem.
const SKIP = /(?:^|:)(?:cave_|void_)?air$|structure_void|light_block|barrier|short_grass|tall_grass|fern|wildflowers|leaf_litter|bush|cornflower|oxeye_daisy|dandelion|poppy|sapling|azure_bluet|tulip|allium|orchid|lily_of_the_valley|peony|lilac|sunflower|double_plant/;

let running = false;
let stopRequested = false;
let booted = false;

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const sleep = (ticks) => new Promise((res) => system.runTimeout(res, Math.max(1, ticks)));
function withTimeout(p, ticks) {
  return Promise.race([p, sleep(ticks).then(() => { throw new Error("timeout carregando a area"); })]);
}
const strip = (s) => String(s).replace(/§./g, "");
function log(msg) { try { console.warn("[PREGEN] " + strip(msg)); } catch { /* sem console */ } }
function say(msg) { try { world.sendMessage("§b[Pregen]§r " + msg); } catch { /* sem jogadores */ } }
function note(msg) { log(msg); say(msg); }
const errText = (e) => String(e && e.message ? e.message : e);

// ---------- saude do servidor: tempo real gasto a cada 20 ticks ----------
let wallLast = Date.now(), avgMs = 1000;

function writePos() {
  try {
    const p = world.getAllPlayers()[0]; if (!p) return;
    const l = p.location;
    world.setDynamicProperty(POS_PROP, l.x.toFixed(2) + "," + l.y.toFixed(2) + "," + l.z.toFixed(2) + "," + (p.dimension.id === "minecraft:overworld" ? 0 : 1));
  } catch { /* jogador ainda nao disponivel */ }
}

// ---------- LOD: amostra o terreno enquanto os chunks estao carregados ----------
// Formato (por chunk, 4x4 celulas, 3 bytes cada = 48 bytes, base64):
//   byte0,byte1 = (altura + 64) em little-endian; byte2 = indice na paleta (255 = sem dado)
// Gravado em propriedades dinamicas do mundo: lod_<rx>_<rz> = "cx,cz:BASE64;cx,cz:BASE64;..." (regiao 8x8 chunks)
// e lod_pal = ["minecraft:grass_block", ...].
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function b64enc(u8) {
  let s = "";
  for (let i = 0; i < u8.length; i += 3) {
    const n = (u8[i] << 16) | ((u8[i + 1] || 0) << 8) | (u8[i + 2] || 0);
    s += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + B64[(n >> 6) & 63] + B64[n & 63];
  }
  return s;
}
let palette = null, palDirty = false;
const regions = new Map();
function loadPalette() {
  if (palette) return;
  try { palette = JSON.parse(world.getDynamicProperty(PAL_PROP) || "[]"); } catch { palette = []; }
}
function paletteId(name) {
  let i = palette.indexOf(name);
  if (i < 0) { if (palette.length >= 255) return 255; i = palette.length; palette.push(name); palDirty = true; }
  return i;
}
function regionKey(cx, cz) { return "lod_" + Math.floor(cx / 8) + "_" + Math.floor(cz / 8); }
function getRegion(key) {
  let r = regions.get(key);
  if (!r) {
    r = { dirty: false, chunks: new Map() };
    const s = world.getDynamicProperty(key);
    if (typeof s === "string") for (const e of s.split(";")) { if (!e) continue; const p = e.split(":"); r.chunks.set(p[0], p[1]); }
    regions.set(key, r);
  }
  return r;
}
function flushLod() {
  for (const [key, r] of regions) {
    if (!r.dirty) continue;
    world.setDynamicProperty(key, [...r.chunks].map(([k, v]) => k + ":" + v).join(";"));
    r.dirty = false;
  }
  if (palDirty) { world.setDynamicProperty(PAL_PROP, JSON.stringify(palette)); palDirty = false; }
}
function sampleChunk(dim, cx, cz) {
  const out = new Uint8Array(48); let ok = 0;
  for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
    const x = cx * 16 + i * 4 + 2, z = cz * 16 + j * 4 + 2, n = (j * 4 + i) * 3;
    let h = -64, id = 255;
    try {
      let b = dim.getTopmostBlock({ x, z }), k = 0;
      while (b && SKIP.test(b.typeId) && k++ < 4) b = b.below();
      if (b && !SKIP.test(b.typeId)) {
        let name = b.typeId, y = b.y;
        // getTopmostBlock ignora liquidos: se ha agua por cima, o topo e a superficie da agua.
        const a = b.above();
        if (a && WATER.test(a.typeId)) {
          let top = a.y;
          const s62 = dim.getBlock({ x, y: 62, z });          // nivel do mar (rios/oceanos)
          if (s62 && WATER.test(s62.typeId)) {
            top = 62;
            for (let q = 63; q < 100; q++) { const bb = dim.getBlock({ x, y: q, z }); if (bb && WATER.test(bb.typeId)) top = q; else break; }
          } else { let c = a, g = 0; while (g++ < 24) { const nx = c.above(); if (nx && WATER.test(nx.typeId)) c = nx; else break; } top = c.y; }
          name = "minecraft:water"; y = top;
        }
        h = y; id = paletteId(name); ok++;
      }
    } catch { /* chunk nao carregado */ }
    out[n] = (h + 64) & 255; out[n + 1] = (h + 64) >> 8; out[n + 2] = id;
  }
  return ok ? out : null;
}
async function sampleTile(dim, t, st) {
  let n = 0;
  for (let cz = t.z0; cz <= t.z1; cz++) for (let cx = t.x0; cx <= t.x1; cx++) {
    const rec = sampleChunk(dim, cx, cz);
    if (rec) { const r = getRegion(regionKey(cx, cz)); r.chunks.set(cx + "," + cz, b64enc(rec)); r.dirty = true; st.sampled = (st.sampled || 0) + 1; }
    else st.unsampled = (st.unsampled || 0) + 1;
    if (++n % 12 === 0) await sleep(1);
  }
}

// ---------- estado salvo no mundo ----------
function loadState() {
  try {
    const s = world.getDynamicProperty(PROP);
    if (typeof s !== "string") return undefined;
    const st = JSON.parse(s);
    // estados antigos (<=1.4) nao tinham estes campos
    if (!Array.isArray(st.failed)) st.failed = [];
    if (!hasProfile(st.profile)) st.profile = "normal";
    st.lod = st.lod !== false;
    st.base = st.base || 0;
    st.fails = st.fails || 0;
    return st;
  } catch { return undefined; }
}
function saveState(st) { try { world.setDynamicProperty(PROP, JSON.stringify(st)); } catch { /* ignora */ } }

function newState(cx, cz, radius, profile, lod, prev) {
  const maxChunks = world.tickingAreaManager.maxChunkCount || 100;
  const side = Math.max(1, Math.min(PROFILES[profile].side, Math.floor(Math.sqrt(maxChunks))));
  const st = {
    v: 2, cx, cz, radius: clamp(radius, 1, CONFIG.maxRadius), side, profile, lod,
    idx: 0, fails: 0, failed: [], done: false, base: 0, sampled: 0, unsampled: 0,
  };
  // ampliando um raio ja concluido no mesmo centro: o miolo pronto e pulado
  if (prev && prev.done && prev.cx === cx && prev.cz === cz && prev.radius < st.radius) {
    st.base = prev.radius; st.sampled = prev.sampled || 0; st.unsampled = prev.unsampled || 0;
  }
  return st;
}

function buildTiles(st) {
  const { cx, cz, radius, side, base } = st;
  const x0 = cx - radius, x1 = cx + radius, z0 = cz - radius, z1 = cz + radius, tiles = [];
  for (let a = x0; a <= x1; a += side)
    for (let b = z0; b <= z1; b += side) {
      const t = { x0: a, z0: b, x1: Math.min(a + side - 1, x1), z1: Math.min(b + side - 1, z1) };
      const inner = base > 0 && t.x0 >= cx - base && t.x1 <= cx + base && t.z0 >= cz - base && t.z1 <= cz + base;
      if (!inner) tiles.push(t);
    }
  const d = (t) => { const mx = (t.x0 + t.x1) / 2 - cx, mz = (t.z0 + t.z1) / 2 - cz; return mx * mx + mz * mz; };
  tiles.sort((p, q) => d(p) - d(q));   // do centro para fora
  return tiles;
}

function showProgress(player, st, total) {
  if (!player) return;
  const frac = total ? st.idx / total : 1, w = 20, f = Math.round(frac * w);
  const bad = st.fails + st.failed.length;
  const text = `§bPre-geracao §f${"█".repeat(f)}§8${"░".repeat(w - f)} §f${Math.round(frac * 100)}%`
    + (bad ? ` §c(${bad} falhas)` : "");
  try { player.onScreenDisplay.setActionBar(text); } catch { /* jogador saiu */ }
}

// ---------- geracao ----------
async function processTile(dim, mgr, t, st, profile, player) {
  let lastErr = null;
  for (let attempt = 1; attempt <= CONFIG.tileAttempts; attempt++) {
    if (stopRequested) return false;
    if (profile.protect && player) { try { player.addEffect("resistance", 400, { amplifier: 4, showParticles: false }); } catch { /* ignora */ } }
    try {
      if (mgr.hasTickingArea(AREA_ID)) mgr.removeTickingArea(AREA_ID);
      await withTimeout(mgr.createTickingArea(AREA_ID, {
        dimension: dim,
        from: { x: t.x0 * 16, y: 0, z: t.z0 * 16 },
        to: { x: t.x1 * 16 + 15, y: 0, z: t.z1 * 16 + 15 },
      }), CONFIG.tileTimeout);
      if (st.lod) {
        loadPalette();
        await sampleTile(dim, t, st);   // le o terreno enquanto a area esta carregada
        flushLod();
      }
      return true;
    } catch (e) {
      lastErr = e;
      await sleep(20 * attempt);
    } finally {
      try { if (mgr.hasTickingArea(AREA_ID)) mgr.removeTickingArea(AREA_ID); } catch { /* ignora */ }
    }
  }
  st.errors = (st.errors || 0) + 1;
  if (st.errors <= 3) note("§cfalha num bloco: " + errText(lastErr));
  return false;
}

async function pace(profile, tileTicks) {
  const pause = profile.duty >= 1
    ? profile.minPause
    : clamp(Math.round(tileTicks * (1 - profile.duty) / profile.duty), profile.minPause, profile.maxPause);
  await sleep(pause);
  if (profile.guard) {                       // espera o servidor se recuperar de lag (ate 30 s)
    let w = 0;
    while (avgMs > 1250 && w < 600 && !stopRequested) { await sleep(20); w += 20; }
  }
}

async function run(player, st) {
  running = true; stopRequested = false;
  try {
    const dim = world.getDimension("overworld");
    const mgr = world.tickingAreaManager;
    const profile = PROFILES[st.profile] || PROFILES.normal;
    const tiles = buildTiles(st);
    const total = tiles.length;
    log(`START radius=${st.radius} base=${st.base} center=${st.cx},${st.cz} profile=${st.profile} tiles=${total} side=${st.side} lod=${st.lod}`);
    say(`gerando raio ${st.radius} chunks (${total} blocos de ${st.side}x${st.side}, perfil ${st.profile}).` + (player ? " Comece parado!" : ""));
    let streak = 0, lastLog = system.currentTick - 1000;

    for (let i = st.idx; i < total; i++) {
      if (stopRequested) break;
      const t0 = system.currentTick;
      const ok = await processTile(dim, mgr, tiles[i], st, profile, player);
      if (stopRequested && !ok) break;     // bloco interrompido pelo stop: tenta de novo ao retomar
      if (ok) streak = 0;
      else {
        streak++;
        if (st.failed.length < 500) st.failed.push(i); else st.fails++;
      }
      st.idx = i + 1; saveState(st);
      if (streak >= CONFIG.abortAfterFails) {
        log(`ABORT ${streak} falhas seguidas (progresso ${st.idx}/${total}). O progresso foi salvo.`);
        say("§cinterrompido: muitas falhas seguidas. Use /scriptevent pregen:start para tentar de novo.");
        return;
      }
      if (system.currentTick - lastLog >= 200 || st.idx >= total) {
        lastLog = system.currentTick;
        log(`PROGRESS ${st.idx}/${total} (${Math.round(st.idx * 100 / Math.max(1, total))}%)`);
      }
      showProgress(player, st, total);
      await pace(profile, system.currentTick - t0);
    }

    // passada final: blocos que falharam na ida ganham mais uma chance
    if (!stopRequested && st.idx >= total && st.failed.length) {
      log(`RETRY ${st.failed.length} blocos com falha`);
      const pending = st.failed.slice(); st.failed = [];
      for (const i of pending) {
        if (stopRequested) { st.failed.push(i); continue; }
        const ok = await processTile(dim, mgr, tiles[i], st, profile, player);
        if (!ok) { if (stopRequested) st.failed.push(i); else st.fails++; }
        await pace(profile, 0);
      }
      saveState(st);
    }

    if (!stopRequested && st.idx >= total && st.failed.length === 0) {
      st.done = true; saveState(st);
      log(`DONE tiles=${total} sampled=${st.sampled || 0} unsampled=${st.unsampled || 0} lost=${st.fails}`);
      say(`§aconcluido!§r ${total} blocos; LOD: ${st.sampled || 0} chunks lidos, ${st.unsampled || 0} sem dados` + (st.fails ? `, ${st.fails} blocos perdidos.` : "."));
      if (player) { try { player.playSound("random.levelup"); } catch { /* ignora */ } }
    } else if (stopRequested) {
      saveState(st);
      log(`STOPPED ${st.idx}/${total}`);
      say("pausado. Use /scriptevent pregen:start para continuar.");
    }
  } catch (e) {
    log("ABORT erro inesperado: " + errText(e));
    say("§cerro inesperado: " + errText(e));
  } finally {
    try { const mgr = world.tickingAreaManager; if (mgr.hasTickingArea(AREA_ID)) mgr.removeTickingArea(AREA_ID); } catch { /* ignora */ }
    running = false;
  }
}

function pickPlayer(ev) {
  const e = ev && ev.sourceEntity;
  if (e && e.typeId === "minecraft:player") return e;
  return world.getAllPlayers()[0];     // undefined no servidor sem jogadores: tudo bem, o modo sem jogador cobre isso
}

// Remove ticking area temporaria que ficou salva se o jogo/servidor parou no meio de um bloco.
function boot() {
  if (booted) return; booted = true;
  try {
    const mgr = world.tickingAreaManager;
    if (mgr.hasTickingArea(AREA_ID)) { mgr.removeTickingArea(AREA_ID); log("ticking area temporaria antiga removida"); }
  } catch { /* API indisponivel neste momento */ }
}

// ---------- comandos pregen:* ----------
function parseArgs(msg) {
  const out = { nums: [], profile: null, lod: null };
  for (const t of String(msg || "").trim().split(/\s+/)) {
    if (!t) continue;
    const low = t.toLowerCase();
    if (/^-?\d+$/.test(t)) out.nums.push(parseInt(t, 10));
    else if (hasProfile(low)) out.profile = low;
    else if (low === "nolod") out.lod = false;
    else if (low === "lod") out.lod = true;
  }
  return out;
}

function handleStart(cmd, ev, player) {
  if (running) { note("ja esta rodando. Use /scriptevent pregen:stop primeiro."); return; }
  if (isLodOn()) { note("§eLodForge esta ligado. Use /lodforge:stop antes de pre-gerar."); return; }
  const a = parseArgs(ev.message);
  const prev = loadState();
  let st;

  if (cmd === "grow") {
    if (!prev) { note("nada para ampliar. Use /scriptevent pregen:start primeiro."); return; }
    if (!prev.done) { st = prev; if (a.profile) st.profile = a.profile; }
    else {
      const extra = a.nums.length ? Math.max(1, a.nums[0]) : 10;
      const lod = a.lod !== null ? a.lod : prev.lod !== false;
      st = newState(prev.cx, prev.cz, prev.radius + extra, a.profile || "gentle", lod, prev);
      if (st.radius <= prev.radius) { note(`ja esta no raio maximo (${CONFIG.maxRadius}).`); return; }
    }
  } else {
    const hasR = a.nums.length >= 1;
    const wantR = hasR ? a.nums[0] : CONFIG.autoRadius;
    if (wantR > CONFIG.maxRadius) note(`raio limitado a ${CONFIG.maxRadius} chunks.`);
    const r = clamp(wantR, 1, CONFIG.maxRadius);
    let c;
    if (a.nums.length >= 3) c = { cx: Math.floor(a.nums[1] / 16), cz: Math.floor(a.nums[2] / 16) };
    else if (prev && !prev.done) c = { cx: prev.cx, cz: prev.cz };
    else if (player) c = { cx: Math.floor(player.location.x / 16), cz: Math.floor(player.location.z / 16) };
    else c = { cx: 0, cz: 0 };
    const same = !!prev && prev.cx === c.cx && prev.cz === c.cz;

    if (same && !prev.done && (!hasR || r === prev.radius)) {
      st = prev; if (a.profile) st.profile = a.profile;               // retoma
    } else if (same && prev.done && r <= prev.radius) {
      log(`DONE ja gerado ate o raio ${prev.radius}`);
      say(`ja gerado ate o raio ${prev.radius}. Use /scriptevent pregen:reset para refazer ou um raio maior.`);
      return;
    } else {
      const lod = a.lod !== null ? a.lod : CONFIG.lod;
      st = newState(c.cx, c.cz, r, a.profile || (player ? CONFIG.autoProfile : "fast"), lod, prev);
    }
  }
  saveState(st);
  run(player, st);
}

system.afterEvents.scriptEventReceive.subscribe((ev) => {
  if (!ev.id.startsWith("pregen:")) return;
  boot();
  const cmd = ev.id.slice(7), player = pickPlayer(ev);
  if (cmd === "start" || cmd === "grow") handleStart(cmd, ev, player);
  else if (cmd === "stop") {
    if (running) stopRequested = true; else note("nada em execucao.");
  } else if (cmd === "reset") {
    if (running) { note("pare antes (pregen:stop)."); return; }
    try { world.setDynamicProperty(PROP, undefined); } catch { /* ignora */ }
    if (/\blod\b/i.test(ev.message || "")) {
      try {
        for (const id of world.getDynamicPropertyIds()) if (id.startsWith("lod_")) world.setDynamicProperty(id, undefined);
      } catch { /* ignora */ }
      regions.clear(); palette = null; palDirty = false;
      note("progresso e mapa de LOD apagados.");
    } else note("progresso apagado.");
  } else if (cmd === "status") {
    const st = loadState();
    note(!st ? "nada iniciado."
      : `${st.done ? "concluido" : running ? "gerando" : "pausado"}: bloco ${st.idx}, raio ${st.radius}` +
        `${st.base ? " (miolo " + st.base + " ja pronto)" : ""}, perfil ${st.profile}, falhas ${st.fails + st.failed.length}, LOD ${st.sampled || 0} lidos / ${st.unsampled || 0} sem dados.`);
  }
});

// Retoma sozinho quando um jogador entra e a geracao ficou incompleta (ou inicia, se autoStart).
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  boot();
  system.runTimeout(() => {
    if (running) return;
    if (isLodOn()) return;                          // LodForge ligado: nao compete
    const st = loadState();
    if (st && st.done) return;                      // ja gerado
    if (st) { saveState(st); run(ev.player, st); return; }          // retoma de onde parou
    if (CONFIG.autoStart) {
      const p = ev.player;
      const n = newState(Math.floor(p.location.x / 16), Math.floor(p.location.z / 16), CONFIG.autoRadius, CONFIG.autoProfile, CONFIG.lod, undefined);
      saveState(n); run(p, n);
    }
  }, 60);
});

try { world.afterEvents.worldLoad.subscribe(() => boot()); } catch { /* sem worldLoad: boot roda no primeiro evento */ }

// ---------- /lodforge:start | stop | status ----------
function lodforgeStart() {
  if (running) return [false, "pre-geracao em andamento. Espere terminar (ou /scriptevent pregen:stop)."];
  const st = loadState();
  if (!st || !st.done) return [false, "faca a pre-geracao antes: /scriptevent pregen:start"];
  world.setDynamicProperty(ON_PROP, "1");
  writePos();
  return [true, `LodForge ativado (${st.sampled || 0} chunks de LOD neste mundo).`];
}
function lodforgeStop() { world.setDynamicProperty(ON_PROP, "0"); return [true, "LodForge desativado."]; }
function lodforgeStatus() {
  const st = loadState();
  return [true, `LodForge ${isLodOn() ? "LIGADO" : "desligado"}; pre-geracao: ${!st ? "nao feita" : st.done ? "concluida" : running ? "rodando" : "pausada"}; LOD: ${st && st.sampled || 0} chunks.`];
}
const LF = { start: lodforgeStart, stop: lodforgeStop, status: lodforgeStatus };

system.afterEvents.scriptEventReceive.subscribe((ev) => {      // alternativa: /scriptevent lodforge:start
  if (!ev.id.startsWith("lodforge:")) return;
  const fn = LF[ev.id.slice(9)]; if (!fn) return;
  const [, msg] = fn(); say(msg);
});

try {
  system.beforeEvents.startup.subscribe((init) => {
    const reg = init.customCommandRegistry;
    const level = mc.CommandPermissionLevel ? mc.CommandPermissionLevel.Any : 0;
    const status = (okk) => (mc.CustomCommandStatus ? (okk ? mc.CustomCommandStatus.Success : mc.CustomCommandStatus.Failure) : (okk ? 0 : 1));
    for (const [name, desc] of [["start", "Liga o LOD distante"], ["stop", "Desliga o LOD distante"], ["status", "Mostra o estado do LodForge"]]) {
      try {
        reg.registerCommand({ name: "lodforge:" + name, description: desc, permissionLevel: level, cheatsRequired: false },
          () => {
            let r; try { r = LF[name](); } catch (e) { r = [true, "(aplicando...)"]; system.run(() => { try { LF[name](); } catch { /* ignora */ } }); }
            return { status: status(r[0]), message: r[1] };
          });
      } catch { /* comando ja registrado ou API diferente */ }
    }
  });
} catch { /* comandos personalizados indisponiveis: use /scriptevent lodforge:... */ }

// 1x por segundo: mede a saude do servidor e, com o LodForge ligado, atualiza a posicao do jogador.
system.runInterval(() => {
  const now = Date.now(); avgMs = avgMs * 0.7 + (now - wallLast) * 0.3; wallLast = now;
  if (isLodOn()) writePos();
}, 20);
