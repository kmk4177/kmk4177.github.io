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

// 영구 HOST 기준: 최초 접속한 IP
let hostIp = null;

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
        await safeWriteJson(STATE_FILE, { version: 1, savedAt: Date.now(), hostIp, recent });
      })
      .catch(() => {});
  }, 250);
}

function getClientIp(socket) {
  const xff = socket.handshake.headers["x-forwarded-for"];
  if (typeof xff === "string" && xff.trim()) {
    return xff.split(",")[0].trim();
  }
  const addr = socket.handshake.address;
  return typeof addr === "string" ? addr : "unknown";
}

async function loadStateFromDisk() {
  try {
    await ensureDataDir();
    const raw = await fsp.readFile(STATE_FILE, "utf-8");
    const parsed = JSON.parse(raw);

    if (typeof parsed.hostIp === "string" && parsed.hostIp.trim()) {
      hostIp = parsed.hostIp.trim();
    }

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
let hostSocketId = null;

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
  const ip = getClientIp(socket);

  // 최초 접속 IP를 영구 HOST로 저장
  if (!hostIp) {
    hostIp = ip;
    scheduleSaveState();
  }

  const isHost = hostIp === ip;
  if (isHost) hostSocketId = socket.id;

  socket.emit("host", { isHost, hostSocketId, hostIp });
  socket.emit("recent", recent);

  socket.on("submitText", (payload) => {
    const text = clampText(payload?.text);
    if (!text) return;

    // Capacity control: evict lowest-like bubble first
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
    if (getClientIp(socket) !== hostIp) return;
    const id = String(payload?.id || "");
    if (!id) return;

    removeById(id);
    io.emit("delete", { id });
    scheduleSaveState();
  });

  socket.on("hostEditItem", (payload) => {
    if (getClientIp(socket) !== hostIp) return;

    const id = String(payload?.id || "");
    const text = clampText(payload?.text);
    if (!id || !text) return;

    const radius = computeRadius(text);

    const idx = recent.findIndex((x) => x.id === id);
    if (idx >= 0) {
      recent[idx] = { ...recent[idx], text, radius, ts: Date.now() };
    }

    io.emit("edit", { id, text, radius, ts: Date.now() });
    scheduleSaveState();
  });

  socket.on("disconnect", () => {
    if (socket.id === hostSocketId) {
      hostSocketId = null; // hostIp는 유지
      io.emit("hostReassigned", { hostSocketId, hostIp });
    }
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
