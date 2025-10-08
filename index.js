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

// --- SECURITY KEY & TOKEN CONFIGURATION START ---
// আপনার গোপন Key
const PANEL_SECRET_KEY = process.env.PANEL_KEY || "NARUTO1234";
// টোকেনের বৈধতা (6 ঘন্টা)
const TOKEN_EXPIRY_MS = 6 * 60 * 60 * 1000; 

// বর্তমানে জারি করা টোকেনগুলি ট্র্যাক করার জন্য
const activeTokens = new Map(); 
// --- SECURITY KEY & TOKEN CONFIGURATION END ---

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(bodyParser.json());
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
        if (now > data.expiry) {
            activeTokens.delete(token);
        }
    }
}
// --- END TOKEN FUNCTIONS ---

// --- MIDDLEWARE: প্রতিটি API কলে টোকেন চেক করার জন্য ---
function enforceToken(req, res, next) {
    // টোকেন Query Parameter বা Body থেকে নিন
    const token = req.query.token || req.body.token;

    if (verifyToken(token)) {
        req.userToken = token; 
        next();
    } else {
        res.status(401).json({ success: false, error: "Access Denied: Invalid or expired token." });
    }
}
// --- END MIDDLEWARE ---

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
        dir: b.dir,
        port: b.port || null
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
        bot.proc.kill();
        bot.proc = null;
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
        startBot(id);
    }
}


// --- API ENDPOINTS ---

// ✅ ১. টোকেন জেনারেট করার API Endpoint (নিরাপদ POST মেথড)
app.post("/api/generate-token", (req, res) => {
    // Key এখন req.body থেকে নেওয়া হচ্ছে
    const { key } = req.body; 

    if (key && key === PANEL_SECRET_KEY) {
        const token = generateToken(key);
        res.json({ success: true, token: token, expires_in: TOKEN_EXPIRY_MS });
    } else {
        res.status(401).json({ success: false, error: "Invalid Key." });
    }
});

// ✅ ২. টোকেন ভেরিফাই করার API 
app.post("/api/verify", (req, res) => {
    const { token } = req.body;
    if (verifyToken(token)) {
        res.json({ success: true, message: "Token Valid" });
    } else {
        res.status(401).json({ success: false, error: "Invalid or expired token." });
    }
});


// ⚠️ নিম্নলিখিত সমস্ত API Endpoints-এ 'enforceToken' middleware যোগ করা হয়েছে
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
    setTimeout(() => startBot(id), 2000);

    res.json({ id, name: safeName, dir: appDir });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- Protected API Endpoints ---
app.post("/api/:id/start", enforceToken, (req, res) => {
  startBot(req.params.id);
  res.json({ message: "starting" });
});

app.post("/api/:id/stop", enforceToken, (req, res) => {
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
  if (bot.proc) bot.proc.kill();
  appendLog(id, "🔁 Manual restart\n");
  setTimeout(() => startBot(id), 1500);
  res.json({ message: "restarting" });
});

app.delete("/api/:id/delete", enforceToken, (req, res) => {
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

app.get("/api/bots", enforceToken, (req, res) => {
  const list = Array.from(bots.values()).map(b => ({
    id: b.id,
    name: b.name,
    repoUrl: b.repoUrl,
    entry: b.entry,
    status: b.status,
    startTime: b.startTime || null,
    dir: b.dir,
    port: b.port
  }));
  res.json(list);
});

app.get("/api/:id/logs", enforceToken, (req, res) => {
  const bot = bots.get(req.params.id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  res.json({ logs: bot.logs.slice(-2000) });
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
  socket.emit("bots", Array.from(bots.values()));
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
