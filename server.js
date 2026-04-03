const express = require("express");
const http = require("http");
const { Server } = require("socket.io");
const path = require("path");
const fs = require("fs");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*", methods: ["GET", "POST"] },
});

app.use(express.static(path.join(__dirname, "public")));
app.use(express.json());

// Root route fallback
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// ───────────────────── DATA STORE ─────────────────────
const DB_FILE = path.join(__dirname, "data.json");

function loadDB() {
  try {
    if (fs.existsSync(DB_FILE))
      return JSON.parse(fs.readFileSync(DB_FILE, "utf8"));
  } catch {}
  return { users: {}, leaderboard: [] };
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

let db = loadDB();

function getOrCreateUser(uid, name) {
  if (!db.users[uid]) {
    db.users[uid] = {
      uid,
      name: name || "Racer_" + uid.slice(0, 4),
      totalCoins: 0,
      totalWins: 0,
      totalLosses: 0,
      totalColors: 1,
      totalWheels: 1,
      ownedColors: ["red", "blue", "green", "yellow"],
      ownedWheels: ["blackgrooves"],
      selectedColor: "red",
      selectedWheel: "blackgrooves",
      friends: [],
      friendRequests: [],
      races: 0,
    };
    saveDB(db);
  }
  return db.users[uid];
}

// ───────────────────── REST API ─────────────────────
app.get("/api/user/:uid", (req, res) => {
  const user = db.users[req.params.uid];
  if (!user) return res.json({ error: "not found" });
  res.json(user);
});

app.post("/api/user", (req, res) => {
  const { uid, name } = req.body;
  const user = getOrCreateUser(uid, name);
  res.json(user);
});

app.post("/api/user/:uid/update", (req, res) => {
  const user = db.users[req.params.uid];
  if (!user) return res.json({ error: "not found" });
  const allowed = [
    "name",
    "totalCoins",
    "ownedColors",
    "ownedWheels",
    "selectedColor",
    "selectedWheel",
    "totalWins",
    "totalLosses",
    "totalColors",
    "totalWheels",
    "races",
  ];
  allowed.forEach((k) => {
    if (req.body[k] !== undefined) user[k] = req.body[k];
  });
  saveDB(db);
  res.json(user);
});

app.get("/api/leaderboard", (req, res) => {
  const lb = Object.values(db.users)
    .sort((a, b) => b.totalCoins - a.totalCoins)
    .slice(0, 20)
    .map((u) => ({
      uid: u.uid,
      name: u.name,
      totalCoins: u.totalCoins,
      totalWins: u.totalWins,
      totalLosses: u.totalLosses,
      totalColors: u.ownedColors?.length || 1,
      totalWheels: u.ownedWheels?.length || 1,
      selectedColor: u.selectedColor,
      selectedWheel: u.selectedWheel,
    }));
  res.json(lb);
});

app.post("/api/friend-request", (req, res) => {
  const { fromUID, toUID } = req.body;
  if (fromUID === toUID) return res.json({ error: "Cannot add yourself" });
  const toUser = db.users[toUID];
  if (!toUser) return res.json({ error: "User not found" });
  if (toUser.friendRequests.includes(fromUID))
    return res.json({ error: "Already sent" });
  if (toUser.friends.includes(fromUID))
    return res.json({ error: "Already friends" });
  toUser.friendRequests.push(fromUID);
  saveDB(db);
  const toSocket = onlineSockets[toUID];
  if (toSocket)
    io.to(toSocket).emit("friendRequest", {
      fromUID,
      fromName: db.users[fromUID]?.name,
    });
  res.json({ ok: true });
});

app.post("/api/friend-accept", (req, res) => {
  const { uid, fromUID } = req.body;
  const user = db.users[uid];
  const fromUser = db.users[fromUID];
  if (!user || !fromUser) return res.json({ error: "not found" });
  user.friendRequests = user.friendRequests.filter((r) => r !== fromUID);
  if (!user.friends.includes(fromUID)) user.friends.push(fromUID);
  if (!fromUser.friends.includes(uid)) fromUser.friends.push(uid);
  saveDB(db);
  res.json({ ok: true });
});

app.post("/api/friend-reject", (req, res) => {
  const { uid, fromUID } = req.body;
  const user = db.users[uid];
  if (!user) return res.json({ error: "not found" });
  user.friendRequests = user.friendRequests.filter((r) => r !== fromUID);
  saveDB(db);
  res.json({ ok: true });
});

app.get("/api/user/:uid/friends", (req, res) => {
  const user = db.users[req.params.uid];
  if (!user) return res.json([]);
  const friends = user.friends
    .map((fid) => {
      const f = db.users[fid];
      return f
        ? {
            uid: f.uid,
            name: f.name,
            totalCoins: f.totalCoins,
            totalWins: f.totalWins,
          }
        : null;
    })
    .filter(Boolean);
  res.json(friends);
});

app.get("/api/user/:uid/requests", (req, res) => {
  const user = db.users[req.params.uid];
  if (!user) return res.json([]);
  const requests = user.friendRequests
    .map((fid) => {
      const f = db.users[fid];
      return f ? { uid: f.uid, name: f.name } : null;
    })
    .filter(Boolean);
  res.json(requests);
});

// ───────────────────── SOCKET.IO MULTIPLAYER ─────────────────────
const onlineSockets = {};
const rooms = {};

io.on("connection", (socket) => {
  let myUID = null;

  socket.on("register", ({ uid, name }) => {
    myUID = uid;
    onlineSockets[uid] = socket.id;
    getOrCreateUser(uid, name);
    socket.emit("registered", db.users[uid]);
    broadcastOnlineCount();
  });

  socket.on("joinQueue", ({ uid }) => {
    myUID = uid;
    let roomId = Object.keys(rooms).find(
      (r) => !rooms[r].started && rooms[r].players.length < 4
    );
    if (!roomId) {
      roomId = "room_" + Date.now();
      rooms[roomId] = {
        players: [],
        started: false,
        finished: [],
        countdown: null,
      };
    }
    const user = db.users[uid] || getOrCreateUser(uid);
    const playerData = {
      uid,
      socketId: socket.id,
      name: user.name,
      lane: Math.floor(Math.random() * 4),
      z: 10,
      color: user.selectedColor || "red",
      wheel: user.selectedWheel || "blackgrooves",
      score: 0,
      progress: 0,
      finished: false,
    };
    rooms[roomId].players.push(playerData);
    socket.join(roomId);
    socket.myRoom = roomId;
    io.to(roomId).emit("roomUpdate", rooms[roomId]);

    if (rooms[roomId].players.length >= 2 && !rooms[roomId].countdown) {
      rooms[roomId].countdown = setTimeout(() => startRace(roomId), 5000);
      io.to(roomId).emit("countdown", { seconds: 5 });
    }
    if (rooms[roomId].players.length >= 4) {
      clearTimeout(rooms[roomId].countdown);
      rooms[roomId].countdown = setTimeout(() => startRace(roomId), 3000);
      io.to(roomId).emit("countdown", { seconds: 3 });
    }
  });

  socket.on("leaveQueue", ({ uid }) => {
    const roomId = socket.myRoom;
    if (roomId && rooms[roomId]) {
      rooms[roomId].players = rooms[roomId].players.filter(
        (p) => p.uid !== uid
      );
      if (rooms[roomId].players.length === 0) {
        clearTimeout(rooms[roomId].countdown);
        delete rooms[roomId];
      } else {
        io.to(roomId).emit("roomUpdate", rooms[roomId]);
      }
    }
    socket.leave(roomId);
    socket.myRoom = null;
  });

  socket.on("playerMove", ({ lane, z, score }) => {
    const roomId = socket.myRoom;
    if (!roomId || !rooms[roomId]) return;
    const player = rooms[roomId].players.find((p) => p.uid === myUID);
    if (player) {
      player.lane = lane;
      player.z = z;
      player.score = score;
      player.progress = score;
    }
    socket.to(roomId).emit("otherPlayerMove", { uid: myUID, lane, z, score });
  });

  socket.on("playerFinished", ({ uid, score, position }) => {
    const roomId = socket.myRoom;
    if (!roomId || !rooms[roomId]) return;
    const player = rooms[roomId].players.find((p) => p.uid === uid);
    if (player) {
      player.finished = true;
      player.position = position;
      player.score = score;
    }
    if (!rooms[roomId].finished.find((f) => f.uid === uid)) {
      rooms[roomId].finished.push({
        uid,
        score,
        position,
        name: db.users[uid]?.name || uid.slice(0, 6),
      });
    }
    io.to(roomId).emit("raceProgress", rooms[roomId].finished);
    if (rooms[roomId].finished.length === rooms[roomId].players.length) {
      endRace(roomId);
    }
  });

  socket.on("disconnect", () => {
    if (myUID) delete onlineSockets[myUID];
    if (socket.myRoom && rooms[socket.myRoom]) {
      rooms[socket.myRoom].players = rooms[socket.myRoom].players.filter(
        (p) => p.uid !== myUID
      );
      if (rooms[socket.myRoom].players.length === 0) {
        clearTimeout(rooms[socket.myRoom].countdown);
        delete rooms[socket.myRoom];
      } else {
        io.to(socket.myRoom).emit("roomUpdate", rooms[socket.myRoom]);
      }
    }
    broadcastOnlineCount();
  });
});

function startRace(roomId) {
  if (!rooms[roomId]) return;
  rooms[roomId].started = true;
  rooms[roomId].startTime = Date.now();
  io.to(roomId).emit("raceStart", { roomId, players: rooms[roomId].players });
}

function endRace(roomId) {
  if (!rooms[roomId]) return;
  const results = rooms[roomId].finished.sort((a, b) => b.score - a.score);
  io.to(roomId).emit("raceEnd", { results, roomId });
  results.forEach((r, i) => {
    const user = db.users[r.uid];
    if (!user) return;
    user.races = (user.races || 0) + 1;
    if (i === 0) user.totalWins = (user.totalWins || 0) + 1;
    else user.totalLosses = (user.totalLosses || 0) + 1;
    user.totalCoins = (user.totalCoins || 0) + r.score;
  });
  saveDB(db);
  setTimeout(() => {
    delete rooms[roomId];
  }, 30000);
}

function broadcastOnlineCount() {
  io.emit("onlineCount", Object.keys(onlineSockets).length);
}

// ───────────────────── START ─────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`✅ Velocity Rush server running on port ${PORT}`);
  console.log(`👉 Open http://localhost:${PORT} in your browser`);
});
