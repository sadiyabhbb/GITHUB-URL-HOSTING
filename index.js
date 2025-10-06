// index.js — Bot Hosting Panel (v2.1)
// ✅ Auto create folder
// ✅ Works on Render, Replit, Termux, Local
// ✅ Auto restart + missing module install

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

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

// ====== FOLDER SETUP ======
const APPS_DIR = path.join(__dirname, "apps");
if (!fs.existsSync(APPS_DIR)) {
  fs.mkdirSync(APPS_DIR, { recursive: true });
  console.log("📁 Created apps directory:", APPS_DIR);
}

// ====== BOT STORAGE ======
const bots = new Map(); // id -> { id, name, dir, proc, logs, status, entry }

function appendLog(id, chunk) {
  const bot = bots.get(id);
  if (!bot) return;
  const txt = String(chunk);
  bot.logs.push(txt);
  if (bot.logs.length > 5000) bot.logs.splice(0, bot.logs.length - 5000);
  io.to(id).emit("log", txt);
  console.log(`[${bot.name}] ${txt.trim()}`);
}

function spawnProcess(id, cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { ...opts, shell: true });
  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));
  proc.on("close", (code) => {
    appendLog(id, `\n=== process exited (code ${code}) ===\n`);
  });
  return proc;
}

// ====== DEPLOY ======
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry = "index.js" } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

    const id = uuidv4();
    const repoName = name ? name.replace(/\s+/g, "-") : `bot-${id.substring(0, 6)}`;
    const appDir = path.join(APPS_DIR, repoName);
    const git = simpleGit();

    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    fs.mkdirSync(appDir, { recursive: true });

    bots.set(id, { id, name: repoName, dir: appDir, proc: null, logs: [], status: "cloning", entry });
    io.emit("bots", Array.from(bots.values()));

    appendLog(id, `🌀 Cloning ${repoUrl}...\n`);
    await git.clone(repoUrl, appDir);
    appendLog(id, "✅ Clone complete.\n");

    bots.get(id).status = "installing";
    io.emit("bots", Array.from(bots.values()));

    appendLog(id, "📦 Installing dependencies...\n");
    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, shell: true });
      npm.stdout.on("data", (d) => appendLog(id, d));
      npm.stderr.on("data", (d) => appendLog(id, d));
      npm.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error("npm install failed"));
      });
    });

    bots.get(id).status = "stopped";
    appendLog(id, "✅ Bot ready to start!\n");
    io.emit("bots", Array.from(bots.values()));
    res.json({ id, name: repoName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: e.message });
  }
});

// ====== START BOT ======
app.post("/api/:id/start", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  if (bot.proc) return res.json({ message: "Already running" });

  const entryPath = path.join(bot.dir, bot.entry);
  if (!fs.existsSync(entryPath))
    return res.status(400).json({ error: `Entry file ${bot.entry} not found` });

  appendLog(id, `🚀 Starting bot: node ${bot.entry}\n`);
  const proc = spawn("node", [bot.entry], { cwd: bot.dir, shell: true, env: { ...process.env } });

  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => {
    appendLog(id, d);
    const match = d.toString().match(/Cannot find module '(.+?)'/);
    if (match) {
      const missing = match[1];
      appendLog(id, `\n[Auto-Fix] Installing missing module: ${missing}\n`);
      spawnProcess(id, "npm", ["install", missing, "--save"], { cwd: bot.dir });
    }
  });

  proc.on("close", (code) => {
    appendLog(id, `\n=== Bot exited (code ${code}) ===\n`);
    bot.proc = null;
    bot.status = "stopped";
    io.emit("bots", Array.from(bots.values()));

    // Auto-restart if crash
    if (code !== 0) {
      appendLog(id, "⚠️ Bot crashed — restarting in 5s...\n");
      setTimeout(() => startBot(id), 5000);
    }
  });

  bot.proc = proc;
  bot.status = "running";
  io.emit("bots", Array.from(bots.values()));
  res.json({ message: "Bot started" });
});

function startBot(id) {
  const bot = bots.get(id);
  if (!bot || bot.proc) return;
  appendLog(id, "♻️ Auto restarting bot...\n");
  const proc = spawn("node", [bot.entry], { cwd: bot.dir, shell: true });
  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));
  proc.on("close", () => {
    appendLog(id, "\n=== Bot exited again ===\n");
    bot.proc = null;
    bot.status = "stopped";
    io.emit("bots", Array.from(bots.values()));
  });
  bot.proc = proc;
  bot.status = "running";
  io.emit("bots", Array.from(bots.values()));
}

// ====== STOP BOT ======
app.post("/api/:id/stop", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  if (!bot.proc) return res.json({ message: "Not running" });

  bot.proc.kill();
  bot.proc = null;
  bot.status = "stopped";
  io.emit("bots", Array.from(bots.values()));
  appendLog(id, "🛑 Bot stopped.\n");
  res.json({ message: "Stopped" });
});

// ====== LOGS ======
app.get("/api/bots", (req, res) => {
  res.json(Array.from(bots.values()));
});
app.get("/api/:id/logs", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "Bot not found" });
  res.json({ logs: bot.logs.slice(-1000) });
});

// ====== SOCKET ======
io.on("connection", (socket) => {
  socket.on("subscribe", (id) => {
    const bot = bots.get(id);
    if (!bot) return socket.emit("error", "Bot not found");
    socket.join(id);
    socket.emit("init", bot.logs.join(""));
  });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Bot Panel running on port ${PORT}`));
