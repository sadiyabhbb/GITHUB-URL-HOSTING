// index.js - Bot Hosting Panel v2 (Render ready)

import express from "express";
import http from "http";
import { Server } from "socket.io";
import bodyParser from "body-parser";
import path from "path";
import fs from "fs";
import { spawn } from "child_process";
import simpleGit from "simple-git";
import { fileURLToPath } from "url";
import { v4 as uuidv4 } from "uuid";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const APPS_DIR = path.join(__dirname, "apps");
const STATE_FILE = path.join(__dirname, "bots.json");

if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR);

// store all bots runtime
const bots = new Map();

// ===== Helper Functions =====

function saveState() {
  const data = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    dir: b.dir,
    entry: b.entry,
    status: b.status
  }));
  fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2));
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const data = JSON.parse(fs.readFileSync(STATE_FILE));
    for (const b of data) {
      bots.set(b.id, { ...b, proc: null, logs: [], startTime: null });
    }
    console.log(`♻️ Restored ${bots.size} bots from state`);
  } catch (err) {
    console.error("State load error:", err);
  }
}

function appendLog(id, chunk) {
  const bot = bots.get(id);
  if (!bot) return;
  const text = String(chunk);
  const logFile = path.join(bot.dir, "bot.log");
  fs.appendFileSync(logFile, text);
  bot.logs.push(text);
  if (bot.logs.length > 2000) bot.logs.splice(0, bot.logs.length - 2000);
  io.to(id).emit("log", text);
}

function spawnProcess(id, cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { ...opts, shell: true });
  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));
  proc.on("close", (code, signal) => {
    appendLog(id, `\n=== Process exited (code=${code}, signal=${signal}) ===\n`);
  });
  return proc;
}

// ===== Deploy a new bot =====
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry = "index.js" } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

    const id = uuidv4();
    const botName = name ? name.replace(/\s+/g, "-") : `bot-${id.slice(0, 6)}`;
    const appDir = path.join(APPS_DIR, botName);
    const git = simpleGit();

    // remove old dir if exists
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });

    bots.set(id, { id, name: botName, dir: appDir, entry, proc: null, logs: [], status: "cloning" });
    io.emit("bots", Array.from(bots.values()));
    appendLog(id, `🌀 Cloning ${repoUrl}...\n`);

    await git.clone(repoUrl, appDir);
    appendLog(id, `✅ Clone complete.\n`);

    bots.get(id).status = "installing";
    io.emit("bots", Array.from(bots.values()));
    appendLog(id, `📦 Installing dependencies...\n`);

    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, shell: true });
      npm.stdout.on("data", d => appendLog(id, d));
      npm.stderr.on("data", d => appendLog(id, d));
      npm.on("close", code => (code === 0 ? resolve() : reject(new Error(`npm install failed ${code}`))));
    });

    bots.get(id).status = "stopped";
    appendLog(id, `✅ Ready to start bot.\n`);
    saveState();
    io.emit("bots", Array.from(bots.values()));

    res.json({ id, name: botName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// ===== Start Bot =====
app.post("/api/:id/start", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  if (bot.proc) return res.json({ message: "Already running" });

  const entryPath = path.join(bot.dir, bot.entry || "index.js");
  if (!fs.existsSync(entryPath))
    return res.status(400).json({ error: `Entry file ${bot.entry} not found` });

  appendLog(id, `🚀 Starting bot...\n`);
  const proc = spawn("node", [bot.entry], { cwd: bot.dir, shell: true, env: { ...process.env } });
  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  io.emit("bots", Array.from(bots.values()));
  saveState();

  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));
  proc.on("close", code => {
    appendLog(id, `\n💀 Bot exited (code=${code})\n`);
    bot.proc = null;
    bot.status = "stopped";
    io.emit("bots", Array.from(bots.values()));
    saveState();
    // Auto restart
    if (code !== 0) {
      appendLog(id, "⚠️ Crash detected, restarting in 5s...\n");
      setTimeout(() => startBot(id), 5000);
    }
  });

  res.json({ message: "Started" });
});

// ===== Helper for auto restart =====
function startBot(id) {
  const bot = bots.get(id);
  if (!bot || bot.proc) return;
  const entry = bot.entry || "index.js";
  appendLog(id, "♻️ Auto restarting bot...\n");
  const proc = spawn("node", [entry], { cwd: bot.dir, shell: true, env: { ...process.env } });
  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));
  proc.on("close", code => {
    appendLog(id, `\n=== Bot exited again (code=${code}) ===\n`);
    bot.proc = null;
    bot.status = "stopped";
    io.emit("bots", Array.from(bots.values()));
    saveState();
  });
  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  io.emit("bots", Array.from(bots.values()));
  saveState();
}

// ===== Stop Bot =====
app.post("/api/:id/stop", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  if (!bot.proc) return res.json({ message: "Not running" });

  bot.proc.kill();
  bot.proc = null;
  bot.status = "stopped";
  appendLog(id, "🛑 Stopped by user.\n");
  io.emit("bots", Array.from(bots.values()));
  saveState();
  res.json({ message: "Stopped" });
});

// ===== Restart Bot =====
app.post("/api/:id/restart", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  if (bot.proc) bot.proc.kill();
  appendLog(id, "🔁 Restarting bot...\n");
  setTimeout(() => startBot(id), 2000);
  res.json({ message: "Restarting" });
});

// ===== Get Bots =====
app.get("/api/bots", (req, res) => {
  res.json(Array.from(bots.values()).map(b => ({ ...b, logs: undefined, proc: undefined })));
});

// ===== Get Logs =====
app.get("/api/:id/logs", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  const logFile = path.join(bot.dir, "bot.log");
  let logs = bot.logs;
  if (fs.existsSync(logFile)) {
    const fileLogs = fs.readFileSync(logFile, "utf8").split("\n").slice(-500);
    logs = fileLogs;
  }
  res.json({ logs });
});

// ===== Socket =====
io.on("connection", socket => {
  socket.on("subscribe", id => {
    const bot = bots.get(id);
    if (!bot) return socket.emit("error", "Bot not found");
    socket.join(id);
    const logFile = path.join(bot.dir, "bot.log");
    let data = "";
    if (fs.existsSync(logFile)) data = fs.readFileSync(logFile, "utf8");
    socket.emit("init", data);
  });
});

// ===== Root route =====
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ===== Server Start =====
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Panel running on port ${PORT}`);
  loadState();
});
