const path = require("path");
const fsp = require("fs/promises");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// Optional: allow separate frontend origins (GitHub Pages, etc.)
// ALLOWED_ORIGINS="https://username.github.io,https://yourdomain.com"
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const io = new Server(server, {
  cors: allowedOrigins.length ? { origin: allowedOrigins } : undefined,
});

app.use(express.static(path.join(__dirname, "public")));

// =========================
// Persistence (log/state)
// =========================
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const STATE_FILE = path.join(DATA_DIR, "state.json");

let writeQueue = Promise.resolve();
let saveTimer = null;

async function ensureDataDir() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
}

async function safeWriteJson(filePath, obj) {
  const tmp = filePath + ".tmp";
  const payload = JSON.stringify(obj, null, 2);
  await fsp.writeFile(tmp, payload, "utf-8");
  await fsp.rename(tmp, filePath);
}

function scheduleSaveState() {
  // debounce so likes don't hammer disk
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeQueue = writeQueue
      .then(async () => {
        await ensureDataDir();
        await safeWriteJson(STATE_FILE, { version: 1, savedAt: Date.now(), recent });
      })
      .catch(() => {});
  }, 250);
}

async function loadStateFromDisk() {
  try {
    await ensureDataDir();
    const raw = await fsp.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed.recent)) return;

    recent.length = 0;
    for (const x of parsed.recent) {
      if (!x || typeof x !== "object") continue;
      if (!x.id || !x.text) continue;

      const text = String(x.text);
      recent.push({
        id: String(x.id),
        text,
        likes: Number.isFinite(x.likes) ? x.likes : 0,
        nx: Number.isFinite(x.nx) ? x.nx : Math.random() * 0.75 + 0.125,
        ny: Number.isFinite(x.ny) ? x.ny : Math.random() * 0.35 + 0.15,
        nvx: Number.isFinite(x.nvx) ? x.nvx : (Math.random() * 2 - 1) * 2.4,
        nvy: Number.isFinite(x.nvy) ? x.nvy : (Math.random() * 2 - 1) * 2.4,
        radius: Number.isFinite(x.radius) ? x.radius : computeRadius(text),
        ts: Number.isFinite(x.ts) ? x.ts : Date.now(),
      });
    }

    enforceMaxBubbles();
  } catch {
    // ok if missing
  }
}

// =========================
// Helpers
// =========================
function clampText(s, maxLen = 80) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

function computeRadius(text) {
  const len = [...String(text)].length;
  const baseR = 68;
  const extra = Math.min(120, Math.floor(len * 2.3));
  return Math.max(68, Math.min(220, baseR + extra));
}

const MAX_BALLS = 50;
const RECENT_MAX = 400;

const recent = [];

// =========================
// Host auth (token-based)
// =========================
// Client holds a stable token in localStorage.
// Host privilege is attached to that token (not socket id / not IP).
const HOST_PHRASE = process.env.HOST_PHRASE || "I'm minkyun kang.";

// In-memory host token store (survives reconnects; resets on server restart)
const hostTokens = new Set();

function isValidToken(t) {
  return typeof t === "string" && t.length >= 8 && t.length <= 128;
}

function isHostToken(t) {
  return hostTokens.has(t);
}

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

function enforceMaxBubbles() {
  if (recent.length <= MAX_BALLS) return [];
  recent.sort((a, b) => {
    const dl = (b.likes ?? 0) - (a.likes ?? 0);
    if (dl !== 0) return dl;
    return (b.ts ?? 0) - (a.ts ?? 0);
  });
  const removed = recent.splice(MAX_BALLS);
  return removed.map((x) => x.id);
}

function pickEvictionCandidate() {
  if (recent.length < MAX_BALLS) return null;
  // Evict lowest likes; tie-breaker: oldest first
  let best = recent[0];
  for (const x of recent) {
    if ((x.likes ?? 0) < (best.likes ?? 0)) best = x;
    else if ((x.likes ?? 0) === (best.likes ?? 0) && (x.ts ?? 0) < (best.ts ?? 0)) best = x;
  }
  return best;
}

function removeById(id) {
  const idx = recent.findIndex((x) => x.id === id);
  if (idx >= 0) recent.splice(idx, 1);
}

// =========================
// Socket
// =========================
io.on("connection", (socket) => {
  // Client asks: am I host?
  socket.on("checkHost", (payload) => {
    const token = String(payload?.token ?? "");
    socket.emit("host", { isHost: isValidToken(token) && isHostToken(token), hostCount: hostTokens.size });
  });

  socket.emit("recent", recent);

  // Claim host by phrase + token (does not create a bubble)
  socket.on("claimHost", (payload) => {
    const phrase = String(payload?.phrase ?? "").trim();
    const token = String(payload?.token ?? "");

    if (phrase !== HOST_PHRASE || !isValidToken(token)) {
      socket.emit("claimHostResult", { ok: false });
      // also refresh host status on failure
      socket.emit("host", { isHost: false, hostCount: hostTokens.size });
      return;
    }

    hostTokens.add(token);
    socket.emit("claimHostResult", { ok: true });
    socket.emit("host", { isHost: true, hostCount: hostTokens.size });
    io.emit("hostReassigned", { hostCount: hostTokens.size });
  });

  socket.on("submitText", (payload) => {
    const text = clampText(payload?.text);
    if (!text) return;

    if (recent.length >= MAX_BALLS) {
      const victim = pickEvictionCandidate();
      if (victim) {
        removeById(victim.id);
        io.emit("evict", { id: victim.id, reason: "capacity" });
      }
    }

    const spawn = {
      id: cryptoRandomId(),
      text,
      likes: 0,
      nx: Math.random() * 0.75 + 0.125,
      ny: Math.random() * 0.35 + 0.15,
      nvx: (Math.random() * 2 - 1) * 2.4,
      nvy: (Math.random() * 2 - 1) * 2.4,
      radius: computeRadius(text),
      ts: Date.now(),
    };

    recent.push(spawn);
    if (recent.length > RECENT_MAX) recent.shift();

    io.emit("spawn", spawn);
    scheduleSaveState();
  });

  socket.on("like", (payload) => {
    const id = String(payload?.id || "");
    if (!id) return;
    const idx = recent.findIndex((x) => x.id === id);
    if (idx < 0) return;

    const nextLikes = (recent[idx].likes ?? 0) + 1;
    recent[idx].likes = nextLikes;

    io.emit("likeUpdate", { id, likes: nextLikes });
    scheduleSaveState();
  });

  socket.on("hostDeleteItem", (payload) => {
    const id = String(payload?.id || "");
    const token = String(payload?.token || "");
    if (!id || !isValidToken(token) || !isHostToken(token)) return;

    removeById(id);
    io.emit("delete", { id });
    scheduleSaveState();
  });

  socket.on("hostEditItem", (payload) => {
    const id = String(payload?.id || "");
    const token = String(payload?.token || "");
    const text = clampText(payload?.text);
    if (!id || !text || !isValidToken(token) || !isHostToken(token)) return;

    const radius = computeRadius(text);

    const idx = recent.findIndex((x) => x.id === id);
    if (idx >= 0) {
      recent[idx] = { ...recent[idx], text, radius, ts: Date.now() };
    }

    io.emit("edit", { id, text, radius, ts: Date.now() });
    scheduleSaveState();
  });
});

// =========================
// Boot
// =========================
(async () => {
  await loadStateFromDisk();

  const PORT = process.env.PORT || 3000;
  server.listen(PORT, () => console.log(`Listening on ${PORT}`));
})();
