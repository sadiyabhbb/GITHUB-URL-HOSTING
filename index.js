// index.js — HEADSHOT PANEL v3.6 (Pro Edition)
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

const APPS_DIR = path.join(__dirname, "apps");
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR);

const bots = new Map(); // id -> { id, name, dir, proc, logs, status, startTime, entry }

// === Utility ===
function appendLog(id, chunk) {
  const bot = bots.get(id);
  if (!bot) return;
  const txt = String(chunk).replace(/\x1b\[[0-9;]*m/g, ""); // remove ANSI colors
  bot.logs.push(txt);
  if (bot.logs.length > 5000) bot.logs.splice(0, bot.logs.length - 5000);
  io.to(id).emit("log", txt);
}

function spawnProcess(id, cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { ...opts, shell: true });
  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));
  proc.on("close", (code, signal) => {
    appendLog(id, `\n⚠️ Bot exited (code=${code}, signal=${signal})\n`);
    const bot = bots.get(id);
    if (bot) {
      bot.proc = null;
      bot.status = "stopped";
      delete bot.startTime;
      io.emit("bots", Array.from(bots.values()));

      // Auto restart if crashed
      if (code !== 0) {
        appendLog(id, "♻️ Restarting in 5s...\n");
        setTimeout(() => startBot(id), 5000);
      }
    }
  });
  return proc;
}

// === DEPLOY / UPDATE ===
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry = "index.js" } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

    const id = uuidv4();
    const repoName = name ? name.replace(/\s+/g, "-") : `bot-${id.slice(0, 6)}`;
    const appDir = path.join(APPS_DIR, repoName);
    const git = simpleGit();

    let isUpdate = false;
    if (fs.existsSync(appDir)) {
      bots.set(id, { id, name: repoName, dir: appDir, logs: [], status: "updating", entry });
      appendLog(id, `🔄 Updating existing repo...\n`);
      await git.cwd(appDir);
      await git.pull();
      isUpdate = true;
    } else {
      bots.set(id, { id, name: repoName, dir: appDir, logs: [], status: "cloning", entry });
      appendLog(id, `🌀 Cloning ${repoUrl}\n`);
      await git.clone(repoUrl, appDir);
    }

    io.emit("bots", Array.from(bots.values()));
    appendLog(id, `📦 Installing dependencies...\n`);

    await new Promise((resolve) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, shell: true });
      npm.stdout.on("data", (d) => appendLog(id, d));
      npm.stderr.on("data", (d) => appendLog(id, d));
      npm.on("close", resolve);
    });

    bots.get(id).status = "stopped";
    appendLog(id, `✅ ${isUpdate ? "Update" : "Install"} complete! Restarting in 3s...\n`);
    io.emit("bots", Array.from(bots.values()));

    setTimeout(() => startBot(id), 3000);
    res.json({ id, name: repoName });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// === START ===
function startBot(id) {
  const bot = bots.get(id);
  if (!bot) return;

  const entryPath = path.join(bot.dir, bot.entry);
  if (!fs.existsSync(entryPath)) {
    appendLog(id, `❌ Entry file not found: ${bot.entry}\n`);
    bot.status = "error";
    io.emit("bots", Array.from(bots.values()));
    return;
  }

  appendLog(id, `🚀 Starting bot: node ${bot.entry}\n`);
  bot.startTime = Date.now();
  const proc = spawn("node", [bot.entry], { cwd: bot.dir, shell: true, env: { ...process.env } });
  bot.proc = proc;
  bot.status = "running";
  io.emit("bots", Array.from(bots.values()));

  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));

  proc.on("close", (code) => {
    appendLog(id, `⚠️ Bot stopped (code=${code})\n`);
    bot.proc = null;
    bot.status = "stopped";
    delete bot.startTime;
    io.emit("bots", Array.from(bots.values()));

    if (code !== 0) {
      appendLog(id, "♻️ Auto restart in 5s...\n");
      setTimeout(() => startBot(id), 5000);
    }
  });
}

// === MANUAL CONTROLS ===
app.post("/api/:id/start", (req, res) => {
  startBot(req.params.id);
  res.json({ ok: true });
});

app.post("/api/:id/stop", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot || !bot.proc) return res.json({ message: "not running" });
  bot.proc.kill();
  bot.proc = null;
  bot.status = "stopped";
  delete bot.startTime;
  appendLog(bot.id, "🛑 Bot stopped manually\n");
  io.emit("bots", Array.from(bots.values()));
  res.json({ message: "stopped" });
});

app.post("/api/:id/restart", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) bot.proc.kill();
  appendLog(id, "🔁 Restarting bot...\n");
  setTimeout(() => startBot(id), 2000);
  res.json({ message: "restarting" });
});

// === DATA ===
app.get("/api/bots", (req, res) => {
  const list = Array.from(bots.values()).map((b) => ({
    id: b.id,
    name: b.name,
    status: b.status,
    uptime: b.startTime ? Date.now() - b.startTime : 0,
  }));
  res.json(list);
});

app.get("/api/:id/logs", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  res.json({ logs: bot.logs.slice(-1000) });
});

// === SOCKETS ===
io.on("connection", (socket) => {
  socket.on("subscribe", (id) => {
    const bot = bots.get(id);
    if (!bot) return socket.emit("error", "bot not found");
    socket.join(id);
    socket.emit("init", bot.logs.join(""));
  });
});

// === ROOT ===
app.get("/", (_, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ HEADSHOT PANEL v3.6 running on port ${PORT}`));
