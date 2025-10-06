// index.js — Bot Hosting Panel v2
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

const BOTS_FILE = path.join(APPS_DIR, "bots.json");
const bots = new Map();

// 🧠 Restore saved bots after restart
if (fs.existsSync(BOTS_FILE)) {
  try {
    const saved = JSON.parse(fs.readFileSync(BOTS_FILE, "utf8"));
    saved.forEach(b => {
      bots.set(b.id, { ...b, proc: null, logs: [], status: "stopped" });
    });
    console.log(`♻️ Restored ${saved.length} bots from previous session.`);
  } catch {
    console.log("⚠️ Failed to load previous bots.json");
  }
}

function saveBots() {
  const arr = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    dir: b.dir,
    entry: b.entry,
    status: b.status,
  }));
  fs.writeFileSync(BOTS_FILE, JSON.stringify(arr, null, 2));
}

// 🪵 Append logs (both memory + file)
function appendLog(id, chunk) {
  const b = bots.get(id);
  if (!b) return;
  const txt = String(chunk);
  console.log(`[${b.name}] ${txt.trim()}`);
  b.logs.push(txt);
  if (b.logs.length > 5000) b.logs.splice(0, b.logs.length - 5000);

  const logFile = path.join(b.dir, "bot.log");
  fs.appendFileSync(logFile, txt);
  io.to(id).emit("log", txt);
}

function spawnProcess(id, cmd, args, opts = {}) {
  const proc = spawn(cmd, args, { ...opts, shell: true });
  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));
  proc.on("close", (code, signal) => {
    appendLog(id, `\n=== process exited code=${code}, signal=${signal} ===\n`);
  });
  return proc;
}

// ================= DEPLOY =================
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry = "index.js" } = req.body;
    if (!repoUrl) return res.status(400).json({ error: "repoUrl required" });

    const id = uuidv4();
    const repoName = name ? name.replace(/\s+/g, "-") : `bot-${id.substring(0, 6)}`;
    const appDir = path.join(APPS_DIR, repoName);
    const git = simpleGit();

    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    bots.set(id, { id, name: repoName, dir: appDir, proc: null, logs: [], status: "cloning", entry });
    saveBots();

    io.emit("bots", Array.from(bots.values()));
    appendLog(id, `🌀 Cloning ${repoUrl} into ${appDir}\n`);
    await git.clone(repoUrl, appDir);
    appendLog(id, `✅ Clone finished\n`);

    bots.get(id).status = "installing";
    io.emit("bots", Array.from(bots.values()));

    appendLog(id, `📦 Running npm install...\n`);
    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], { cwd: appDir, shell: true });
      npm.stdout.on("data", (d) => appendLog(id, d));
      npm.stderr.on("data", (d) => appendLog(id, d));
      npm.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`npm install failed with code ${code}`));
      });
    });

    bots.get(id).status = "stopped";
    appendLog(id, `✅ Install complete! Ready to start.\n`);
    io.emit("bots", Array.from(bots.values()));
    saveBots();

    res.json({ id, name: repoName, dir: appDir });
  } catch (e) {
    console.error(e);
    res.status(500).json({ error: String(e) });
  }
});

// ================= START =================
app.post("/api/:id/start", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) return res.json({ message: "already running" });

  const entry = bot.entry || "index.js";
  const entryPath = path.join(bot.dir, entry);
  if (!fs.existsSync(entryPath))
    return res.status(400).json({ error: `entry file ${entry} not found` });

  appendLog(id, `🚀 Starting bot: node ${entry}\n`);
  bot.startTime = Date.now();

  const proc = spawn("node", [entry], { cwd: bot.dir, shell: true, env: { ...process.env } });
  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));

  proc.on("close", (code) => {
    appendLog(id, `\n=== bot exited (code=${code}) ===\n`);
    bot.proc = null;
    bot.status = "stopped";
    io.emit("bots", Array.from(bots.values()));
    saveBots();

    // Auto-restart
    if (code !== 0) {
      appendLog(id, "⚠️ Bot crashed — restarting in 5s...\n");
      setTimeout(() => startBot(id), 5000);
    }
  });

  bot.proc = proc;
  bot.status = "running";
  io.emit("bots", Array.from(bots.values()));
  saveBots();
  res.json({ message: "started" });
});

// Auto restart helper
function startBot(id) {
  const bot = bots.get(id);
  if (!bot || bot.proc) return;
  appendLog(id, "♻️ Auto restarting bot...\n");
  const proc = spawn("node", [bot.entry], { cwd: bot.dir, shell: true, env: { ...process.env } });

  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));
  proc.on("close", (code) => {
    appendLog(id, `\n=== bot exited again (code=${code}) ===\n`);
    bot.proc = null;
    bot.status = "stopped";
    io.emit("bots", Array.from(bots.values()));
    saveBots();
  });

  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  io.emit("bots", Array.from(bots.values()));
  saveBots();
}

// ================= STOP =================
app.post("/api/:id/stop", (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (!bot.proc) return res.json({ message: "not running" });

  try {
    bot.proc.kill();
    bot.proc = null;
    bot.status = "stopped";
    appendLog(id, "🛑 Bot stopped manually\n");
    io.emit("bots", Array.from(bots.values()));
    saveBots();
    res.json({ message: "stopped" });
  } catch (e) {
    res.status(500).json({ error: String(e) });
  }
});

// ================= LOGS =================
app.get("/api/bots", (req, res) => res.json(Array.from(bots.values())));
app.get("/api/:id/logs", (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  res.json({ logs: bot.logs.slice(-1000) });
});

// ================= SOCKET =================
io.on("connection", (socket) => {
  socket.on("subscribe", (id) => {
    const bot = bots.get(id);
    if (!bot) return socket.emit("error", "bot not found");
    socket.join(id);
    socket.emit("init", bot.logs.join(""));
  });
});

app.get("/", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Panel running on port ${PORT}`));
