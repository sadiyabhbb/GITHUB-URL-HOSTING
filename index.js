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
const PANEL_SECRET_KEY = process.env.PANEL_KEY || "NARUTO1234";
const TOKEN_EXPIRY_MS = 6 * 60 * 60 * 1000; 
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
// тЬЕ рж╕рж╛рж░рзНржнрж╛рж░ рж░рж┐рж╕рзНржЯрж╛рж░рзНржЯрзЗ ржПржЯрж┐ рж░рж┐рж╕рзЗржЯ рж╣ржмрзЗ (Panel Uptime ржПрж░ рж╕рзЛрж░рзНрж╕)
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

// --- MIDDLEWARE: ржЯрзЛржХрзЗржи ржПржиржлрзЛрж░рзНрж╕ ржХрж░рждрзЗ, GET ржУ POST ржЙржнрзЯ рж░рж┐ржХрзЛрзЯрзЗрж╕рзНржЯрзЗрж░ ржЬржирзНржп ржЯрзЛржХрзЗржи Query ржмрж╛ Body ржерзЗржХрзЗ ржирж┐ржмрзЗ ---
function enforceToken(req, res, next) {
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
        // тЬЕ ржмржЯрзЗрж░ рж░рж╛ржирж┐ржВ ржЯрж╛ржЗржо рж╣рж┐рж╕рзЗржм ржХрж░рзЗ ржкрж╛ржарж╛ржирзЛ рж╣ржЪрзНржЫрзЗ (Uptime)
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
        appendLog(id, `тЭМ Entry not found: ${bot.entry}\n`);
        bot.status = "error";
        emitBots();
        return;
    }

    if (!bot.port) bot.port = getRandomPort();

    appendLog(id, `ЁЯЪА Starting bot: node ${bot.entry} (PORT=${bot.port})\n`);
    const proc = spawn("node", [bot.entry], {
        cwd: bot.dir,
        shell: true,
        env: { ...process.env, NODE_ENV: "production", PORT: bot.port },
    });

    bot.proc = proc;
    bot.status = "running";
    bot.startTime = Date.now(); // рж╕рзНржЯрж╛рж░рзНржЯ ржЯрж╛ржЗржо рж╕рзЗржЯ
    delete bot.lastDuration; // ржЖржЧрзЗрж░ ржбрж┐ржЙрж░рзЗрж╢ржи ржорзБржЫрзЗ ржлрзЗрж▓рж╛
    emitBots();

    proc.stdout.on("data", d => appendLog(id, d));
    proc.stderr.on("data", d => appendLog(id, d));

    proc.on("error", err => {
        appendLog(id, `тЪая╕П Process error: ${err.message}\n`);
    });

    proc.on("close", (code) => {
        appendLog(id, `ЁЯЫС Bot exited (code=${code})\n`);
        // рж╕рзНржЯржк рж╣ржУрзЯрж╛рж░ рж╕ржорзЯ ржЯрзЛржЯрж╛рж▓ рж░рж╛ржирж┐ржВ ржЯрж╛ржЗржо рж╕рзЗржн ржХрж░рж╛
        if (bot.startTime) {
            bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
        }
        
        bot.proc = null;
        bot.status = "stopped";
        delete bot.startTime; // рж╕рзНржЯрж╛рж░рзНржЯ ржЯрж╛ржЗржо ржорзБржЫрзЗ ржлрзЗрж▓рж╛
        emitBots();

        if (code === 0) return; 
        
        if (code === "EADDRINUSE") {
            appendLog(id, "тЪая╕П Port in use. Assigning new port...\n");
            bot.port = getRandomPort();
        }

        if (restartCount < 5) {
            appendLog(id, `ЁЯФБ Restarting in 5s (try ${restartCount + 1}/5)\n`);
            setTimeout(() => startBot(id, restartCount + 1), 5000);
        } else {
            appendLog(id, "тЭМ Max restart attempts reached. Bot stopped.\n");
        }
    });
}

async function updateBot(id) {
    const bot = bots.get(id);
    if (!bot) return;
    
    // тЬЕ ржлрж┐ржХрзНрж╕ржб рж▓ржЬрж┐ржХ: ржкрзБрж░рж╛рждржи ржкрзНрж░рж╕рзЗрж╕ ржХрж┐рж▓ ржХрж░рж╛рж░ ржПржмржВ рж╕рзНржЯрзЗржЯрж╕ ржкрж░рж┐рж╖рзНржХрж╛рж░ ржХрж░рж╛рж░ ржЖржкржбрзЗржЯ
    if (bot.proc) {
        appendLog(id, "тЪая╕П Stopping previous instance before update...\n");
        
        // ржкрзНрж░рж╕рзЗрж╕ ржХрж┐рж▓ ржХрж░рж╛рж░ ржЖржЧрзЗ рж░рж╛ржирж┐ржВ ржЯрж╛ржЗржо рж╕рзЗржн ржХрж░рж╛ рж╣ржЪрзНржЫрзЗ
        if (bot.startTime) {
            bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
        }
        
        // ЁЯЫС ржЧрзБрж░рзБрждрзНржмржкрзВрж░рзНржг: ржкрзНрж░рж╕рзЗрж╕ ржЗржнрзЗржирзНржЯ рж▓рж┐рж╕рзЗржирж╛рж░ рж░рж┐ржорзБржн ржХрж░рж╛
        // ржПржЯрж┐ ржирж┐рж╢рзНржЪрж┐ржд ржХрж░ржмрзЗ ржпрзЗ 'close' ржЗржнрзЗржирзНржЯржЯрж┐ ржкрж░ржмрж░рзНрждрзАрждрзЗ startBot() ржЯрзНрж░рж┐ржЧрж╛рж░ ржХрж░ржмрзЗ ржирж╛
        bot.proc.removeAllListeners('close'); 
        bot.proc.kill('SIGTERM'); // SIGTERM ржжрж┐рзЯрзЗ рж╕ржарж┐ржХржнрж╛ржмрзЗ ржмржирзНржз ржХрж░рж╛рж░ ржЪрзЗрж╖рзНржЯрж╛
        
        bot.proc = null;
        delete bot.startTime; 
    }
    
    bot.status = "updating";
    emitBots();
    appendLog(id, "ЁЯФД Fetching latest changes (git pull)...\n");

    try {
        const git = simpleGit(bot.dir);
        
        const pullResult = await git.pull();
        appendLog(id, `тЬЕ Git Pull successful: ${pullResult.summary.changes} files changed\n`);

        bot.status = "installing";
        emitBots();
        appendLog(id, `ЁЯУж Running npm install...\n`);

        await new Promise((resolve, reject) => {
            const npm = spawn("npm", ["install", "--no-audit", "--no-fund"], {
                cwd: bot.dir,
                shell: true,
            });
            npm.stdout.on("data", d => appendLog(id, d));
            npm.stderr.on("data", d => appendLog(id, d));
            npm.on("close", code => code === 0 ? resolve() : reject(new Error("npm install failed")));
        });
        
        appendLog(id, `тЬЕ Install complete, restarting bot\n`);
        
    } catch (err) {
        appendLog(id, `тЭМ Update failed: ${err.message}\n`);
    } finally {
        bot.status = "stopped";
        emitBots();
        startBot(id);
    }
}


// --- API ENDPOINTS ---

// тЬЕ ржЯрзЛржХрзЗржи ржЬрзЗржирж╛рж░рзЗржЯ ржХрж░рж╛рж░ API Endpoint (POST ржПржмржВ GET ржжрзБржЯрзЛржЗ рж╣рзНржпрж╛ржирзНржбрзЗрж▓ ржХрж░ржмрзЗ)
function handleTokenGeneration(req, res) {
    const key = req.query.key || req.body.key; 

    if (key && key === PANEL_SECRET_KEY) {
        const token = generateToken(key);
        
        // тЬЕ ржЪрзВржбрж╝рж╛ржирзНржд JSON ржлрж░ржорзНржпрж╛ржЯ
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


// тЬЕ ржЯрзЛржХрзЗржи ржнрзЗрж░рж┐ржлрж╛ржЗ ржХрж░рж╛рж░ API (POST) 
app.post("/api/verify", (req, res) => {
    const { token } = req.body;
    if (verifyToken(token)) {
        const expiryData = activeTokens.get(token);
        res.json({ success: true, message: "Token Valid", expires_in: expiryData.expiry - Date.now() });
    } else {
        res.status(401).json({ success: false, error: "Invalid or expired token." });
    }
});


// тЪая╕П ржирж┐ржорзНржирж▓рж┐ржЦрж┐ржд рж╕ржорж╕рзНржд API Endpoints-ржП 'enforceToken' middleware ржпрзЛржЧ ржХрж░рж╛ рж╣рзЯрзЗржЫрзЗ
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
    appendLog(id, `ЁЯУж Cloning ${repoUrl} -> ${appDir}\n`);

    const git = simpleGit();
    if (fs.existsSync(appDir)) fs.rmSync(appDir, { recursive: true, force: true });
    await git.clone(repoUrl, appDir);
    appendLog(id, `тЬЕ Clone complete\n`);

    bots.get(id).status = "installing";
    emitBots();
    appendLog(id, `ЁЯУж Running npm install...\n`);

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
    appendLog(id, `тЬЕ Install done, starting in 2s\n`);
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
  if (bot.proc) {
    // рж╕рзНржЯржк рж╣ржУрзЯрж╛рж░ рж╕ржорзЯ ржЯрзЛржЯрж╛рж▓ рж░рж╛ржирж┐ржВ ржЯрж╛ржЗржо рж╕рзЗржн ржХрж░рж╛
    if (bot.startTime) {
        bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
    }
    bot.proc.kill();
  }
  bot.proc = null;
  bot.status = "stopped";
  delete bot.startTime; // рж╕рзНржЯрж╛рж░рзНржЯ ржЯрж╛ржЗржо ржорзБржЫрзЗ ржлрзЗрж▓рж╛
  emitBots();
  appendLog(req.params.id, "ЁЯЯб Stopped\n");
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
     // рж╕рзНржЯржк рж╣ржУрзЯрж╛рж░ рж╕ржорзЯ ржЯрзЛржЯрж╛рж▓ рж░рж╛ржирж┐ржВ ржЯрж╛ржЗржо рж╕рзЗржн ржХрж░рж╛
    if (bot.startTime) {
        bot.lastDuration = (bot.lastDuration || 0) + (Date.now() - bot.startTime);
    }
    bot.proc.kill();
  }
  appendLog(id, "ЁЯФБ Manual restart\n");
  setTimeout(() => startBot(id), 1500);
  res.json({ message: "restarting" });
});

app.delete("/api/:id/delete", enforceToken, (req, res) => {
  const id = req.params.id;
  const bot = bots.get(id);
  if (!bot) return res.status(404).json({ error: "bot not found" });
  try {
    if (bot.proc) {
        bot.proc.removeAllListeners('close'); // ржирж┐рж╢рзНржЪрж┐ржд ржХрж░рж╛ рж╣рж▓рзЛ delete-ржПрж░ рж╕ржорзЯ ржпрзЗржи ржХрзЛржирзЛ ржЕржЯрзЛ-рж░рж┐рж╕рзНржЯрж╛рж░рзНржЯ ржирж╛ рж╣рзЯ
        bot.proc.kill();
    }
    if (fs.existsSync(bot.dir)) fs.rmSync(bot.dir, { recursive: true, force: true });
    bots.delete(id);
    emitBots();
    appendLog(id, "ЁЯЧСя╕П Bot deleted\n");
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
    // тЬЕ Host-ржПрж░ ржЖрж╕рж▓ Uptime рж╕рзЗржХрзЗржирзНржбрзЗ ржкрж╛ржарж╛ржирзЛ рж╣ржЪрзНржЫрзЗ
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
server.listen(PORT, () => console.log(`тЬЕ LIKHON PANEL running on port ${PORT}`));

// тЬЕ ржкрзНрж░рждрж┐ рзл рж╕рзЗржХрзЗржирзНржбрзЗ ржмржЯрзЗрж░ рж╕рзНржЯрзНржпрж╛ржЯрж╛рж╕ ржЖржкржбрзЗржЯ ржХрж░рж╛рж░ ржЬржирзНржп timer (Emit Bots)
setInterval(emitBots, 5000);
