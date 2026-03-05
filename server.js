const path = require("path");
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

function clampText(s, maxLen = 80) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

// Bubble radius baseline (2x)
function computeRadius(text) {
  const len = [...String(text)].length;
  const baseR = 68;
  const extra = Math.min(120, Math.floor(len * 2.3));
  return Math.max(68, Math.min(220, baseR + extra));
}

const MAX_BALLS = 20;

// Active bubbles list (also used to seed late joiners)
const recent = [];
const RECENT_MAX = 120;

let hostSocketId = null;

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
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

io.on("connection", (socket) => {
  if (!hostSocketId) hostSocketId = socket.id;

  socket.emit("host", { isHost: socket.id === hostSocketId, hostSocketId });
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
  });

  // Like: any user can like
  socket.on("like", (payload) => {
    const id = String(payload?.id || "");
    if (!id) return;
    const idx = recent.findIndex((x) => x.id === id);
    if (idx < 0) return;

    const nextLikes = (recent[idx].likes ?? 0) + 1;
    recent[idx].likes = nextLikes;

    io.emit("likeUpdate", { id, likes: nextLikes });
  });

  // Host-only controls
  socket.on("hostClearLog", () => {
    if (socket.id !== hostSocketId) return;
    const ids = recent.map(x => x.id);
    recent.length = 0;
    io.emit("logCleared", { ids });
  });

  socket.on("hostDeleteItem", (payload) => {
    if (socket.id !== hostSocketId) return;
    const id = String(payload?.id || "");
    if (!id) return;
    removeById(id);
    io.emit("delete", { id });
  });

  socket.on("hostEditItem", (payload) => {
    if (socket.id !== hostSocketId) return;

    const id = String(payload?.id || "");
    const text = clampText(payload?.text);
    if (!id || !text) return;

    const radius = computeRadius(text);

    const idx = recent.findIndex((x) => x.id === id);
    if (idx >= 0) {
      recent[idx] = { ...recent[idx], text, radius, ts: Date.now() };
    }

    io.emit("edit", { id, text, radius, ts: Date.now() });
  });

  socket.on("disconnect", () => {
    if (socket.id === hostSocketId) {
      const ids = Array.from(io.sockets.sockets.keys());
      hostSocketId = ids.length ? ids[0] : null;
      io.emit("hostReassigned", { hostSocketId });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Listening on ${PORT}`));
