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
import os from "os";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(bodyParser.json());
app.use(express.static(path.join(__dirname, "public")));

const APPS_DIR = path.join(__dirname, "apps");
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

const bots = new Map();

function cleanAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

function appendLog(id, chunk) {
  const bot = bots.get(id);
  if (!bot) return;
  const txt = cleanAnsi(String(chunk));
  bot.logs.push(txt);
  if (bot.logs.length > 3000) bot.logs.splice(0, bot.logs.length - 3000);
  io.to(id).emit("log", { id, text: txt });
}

function emitBots() {
  const list = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    repoUrl: b.repoUrl,
    entry: b.entry,
    status: b.status,
    startTime: b.startTime || null,
    dir: b.dir
  }));
  io.emit("bots", list);
}

// ✅ crash-safe start function
function startBot(id, restartCount = 0) {
  const bot = bots.get(id);
  if (!bot || bot.proc) return;

  const entryPath = path.join(bot.dir, bot.entry || "index.js");
  if (!fs.existsSync(entryPath)) {
    appendLog(id, `❌ Entry not found: ${bot.entry}\n`);
    bot.status = "error";
    emitBots();
    return;
  }

  appendLog(id, `🚀 Starting bot: node ${bot.entry}\n`);
  const proc = spawn("node", [bot.entry], {
    cwd: bot.dir,
    shell: true,
    env: { ...process.env, NODE_ENV: "production" },
  });

  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  emitBots();

  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));

  proc.on("error", err => {
    appendLog(id, `⚠️ Process error: ${err.message}\n`);
  });

  proc.on("close", (code) => {
    appendLog(id, `🛑 Bot exited (code=${code})\n`);
    bot.proc = null;
    bot.status = "stopped";
    delete bot.startTime;
    emitBots();

    // limit restart attempts
    if (code !== 0 && restartCount < 5) {
      appendLog(id, `🔁 Restarting in 5s (try ${restartCount + 1}/5)\n`);
      setTimeout(() => startBot(id, restartCount + 1), 5000);
    } else if (restartCount >= 5) {
      appendLog(id, "❌ Max restart attempts reached. Bot stopped.\n");
    }
  });
}

// 🧩 Deploy new bot
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry = "index.js" } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

    const safeName = (name && name.trim())
      ? name.trim().replace(/\s+/g, "-")
      : path.basename(repoUrl).replace(/\.git$/, "") + "-" + uuidv4().slice(0, 6);

    const appDir = path.join(APPS_DIR, safeName);
    const id = uuidv4();

    bots.set(id, {
      id,
      name: safeName,
      repoUrl,
      dir: appDir,
      entry,
      proc: null,
      logs: [],
      status: "cloning",
    });
    emitBots();
    appendLog(id, `📦 Cloning ${repoUrl} -> ${appDir}\n`);

    const git = simpleGit();

    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    await git.clone(repoUrl, appDir);
    appendLog(id, `✅ Clone complete\n`);

    bots.get(id).status = "installing";
    emitBots();
    appendLog(id, `📦 Running npm install...\n`);

    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: appDir,
        shell: true,
      });
      npm.stdout.on("data", d => appendLog(id, d));
      npm.stderr.on("data", d => appendLog(id, d));
      npm.on("close", code => code === 0 ? resolve() : reject(new Error("npm install failed")));
    });

    bots.get(id).status = "stopped";
    emitBots();
    appendLog(id, `✅ Install done, starting in 2s\n`);
    setTimeout(() => startBot(id), 2000);

    res.json({ id, name: safeName, dir: appDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// update, start, stop, restart, delete endpoints unchanged
app.post("/api/:id/start", (req, res) => {
  startBot(req.params.id);
  res.json({ message: "starting" });
});

app.post("/api/:id/stop", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) bot.proc.kill();
  bot.proc = null;
  bot.status = "stopped";
  delete bot.startTime;
  emitBots();
  appendLog(req.params.id, "🟡 Stopped\n");
  res.json({ message: "stopped" });
});

app.post("/api/:id/restart", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) bot.proc.kill();
  appendLog(id, "🔁 Manual restart\n");
  setTimeout(() => startBot(id), 1500);
  res.json({ message: "restarting" });
});

app.delete("/api/:id/delete", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  try {
    if (bot.proc) bot.proc.kill();
    if (fs.existsSync(bot.dir)) fs.rmSync(bot.dir, { recursive: true, force: true });
    bots.delete(id);
    emitBots();
    appendLog(id, "🗑️ Bot deleted\n");
    res.json({ message: "deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bots", (req, res) => {
  const list = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    repoUrl: b.repoUrl,
    entry: b.entry,
    status: b.status,
    startTime: b.startTime || null,
    dir: b.dir,
  }));
  res.json(list);
});

app.get("/api/:id/logs", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  res.json({ logs: bot.logs.slice(-2000) });
});

// ✅ memory in GB
app.get("/api/host", (req, res) => {
  const totalGB = (os.totalmem() / 1024 / 1024 / 1024).toFixed(2);
  const freeGB = (os.freemem() / 1024 / 1024 / 1024).toFixed(2);
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    cpus: os.cpus().length,
    memory: { totalGB, freeGB },
    uptime: os.uptime(),
    bots: bots.size,
  });
});

io.on("connection", (socket) => {
  socket.emit("bots", Array.from(bots.values()));
  socket.on("attachConsole", (id) => {
    const bot = bots.get(id);
    if (!bot) return;
    socket.join(id);
    socket.emit("initLogs", bot.logs.join(""));
  });
  socket.on("detachConsole", (id) => socket.leave(id));
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ LIKHON PANEL running on port ${PORT}`));
