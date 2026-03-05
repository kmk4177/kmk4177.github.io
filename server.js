
const path = require("path");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, "public")));

function clampText(s, maxLen = 80) {
  const t = String(s ?? "").trim();
  if (!t) return "";
  return t.length > maxLen ? t.slice(0, maxLen - 1) + "…" : t;
}

// Bubble radius doubled
function computeRadius(text) {
  const len = [...String(text)].length;
  const baseR = 68;
  const extra = Math.min(120, Math.floor(len * 2.3));
  return Math.max(68, Math.min(220, baseR + extra));
}

const recent = [];
let hostSocketId = null;

io.on("connection", (socket) => {
  if (!hostSocketId) hostSocketId = socket.id;

  socket.emit("recent", recent);

  socket.on("submitText", (payload) => {
    const text = clampText(payload?.text);
    if (!text) return;

    const spawn = {
      id: Math.random().toString(16).slice(2) + Date.now().toString(16),
      text,
      nx: Math.random() * 0.75 + 0.125,
      ny: Math.random() * 0.35 + 0.15,
      nvx: (Math.random() * 2 - 1) * 2.4,
      nvy: (Math.random() * 2 - 1) * 2.4,
      radius: computeRadius(text),
      ts: Date.now(),
    };

    recent.push(spawn);
    if (recent.length > 60) recent.shift();

    io.emit("spawn", spawn);
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log("Server running"));
