import express from "express";
import { Server } from "socket.io";
import http from "http";
import { exec, spawn } from "child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "fs";
import { join } from "path";
import bodyParser from "body-parser";
import simpleGit from "simple-git";
import { v4 as uuidv4 } from "uuid";
import moment from "moment-timezone";

const app = express();
const server = http.createServer(app);
const io = new Server(server);

const PORT = process.env.PORT || 3000;
const botsFile = "bots.json";

app.use(express.static("public"));
app.use(bodyParser.json());

let bots = existsSync(botsFile)
  ? JSON.parse(readFileSync(botsFile))
  : [];

const processes = {};

function saveBots() {
  writeFileSync(botsFile, JSON.stringify(bots, null, 2));
}

function logNow() {
  return moment().tz("Asia/Dhaka").format("HH:mm:ss");
}

function sendBots() {
  io.emit("bots", bots);
}

// ✅ Deploy Bot
app.post("/api/deploy", async (req, res) => {
  try {
    const { repoUrl, name, entry } = req.body;
    if (!repoUrl) return res.json({ error: "Repository URL required" });

    const id = uuidv4();
    const botName = name || repoUrl.split("/").pop().replace(".git", "");
    const folder = join(process.cwd(), botName);

    const git = simpleGit();
    bots.push({ id, name: botName, repoUrl, folder, entry, status: "cloning" });
    saveBots();
    sendBots();

    await git.clone(repoUrl, folder);

    bots = bots.map(b => (b.id === id ? { ...b, status: "installing" } : b));
    saveBots();
    sendBots();

    exec(`cd ${folder} && npm install`, (err) => {
      if (err) {
        bots = bots.map(b => (b.id === id ? { ...b, status: "error" } : b));
        saveBots();
        sendBots();
        return;
      }
      startBot(id);
    });

    res.json({ id, name: botName });
  } catch (err) {
    console.error(err);
    res.json({ error: err.message });
  }
});

// ✅ Start Bot
app.post("/api/:id/start", (req, res) => {
  const { id } = req.params;
  startBot(id);
  res.json({ message: "Bot started" });
});

// ✅ Stop Bot
app.post("/api/:id/stop", (req, res) => {
  const { id } = req.params;
  stopBot(id);
  res.json({ message: "Bot stopped" });
});

// ✅ Update Bot (git pull + restart)
app.post("/api/:id/update", async (req, res) => {
  const { id } = req.params;
  const bot = bots.find(b => b.id === id);
  if (!bot) return res.json({ error: "Bot not found" });

  try {
    const git = simpleGit(bot.folder);
    await git.pull();
    stopBot(id);
    setTimeout(() => startBot(id), 2000);
    res.json({ message: `✅ ${bot.name} updated & restarted!` });
  } catch (err) {
    console.error(err);
    res.json({ error: "Update failed: " + err.message });
  }
});

// ✅ Get Bots List
app.get("/api/bots", (req, res) => res.json(bots));

// ✅ Get Logs
app.get("/api/:id/logs", (req, res) => {
  const { id } = req.params;
  const bot = bots.find(b => b.id === id);
  if (!bot) return res.json({ logs: [] });
  res.json({ logs: bot.logs || [] });
});

// ✅ Functions
function startBot(id) {
  const bot = bots.find(b => b.id === id);
  if (!bot) return;

  const entry = bot.entry || "index.js";
  const proc = spawn("node", [entry], { cwd: bot.folder });

  processes[id] = proc;
  bot.status = "running";
  bot.logs = bot.logs || [];
  saveBots();
  sendBots();

  proc.stdout.on("data", (data) => {
    const msg = `[${logNow()}] ${data}`;
    io.emit("log", msg);
    bot.logs.push(msg);
  });

  proc.stderr.on("data", (data) => {
    const msg = `[${logNow()}] ⚠️ ${data}`;
    io.emit("log", msg);
    bot.logs.push(msg);
  });

  proc.on("exit", () => {
    bot.status = "stopped";
    saveBots();
    sendBots();
  });
}

function stopBot(id) {
  if (processes[id]) {
    processes[id].kill();
    delete processes[id];
  }
  bots = bots.map(b => (b.id === id ? { ...b, status: "stopped" } : b));
  saveBots();
  sendBots();
}

// ✅ Restore bots on restart (optional auto start)
bots.forEach(b => {
  b.status = "stopped";
});

// ✅ Socket.io
io.on("connection", (socket) => {
  console.log("🟢 Client connected");
  socket.emit("bots", bots);
  socket.on("subscribe", (id) => {
    const bot = bots.find(b => b.id === id);
    if (bot && bot.logs) socket.emit("init", bot.logs.join(""));
  });
});

server.listen(PORT, () => console.log(`🚀 Panel running on http://localhost:${PORT}`));
