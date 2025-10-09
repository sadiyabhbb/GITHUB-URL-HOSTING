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

import axios from "axios";
import FormData from "form-data";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- CONFIG ---
const PANEL_SECRET_KEY = process.env.PANEL_KEY || "NARUTO1234";
const TOKEN_EXPIRY_MS = 6 * 60 * 60 * 1000;
const BACKUP_URL = process.env.BACKUP_URL || "https://lite-bkup-panel.onrender.com"; // <-- backup/storage server
const LOG_LOCAL_KEEP = Number(process.env.LOG_LOCAL_KEEP) || 200; // how many log lines to keep locally
const LOG_UPLOAD_CHUNK = Number(process.env.LOG_UPLOAD_CHUNK) || 150; // when exceed, upload oldest chunk
// ----------------

const activeTokens = new Map();

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(bodyParser.json({ limit: "10mb" }));
app.use(express.static(path.join(__dirname, "public")));

const APPS_DIR = path.join(__dirname, "apps");
if (!fs.existsSync(APPS_DIR)) fs.mkdirSync(APPS_DIR, { recursive: true });

const bots = new Map();
const serverStartTime = Date.now();

// --- TOKEN FUNCTIONS ---
function generateToken(key) {
  const token = uuidv4();
  const expiry = Date.now() + TOKEN_EXPIRY_MS;
  activeTokens.set(token, { expiry, createdAt: Date.now() });
  if (activeTokens.size > 100) cleanupExpiredTokens();
  return token;
}

function verifyToken(token) {
  if (!token) return false;
  const data = activeTokens.get(token);
  if (!data) return false;
  if (Date.now() > data.expiry) {
    activeTokens.delete(token);
    return false;
  }
  return true;
}

function cleanupExpiredTokens() {
  const now = Date.now();
  for (let [token, data] of activeTokens.entries()) {
    if (now > data.expiry) activeTokens.delete(token);
  }
}
// --- END TOKEN FUNCTIONS ---

function enforceToken(req, res, next) {
  const token = req.query.token || req.body.token;
  if (verifyToken(token)) {
    req.userToken = token;
    next();
  } else {
    res.status(401).json({ success: false, error: "Access Denied: Invalid or expired token." });
  }
}

function cleanAnsi(s) {
  return String(s).replace(/\x1b\[[0-9;]*m/g, "");
}

// --- Backup helpers: try JSON save endpoint first, fallback to multipart upload ---
async function trySaveJsonFile(filename, content) {
  try {
    // many storage implementations expose /api/save/:filename that accepts JSON
    const url = `${BACKUP_URL.replace(/\/$/, "")}/api/save/${encodeURIComponent(filename)}`;
    await axios.post(url, content, { timeout: 15000 });
    return true;
  } catch (err) {
    return false;
  }
}

async function tryUploadMultipart(filename, bufferOrString) {
  try {
    const url = `${BACKUP_URL.replace(/\/$/, "")}/upload`;
    const form = new FormData();
    // FormData expects a stream / buffer — provide Buffer
    const buffer = Buffer.isBuffer(bufferOrString) ? bufferOrString : Buffer.from(String(bufferOrString));
    form.append("file", buffer, { filename });

    await axios.post(url, form, {
      headers: form.getHeaders(),
      maxBodyLength: Infinity,
      timeout: 20000
    });
    return true;
  } catch (err) {
    return false;
  }
}

// Generic upload: first try JSON save API, fallback to multipart file upload
async function uploadToStorage(filename, data) {
  try {
    // If data is object, send as JSON body; else send as text content to JSON endpoint
    const jsonAttempt = await trySaveJsonFile(filename, typeof data === "object" ? data : { data: String(data) });
    if (jsonAttempt) return true;
    // fallback to multipart upload
    const multipartAttempt = await tryUploadMultipart(filename, typeof data === "object" ? JSON.stringify(data, null, 2) : String(data));
    return multipartAttempt;
  } catch (err) {
    return false;
  }
}

// appendLog now uploads older chunks to storage to keep memory low
function appendLog(id, chunk) {
  const bot = bots.get(id);
  if (!bot) return;
  const txt = cleanAnsi(String(chunk));
  bot.logs.push(txt);

  // If logs exceed LOG_LOCAL_KEEP, extract oldest chunk and upload it asynchronously
  if (bot.logs.length > LOG_LOCAL_KEEP) {
    const overflowCount = bot.logs.length - LOG_LOCAL_KEEP;
    // limit upload chunk size
    const chunkCount = Math.min(overflowCount, LOG_UPLOAD_CHUNK);
    const uploadChunk = bot.logs.splice(0, chunkCount); // remove oldest lines
    // prepare content
    const content = uploadChunk.join("");
    const filename = `${bot.id}_logs_${Date.now()}.txt`;
    // fire-and-forget (no blocking)
    uploadToStorage(filename, content).catch(e => {
      // if upload fails, push chunk back but keep small memory footprint: only keep last LOG_LOCAL_KEEP
      console.error("Log upload failed for", bot.id, e.message || e);
      // attempt to append failure note to current logs (bounded)
      bot.logs.unshift(`[log-upload-failed ${new Date().toISOString()}]\n`);
      // If push back would exceed LOG_LOCAL_KEEP, trim again
      if (bot.logs.length > LOG_LOCAL_KEEP) {
        bot.logs.splice(0, bot.logs.length - LOG_LOCAL_KEEP);
      }
    });
  }

  // enforce absolute maximum safety cap (in case)
  if (bot.logs.length > LOG_LOCAL_KEEP * 2) {
    bot.logs = bot.logs.slice(-LOG_LOCAL_KEEP);
  }

  io.to(id).emit("log", { id, text: txt });
}

// uptime formatting unchanged
function formatUptime(ms) {
  if (!ms || ms < 0) return '0h 0m 0s';
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${minutes}m ${secs}s`;
}

function emitBots() {
  const now = Date.now();
  const list = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    repoUrl: b.repoUrl,
    entry: b.entry,
    status: b.status,
    startTime: b.startTime || null,
    dir: b.dir,
    port: b.port || null,
    botUptime: b.startTime && b.status === 'running' ? formatUptime(now - b.startTime) : (b.startTime ? formatUptime(b.lastDuration || 0) : 'N/A')
  }));
  io.emit("bots", list);
}

function getRandomPort(base = 10000) {
  return base + Math.floor(Math.random() * 40000);
}

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

  if (!bot.port) bot.port = getRandomPort();

  appendLog(id, `🚀 Starting bot: node ${bot.entry} (PORT=${bot.port})\n`);
  const proc = spawn("node", [bot.entry], {
    cwd: bot.dir,
    shell: true,
    env: { ...process.env, NODE_ENV: "production", PORT: bot.port },
  });

  bot.proc = proc;
  bot.status = "running";
  bot.startTime = Date.now();
  delete bot.lastDuration;
  emitBots();

  proc.stdout.on("data", d => appendLog(id, d));
  proc.stderr.on("data", d => appendLog(id, d));

  proc.on("error", err => {
    appendLog(id, `⚠️ Process error: ${err.message}\n`);
  });

  proc.on("close", (code) => {
    appendLog(id, `🛑 Bot exited (code=${code})\n`);
    if (bot.startTime) {
      bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
    }

    bot.proc = null;
    bot.status = "stopped";
    delete bot.startTime;
    emitBots();

    if (code === 0) return;

    if (code === "EADDRINUSE") {
      appendLog(id, "⚠️ Port in use. Assigning new port...\n");
      bot.port = getRandomPort();
    }

    if (restartCount < 5) {
      appendLog(id, `🔁 Restarting in 5s (try ${restartCount + 1}/5)\n`);
      setTimeout(() => startBot(id, restartCount + 1), 5000);
    } else {
      appendLog(id, "❌ Max restart attempts reached. Bot stopped.\n");
    }
  });
}

async function updateBot(id) {
  const bot = bots.get(id);
  if (!bot) return;

  if (bot.proc) {
    appendLog(id, "⚠️ Stopping previous instance before update...\n");
    if (bot.startTime) {
      bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
    }
    bot.proc.removeAllListeners('close');
    bot.proc.kill('SIGTERM');

    bot.proc = null;
    delete bot.startTime;
  }

  bot.status = "updating";
  emitBots();
  appendLog(id, "🔄 Fetching latest changes (git pull)...\n");

  try {
    const git = simpleGit(bot.dir);
    const pullResult = await git.pull();
    appendLog(id, `✅ Git Pull successful: ${pullResult.summary.changes} files changed\n`);

    bot.status = "installing";
    emitBots();
    appendLog(id, `📦 Running npm install...\n`);

    await new Promise((resolve, reject) => {
      const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], {
        cwd: bot.dir,
        shell: true,
      });
      npm.stdout.on("data", d => appendLog(id, d));
      npm.stderr.on("data", d => appendLog(id, d));
      npm.on("close", code => code === 0 ? resolve() : reject(new Error("npm install failed")));
    });

    appendLog(id, `✅ Install complete, restarting bot\n`);
  } catch (err) {
    appendLog(id, `❌ Update failed: ${err.message}\n`);
  } finally {
    bot.status = "stopped";
    emitBots();

    // upload small bot meta/info to storage so we have record
    try {
      const metaFilename = `${bot.id}_info.json`;
      await uploadToStorage(metaFilename, {
        id: bot.id,
        name: bot.name,
        repoUrl: bot.repoUrl,
        entry: bot.entry,
        updated_at: new Date().toISOString()
      });
    } catch (e) {
      // ignore
    }

    startBot(id);
  }
}


// --- API ENDPOINTS ---
function handleTokenGeneration(req, res) {
  const key = req.query.key || req.body.key;

  if (key && key === PANEL_SECRET_KEY) {
    const token = generateToken(key);
    res.json({
      success: true,
      token: token,
      expires_in: "6h",
      host_name: "TAHSIN VEX",
      author: "LIKHON",
      generated_at: new Date().toISOString()
    });
  } else {
    res.status(401).json({ success: false, error: "Invalid Key." });
  }
}

app.post("/api/generate-token", handleTokenGeneration);
app.get("/api/generate-token", handleTokenGeneration);

app.post("/api/verify", (req, res) => {
  const { token } = req.body;
  if (verifyToken(token)) {
    const expiryData = activeTokens.get(token);
    res.json({ success: true, message: "Token Valid", expires_in: expiryData.expiry - Date.now() });
  } else {
    res.status(401).json({ success: false, error: "Invalid or expired token." });
  }
});

app.post("/api/deploy", enforceToken, async (req, res) => {
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
      port: getRandomPort()
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

    // Upload small meta to storage (non-blocking)
    const botMeta = {
      id,
      name: safeName,
      repoUrl,
      entry,
      created_at: new Date().toISOString()
    };
    uploadToStorage(`${id}_meta.json`, botMeta).catch(() => {});

    setTimeout(() => startBot(id), 2000);

    res.json({ id, name: safeName, dir: appDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Protected API Endpoints
app.post("/api/:id/start", enforceToken, (req, res) => {
  startBot(req.params.id);
  res.json({ message: "starting" });
});

app.post("/api/:id/stop", enforceToken, (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) {
    if (bot.startTime) {
      bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
    }
    bot.proc.kill();
  }
  bot.proc = null;
  bot.status = "stopped";
  delete bot.startTime;
  emitBots();
  appendLog(req.params.id, "🟡 Stopped\n");
  res.json({ message: "stopped" });
});

app.post("/api/:id/update", enforceToken, (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  updateBot(id);
  res.json({ message: "update started" });
});

app.post("/api/:id/restart", enforceToken, (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  if (bot.proc) {
    if (bot.startTime) {
      bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
    }
    bot.proc.kill();
  }
  appendLog(id, "🔁 Manual restart\n");
  setTimeout(() => startBot(id), 1500);
  res.json({ message: "restarting" });
});

app.delete("/api/:id/delete", enforceToken, (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  try {
    if (bot.proc) {
      bot.proc.removeAllListeners('close');
      bot.proc.kill();
    }
    if (fs.existsSync(bot.dir)) fs.rmSync(bot.dir, { recursive: true, force: true });
    bots.delete(id);
    emitBots();
    appendLog(id, "🗑️ Bot deleted\n");
    res.json({ message: "deleted" });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get("/api/bots", enforceToken, (req, res) => {
  const now = Date.now();
  const list = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    repoUrl: b.repoUrl,
    entry: b.entry,
    status: b.status,
    startTime: b.startTime || null,
    dir: b.dir,
    port: b.port,
    botUptime: b.startTime && b.status === 'running' ? formatUptime(now - b.startTime) : (b.startTime ? formatUptime(b.lastDuration || 0) : 'N/A')
  }));
  res.json(list);
});

app.get("/api/:id/logs", enforceToken, (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  // return last local logs and provide a storage URL hint for older logs
  const localLogs = bot.logs.slice(-LOG_LOCAL_KEEP);
  const storageFilename = `${bot.id}_logs.txt`; // conventional name to check
  const storageUrlCandidates = [
    `${BACKUP_URL.replace(/\/$/, "")}/data/${storageFilename}`,
    `${BACKUP_URL.replace(/\/$/, "")}/${storageFilename}`,
    `${BACKUP_URL.replace(/\/$/, "")}/api/load/${encodeURIComponent(storageFilename)}`
  ];
  res.json({ logs: localLogs, storageUrls: storageUrlCandidates });
});

app.get("/api/host", enforceToken, (req, res) => {
  const total = os.totalmem();
  const free = os.freemem();
  const uptimeSeconds = Math.floor((Date.now() - serverStartTime) / 1000);
  res.json({
    platform: os.platform(),
    arch: os.arch(),
    node: process.version,
    cpus: os.cpus().length,
    memory: {
      total,
      free,
      totalGB: +(total / 1024 / 1024 / 1024).toFixed(2),
      freeGB: +(free / 1024 / 1024 / 1024).toFixed(2),
    },
    uptime: uptimeSeconds,
    bots: bots.size,
  });
});

io.on("connection", (socket) => {
  const now = Date.now();
  socket.emit("bots", Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    repoUrl: b.repoUrl,
    entry: b.entry,
    status: b.status,
    startTime: b.startTime || null,
    dir: b.dir,
    port: b.port || null,
    botUptime: b.startTime && b.status === 'running' ? formatUptime(now - b.startTime) : (b.startTime ? formatUptime(b.lastDuration || 0) : 'N/A')
  })));
  socket.on("attachConsole", (id) => {
    const bot = bots.get(id);
    if (!bot) return;
    socket.join(id);
    socket.emit("initLogs", bot.logs.join(""));
  });
  socket.on("detachConsole", (id) => socket.leave(id));
});

app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ LIKHON PANEL running on port ${PORT}`));

// periodic emit
setInterval(emitBots, 5000);
