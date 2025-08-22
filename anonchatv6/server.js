// AnonChat v6 — FULL classic build
// Features: rooms, replies, edit/delete, pin/unpin, drag-drop uploads, voice note, admin panel, SQLite persistence
// Uses custom Socket.IO client path (/realtime) to avoid ad-blockers that block /socket.io
//
// Install deps (one line):
// npm i express socket.io multer nanoid sanitize-html rate-limiter-flexible leo-profanity useragent geoip-lite better-sqlite3
//
// Start: node server.js

const path = require("path");
const fs = require("fs");
const crypto = require("crypto");
const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const multer = require("multer");
const sanitizeHtml = require("sanitize-html");
const { customAlphabet } = require("nanoid");
const { RateLimiterMemory } = require("rate-limiter-flexible");
const leo = require("leo-profanity");
const useragent = require("useragent");
const geoip = require("geoip-lite");
const Database = require("better-sqlite3");

const PORT = process.env.PORT || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || "letmein";
const FILTER_MODE = process.env.FILTER_MODE || "soft"; // 'soft' cleans, 'block' rejects
const SAVE_RAW_IP = process.env.SAVE_RAW_IP !== "0";   // set to 0 to hash IPs
const IP_SALT = process.env.IP_SALT || "change-me";
const MAX_FILE_MB = Number(process.env.MAX_FILE_MB || 12);

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  path: "/realtime",
  transports: ["websocket","polling"],
  serveClient: true,
  cors: { origin: true }
});

// Helpers
const nanoid = customAlphabet("ABCDEFGHJKLMNPQRSTUVWXYZ23456789", 8);
const uid = customAlphabet("abcdefghijklmnopqrstuvwxyz0123456789", 10);
const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR);
const DB_PATH = path.join(DATA_DIR, "anonchat.db");

// DB init & migrations
const db = new Database(DB_PATH);
db.pragma("journal_mode = wal");
db.exec(`
CREATE TABLE IF NOT EXISTS rooms(
  roomId TEXT PRIMARY KEY,
  topic TEXT DEFAULT '',
  capacity INTEGER DEFAULT 50,
  locked INTEGER DEFAULT 0,
  createdTs INTEGER
);
CREATE TABLE IF NOT EXISTS messages(
  id TEXT PRIMARY KEY,
  roomId TEXT,
  userId TEXT,
  name TEXT,
  text TEXT,
  files TEXT,
  replyTo TEXT,
  ts INTEGER,
  deleted INTEGER DEFAULT 0,
  editedTs INTEGER
);
CREATE INDEX IF NOT EXISTS idx_messages_room_ts ON messages(roomId, ts);
CREATE TABLE IF NOT EXISTS audit(
  ts INTEGER,
  event TEXT,
  roomId TEXT,
  userId TEXT,
  anonName TEXT,
  ip TEXT,
  ua TEXT,
  geo TEXT
);
CREATE TABLE IF NOT EXISTS pins(
  roomId TEXT,
  messageId TEXT PRIMARY KEY,
  pinnedTs INTEGER
);
`);

const insertRoom = db.prepare("INSERT OR IGNORE INTO rooms(roomId, topic, capacity, locked, createdTs) VALUES (?, ?, ?, ?, ?)");
const updateRoom = db.prepare("UPDATE rooms SET topic=?, capacity=?, locked=? WHERE roomId=?");
const selectRoom = db.prepare("SELECT * FROM rooms WHERE roomId=?");
const listRooms = db.prepare("SELECT roomId, topic, capacity, locked FROM rooms ORDER BY createdTs DESC LIMIT 200");

const insertMsg = db.prepare(`INSERT INTO messages(id, roomId, userId, name, text, files, replyTo, ts, deleted, editedTs) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`);
const markDeleted = db.prepare(`UPDATE messages SET deleted=1 WHERE id=?`);
const updateMsgText = db.prepare(`UPDATE messages SET text=?, editedTs=? WHERE id=?`);
const selectRecent = db.prepare(`SELECT * FROM messages WHERE roomId=? AND deleted=0 ORDER BY ts DESC LIMIT ?`);
const getMessage = db.prepare(`SELECT * FROM messages WHERE id=?`);

const insertAudit = db.prepare(`INSERT INTO audit(ts, event, roomId, userId, anonName, ip, ua, geo) VALUES (?,?,?,?,?,?,?,?)`);

const pinAdd = db.prepare(`INSERT OR REPLACE INTO pins(roomId, messageId, pinnedTs) VALUES(?, ?, ?)`);
const pinRemove = db.prepare(`DELETE FROM pins WHERE messageId=?`);
const pinsForRoom = db.prepare(`SELECT messageId FROM pins WHERE roomId=? ORDER BY pinnedTs DESC LIMIT 25`);

// Runtime state
const ROOM_CAP_DEFAULT = 50;
const rooms = new Map(); // roomId -> { members:Set<socketId>, topic, capacity, locked, ownerUserId }
const bans = new Map();  // ip -> { until, reason }
const mutes = new Map(); // key -> { until, reason }

// Profanity
leo.loadDictionary('en');

// Static
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));
app.use("/uploads", express.static(path.join(__dirname, "uploads"), { maxAge: "1d" }));

// Health
app.get("/health", (req,res)=>res.json({ ok:true, uptime: process.uptime() }));

// Uploads
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) fs.mkdirSync(uploadsDir);
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, uploadsDir),
  filename: (_, file, cb) => {
    const safe = (file.originalname || "file").replace(/[^\w.\-\s\(\)]/g, "_");
    const ext = path.extname(safe);
    cb(null, `${uid()}${ext.toLowerCase()}`);
  },
});
const upload = multer({ storage, limits: { fileSize: MAX_FILE_MB * 1024 * 1024 } });
app.post("/api/upload", upload.array("files", 4), (req, res) => {
  const items = (req.files || []).map(f => ({
    url: `/uploads/${f.filename}`,
    originalName: f.originalname,
    size: f.size,
    mimetype: f.mimetype,
  }));
  res.json({ files: items });
});

// Helpers
function hashIP(ip) { return crypto.createHash("sha256").update(ip + (process.env.IP_SALT || "salt")).digest("hex"); }
function now() { return Date.now(); }
function roomRuntime(roomId) {
  let r = rooms.get(roomId);
  if (!r) {
    const row = selectRoom.get(roomId);
    r = { members: new Set(), topic: row?.topic || "", capacity: row?.capacity || ROOM_CAP_DEFAULT, locked: !!row?.locked, ownerUserId: undefined };
    rooms.set(roomId, r);
  }
  return r;
}

// Admin gate
function requireAdmin(req, res, next) {
  if ((req.query.key || req.headers["x-admin-key"]) !== ADMIN_KEY) return res.status(401).json({ ok:false, error:"unauthorized" });
  next();
}

// Admin APIs
app.get("/admin/state", requireAdmin, (req, res) => {
  const dbRooms = listRooms.all();
  const bansArr = Array.from(bans.entries()).map(([ip,b])=>({ip,until:b.until,reason:b.reason}));
  const mutesArr = Array.from(mutes.entries()).map(([k,b])=>({key:k,until:b.until,reason:b.reason}));
  res.json({ ok:true, rooms: dbRooms.map(r => ({...r, members: rooms.get(r.roomId)?.members.size || 0})), bans: bansArr, mutes: mutesArr });
});
app.get("/admin/messages", requireAdmin, (req, res) => {
  const roomId = String(req.query.roomId || "");
  if (!roomId) return res.status(400).json({ ok:false, error:"roomId required" });
  const rows = selectRecent.all(roomId, 200).map(r => ({...r, files: JSON.parse(r.files||"[]"), replyTo: r.replyTo ? JSON.parse(r.replyTo) : null}));
  res.json({ ok:true, items: rows });
});
app.post("/admin/delete", requireAdmin, (req, res) => {
  const { roomId, messageId } = req.body || {};
  if (!roomId || !messageId) return res.status(400).json({ ok:false });
  markDeleted.run(messageId);
  io.to(roomId).emit("deleted", { messageId });
  res.json({ ok:true });
});
app.post("/admin/ban", requireAdmin, (req, res) => {
  const { ip, minutes=60, reason="ban" } = req.body || {};
  if (!ip) return res.status(400).json({ ok:false });
  const until = now() + Math.max(1, Number(minutes))*60*1000;
  bans.set(ip, { until, reason });
  for (const [id, s] of io.sockets.sockets) {
    const sFwd = s.handshake.headers["x-forwarded-for"];
    const sIp = (sFwd ? String(sFwd).split(",")[0].trim() : s.handshake.address) || "unknown";
    if (sIp === ip) s.disconnect(true);
  }
  res.json({ ok:true });
});
app.post("/admin/unban", requireAdmin, (req, res) => { const { ip } = req.body || {}; bans.delete(ip); res.json({ ok:true }); });
app.post("/admin/mute", requireAdmin, (req, res) => {
  const { key, minutes=15, reason="mute" } = req.body || {};
  if (!key) return res.status(400).json({ ok:false });
  const until = now() + Math.max(1, Number(minutes))*60*1000;
  mutes.set(key, { until, reason }); res.json({ ok:true });
});
app.post("/admin/unmute", requireAdmin, (req, res) => { const { key } = req.body || {}; mutes.delete(key); res.json({ ok:true }); });
app.post("/admin/pin", requireAdmin, (req, res) => {
  const { roomId, messageId } = req.body || {};
  if (!roomId || !messageId) return res.status(400).json({ ok:false });
  const row = getMessage.get(messageId); if (!row || row.deleted) return res.status(404).json({ ok:false });
  pinAdd.run(roomId, messageId, now());
  io.to(roomId).emit("pinned", { messageId });
  res.json({ ok:true });
});
app.post("/admin/unpin", requireAdmin, (req, res) => {
  const { roomId, messageId } = req.body || {};
  if (!roomId || !messageId) return res.status(400).json({ ok:false });
  pinRemove.run(messageId);
  io.to(roomId).emit("unpinned", { messageId });
  res.json({ ok:true });
});

// Limits
const ipLimiter = new RateLimiterMemory({ points: 12, duration: 10 });
const userLimiter = new RateLimiterMemory({ points: 10, duration: 10 });

// Socket.io
io.on("connection", (socket) => {
  const forwarded = socket.handshake.headers["x-forwarded-for"];
  const remoteAddr = socket.handshake.address;
  const ip = (forwarded ? String(forwarded).split(",")[0].trim() : remoteAddr) || "unknown";
  const ua = socket.handshake.headers["user-agent"] || "";
  const agent = useragent.parse(ua);
  const uaInfo = { family: agent.family, os: agent.os.toString(), device: agent.device.toString(), raw: ua };
  const geo = geoip.lookup(ip) || null;

  const ban = bans.get(ip);
  if (ban && now() < ban.until) { socket.disconnect(true); return; }
  if (ban && now() >= ban.until) bans.delete(ip);

  // session identity
  const persistedId = socket.handshake.auth?.persistedId;
  const userId = (typeof persistedId === "string" && persistedId.length >= 10) ? String(persistedId).slice(0,32) : uid();
  socket.userId = userId;

  // room join (create if hinted)
  const roomHint = socket.handshake.auth?.roomHint;
  const lock = !!socket.handshake.auth?.roomLock;
  const roomId = roomHint || nanoid();
  insertRoom.run(roomId, "", ROOM_CAP_DEFAULT, lock ? 1 : 0, now());
  const room = roomRuntime(roomId);
  const firstJoin = room.members.size === 0;
  if (firstJoin) room.ownerUserId = userId;
  if (lock) room.locked = true;

  const anonName = "anon-" + userId.slice(0,5);
  socket.join(roomId);
  room.members.add(socket.id);

  // history + pins
  const rows = selectRecent.all(roomId, 120).reverse();
  const pinnedIds = pinsForRoom.all(roomId).map(r => r.messageId);
  socket.emit("hello", { roomId, anonName, userId, topic: room.topic, capacity: room.capacity || ROOM_CAP_DEFAULT, locked: room.locked, owner: room.ownerUserId });
  socket.emit("pins", { ids: pinnedIds });
  socket.emit("history", rows.map(r => ({
    id: r.id, userId: r.userId, name: r.name, roomId: r.roomId, text: r.text, files: JSON.parse(r.files||"[]"),
    replyTo: r.replyTo ? JSON.parse(r.replyTo) : null, ts: r.ts, editedTs: r.editedTs || null
  })));

  insertAudit.run(now(), "join", roomId, userId, anonName, SAVE_RAW_IP ? ip : hashIP(ip), JSON.stringify(uaInfo), JSON.stringify(geo));
  io.to(roomId).emit("presence", { type: "join", count: room.members.size });

  socket.on("setNick", (nick) => {
    const name = String(nick || "").slice(0, 24).trim();
    if (!name) return;
    socket.nick = sanitizeHtml(name, { allowedTags: [], allowedAttributes: {} });
  });

  socket.on("setRoom", ({ topic, capacity, locked }) => {
    if (room.ownerUserId !== userId) return;
    room.topic = String(topic || "").slice(0, 140);
    const cap = Number(capacity || ROOM_CAP_DEFAULT);
    room.capacity = Math.max(2, Math.min(200, isNaN(cap) ? ROOM_CAP_DEFAULT : cap));
    room.locked = !!locked;
    updateRoom.run(room.topic, room.capacity, room.locked ? 1 : 0, roomId);
    io.to(roomId).emit("roomUpdate", { topic: room.topic, capacity: room.capacity, locked: room.locked });
  });

  socket.on("msg", async (payload) => {
    try { await ipLimiter.consume(ip); } catch { socket.emit("errorMsg","Slow down (IP)."); return; }
    try { await userLimiter.consume(userId); } catch { socket.emit("errorMsg","Slow down (user)."); return; }

    let cleanText = payload?.text ? String(payload.text).slice(0, 2000) : "";
    cleanText = sanitizeHtml(cleanText, { allowedTags: [], allowedAttributes: {} });
    if (cleanText) {
      if (FILTER_MODE === "block" && leo.check(cleanText)) { socket.emit("errorMsg","Message blocked."); return; }
      else if (FILTER_MODE === "soft" && leo.check(cleanText)) { cleanText = leo.clean(cleanText); }
    }
    const replyTo = payload?.replyTo || null;
    const files = Array.isArray(payload?.files) ? payload.files.slice(0,4) : [];

    const name = socket.nick || ("anon-" + userId.slice(0,5));
    const msg = { id: uid(), roomId, userId, name, text: cleanText, files, replyTo, ts: now() };
    insertMsg.run(msg.id, roomId, userId, name, msg.text, JSON.stringify(files), replyTo ? JSON.stringify(replyTo) : null, msg.ts);
    io.to(roomId).emit("msg", { ...msg });
  });

  socket.on("edit", ({ messageId, text }) => {
    const row = getMessage.get(messageId); if (!row || row.deleted) return;
    if (row.userId !== userId) return;
    let cleanText = String(text || "").slice(0, 2000);
    cleanText = sanitizeHtml(cleanText, { allowedTags: [], allowedAttributes: {} });
    if (FILTER_MODE === "block" && leo.check(cleanText)) return;
    if (FILTER_MODE === "soft" && leo.check(cleanText)) cleanText = leo.clean(cleanText);
    const t = now();
    updateMsgText.run(cleanText, t, messageId);
    io.to(row.roomId).emit("edited", { messageId, text: cleanText, editedTs: t });
  });

  socket.on("pin", ({ messageId }) => {
    if (room.ownerUserId !== userId) return;
    const row = getMessage.get(messageId); if (!row || row.deleted) return;
    pinAdd.run(row.roomId, messageId, now());
    io.to(row.roomId).emit("pinned", { messageId });
  });
  socket.on("unpin", ({ messageId }) => {
    if (room.ownerUserId !== userId) return;
    pinRemove.run(messageId);
    io.to(roomId).emit("unpinned", { messageId });
  });

  socket.on("typing", () => { socket.to(roomId).emit("typing", { name: socket.nick || ("anon-" + userId.slice(0,5)), userId }); });

  socket.on("delete", ({ messageId }) => {
    const row = getMessage.get(messageId);
    if (!row) return;
    if (row.userId !== userId) return;
    markDeleted.run(messageId);
    io.to(row.roomId).emit("deleted", { messageId });
  });

  socket.on("report", ({ messageId, reason }) => {
    insertAudit.run(now(), "report", roomId, userId, "", SAVE_RAW_IP ? ip : hashIP(ip), JSON.stringify({ reason: String(reason||"").slice(0,500) }), "");
    socket.emit("errorMsg", "Report submitted. Thanks.");
  });

  socket.on("disconnect", () => {
    const r = rooms.get(roomId);
    if (r) { r.members.delete(socket.id); io.to(roomId).emit("presence", { type: "leave", count: r.members.size }); }
    insertAudit.run(now(), "leave", roomId, userId, "", SAVE_RAW_IP ? ip : hashIP(ip), "", "");
  });
});

server.listen(PORT, () => {
  console.log(`AnonChat v6 FULL running on http://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health`);
});
