import express from "express";
import http from "http";
import { Server } from "socket.io";
import { exec, spawn } from "child_process";
import { join } from "path";
import { existsSync, mkdirSync, appendFileSync, readFileSync } from "fs";
import simpleGit from "simple-git";
import bodyParser from "body-parser";
import { v4 as uuidv4 } from "uuid";
import moment from "moment-timezone";

const app = express();
const server = http.createServer(app);
const io = new Server(server);
const PORT = process.env.PORT || 3000;

// === Directories ===
const baseDir = join(process.cwd(), "apps");
if (!existsSync(baseDir)) mkdirSync(baseDir);

app.use(bodyParser.json());
app.use(express.static("public"));

// === Memory store ===
let bots = [];

// === Utility ===
function logFile(botId) {
  const dir = join(baseDir, botId);
  if (!existsSync(dir)) mkdirSync(dir);
  return join(dir, "bot.log");
}
function log(botId, data) {
  appendFileSync(logFile(botId), `[${moment().format("HH:mm:ss")}] ${data}\n`);
}

// === API ROUTES ===

// get all bots
app.get("/api/bots", (req, res) => {
  res.json(bots.map(b => ({
    id: b.id,
    name: b.name,
    status: b.proc ? "running" : "stopped",
    startTime: b.startTime || null
  })));
});

// deploy new bot
app.post("/api/deploy", async (req, res) => {
  const { repoUrl, name, entry = "index.js" } = req.body;
  if (!repoUrl) return res.json({ error: "Missing repoUrl" });

  const id = uuidv4().slice(0, 8);
  const dir = join(baseDir, id);
  const git = simpleGit();

  try {
    await git.clone(repoUrl, dir);
    log(id, `✅ Repo cloned from ${repoUrl}`);
    exec(`cd ${dir} && npm install`, (err, out) => {
      if (err) log(id, "❌ npm install failed");
      else log(id, "✅ npm install complete");
    });

    bots.push({ id, name: name || id, entry, dir, repoUrl, proc: null });
    res.json({ id, name: name || id });
  } catch (e) {
    res.json({ error: e.message });
  }
});

// start bot
app.post("/api/:id/start", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.json({ error: "Bot not found" });

  if (bot.proc) return res.json({ error: "Already running" });

  const proc = spawn("node", [join(bot.dir, bot.entry || "index.js")], { cwd: bot.dir });
  bot.proc = proc;
  bot.startTime = Date.now();

  proc.stdout.on("data", data => {
    const msg = data.toString();
    io.emit("log", msg);
    log(bot.id, msg);
  });
  proc.stderr.on("data", data => {
    const msg = data.toString();
    io.emit("log", msg);
    log(bot.id, msg);
  });
  proc.on("close", () => {
    log(bot.id, "🔴 Bot stopped");
    bot.proc = null;
  });

  log(bot.id, "🟢 Bot started");
  res.json({ ok: true });
});

// stop bot
app.post("/api/:id/stop", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.json({ error: "Bot not found" });

  if (bot.proc) {
    bot.proc.kill("SIGTERM");
    bot.proc = null;
    log(bot.id, "🔴 Bot stopped manually");
  }
  res.json({ ok: true });
});

// restart bot
app.post("/api/:id/restart", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.json({ error: "Bot not found" });

  if (bot.proc) bot.proc.kill("SIGTERM");
  setTimeout(() => {
    const proc = spawn("node", [join(bot.dir, bot.entry || "index.js")], { cwd: bot.dir });
    bot.proc = proc;
    bot.startTime = Date.now();
    log(bot.id, "🔁 Bot restarted");
    proc.stdout.on("data", d => io.emit("log", d.toString()));
  }, 1000);

  res.json({ ok: true });
});

// update bot (git pull + npm install + restart)
app.post("/api/:id/update", (req, res) => {
  const bot = bots.find(b => b.id === req.params.id);
  if (!bot) return res.json({ error: "Bot not found" });
  const dir = bot.dir;

  log(bot.id, "⬆️ Starting update...");
  const git = simpleGit(dir);
  git.pull()
    .then(() => {
      log(bot.id, "✅ Git pull done");
      exec(`cd ${dir} && npm install`, (err) => {
        if (err) {
          log(bot.id, "❌ npm install failed");
          return res.json({ error: "npm install failed" });
        }
        log(bot.id, "✅ npm install done");
        if (bot.proc) bot.proc.kill("SIGTERM");
        setTimeout(() => {
          const proc = spawn("node", [join(bot.dir, bot.entry || "index.js")], { cwd: bot.dir });
          bot.proc = proc;
          bot.startTime = Date.now();
          log(bot.id, "♻️ Bot updated & restarted");
          proc.stdout.on("data", d => io.emit("log", d.toString()));
        }, 1000);
        res.json({ ok: true });
      });
    })
    .catch(e => {
      log(bot.id, "❌ Git pull failed: " + e.message);
      res.json({ error: e.message });
    });
});

// logs
app.get("/api/:id/logs", (req, res) => {
  const f = logFile(req.params.id);
  if (!existsSync(f)) return res.json({ logs: [] });
  const data = readFileSync(f, "utf-8").split("\n").slice(-400);
  res.json({ logs: data });
});

// === SOCKET.IO ===
io.on("connection", socket => {
  console.log("🟢 client connected");
  socket.on("subscribe", botId => {
    const f = logFile(botId);
    if (existsSync(f)) socket.emit("log", readFileSync(f, "utf-8"));
  });
});

// === START SERVER ===
server.listen(PORT, () => {
  console.log(`🚀 HEADSHOT PANEL running on port ${PORT}`);
});
