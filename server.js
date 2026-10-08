const http = require('http');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const PUBLIC_URL = 'https://gmajna-server.onrender.com';
const rooms = new Map();

const httpServer = http.createServer((req, res) => {
  const requestUrl = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (requestUrl.pathname === '/join') {
    const room = requestUrl.searchParams.get('room') || '';
    if (!/^[\w-]{1,100}$/.test(room)) {
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('Neveljavna povabilna povezava.');
      return;
    }
    const appUrl = `gmajna://join?server=${encodeURIComponent(PUBLIC_URL)}&room=${encodeURIComponent(room)}`;
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(`<!doctype html>
<html lang="sl">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pridruži se Gmajna Jamu</title>
<style>
  body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0d0d12;color:#fff;font:16px Arial,sans-serif}
  main{box-sizing:border-box;width:min(420px,calc(100% - 32px));padding:28px;border:1px solid #30303a;border-radius:18px;background:#16161d;text-align:center}
  h1{font-size:22px}p{color:#bdbdc7;line-height:1.5}
  a{display:block;margin:18px 0;padding:13px;border-radius:10px;background:#ff3d71;color:#fff;text-decoration:none;font-weight:700}
  small{color:#999}
</style>
<main><h1>Gmajna Music Jam</h1><p>Gostitelj te vabi k skupnemu poslušanju. Za pridružitev odpri povabilo v aplikaciji Gmajna Music.</p>
<a href="${appUrl}">Odpri Gmajna Music</a><small>Če se aplikacija ne odpre, jo najprej zaženi in klikni povezavo znova.</small></main>
</html>`);
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Gmajna Music Jam server is running');
});

const io = new Server(httpServer, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 20000,
});

function sendRoomState(room) {
  const state = rooms.get(room);
  if (!state) return;
  const payload = {
    hostId: state.hostId,
    controlAllowed: state.controlAllowed,
    members: [...state.members.values()].map(({ peerId, name }) => ({ peerId, name })),
  };
  for (const member of state.members.values()) {
    io.to(member.socketId).emit('jam:state', payload);
  }
}

function closeRoom(room, state) {
  io.to(room).emit('jam:ended');
  for (const member of state.members.values()) {
    const socket = io.sockets.sockets.get(member.socketId);
    if (socket) {
      socket.leave(room);
      socket.data.jamRoom = '';
      socket.data.peerId = '';
    }
  }
  rooms.delete(room);
}

io.on('connection', (socket) => {
  socket.on('join', (room) => {
    if (typeof room !== 'string' || !/^[\w-]{1,100}$/.test(room)) {
      socket.emit('jam:error', 'Neveljavna koda sobe.');
      return;
    }
    socket.data.jamRoom = room;
    socket.join(room);
  });

  socket.on('jam:register', (data = {}) => {
    const room = socket.data.jamRoom;
    const { peerId, name, wantsHost } = data;
    if (!room || typeof peerId !== 'string' || !/^[\w-]{1,100}$/.test(peerId)) {
      socket.emit('jam:error', 'Neveljavna soba ali ID poslušalca.');
      return;
    }

    let state = rooms.get(room);
    if (!state && wantsHost === true && typeof data.hostToken === 'string'
        && /^[\w-]{20,100}$/.test(data.hostToken)) {
      state = {
        hostId: '',
        hostToken: data.hostToken,
        controlAllowed: false,
        members: new Map(),
        latestPresence: null,
      };
      rooms.set(room, state);
    }
    if (!state) {
      socket.emit('jam:error', 'Gostitelj še ni ustvaril tega jama.');
      return;
    }

    if (wantsHost === true) {
      if (data.hostToken !== state.hostToken) {
        socket.emit('jam:error', 'Ta jam že ima drugega gostitelja.');
        return;
      }
      state.hostId = peerId;
      state.controlAllowed = false;
    } else if (!state.hostId) {
      socket.emit('jam:error', 'Gostitelj še ni ustvaril tega jama.');
      return;
    }

    const previous = state.members.get(peerId);
    if (previous && previous.socketId !== socket.id) {
      io.sockets.sockets.get(previous.socketId)?.disconnect(true);
    }
    socket.data.peerId = peerId;
    state.members.set(peerId, {
      peerId,
      name: typeof name === 'string' ? name.slice(0, 40) : 'Poslušalec',
      socketId: socket.id,
    });

    sendRoomState(room);
    if (state.latestPresence) socket.emit('sync', state.latestPresence);
  });

  socket.on('jam:control', (data = {}) => {
    const room = socket.data.jamRoom;
    const state = room && rooms.get(room);
    if (!state || socket.data.peerId !== state.hostId) return;
    state.controlAllowed = data.enabled === true;
    sendRoomState(room);
  });

  socket.on('jam:close', () => {
    const room = socket.data.jamRoom;
    const state = room && rooms.get(room);
    if (!state || socket.data.peerId !== state.hostId) return;
    closeRoom(room, state);
  });

  socket.on('sync', (data) => {
    const room = socket.data.jamRoom;
    const state = room && rooms.get(room);
    const member = state && state.members.get(socket.data.peerId);
    if (!state || !member || !data || typeof data !== 'object') return;

    const isHost = member.peerId === state.hostId;
    if (data.a === 'close' && isHost) {
      closeRoom(room, state);
      return;
    }
    if (data.a === 'presence' && !isHost) {
      const packet = {
        ...data,
        peerId: member.peerId,
        hostId: state.hostId,
        isHost: false,
        controlAllowed: state.controlAllowed,
      };
      socket.to(room).emit('sync', packet);
      return;
    }
    if (!isHost && !state.controlAllowed) return;

    const packet = {
      ...data,
      peerId: member.peerId,
      hostId: state.hostId,
      isHost,
      controlAllowed: state.controlAllowed,
    };
    if (data.a === 'presence') state.latestPresence = packet;
    socket.to(room).emit('sync', packet);
  });

  socket.on('disconnect', () => {
    const room = socket.data.jamRoom;
    const state = room && rooms.get(room);
    const member = state && state.members.get(socket.data.peerId);
    if (!member || member.socketId !== socket.id) return;
    state.members.delete(socket.data.peerId);
    sendRoomState(room);
  });
});

httpServer.listen(PORT, () => console.log(`Gmajna Music Jam server is listening on ${PORT}`));
