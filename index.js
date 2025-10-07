// index.js — HEADSHOT PANEL v4.0
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

// bots map: id => { id, name, dir, entry, repoUrl, proc, logs[], status, startTime }
const bots = new Map();

// utils
function cleanAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}
function appendLog(id, chunk) {
  const bot = bots.get(id);
  if (!bot) return;
  const txt = cleanAnsi(String(chunk));
  bot.logs.push(txt);
  if (bot.logs.length > 5000) bot.logs.splice(0, bot.logs.length - 5000);
  io.to(id).emit("log", txt);            // emit to subscribers of that bot
  io.emit("globalLog", { id, text: txt }); // also emit global for admin view
  // Also optionally write a per-bot logfile on disk (uncomment if desired)
  // fs.appendFileSync(path.join(bot.dir, 'bot.log'), txt);
  console.log(`[${bot.name}] ${txt.trim()}`);
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
function spawnProcess(id, cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { ...opts, shell: true });
  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));
  proc.on("close", (code, signal) => {
    appendLog(id, `\n=== process exited code=${code}, signal=${signal} ===\n`);
  });
  return proc;
}

// start bot helper
function startBot(id) {
  const bot = bots.get(id);
  if (!bot) return;
  if (bot.proc) return;
  const entry = bot.entry || "index.js";
  const entryPath = path.join(bot.dir, entry);
  if (!fs.existsSync(entryPath)) {
    appendLog(id, `❌ Entry not found: ${entry}\n`);
    bot.status = "error";
    emitBots();
    return;
  }
  appendLog(id, `🚀 Starting: node ${entry}\n`);
  const proc = spawn("node", [entry], { cwd: bot.dir, shell: true, env: { ...process.env } });
  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  emitBots();

  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));

  proc.on("close", code => {
    appendLog(id, `⚠️ Bot exited (code=${code})\n`);
    bot.proc = null;
    bot.status = "stopped";
    delete bot.startTime;
    emitBots();
    if (code !== 0) {
      appendLog(id, "♻️ Auto-restart in 5s...\n");
      setTimeout(() => startBot(id), 5000);
    }
  });
}

// ---------- API ----------

// deploy: clone (if not exists) then npm install then start (delayed)
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry = "index.js" } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

    const safeName = (name && name.trim()) ? name.trim().replace(/\s+/g, "-") : path.basename(repoUrl).replace(/\.git$/, '') + "-" + uuidv4().slice(0,6);
    const appDir = path.join(APPS_DIR, safeName);
    const id = uuidv4();

    // create bot record
    bots.set(id, { id, name: safeName, repoUrl, dir: appDir, entry, proc: null, logs: [], status: "cloning" });
    emitBots();
    appendLog(id, `🌀 Cloning ${repoUrl} -> ${appDir}\n`);

    const git = simpleGit();
    // if folder exists but not a git repo, remove to avoid conflicts
    if (fs.existsSync(appDir) && !fs.existsSync(path.join(appDir, ".git"))) {
      fs.rmSync(appDir, { recursive: true, force: true });
    }

    if (fs.existsSync(appDir) && fs.existsSync(path.join(appDir, ".git"))) {
      await git.cwd(appDir);
      await git.pull();
      appendLog(id, `🔄 Pulled existing repo\n`);
    } else {
      await git.clone(repoUrl, appDir);
      appendLog(id, `✅ Clone finished\n`);
    }

    // install
    bots.get(id).status = "installing";
    emitBots();
    appendLog(id, `📦 npm install (may take a while)...\n`);
    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, shell: true });
      npm.stdout.on("data", d => appendLog(id, d));
      npm.stderr.on("data", d => appendLog(id, d));
      npm.on("close", (code) => code === 0 ? resolve() : reject(new Error("npm install failed: " + code)));
    });

    bots.get(id).status = "stopped";
    emitBots();
    appendLog(id, `✅ Install done — starting in 2s...\n`);
    setTimeout(() => startBot(id), 2000);

    res.json({ id, name: safeName, dir: appDir });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
  }
});

// update: git pull + npm install + restart
app.post("/api/:id/update", async (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });

  try {
    appendLog(id, `🔁 Updating: git pull in ${bot.dir}\n`);
    bot.status = "updating";
    emitBots();
    const git = simpleGit(bot.dir);
    await git.pull();
    appendLog(id, `✅ Git pull complete\n`);

    appendLog(id, `📦 npm install (after pull)...\n`);
    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: bot.dir, shell: true });
      npm.stdout.on("data", d => appendLog(id, d));
      npm.stderr.on("data", d => appendLog(id, d));
      npm.on("close", code => code === 0 ? resolve() : reject(new Error("npm install failed: " + code)));
    });

    appendLog(id, `🔁 Restarting in 2s...\n`);
    if (bot.proc) try { bot.proc.kill(); } catch(e){}
    bot.proc = null;
    bot.status = "stopped";
    emitBots();
    setTimeout(() => startBot(id), 2000);

    res.json({ message: "updated" });
  } catch (err) {
    appendLog(id, `❌ Update failed: ${err.message}\n`);
    bot.status = "stopped";
    emitBots();
    res.status(500).json({ error: String(err) });
  }
});

// start/stop/restart
app.post("/api/:id/start", (req, res) => { startBot(req.params.id); res.json({ message: "starting" }); });
app.post("/api/:id/stop", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) try { bot.proc.kill(); } catch(e){}
  bot.proc = null; bot.status = "stopped"; delete bot.startTime;
  emitBots();
  appendLog(req.params.id, "🛑 Stopped manually\n");
  res.json({ message: "stopped" });
});
app.post("/api/:id/restart", (req, res) => {
  const id = req.params.id; const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) try { bot.proc.kill(); } catch(e){}
  appendLog(id, "🔁 Manual restart...\n");
  setTimeout(() => startBot(id), 1500);
  res.json({ message: "restarting" });
});

// delete bot (stop + remove folder)
app.delete("/api/:id/delete", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  try {
    if (bot.proc) try { bot.proc.kill(); } catch(e){}
    if (fs.existsSync(bot.dir)) fs.rmSync(bot.dir, { recursive: true, force: true });
    bots.delete(id);
    emitBots();
    appendLog(id, "🗑 Bot removed\n");
    res.json({ message: "deleted" });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// list bots & logs endpoints
app.get("/api/bots", (req, res) => {
  const list = Array.from(bots.values()).map(b => ({
    id: b.id, name: b.name, repoUrl: b.repoUrl, entry: b.entry, status: b.status, startTime: b.startTime || null, dir: b.dir
  }));
  res.json(list);
});
app.get("/api/:id/logs", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  res.json({ logs: bot.logs.slice(-2000) });
});

// host info
app.get("/api/host", (req, res) => {
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    cwd: process.cwd(),
    cpus: os.cpus().length,
    memory: { total: os.totalmem(), free: os.freemem() },
    bots: bots.size
  });
});

// sockets
io.on("connection", socket => {
  // emit bots snapshot
  const list = Array.from(bots.values()).map(b => ({
    id: b.id, name: b.name, repoUrl: b.repoUrl, entry: b.entry, status: b.status, startTime: b.startTime || null, dir: b.dir
  }));
  socket.emit("bots", list);

  socket.on("subscribe", id => {
    const bot = bots.get(id);
    if (!bot) return socket.emit("error", "bot not found");
    socket.join(id);
    // send current log buffer
    socket.emit("init", bot.logs.join(""));
  });
});

// serve UI
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ HEADSHOT PANEL v4.0 running on port ${PORT}`));
