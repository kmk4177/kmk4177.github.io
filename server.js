const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
app.get("/healthz", (_, res) => res.status(200).send("ok"));

const server = http.createServer(app);

// If you want to host the frontend separately (e.g., GitHub Pages),
// set ALLOWED_ORIGINS to a comma-separated list of origins.
// Example: ALLOWED_ORIGINS=https://username.github.io,https://mydomain.com
const allowedOrigins = (process.env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);

const io = new Server(server, {
  cors: allowedOrigins.length ? { origin: allowedOrigins } : undefined
});

app.use(express.static(path.join(__dirname, "public")));

function clampText(s, maxLen = 80) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

// 최근 생성된 공을 새로 접속한 사람에게도 보여주기 위한 버퍼
const recent = [];
const RECENT_MAX = 60;

io.on("connection", (socket) => {
  socket.emit("recent", recent);

  socket.on("submitText", (payload) => {
    const text = clampText(payload?.text);
    if (!text) return;

    // 글자가 길수록 공을 키움 (클라에서도 맞춤 렌더링)
    const len = [...text].length; // 유니코드 안전-ish
    const baseR = 34;
    const extra = Math.min(60, Math.floor(len * 1.15)); // 길이에 비례, 상한
    const radius = Math.max(34, Math.min(110, baseR + extra));

    const spawn = {
      id: cryptoRandomId(),
      text,
      nx: Math.random() * 0.75 + 0.125, // 0.125~0.875
      ny: Math.random() * 0.35 + 0.15,  // 0.15~0.50
      nvx: (Math.random() * 2 - 1) * 2.4, // -2.4~2.4 (버블 느낌)
      nvy: (Math.random() * 2 - 1) * 2.4, // -2.4~2.4
      radius,
      ts: Date.now()
    };

    recent.push(spawn);
    if (recent.length > RECENT_MAX) recent.shift();

    io.emit("spawn", spawn);
  });
});

function cryptoRandomId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  return Math.random().toString(16).slice(2) + Date.now().toString(16);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Listening on port ${PORT}`);
});
