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
  if (bot.logs.length > 5000) bot.logs.splice(0, bot.logs.length - 5000);
  io.to(id).emit("log", { id, text: txt });
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

function startBot(id) {
  const bot = bots.get(id);
  if (!bot || bot.proc) return;
  const entry = bot.entry || "index.js";
  const entryPath = path.join(bot.dir, entry);
  if (!fs.existsSync(entryPath)) {
    appendLog(id, `❌ Entry not found: ${entry}\n`);
    bot.status = "error";
    emitBots();
    return;
  }

  appendLog(id, `🚀 Starting: node ${entry}\n`);
  const proc = spawn("node", [entry], {
    cwd: bot.dir,
    shell: true,
    env: { ...process.env },
  });
  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  emitBots();

  proc.stdout.on("data", (d) => appendLog(id, d));
  proc.stderr.on("data", (d) => appendLog(id, d));

  proc.on("close", (code) => {
    appendLog(id, `⚠️ Bot exited (code=${code})\n`);
    bot.proc = null;
    bot.status = "stopped";
    delete bot.startTime;
    emitBots();
  });
}

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
    appendLog(id, `✅ Clone finished\n`);

    bots.get(id).status = "installing";
    emitBots();
    appendLog(id, `📦 Running npm install\n`);
    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: appDir,
        shell: true,
      });
      npm.stdout.on("data", (d) => appendLog(id, d));
      npm.stderr.on("data", (d) => appendLog(id, d));
      npm.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error("npm install failed: " + code))
      );
    });

    bots.get(id).status = "stopped";
    emitBots();
    appendLog(id, `✅ Install done, starting bot\n`);
    startBot(id);
    res.json({ id, name: safeName, dir: appDir });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: String(err) });
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
  res.json({ logs: bot.logs.slice(-1000) });
});

app.get("/api/host", (req, res) => {
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    cpus: os.cpus().length,
    memory: (os.totalmem() / 1024 / 1024 / 1024).toFixed(1) + " GB",
    uptime: os.uptime(),
    bots: bots.size,
  });
});

io.on("connection", (socket) => {
  socket.emit("bots", Array.from(bots.values()));
  socket.on("subscribe", (id) => {
    socket.join(id);
    const bot = bots.get(id);
    if (bot) socket.emit("log", { id, text: bot.logs.join("") });
  });
  socket.on("unsubscribe", (id) => socket.leave(id));
});

app.get("*", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`🚀 Xavia Panel running on port ${PORT}`));
