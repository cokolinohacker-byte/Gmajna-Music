const { ipcRenderer, webFrame } = require('electron');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');

const VERSION = 'v13';

// ====== NASTAVITVE VIDEZA (spreminjaj po želji) ======
const THEME = {
  accent: '#f5a900',
  bg: '#0d0d12',
  panel: '#16161d',
};
// =====================================================

const DEFAULT_SERVER = 'https://gmajna-server.onrender.com';
let logoDataUrl = '';
try {
  logoDataUrl = `data:image/png;base64,${fs.readFileSync(path.join(__dirname, 'assets', 'gmajna-logo.png')).toString('base64')}`;
} catch (error) {
  console.error('Logotipa Gmajna Music ni mogoče naložiti:', error);
}

const store = {
  get: (k, d) => { try { return localStorage.getItem('gm_' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('gm_' + k, v); } catch {} },
};

let socket = null;
let remote = false;
let statusDot = null;
let adUntil = 0;
let lastId = null;
let cachedId = null;
let jamHost = false;
let controlAllowed = false;
let hostId = '';
let hostToken = store.get('hostToken', '');
let peerId = store.get('peerId', '');
const peers = new Map();
let presenceTimer = null;
let peerList = null;
let jamStatus = null;
let controlButton = null;
let roomInfo = null;
let hostIdDisplay = null;
let fullscreenUiNodes = [];
let fullscreenMount = null;
let activeRoom = '';
let inviteUrl = '';
let serverInput = null;
let roomInput = null;
let queuedInvite = null;
let nowPlayingArt = null;
let nowPlayingTitle = null;
let nowPlayingArtist = null;
let currentTrackInfo = { id: '', title: '', artist: '', art: '' };
let lastArtwork = '';
let requestedTrackId = '';
let requestedTrackAt = 0;
let progressObserver = null;
let progressPageObserver = null;

const TRACK_SYNC_TOLERANCE = 0.75;
const PLAYER_POLL_MS = 500;
const PRESENCE_INTERVAL_MS = 1000;
let playerPollPending = false;

const urlId = () => new URLSearchParams(location.search).get('v');
const currentId = () => cachedId || urlId();
const getVideo = () => document.querySelector('video');
const validId = (id) => typeof id === 'string' && /^[\w-]{11}$/.test(id);

// ID pesmi preberemo iz predvajalnika (deluje tudi, ko URL ne kaže pesmi)
async function readPlayerId() {
  try {
    const id = await webFrame.executeJavaScript(`(function () {
      try {
        var p = document.getElementById('movie_player');
        return (p && p.getVideoData) ? p.getVideoData().video_id : null;
      } catch (e) { return null; }
    })()`);
    return validId(id) ? id : null;
  } catch { return null; }
}

async function readPlayerInfo() {
  try {
    const info = await webFrame.executeJavaScript(`(function () {
      try {
        var p = document.getElementById('movie_player');
        if (!p || !p.getVideoData) return null;
        var d = p.getVideoData();
        if (!d || !d.video_id) return null;
        return {
          id: d.video_id,
          title: d.title || '',
          artist: d.author || '',
          art: d.thumbnail_url || ''
        };
      } catch (e) { return null; }
    })()`);
    return info && validId(info.id) ? info : null;
  } catch (error) {
    console.warn('Podatkov o trenutni skladbi ni mogoče prebrati:', error);
    return null;
  }
}

function applyTrackInfo(info) {
  if (!info || !validId(info.id)) return;
  currentTrackInfo = {
    id: info.id,
    title: typeof info.title === 'string' && info.title.trim() ? info.title.trim() : 'Neznan naslov',
    artist: typeof info.artist === 'string' && info.artist.trim() ? info.artist.trim() : 'YouTube Music',
    art: typeof info.art === 'string' && /^https:\/\/[^/]*ytimg\.com\//i.test(info.art)
      ? info.art
      : `https://i.ytimg.com/vi/${info.id}/hqdefault.jpg`,
  };
  if (nowPlayingTitle) nowPlayingTitle.textContent = currentTrackInfo.title;
  if (nowPlayingArtist) nowPlayingArtist.textContent = currentTrackInfo.artist;
  if (nowPlayingArt && lastArtwork !== currentTrackInfo.art) {
    lastArtwork = currentTrackInfo.art;
    nowPlayingArt.alt = `Naslovnica: ${currentTrackInfo.title}`;
    nowPlayingArt.src = currentTrackInfo.art;
  }
}

function applyAlbumColor(image) {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 12;
    canvas.height = 12;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Canvas 2D ni na voljo.');
    context.drawImage(image, 0, 0, 12, 12);
    const pixels = context.getImageData(0, 0, 12, 12).data;
    let red = 0;
    let green = 0;
    let blue = 0;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) {
      if (pixels[index + 3] < 128) continue;
      red += pixels[index];
      green += pixels[index + 1];
      blue += pixels[index + 2];
      count += 1;
    }
    if (!count) return;
    const color = [red, green, blue]
      .map((channel) => Math.round(channel / count).toString(16).padStart(2, '0'))
      .join('');
    document.documentElement.style.setProperty('--gm-album-color', `#${color}`);
  } catch (error) {
    console.warn('Barve naslovnice ni mogoče določiti; uporabljam privzeto barvo.', error);
  }
}

function setStatus(on) {
  if (!statusDot) return;
  statusDot.style.background = on ? '#3ddc84' : '#888';
  statusDot.setAttribute('aria-label', on ? 'Povezano' : 'Povezava ni aktivna');
  statusDot.title = on ? 'Povezano' : 'Povezava ni aktivna';
  if (jamStatus) jamStatus.textContent = on
    ? `Povezano kot ${jamHost ? 'gostitelj' : 'poslušalec'}`
    : 'Ni povezano';
}

function ensurePeerId() {
  if (!peerId) {
    peerId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2) + Date.now().toString(36);
    store.set('peerId', peerId);
  }
  return peerId;
}

function renderPeers() {
  if (!peerList) return;
  const now = Date.now();
  if (jamHost && peerId) {
    peers.set(peerId, { name: 'Gostitelj', isHost: true, seenAt: now });
  }
  for (const [id, peer] of peers) {
    if (now - peer.seenAt > 7000) peers.delete(id);
  }
  peerList.replaceChildren();
  if (!peers.size) {
    peerList.append(el('div', { className: 'gm-empty-peer', textContent: 'Čakamo na poslušalce …' }));
    return;
  }
  for (const peer of peers.values()) {
    const item = el('div', { className: 'gm-peer' });
    const avatar = el('span', { className: 'gm-peer-avatar', textContent: peer.isHost ? '♫' : '•' });
    const name = el('span', { className: 'gm-peer-name', textContent: peer.name || 'Poslušalec' });
    const role = el('span', { className: 'gm-peer-role', textContent: peer.isHost ? 'Gostitelj' : '' });
    item.append(avatar, name, role);
    peerList.append(item);
  }
}

function emitPresence() {
  if (!socket || !socket.connected) return;
  const video = getVideo();
  const id = currentId();
  socket.emit('sync', {
    a: 'presence',
    peerId: ensurePeerId(),
    name: store.get('peerName', jamHost ? 'Gostitelj' : 'Poslušalec'),
    isHost: jamHost,
    hostId,
    controlAllowed,
    id: validId(id) ? id : undefined,
    t: video ? video.currentTime : undefined,
    playing: video ? !video.paused : false,
    title: currentTrackInfo.id === id ? currentTrackInfo.title : '',
    artist: currentTrackInfo.id === id ? currentTrackInfo.artist : '',
    art: currentTrackInfo.id === id ? currentTrackInfo.art : '',
  });
}

function makeId() {
  return typeof crypto.randomUUID === 'function'
    ? crypto.randomUUID()
    : Math.random().toString(36).slice(2) + Date.now().toString(36);
}

function makeBrandMark(className = 'gm-mark') {
  const mark = el('span', { className, 'aria-hidden': 'true' });
  if (logoDataUrl) {
    mark.append(el('img', { src: logoDataUrl, alt: '' }));
  } else {
    mark.textContent = '♫';
  }
  return mark;
}

function connectFromInvite(invite) {
  if (!invite || typeof invite.room !== 'string' || !/^[\w-]{1,100}$/.test(invite.room)) return;
  const server = typeof invite.server === 'string' ? invite.server : DEFAULT_SERVER;
  if (!/^https?:\/\//i.test(server)) return;
  const room = invite.room;
  leaveJam(false);
  jamHost = false;
  controlAllowed = false;
  hostToken = '';
  hostId = '';
  store.set('jamHost', '0');
  store.set('jamHostRoom', '');
  store.set('hostToken', '');
  store.set('server', server);
  store.set('room', room);
  store.set('active', '1');
  if (roomInput) roomInput.value = room;
  if (serverInput) serverInput.value = server;
  inviteUrl = '';
  connect(server, room);
}

ipcRenderer.on('jam-invite', (_event, invite) => {
  if (!peerList) queuedInvite = invite;
  else connectFromInvite(invite);
});

function authorizedPeer(data) {
  return Boolean(data && typeof data.peerId === 'string'
    && (data.peerId === hostId || (controlAllowed && peers.has(data.peerId))));
}

function toast(text) {
  const t = document.createElement('div');
  t.textContent = text;
  t.style.cssText = `position:fixed;left:50%;bottom:110px;transform:translateX(-50%);z-index:99999;
    padding:8px 16px;border-radius:16px;background:${THEME.panel};color:#fff;font:13px Roboto,sans-serif;
    border:1px solid #333;box-shadow:0 4px 14px rgba(0,0,0,.5)`;
  (fullscreenMount || document.body).appendChild(t);
  setTimeout(() => t.remove(), 2500);
}

function moveUiToFullscreen() {
  const target = document.fullscreenElement
    || document.querySelector('#movie_player.ytp-fullscreen, .html5-video-player.ytp-fullscreen')
    || document.body;
  if (target === fullscreenMount && fullscreenUiNodes.every((node) => node.parentElement === target)) return;
  fullscreenMount = target;
  for (const node of fullscreenUiNodes) target.appendChild(node);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Kopirano');
  } catch (error) {
    console.error('Kopiranje ni uspelo:', error);
    toast('Kopiranje ni uspelo');
  }
}

// vrne true, če je sporočilo res poslano
function send(data) {
  if (Date.now() < adUntil) return false;
  if (!socket || !socket.connected || remote) return false;
  if (data.a === 'track' && !jamHost && !controlAllowed) return false;
  socket.emit('sync', {
    ...data,
    peerId: ensurePeerId(),
    hostId,
    isHost: jamHost,
  });
  return true;
}

function goToTrack(id) {
  if (!validId(id)) return;
  if (currentId() === id) return;
  cachedId = id;
  lastId = id;
  requestedTrackId = id;
  requestedTrackAt = Date.now();
  store.set('quiet', String(Date.now() + 3500));
  toast('🎵 Menjam pesem …');
  const watchUrl = `https://music.youtube.com/watch?v=${encodeURIComponent(id)}`;
  webFrame.executeJavaScript(`(function () {
    var link = document.createElement('a');
    link.href = '/watch?v=' + ${JSON.stringify(id)};
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    link.remove();
    return true;
  })()`).then((started) => {
    if (!started) throw new Error('YouTube Music navigacija ni uspela.');
    setTimeout(async () => {
      const info = await readPlayerInfo();
      if (info && info.id === id) {
        requestedTrackId = '';
        return;
      }
      const playerStarted = await webFrame.executeJavaScript(`(function () {
        var player = document.getElementById('movie_player');
        if (!player || typeof player.loadVideoById !== 'function') return false;
        player.loadVideoById(${JSON.stringify(id)});
        return true;
      })()`);
      if (!playerStarted) {
        location.href = watchUrl;
        return;
      }
      setTimeout(async () => {
        const playingId = await readPlayerId();
        if (playingId !== id) location.href = watchUrl;
        else requestedTrackId = '';
      }, 2000);
    }, 1200);
  }).catch((error) => {
    console.warn('Neposreden preklop pesmi ni uspel:', error);
    location.href = watchUrl;
  });
}

function connect(server, room) {
  if (socket) socket.disconnect();
  if (presenceTimer) clearInterval(presenceTimer);
  activeRoom = room;
  hostId = jamHost ? ensurePeerId() : '';
  peers.clear();
  if (jamHost) {
    peers.set(peerId, { name: 'Gostitelj', isHost: true, seenAt: Date.now() });
  }
  if (peerList) renderPeers();
  socket = io(server, { reconnection: true });
  socket.on('connect', () => {
    socket.emit('join', room);
    socket.emit('jam:register', {
      peerId: ensurePeerId(),
      name: store.get('peerName', jamHost ? 'Gostitelj' : 'Poslušalec'),
      wantsHost: jamHost,
      hostToken: jamHost ? hostToken : undefined,
    });
    if (jamHost) socket.emit('jam:control', { enabled: controlAllowed });
    setStatus(true);
  });
  socket.on('disconnect', () => setStatus(false));
  socket.on('connect_error', (error) => {
    setStatus(false);
    console.error('Povezava z jamom ni uspela:', error);
    if (roomInfo) roomInfo.textContent = 'Povezava s strežnikom ni uspela. Poskušam znova …';
  });

  socket.on('sync', (d) => {
    if (!d || d.peerId === peerId) return;
    if (d.a === 'close' && (d.peerId === hostId || d.isHost === true)) {
      leaveJam(false);
      toast('Gostitelj je zaključil jam');
      return;
    }
    if (d.a === 'presence') {
      if (d.isHost === true && typeof d.peerId === 'string') {
        if (hostId && hostId !== d.peerId) return;
        hostId = d.peerId;
        controlAllowed = d.controlAllowed === true;
        store.set('hostId', hostId);
        if (hostIdDisplay) hostIdDisplay.textContent = `Host ID: ${hostId}`;
        if (controlButton) {
          controlButton.style.display = jamHost ? 'block' : 'none';
          controlButton.textContent = `Upravljanje za poslušalce: ${controlAllowed ? 'vklopljeno' : 'izklopljeno'}`;
        }
      }
      peers.set(d.peerId, {
        name: typeof d.name === 'string' ? d.name : 'Poslušalec',
        isHost: d.isHost === true || d.peerId === hostId,
        seenAt: Date.now(),
      });
      renderPeers();
      applyTrackInfo(d);
      if ((d.peerId === hostId || d.isHost === true) && validId(d.id) && d.id !== currentId()) {
        goToTrack(d.id);
        return;
      }
      if ((d.peerId === hostId || d.isHost === true) && !jamHost) applyPlaybackState(d);
      return;
    }
    if (!authorizedPeer(d)) return;
    applyTrackInfo(d);
    if (validId(d.id) && d.id !== currentId()) {
      goToTrack(d.id);
      return;
    }
    if (d.a === 'track') return;
    applyPlaybackState(d);
  });
  socket.on('jam:state', (state) => {
    if (!state || !Array.isArray(state.members)) return;
    hostId = typeof state.hostId === 'string' ? state.hostId : '';
    controlAllowed = state.controlAllowed === true;
    store.set('hostId', hostId);
    if (hostIdDisplay) hostIdDisplay.textContent = hostId ? `Host ID: ${hostId}` : 'Host ID: ni na voljo';
    if (controlButton) {
      controlButton.style.display = jamHost ? 'block' : 'none';
      controlButton.textContent = `Upravljanje za poslušalce: ${controlAllowed ? 'vklopljeno' : 'izklopljeno'}`;
    }
    peers.clear();
    for (const member of state.members) {
      if (!member || typeof member.peerId !== 'string') continue;
      peers.set(member.peerId, {
        name: member.name || 'Poslušalec',
        isHost: member.peerId === hostId,
        seenAt: Date.now(),
      });
    }
    renderPeers();
    setStatus(true);
    if (roomInfo && jamHost && inviteUrl) roomInfo.textContent = `Jam je aktiven.\nPovabilna povezava:\n${inviteUrl}`;
    if (jamHost) emitPresence();
  });
  socket.on('jam:ended', () => {
    leaveJam(false);
    if (roomInfo) roomInfo.textContent = 'Gostitelj je zaključil jam.';
    toast('Gostitelj je zaključil jam');
  });
  socket.on('jam:error', (message) => {
    if (roomInfo) roomInfo.textContent = String(message || 'V jamo se ni bilo mogoče povezati.');
    setStatus(false);
  });
  presenceTimer = setInterval(() => {
    if (socket && socket.connected) emitPresence();
    renderPeers();
  }, PRESENCE_INTERVAL_MS);
}

function applyPlaybackState(data) {
  const video = getVideo();
  if (!video) return;
  remote = true;
  if (video.readyState > 0 && typeof data.t === 'number'
      && Math.abs(video.currentTime - data.t) > TRACK_SYNC_TOLERANCE) {
    video.currentTime = data.t;
  }
  if (data.a === 'play' || data.playing === true) video.play().catch((error) => {
    console.warn('Predvajanja ni mogoče sinhronizirati:', error);
  });
  if (data.a === 'pause' || data.playing === false) video.pause();
  setTimeout(() => { remote = false; }, 500);
}

function leaveJam(notifyHost = false) {
  const oldSocket = socket;
  const closingJam = notifyHost && jamHost && oldSocket && oldSocket.connected;
  if (closingJam) {
    oldSocket.emit('jam:close');
    oldSocket.emit('sync', {
      a: 'close',
      peerId: ensurePeerId(),
      hostId,
      isHost: true,
    });
  }
  store.set('active', '0');
  store.set('jamHost', '0');
  store.set('jamHostRoom', '');
  store.set('hostToken', '');
  store.set('hostId', '');
  jamHost = false;
  hostToken = '';
  hostId = '';
  controlAllowed = false;
  inviteUrl = '';
  peers.clear();
  renderPeers();
  if (controlButton) controlButton.style.display = 'none';
  if (hostIdDisplay) hostIdDisplay.textContent = 'Jam: ni povezan';
  const inviteButton = document.querySelector('.gm-invite-button');
  if (inviteButton) inviteButton.style.display = 'none';
  if (presenceTimer) {
    clearInterval(presenceTimer);
    presenceTimer = null;
  }
  if (socket) {
    socket = null;
    if (closingJam) setTimeout(() => oldSocket.disconnect(), 150);
    else oldSocket.disconnect();
  }
  setStatus(false);
  if (roomInfo) roomInfo.textContent = '';
}

function el(tag, props = {}, css = '') {
  const e = document.createElement(tag);
  Object.assign(e, props);
  if (css) e.style.cssText = css;
  return e;
}

function buildUI() {
  const btn = el('button', { className: 'gm-jam-trigger', 'aria-label': 'Odpri Gmajna Jam' });
  const triggerMark = makeBrandMark();
  const triggerLabel = el('span', { textContent: 'Jam' });
  statusDot = el('span', { className: 'gm-status-dot', 'aria-label': 'Povezava ni aktivna' });
  btn.append(triggerMark, triggerLabel, statusDot);

  const panel = el('div', { className: 'gm-jam-panel' });
  const header = el('div', { className: 'gm-panel-header' });
  const panelMark = makeBrandMark('gm-mark gm-panel-mark');
  const titleWrap = el('div');
  const title = el('div', { className: 'gm-panel-title', textContent: 'Gmajna Music [Beta]' });
  jamStatus = el('div', { className: 'gm-panel-subtitle', textContent: 'Ni povezano' });
  titleWrap.append(title, jamStatus);
  const close = el('button', { className: 'gm-close-button', textContent: '×', 'aria-label': 'Zapri jam' });
  header.append(panelMark, titleWrap, close);
  close.onclick = () => {
    panel.style.display = 'none';
  };

  const connection = el('div', { className: 'gm-connection' });
  hostIdDisplay = el('div', { className: 'gm-host-id', textContent: 'Jam: ni povezan' });
  const nowPlaying = el('div', { className: 'gm-now-playing' });
  nowPlayingArt = el('img', {
    className: 'gm-now-playing-art',
    alt: 'Naslovnica trenutne skladbe',
  });
  nowPlayingArt.crossOrigin = 'anonymous';
  const nowPlayingCopy = el('div', { className: 'gm-now-playing-copy' });
  nowPlayingCopy.append(
    el('div', { className: 'gm-now-playing-label', textContent: 'Zdaj se predvaja' }),
    nowPlayingTitle = el('div', { className: 'gm-now-playing-title', textContent: 'Nič se ne predvaja' }),
    nowPlayingArtist = el('div', { className: 'gm-now-playing-artist', textContent: 'Predvajaj skladbo v YouTube Music' })
  );
  nowPlaying.append(nowPlayingArt, nowPlayingCopy);
  nowPlayingArt.addEventListener('load', () => applyAlbumColor(nowPlayingArt));
  nowPlayingArt.addEventListener('error', () => {
    console.warn('Naslovnice trenutne skladbe ni mogoče naložiti.');
    nowPlayingArt.removeAttribute('src');
  });
  const copyHost = el('button', {
    className: 'gm-action-button gm-invite-button',
    textContent: '⎘  Kopiraj kratko povezavo',
  });
  copyHost.style.display = 'none';
  copyHost.onclick = async () => {
    if (!inviteUrl) {
      toast('Povabilno povezavo lahko ustvari gostitelj');
      return;
    }
    await copyText(inviteUrl);
  };
  const copyCode = el('button', {
    className: 'gm-action-button gm-invite-button',
    textContent: 'Kopiraj kodo Jama',
  });
  copyCode.style.display = 'none';
  copyCode.onclick = async () => {
    if (!activeRoom) {
      toast('Koda Jama ni na voljo');
      return;
    }
    await copyText(activeRoom);
  };
  connection.append(hostIdDisplay);

  const sectionTitle = el('div', { className: 'gm-section-title', textContent: 'Povezani poslušalci' });
  peerList = el('div', { className: 'gm-peer-list' });
  renderPeers();

  controlButton = el('button', {
    className: 'gm-action-button',
    textContent: 'Upravljanje za poslušalce: vklopljeno',
  });
  controlButton.style.display = 'none';
  controlButton.onclick = () => {
    if (!jamHost) {
      toast('To lahko spremeni samo gostitelj');
      return;
    }
    controlAllowed = !controlAllowed;
    store.set('controlAllowed', controlAllowed ? '1' : '0');
    controlButton.textContent = `Upravljanje za poslušalce: ${controlAllowed ? 'vklopljeno' : 'izklopljeno'}`;
    if (socket && socket.connected) socket.emit('jam:control', { enabled: controlAllowed });
    emitPresence();
  };

  const settings = el('div', { className: 'gm-connect-form' });
  serverInput = el('input', { type: 'hidden', value: DEFAULT_SERVER });
  const l2 = el('label', { className: 'gm-field-label', textContent: 'Povabilna povezava' });
  roomInput = el('input', {
    className: 'gm-field',
    value: '',
    placeholder: 'Prilepi povezavo od gostitelja',
  });

  const join = el('button', { className: 'gm-primary-button', textContent: 'Pridruži se kot poslušalec' });

  join.onclick = () => {
    let server = serverInput.value.trim();
    let room = roomInput.value.trim();
    if (room.startsWith('gmajna://') || room.startsWith('https://')) {
      try {
        const invite = new URL(room);
        if (invite.protocol === 'gmajna:') {
          server = invite.searchParams.get('server') || DEFAULT_SERVER;
        } else if (invite.origin !== DEFAULT_SERVER
            || (invite.pathname !== '/join' && !/^\/j\/[\w-]{1,100}$/.test(invite.pathname))) {
          throw new Error('Neznan naslov povabila');
        }
        room = invite.pathname.startsWith('/j/')
          ? invite.pathname.slice(3)
          : invite.searchParams.get('room') || '';
      } catch (error) {
        console.error('Povabilne povezave ni mogoče prebrati:', error);
        toast('Povabilna povezava ni veljavna');
        return;
      }
    }
    if (!/^https?:\/\//i.test(server) || !/^[\w-]{1,100}$/.test(room)) {
      toast('Prilepi veljavno povabilno povezavo');
      return;
    }
    leaveJam(false);
    jamHost = false;
    controlAllowed = false;
    hostToken = '';
    hostId = '';
    controlButton.style.display = 'none';
    copyHost.style.display = 'none';
    copyCode.style.display = 'none';
    store.set('jamHost', '0');
    store.set('jamHostRoom', '');
    store.set('hostToken', '');
    store.set('hostId', '');
    store.set('server', server);
    store.set('room', room);
    store.set('active', '1');
    serverInput.value = server;
    roomInput.value = '';
    roomInfo.textContent = 'Povezovanje z Jamom …';
    connect(server, room);
  };
  btn.onclick = () => {
    panel.style.display = getComputedStyle(panel).display === 'none' ? 'block' : 'none';
  };

  const host = el('button', { className: 'gm-primary-button', textContent: 'Ustvari Jam' });
  roomInfo = el('div', { className: 'gm-room-info' });

  host.onclick = async () => {
    try {
      leaveJam(false);
      const code = makeId();
      hostToken = makeId();
      inviteUrl = `${DEFAULT_SERVER}/j/${encodeURIComponent(code)}`;
      const jamServerAddress = DEFAULT_SERVER;
      serverInput.value = jamServerAddress;
      roomInput.value = '';
      jamHost = true;
      controlAllowed = true;
      store.set('controlAllowed', '1');
      hostId = '';
      hostIdDisplay.textContent = `Jam ID: ${code}`;
      controlButton.style.display = 'block';
      copyHost.style.display = 'block';
      copyCode.style.display = 'block';
      store.set('jamHost', '1');
      store.set('hostToken', hostToken);
      store.set('jamHostRoom', code);
      store.set('server', jamServerAddress);
      store.set('room', code);
      store.set('active', '1');
      connect(jamServerAddress, code);
      roomInfo.textContent = `Jam se ustvarja …`;
    } catch (error) {
      console.error('Jam ni bilo mogoče ustvariti:', error);
      roomInfo.textContent = 'Jama ni bilo mogoče ustvariti. Preveri povezavo z internetom.';
    }
  };

  const closeJam = el('button', { className: 'gm-close-jam-button', textContent: 'Zapri Music Together' });
  closeJam.onclick = () => {
    leaveJam(jamHost);
    roomInfo.textContent = 'Jam je zaprt.';
  };

  settings.append(l2, roomInput, join, host);
  panel.append(
    header,
    connection,
    nowPlaying,
    sectionTitle,
    peerList,
    copyHost,
    copyCode,
    controlButton,
    settings,
    closeJam,
    roomInfo
  );
  panel.style.display = 'none';
  document.body.append(panel, btn);
  fullscreenUiNodes = [panel, btn, document.querySelector('.gm-brand')].filter(Boolean);
  document.addEventListener('fullscreenchange', moveUiToFullscreen);
  document.addEventListener('webkitfullscreenchange', moveUiToFullscreen);
  const fullscreenWatcher = setInterval(moveUiToFullscreen, 500);
  window.addEventListener('beforeunload', () => clearInterval(fullscreenWatcher), { once: true });
  moveUiToFullscreen();

  if (store.get('active', '0') === '1' && store.get('room', '')) {
    jamHost = store.get('jamHost', '0') === '1'
      && store.get('jamHostRoom', '') === store.get('room', '');
    hostToken = jamHost ? store.get('hostToken', '') : '';
    controlAllowed = jamHost && store.get('controlAllowed', '1') === '1';
    hostId = '';
    inviteUrl = jamHost
      ? `${DEFAULT_SERVER}/j/${encodeURIComponent(store.get('room', ''))}`
      : '';
    controlButton.style.display = jamHost ? 'block' : 'none';
    copyHost.style.display = jamHost ? 'block' : 'none';
    copyCode.style.display = jamHost ? 'block' : 'none';
    hostIdDisplay.textContent = jamHost ? `Jam ID: ${store.get('room', '')}` : 'Jam: čakanje na gostitelja';
    if (jamHost) roomInfo.textContent = `Povabilna povezava:\n${inviteUrl}`;
    const server = store.get('server', DEFAULT_SERVER);
    const room = store.get('room', '');
    if (jamHost && !hostToken) {
      roomInfo.textContent = 'Gostiteljski ključ manjka. Ustvari nov Jam.';
      leaveJam(false);
      return;
    }
    connect(server.includes('localhost:3000') ? DEFAULT_SERVER : server, room);
  }

  ipcRenderer.invoke('consume-jam-invite').then((invite) => {
    const queued = invite || queuedInvite;
    queuedInvite = null;
    if (queued) connectFromInvite(queued);
  }).catch((error) => console.error('Povabila ni mogoče odpreti:', error));
}

// zazna menjavo pesmi (preskok, izbira, konec pesmi) in jo pošlje
function checkTrack() {
  const id = currentId();
  if (!validId(id)) return;
  if (lastId === null) { lastId = id; return; }
  if (id !== lastId) {
    lastId = id;
    cachedId = id;
    send({
      a: 'track',
      id,
      title: currentTrackInfo.title,
      artist: currentTrackInfo.artist,
      art: currentTrackInfo.art,
    });
  }
}

async function pollPlayerId() {
  if (playerPollPending) return;
  playerPollPending = true;
  try {
    const info = await readPlayerInfo();
    const id = info ? info.id : await readPlayerId();
    if (requestedTrackId) {
      if (id === requestedTrackId) {
        requestedTrackId = '';
      } else if (Date.now() - requestedTrackAt < 8000) {
        return;
      } else {
        requestedTrackId = '';
        lastId = id;
        cachedId = id;
        if (info) applyTrackInfo(info);
        return;
      }
    }
    if (id) cachedId = id;
    if (info) applyTrackInfo(info);
    checkTrack();
  } finally {
    playerPollPending = false;
  }
}

function hookVideo() {
  const hookedVideos = new WeakSet();
  const attachVideoEvents = () => {
    const v = getVideo();
    if (!v || hookedVideos.has(v)) return;
    hookedVideos.add(v);

    const msg = (a) => ({
      a,
      t: v.currentTime,
      id: currentId(),
      title: currentTrackInfo.title,
      artist: currentTrackInfo.artist,
      art: currentTrackInfo.art,
    });

    v.addEventListener('play',   () => { pollPlayerId(); setTimeout(() => send(msg('play')), 150); });
    v.addEventListener('pause',  () => send(msg('pause')));
    v.addEventListener('seeked', () => send(msg('seek')));
    v.addEventListener('loadedmetadata', pollPlayerId);
  };
  setInterval(attachVideoEvents, PLAYER_POLL_MS);
  setInterval(pollPlayerId, PLAYER_POLL_MS);
}

function installProgressStyles() {
  const observedRoots = new WeakSet();
  let scanPlayerBars = () => {};
  progressObserver = new MutationObserver(() => window.requestAnimationFrame(scanPlayerBars));
  progressPageObserver = new MutationObserver(() => window.requestAnimationFrame(scanPlayerBars));
  const progressCss = `
    #progress-bar, tp-yt-paper-progress {
      --paper-progress-active-color: #ff1744 !important;
      --paper-progress-container-color: rgba(255,255,255,.14) !important;
      --paper-progress-height: 2px !important;
      --paper-slider-active-color: #ff1744 !important;
      --paper-slider-knob-color: #ff1744 !important;
      --paper-slider-knob-start-color: #ff1744 !important;
      filter: drop-shadow(0 0 3px rgba(255,23,68,.6));
      transition: filter 250ms ease;
    }
    #activeProgress, #sliderKnob {
      transition: width 1s linear, transform 1s linear, left 1s linear;
      will-change: width, transform, left;
    }
    #progress-bar:active #activeProgress,
    #progress-bar:active #sliderKnob { transition: none; }
    #progress-bar::after {
      content: ''; position: absolute; inset: 0; z-index: 1; pointer-events: none;
      background: linear-gradient(105deg, transparent 30%, rgba(255,255,255,.5) 50%, transparent 70%);
      background-size: 220% 100%; opacity: .34;
      animation: gm-progress-wave 3.2s linear infinite;
    }
    @keyframes gm-progress-wave {
      from { background-position: 110% 0; }
      to { background-position: -110% 0; }
    }
  `;
  const observeRoot = (root) => {
    if (!observedRoots.has(root)) {
      observedRoots.add(root);
      const style = document.createElement('style');
      style.textContent = progressCss;
      root.appendChild(style);
      progressObserver.observe(root, { childList: true, subtree: true });
    }
    for (const node of root.querySelectorAll('*')) {
      if (node.shadowRoot) observeRoot(node.shadowRoot);
    }
  };
  scanPlayerBars = () => {
    for (const playerBar of document.querySelectorAll('ytmusic-player-bar')) {
      if (playerBar.shadowRoot) observeRoot(playerBar.shadowRoot);
    }
  };
  progressPageObserver.observe(document.documentElement, { childList: true, subtree: true });
  scanPlayerBars();
}

function applyTheme() {
  const style = el('style');
  style.textContent = `
    html, body { --ytmusic-color-white-pure: #fff; background: ${THEME.bg}; }
    ytmusic-app {
      background:
        radial-gradient(ellipse at 82% 12%,
          color-mix(in srgb, var(--gm-album-color, ${THEME.accent}) 34%, transparent), transparent 48%),
        radial-gradient(ellipse at 10% 88%,
          color-mix(in srgb,
            color-mix(in srgb, var(--gm-album-color, ${THEME.accent}) 56%, #f5a900) 26%, transparent), transparent 52%),
        ${THEME.bg} !important;
      transition: background 900ms ease;
    }
    ytmusic-app-layout { background: transparent !important; }
    ytmusic-nav-bar, ytmusic-player-bar {
      background: color-mix(in srgb, ${THEME.panel} 92%, #f5a900) !important;
      transition: background 900ms ease;
    }
    #progress-bar, tp-yt-paper-progress { --paper-progress-active-color: #ff1744 !important; }
    ytmusic-mealbar-promo-renderer,
    ytmusic-statement-banner-renderer { display: none !important; }
    ytmusic-logo { display: none !important; }
    .gm-brand {
      position: fixed; top: 13px; left: 72px; z-index: 99999; display: flex;
      align-items: center; gap: 10px; color: #fff; font: 700 16px Roboto, sans-serif;
      letter-spacing: -.3px; pointer-events: none;
    }
    .gm-mark {
      display: inline-flex; width: 30px; height: 30px; flex: 0 0 30px;
      align-items: center; justify-content: center; border-radius: 50%;
      overflow: hidden; border: 1px solid rgba(255,190,64,.72);
      background: #080604; color: #fff; font: 700 19px Georgia, serif;
      box-shadow: 0 3px 16px rgba(245,169,0,.38);
    }
    .gm-mark img {
      display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover;
    }
    .gm-jam-trigger {
      position: fixed; left: 20px; bottom: 88px; z-index: 99999;
      display: flex; align-items: center; gap: 10px; padding: 9px 17px 9px 9px;
      border: 1px solid rgba(245,169,0,.42); border-radius: 28px;
      background: linear-gradient(115deg, #17120a, #292012 60%, #11100d);
      color: #fff; font: 700 14px Roboto,sans-serif; letter-spacing: .2px;
      cursor: pointer; box-shadow: 0 5px 24px rgba(0,0,0,.55), 0 0 20px rgba(245,169,0,.18);
      transition: transform .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .gm-jam-trigger:hover {
      transform: translateY(-3px) scale(1.025); border-color: #ffd166;
      box-shadow: 0 8px 28px rgba(0,0,0,.6), 0 0 28px rgba(245,169,0,.34);
    }
    .gm-jam-trigger:focus-visible, .gm-jam-panel button:focus-visible, .gm-jam-panel input:focus-visible {
      outline: 2px solid #ffd166; outline-offset: 3px;
    }
    .gm-jam-trigger .gm-mark {
      width: 36px; height: 36px; flex-basis: 36px; font-size: 22px;
      border-color: rgba(255,209,102,.9);
    }
    .gm-status-dot {
      width: 9px; height: 9px; margin-left: 2px; border-radius: 50%;
      background: #888; box-shadow: 0 0 0 3px rgba(255,255,255,.1);
    }
    .gm-jam-panel {
      position: fixed; left: 20px; bottom: 145px; z-index: 99999;
      box-sizing: border-box; width: min(350px, calc(100vw - 32px)); max-height: min(78vh, 700px); overflow-y: auto;
      padding: 20px; display: none;
      border: 1px solid rgba(245,169,0,.36); border-radius: 20px;
      background: linear-gradient(155deg, rgba(38,29,14,.98), rgba(19,19,17,.99) 48%);
      color: #fff; font-family: Roboto,sans-serif;
      box-shadow: 0 18px 54px rgba(0,0,0,.68), 0 0 28px rgba(245,169,0,.12);
      backdrop-filter: blur(22px); animation: gm-panel-in .2s ease-out;
    }
    @keyframes gm-panel-in {
      from { opacity: 0; transform: translateY(8px) scale(.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .gm-panel-header {
      position: sticky; top: -20px; z-index: 1; display: flex; align-items: center; gap: 11px;
      margin: -2px -2px 16px; padding: 2px 2px 14px;
      border-bottom: 1px solid rgba(255,255,255,.1);
      background: linear-gradient(155deg, #261e10, #211d14);
    }
    .gm-panel-mark { width: 40px; height: 40px; flex-basis: 40px; font-size: 23px; }
    .gm-close-button {
      width: 30px; height: 30px; flex: 0 0 30px; margin-left: auto; padding: 0;
      border: 1px solid #393943; border-radius: 50%; background: transparent;
      color: #bbb; font: 22px/1 Roboto,sans-serif; cursor: pointer;
    }
    .gm-close-button:hover { border-color: ${THEME.accent}; color: #fff; }
    .gm-panel-title { font-size: 17px; font-weight: 800; letter-spacing: -.2px; }
    .gm-panel-subtitle { margin-top: 4px; color: #d8c69f; font-size: 12px; }
    .gm-connection { padding: 10px 0 14px; border-bottom: 1px solid rgba(255,255,255,.12); }
    .gm-host-id { overflow-wrap: anywhere; margin: 4px 0 10px; color: #d1c3d0; font-size: 11px; }
    .gm-now-playing {
      display: flex; align-items: center; gap: 12px; margin: 12px 0 15px; padding: 10px;
      border: 1px solid rgba(255,255,255,.11); border-radius: 13px;
      background: linear-gradient(115deg, rgba(255,255,255,.075), rgba(255,255,255,.025));
      box-shadow: inset 0 0 24px rgba(255,255,255,.015);
    }
    .gm-now-playing-art {
      width: 64px; height: 64px; flex: 0 0 64px; border-radius: 9px;
      object-fit: cover; background: #29232d; box-shadow: 0 4px 14px rgba(0,0,0,.4);
    }
    .gm-now-playing-copy { min-width: 0; flex: 1; }
    .gm-now-playing-label {
      margin-bottom: 5px; color: #e8bd69; font-size: 9px; font-weight: 800;
      letter-spacing: 1.2px; text-transform: uppercase;
    }
    .gm-now-playing-title {
      overflow: hidden; color: #fff; font-size: 13px; font-weight: 700;
      line-height: 1.35; text-overflow: ellipsis;
    }
    .gm-now-playing-artist {
      overflow: hidden; margin-top: 4px; color: #b7aab5; font-size: 11px;
      text-overflow: ellipsis; white-space: nowrap;
    }
    .gm-section-title { margin: 16px 0 9px; font-size: 13px; font-weight: 800; letter-spacing: .2px; }
    .gm-peer-list { max-height: 130px; overflow-y: auto; }
    .gm-peer { display: flex; align-items: center; gap: 9px; min-height: 32px; }
    .gm-peer-avatar {
      display: inline-flex; width: 24px; height: 24px; align-items: center; justify-content: center;
      flex: 0 0 24px; border-radius: 50%; background: #353540; color: #ffd35a; font-weight: 700;
    }
    .gm-peer-name { overflow: hidden; flex: 1; color: #eee; font-size: 12px; text-overflow: ellipsis; }
    .gm-peer-role, .gm-empty-peer { color: #999; font-size: 11px; }
    .gm-empty-peer { padding: 4px 0 10px; }
    .gm-action-button {
      width: 100%; margin-top: 8px; padding: 11px 12px; border: 1px solid rgba(255,255,255,.11);
      border-radius: 10px; background: rgba(255,255,255,.035); color: #f5edf3;
      text-align: left; font: 600 12px Roboto,sans-serif; cursor: pointer;
    }
    .gm-action-button:hover { border-color: rgba(245,169,0,.45); background: rgba(255,255,255,.08); }
    .gm-connect-form { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.12); }
    .gm-close-jam-button {
      width: 100%; margin-top: 10px; padding: 11px; border: 1px solid rgba(245,169,0,.34);
      border-radius: 9px; background: rgba(245,169,0,.07); color: #ffd166;
      font: 600 12px Roboto,sans-serif; cursor: pointer;
    }
    .gm-close-jam-button:hover { background: rgba(245,169,0,.14); }
    .gm-field-label { display: block; margin: 10px 0 5px; color: #b9b9c2; font-size: 12px; }
    .gm-field {
      box-sizing: border-box; width: 100%; padding: 10px 11px; border: 1px solid #373741;
      border-radius: 9px; outline: none; background: #0e0e13; color: #fff;
      font: 13px Roboto,sans-serif; transition: border-color .18s ease;
    }
    .gm-field:focus { border-color: ${THEME.accent}; }
    .gm-primary-button, .gm-secondary-button {
      box-sizing: border-box; width: 100%; margin-top: 10px; padding: 10px 12px;
      border-radius: 9px; font: 600 13px Roboto,sans-serif; cursor: pointer;
      transition: filter .18s ease, background .18s ease;
    }
    .gm-primary-button { border: 0; background: ${THEME.accent}; color: #fff; }
    .gm-primary-button {
      background: linear-gradient(105deg, #e59700, #ffd166);
      box-shadow: 0 5px 16px rgba(245,169,0,.2);
    }
    .gm-primary-button:hover { filter: brightness(1.12); box-shadow: 0 7px 20px rgba(245,169,0,.3); }
    .gm-secondary-button { border: 1px solid #393943; background: transparent; color: #ddd; }
    .gm-secondary-button:hover { background: rgba(255,255,255,.06); }
    .gm-host-button { border-color: rgba(245,169,0,.55); color: #ffd166; }
    .gm-room-info {
      margin-top: 12px; color: #c6c6cf; font-size: 12px; line-height: 1.55;
      white-space: pre-line; overflow-wrap: anywhere;
    }
    #movie_player.ytp-fullscreen, .html5-video-player.ytp-fullscreen { overflow: visible !important; }
  `;
  document.head.appendChild(style);
  installProgressStyles();

  const brand = el('div', { className: 'gm-brand', 'aria-label': 'Gmajna Music' });
  brand.append(makeBrandMark(),
    el('span', { textContent: 'Gmajna Music' }));
  document.body.appendChild(brand);
}

function adSkipper() {
  setInterval(() => {
    const player = document.querySelector('#movie_player, ytmusic-player');
    const v = getVideo();
    const adShowing = !!document.querySelector('.ad-showing, .ad-interrupting')
      || (player && player.classList.contains('ad-showing'));

    if (adShowing) {
      adUntil = Date.now() + 2000;
      if (v) {
        v.muted = true;
        v.playbackRate = 16;
        if (isFinite(v.duration) && v.duration > 0) v.currentTime = v.duration;
      }
    } else if (v) {
      if (v.muted && !remote) v.muted = false;
      if (v.playbackRate !== 1) v.playbackRate = 1;
    }

    const skip = document.querySelector(
      '.ytp-skip-ad-button, .ytp-ad-skip-button, .ytp-ad-skip-button-modern'
    );
    if (skip) skip.click();
  }, 250);
}

window.addEventListener('DOMContentLoaded', () => {
  applyTheme();
  buildUI();
  hookVideo();
  adSkipper();
  setTimeout(() => toast('Gmajna Music ' + VERSION), 1500);
});