const { ipcRenderer, webFrame } = require('electron');
const { io } = require('socket.io-client');
const fs = require('fs');
const path = require('path');

const VERSION = 'v13';

const store = {
  get: (k, d) => { try { return localStorage.getItem('gm_' + k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem('gm_' + k, v); } catch {} },
};

// ====== NASTAVITVE VIDEZA (spreminjaj po želji) ======
const THEMES = {
  gmajna: { name: 'Gmajna Gold', accent: '#f5a900', bg: '#0d0d12', panel: '#16161d' },
  ocean: { name: 'Ocean Blue', accent: '#55b7ff', bg: '#0b1017', panel: '#131e29' },
  violet: { name: 'Violet Night', accent: '#bc8cff', bg: '#100d16', panel: '#1b1525' },
};
// =====================================================

const DEFAULT_SERVER = 'https://gmajna-server.onrender.com';
const PLUGINS = [
  { id: 'ambient-background', name: 'Ambient Mode', description: 'Barvni sij ozadja iz naslovnice.', enabled: true },
  { id: 'album-color-theme', name: 'Album Color Theme', description: 'Prilagodi poudarke barvi naslovnice.', enabled: true },
  { id: 'animated-progress', name: 'Animated Progress', description: 'Gladko gibanje in nežen odsev na predvajanem delu.', enabled: true },
  { id: 'hide-promotions', name: 'Hide Promotions', description: 'Skrije promocijske pasice v YouTube Music.', enabled: true },
];
let themeId = store.get('theme', 'gmajna');
if (!Object.hasOwn(THEMES, themeId)) themeId = 'gmajna';
let THEME = THEMES[themeId];
const BACKGROUND_MODES = ['ambient', 'image', 'default'];
let backgroundMode = store.get('backgroundMode', 'ambient');
if (!BACKGROUND_MODES.includes(backgroundMode)) backgroundMode = 'ambient';
let backgroundImage = store.get('backgroundImage', '');
if (!/^data:image\/jpeg;base64,[\w+/]+=*$/.test(backgroundImage)) backgroundImage = '';
if (backgroundMode === 'image' && !backgroundImage) backgroundMode = 'ambient';
function loadThemeLogo() {
  const logoPath = path.join(__dirname, 'assets', 'gmajna-logo.png');
  try {
    return `data:image/png;base64,${fs.readFileSync(logoPath).toString('base64')}`;
  } catch (error) {
    console.error('Logotipa Gmajna Music ni mogoče naložiti:', error);
    return '';
  }
}
let logoDataUrl = loadThemeLogo();

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
let nativeWindowFullscreen = false;
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
let themeStyle = null;
let pluginSettingsPanel = null;
let jamPanel = null;
let jamTrigger = null;
let pendingMenuAction = '';
let appTitleBar = null;
let windowTitleBar = null;
let youtubeProfileButton = null;
let musicShell = null;
let shellContent = null;
let shellSearch = null;
let shellPlayer = null;
let shellSearchTimer = null;
let shellNavigationTimer = null;
let shellContentDeadline = 0;
let shellNavigationPending = '';
let shellView = store.get('shellView', 'home');
let shellQuery = store.get('shellQuery', '');

function pluginEnabled(id) {
  const plugin = PLUGINS.find((entry) => entry.id === id);
  return plugin ? store.get(`plugin_${id}`, plugin.enabled ? '1' : '0') === '1' : false;
}

function applyPluginSettings() {
  if (!document.body) return;
  document.documentElement.style.setProperty(
    '--gm-custom-background-image',
    backgroundImage ? `url("${backgroundImage}")` : 'none'
  );
  document.body.classList.toggle(
    'gm-ambient-background',
    backgroundMode === 'ambient' && pluginEnabled('ambient-background')
  );
  document.body.classList.toggle(
    'gm-custom-background',
    backgroundMode === 'image' && Boolean(backgroundImage)
  );
  document.body.classList.toggle('gm-hide-promotions', pluginEnabled('hide-promotions'));
  const root = document.documentElement;
  const albumThemeEnabled = pluginEnabled('album-color-theme');
  const progressEnabled = pluginEnabled('animated-progress');
  root.classList.toggle('gm-album-theme-enabled', albumThemeEnabled);
  if (!albumThemeEnabled && backgroundMode !== 'ambient') root.style.removeProperty('--gm-album-color');
  root.style.setProperty('--gm-progress-animation',
    progressEnabled ? 'gm-progress-shimmer 3.6s ease-in-out infinite' : 'none');
  root.style.setProperty('--gm-progress-wave-opacity',
    progressEnabled ? '.2' : '0');
  root.style.setProperty('--gm-progress-transition',
    progressEnabled ? 'width 450ms cubic-bezier(.22,.61,.36,1)' : 'none');
  root.style.setProperty('--gm-progress-glow',
    progressEnabled
      ? 'drop-shadow(0 0 1.5px color-mix(in srgb, var(--gm-accent) 32%, transparent))'
      : 'none');
  root.style.setProperty('--gm-promo-display', pluginEnabled('hide-promotions') ? 'none' : 'revert');
}

function handleMenuAction(action) {
  if (action !== 'plugins' && action !== 'jam') return;
  if (!pluginSettingsPanel || !jamPanel) {
    pendingMenuAction = action;
    return;
  }
  const showPlugins = action === 'plugins';
  pluginSettingsPanel.style.display = showPlugins ? 'block' : 'none';
  jamPanel.style.display = showPlugins ? 'none' : 'block';
  document.documentElement.classList.toggle('gm-plugin-settings-open', showPlugins);
  if (jamTrigger) jamTrigger.setAttribute('aria-expanded', String(!showPlugins));
}

ipcRenderer.on('app-menu-action', (_event, action) => handleMenuAction(action));
ipcRenderer.on('gm-window-state', (_event, state) => {
  if (!windowTitleBar) return;
  const isMaximized = state === 'maximized';
  windowTitleBar.classList.toggle('gm-maximized', isMaximized);
  const button = windowTitleBar.querySelector('.gm-maximize-button');
  if (button) {
    button.replaceChildren(createWindowIcon(isMaximized ? 'restore' : 'maximize'));
    button.title = isMaximized ? 'Restore' : 'Maximize';
    button.setAttribute('aria-label', button.title);
  }
});
ipcRenderer.on('gm-fullscreen-state', (_event, isFullscreen) => {
  nativeWindowFullscreen = isFullscreen === true;
  moveUiToFullscreen();
});

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
  updateShellPlayer();
}

function applyAlbumColor(image) {
  if (!pluginEnabled('album-color-theme') && backgroundMode !== 'ambient') return;
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

function findDeepElements(selector, root = document, found = []) {
  for (const node of root.querySelectorAll('*')) {
    if (node.matches(selector)) found.push(node);
    if (node.shadowRoot) findDeepElements(selector, node.shadowRoot, found);
  }
  return found;
}

function getServiceTracks() {
  const tracks = new Map();
  for (const anchor of findDeepElements('a[href*="/watch?v="]')) {
    const id = new URL(anchor.href, location.href).searchParams.get('v');
    if (!validId(id) || tracks.has(id)) continue;
    const title = (anchor.innerText || anchor.getAttribute('aria-label')
      || anchor.querySelector('[title]')?.getAttribute('title') || '').trim();
    const image = anchor.querySelector('img');
    tracks.set(id, {
      id,
      title: title || 'YouTube Music skladba',
      artist: '',
      art: image?.src || `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
    });
  }
  return [...tracks.values()].slice(0, 48);
}

function renderShellTracks(tracks, heading) {
  if (!shellContent) return;
  shellContent.replaceChildren();
  shellContent.append(el('h1', { className: 'gm-shell-heading', textContent: heading }));
  if (!tracks.length) {
    shellContent.append(el('p', {
      className: 'gm-shell-empty',
      textContent: shellView === 'search'
        ? 'Ni zadetkov. Poskusi drugo iskanje.'
        : 'Vsebina se še nalaga. Poskusi znova čez trenutek.',
    }));
    return;
  }
  const grid = el('div', { className: 'gm-shell-grid' });
  for (const track of tracks) {
    const card = el('button', {
      className: 'gm-shell-track',
      type: 'button',
      title: `Predvajaj ${track.title}`,
    });
    const art = el('img', { className: 'gm-shell-art', src: track.art, alt: '' });
    const title = el('span', { className: 'gm-shell-track-title', textContent: track.title });
    card.append(art, title);
    card.addEventListener('click', () => goToTrack(track.id));
    grid.append(card);
  }
  shellContent.append(grid);
}

function refreshShellContent() {
  if (!shellContent) return;
  if (shellSearchTimer) clearTimeout(shellSearchTimer);
  const heading = shellView === 'search'
    ? `Rezultati za »${shellQuery}«`
    : shellView === 'library' ? 'Tvoja knjižnica' : 'Dobrodošel v Gmajna Music';
  if (shellNavigationPending) {
    shellContent.replaceChildren(
      el('h1', { className: 'gm-shell-heading', textContent: heading }),
      el('p', { className: 'gm-shell-empty', textContent: 'Nalagam …' })
    );
    return;
  }
  const tracks = getServiceTracks();
  if (tracks.length) {
    shellContentDeadline = 0;
    renderShellTracks(tracks, heading);
    return;
  }
  if (shellContentDeadline && Date.now() < shellContentDeadline) {
    shellSearchTimer = setTimeout(refreshShellContent, 400);
    return;
  }
  shellContentDeadline = 0;
  renderShellTracks([], heading);
}

function updateShellPlayer() {
  if (!shellPlayer) return;
  const video = getVideo();
  const info = currentTrackInfo;
  const title = shellPlayer.querySelector('.gm-shell-player-title');
  const artist = shellPlayer.querySelector('.gm-shell-player-artist');
  const art = shellPlayer.querySelector('.gm-shell-player-art');
  const playButton = shellPlayer.querySelector('.gm-shell-play');
  const seek = shellPlayer.querySelector('.gm-shell-seek');
  const elapsed = shellPlayer.querySelector('.gm-shell-elapsed');
  const duration = shellPlayer.querySelector('.gm-shell-duration');
  if (title) title.textContent = info.title || 'Izberi skladbo';
  if (artist) artist.textContent = info.artist || 'Gmajna Music';
  if (art && info.art && art.src !== info.art) art.src = info.art;
  if (playButton) playButton.textContent = video && !video.paused ? '❚❚' : '▶';
  if (video && Number.isFinite(video.duration) && video.duration > 0) {
    if (seek && document.activeElement !== seek) {
      seek.value = String(Math.round((video.currentTime / video.duration) * 1000));
    }
    if (elapsed) elapsed.textContent = formatTime(video.currentTime);
    if (duration) duration.textContent = formatTime(video.duration);
  }
}

function formatTime(seconds) {
  const safeSeconds = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  return `${Math.floor(safeSeconds / 60)}:${String(safeSeconds % 60).padStart(2, '0')}`;
}

function buildMusicShell() {
  musicShell = el('div', { className: 'gm-shell', 'aria-label': 'Gmajna Music' });
  const sidebar = el('aside', { className: 'gm-shell-sidebar' });
  const brand = el('div', { className: 'gm-shell-brand' });
  brand.append(makeBrandMark('gm-mark gm-shell-brand-mark'),
    el('strong', { textContent: 'Gmajna Music' }));
  const nav = el('nav', { className: 'gm-shell-nav', 'aria-label': 'Glavna navigacija' });
  const navItems = [
    { id: 'home', label: 'Domov', icon: '⌂' },
    { id: 'search', label: 'Iskanje', icon: '⌕' },
    { id: 'library', label: 'Knjižnica', icon: '▤' },
  ];
  for (const item of navItems) {
    const button = el('button', {
      className: `gm-shell-nav-item${shellView === item.id ? ' is-active' : ''}`,
      type: 'button',
    });
    button.append(
      el('span', { className: 'gm-shell-nav-icon', textContent: item.icon }),
      el('span', { textContent: item.label })
    );
    button.addEventListener('click', () => {
      shellView = item.id;
      store.set('shellView', shellView);
      if (item.id === 'home') {
        shellQuery = '';
        if (shellSearch) shellSearch.value = '';
        store.set('shellQuery', '');
        if (location.pathname !== '/') navigateService('/');
      } else if (item.id === 'library') {
        if (location.pathname !== '/library') navigateService('/library');
      } else {
        shellContentDeadline = 0;
        shellSearch?.focus();
      }
      nav.querySelectorAll('.gm-shell-nav-item').forEach((navItem) => {
        navItem.classList.toggle('is-active', navItem === button);
      });
      refreshShellContent();
    });
    nav.append(button);
  }
  sidebar.append(brand, nav);

  const workspace = el('section', { className: 'gm-shell-workspace' });
  const header = el('header', { className: 'gm-shell-header' });
  const searchForm = el('form', { className: 'gm-shell-search' });
  searchForm.append(
    el('span', { className: 'gm-shell-search-icon', textContent: '⌕', 'aria-hidden': 'true' }),
    shellSearch = el('input', {
      className: 'gm-shell-search-input',
      type: 'search',
      placeholder: 'Kaj želiš poslušati?',
      value: shellQuery,
      'aria-label': 'Išči glasbo',
    })
  );
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = shellSearch.value.trim();
    if (!query) return;
    shellQuery = query;
    shellView = 'search';
    store.set('shellQuery', shellQuery);
    store.set('shellView', shellView);
    shellContentDeadline = Date.now() + 10000;
    const searchPath = `/search?q=${encodeURIComponent(query)}`;
    if (!serviceRouteMatches(searchPath)) navigateService(searchPath);
    else refreshShellContent();
  });
  shellSearch.addEventListener('input', () => {
    shellQuery = shellSearch.value;
    store.set('shellQuery', shellQuery);
  });
  header.append(searchForm);
  shellContent = el('main', { className: 'gm-shell-content' });
  workspace.append(header, shellContent);

  shellPlayer = el('footer', { className: 'gm-shell-player' });
  const playerTrack = el('div', { className: 'gm-shell-player-track' });
  const playerCopy = el('div', { className: 'gm-shell-player-copy' });
  playerCopy.append(
      el('strong', { className: 'gm-shell-player-title', textContent: 'Izberi skladbo' }),
      el('span', { className: 'gm-shell-player-artist', textContent: 'Gmajna Music' })
  );
  playerTrack.append(el('img', { className: 'gm-shell-player-art', alt: '' }), playerCopy);
  const controls = el('div', { className: 'gm-shell-player-controls' });
  const previous = el('button', { className: 'gm-shell-control', type: 'button', textContent: '|◀', title: 'Prejšnja skladba' });
  const play = el('button', { className: 'gm-shell-control gm-shell-play', type: 'button', textContent: '▶', title: 'Predvajaj' });
  const next = el('button', { className: 'gm-shell-control', type: 'button', textContent: '▶|', title: 'Naslednja skladba' });
  previous.addEventListener('click', () => clickServiceControl('#previous-button'));
  next.addEventListener('click', () => clickServiceControl('#next-button'));
  play.addEventListener('click', () => {
    const video = getVideo();
    if (!video) return;
    if (video.paused) video.play().catch((error) => console.error('Predvajanja ni mogoče začeti:', error));
    else video.pause();
    updateShellPlayer();
  });
  controls.append(previous, play, next);
  const timeline = el('div', { className: 'gm-shell-timeline' });
  const elapsed = el('span', { className: 'gm-shell-elapsed', textContent: '0:00' });
  const seek = el('input', {
    className: 'gm-shell-seek',
    type: 'range',
    min: '0',
    max: '1000',
    value: '0',
    'aria-label': 'Položaj skladbe',
  });
  const duration = el('span', { className: 'gm-shell-duration', textContent: '0:00' });
  seek.addEventListener('input', () => {
    const video = getVideo();
    if (video && Number.isFinite(video.duration)) {
      video.currentTime = (Number(seek.value) / 1000) * video.duration;
    }
  });
  timeline.append(elapsed, seek, duration);
  shellPlayer.append(playerTrack, controls, timeline);
  musicShell.append(sidebar, workspace, shellPlayer);
  document.body.append(musicShell);
  updateShellPlayer();
  shellContentDeadline = Date.now() + 10000;
  refreshShellContent();
  shellSearch?.addEventListener('focus', () => {
    shellView = 'search';
    store.set('shellView', shellView);
    nav.querySelectorAll('.gm-shell-nav-item').forEach((navItem) => {
      navItem.classList.toggle('is-active', navItem.textContent.includes('Iskanje'));
    });
  });
  const onServiceNavigateFinish = () => {
    if (shellNavigationPending && serviceRouteMatches(shellNavigationPending)) {
      clearTimeout(shellNavigationTimer);
      shellNavigationPending = '';
      shellNavigationTimer = null;
      shellContentDeadline = Math.max(shellContentDeadline, Date.now() + 10000);
    }
    window.setTimeout(() => refreshShellContent(), 250);
  };
  document.addEventListener('yt-navigate-finish', onServiceNavigateFinish);
  window.addEventListener('yt-navigate-finish', onServiceNavigateFinish);
  setInterval(updateShellPlayer, 500);
}

function navigateService(pathname) {
  clearTimeout(shellNavigationTimer);
  shellNavigationPending = pathname;
  shellContentDeadline = Date.now() + 10000;
  refreshShellContent();
  const link = document.createElement('a');
  link.href = pathname;
  link.style.display = 'none';
  try {
    document.body.append(link);
    link.click();
    checkServiceNavigation(pathname, Date.now());
  } catch (error) {
    clearTimeout(shellNavigationTimer);
    shellNavigationTimer = null;
    shellNavigationPending = '';
    console.error(`YouTube Music navigacija ni uspela (${pathname}):`, error);
    toast('Strani ni bilo mogoče odpreti. Poskusi znova.');
    refreshShellContent();
  } finally {
    link.remove();
  }
}

function checkServiceNavigation(pathname, startedAt) {
  if (shellNavigationPending !== pathname) return;
  if (serviceRouteMatches(pathname)) {
    clearTimeout(shellNavigationTimer);
    shellNavigationTimer = null;
    shellNavigationPending = '';
    shellContentDeadline = Math.max(shellContentDeadline, Date.now() + 10000);
    refreshShellContent();
    return;
  }
  if (Date.now() - startedAt >= 8000) {
    shellNavigationTimer = null;
    shellNavigationPending = '';
    console.error(`YouTube Music navigacija ni končala poti ${pathname}.`);
    if (shellContent) {
      shellContent.replaceChildren(
        el('h1', {
          className: 'gm-shell-heading',
          textContent: shellView === 'search' ? `Rezultati za »${shellQuery}«` : 'Gmajna Music',
        }),
        el('p', {
          className: 'gm-shell-empty',
          textContent: 'Iskanja ni bilo mogoče odpreti. Preveri povezavo in poskusi znova.',
        })
      );
    }
    return;
  }
  shellNavigationTimer = setTimeout(() => checkServiceNavigation(pathname, startedAt), 300);
}

function serviceRouteMatches(pathname) {
  const expected = new URL(pathname, location.origin);
  if (location.pathname !== expected.pathname) return false;
  for (const [key, value] of expected.searchParams) {
    if (new URLSearchParams(location.search).get(key) !== value) return false;
  }
  return true;
}

function installMusicShellStyles() {
  const style = el('style');
  style.textContent = `
    .gm-nav-brand { display: none !important; }
    .gm-shell {
      position: fixed; inset: 32px 0 0; z-index: 90000;
      display: grid; grid-template-columns: 232px minmax(0, 1fr);
      grid-template-rows: minmax(0, 1fr) 88px;
      overflow: hidden; background: #121212; color: #f7f7f7;
      font: 14px Arial, sans-serif;
    }
    .gm-shell-sidebar {
      grid-column: 1; grid-row: 1; min-height: 0; padding: 22px 12px;
      background: #090909; overflow-y: auto;
    }
    .gm-shell-brand { display: flex; align-items: center; gap: 10px; padding: 0 -40px 24px; }
    .gm-mark.gm-shell-brand-mark { width: 36px; height: 36px; flex-basis: 36px; }
    .gm-shell-brand strong { font-size: 17px; }
    .gm-shell-nav { display: grid; gap: 5px; }
    .gm-shell-nav-item {
      display: flex; width: 100%; align-items: center; gap: 15px; padding: 11px 12px;
      border: 0; border-radius: 7px; background: transparent; color: #aaa;
      text-align: left; font: 600 14px Arial, sans-serif; cursor: pointer;
    }
    .gm-shell-nav-item:hover, .gm-shell-nav-item.is-active { color: #fff; background: #242424; }
    .gm-shell-nav-icon { width: 22px; font-size: 22px; line-height: 1; text-align: center; }
    .gm-shell-workspace {
      grid-column: 2; grid-row: 1; min-width: 0; min-height: 0;
      overflow: auto; background: linear-gradient(180deg, #24332e 0, #171717 280px, #121212 620px);
    }
    .gm-shell-header {
      position: sticky; top: 0; z-index: 2; display: flex; align-items: center; justify-content: center;
      min-height: 72px; padding: 12px 32px; background: rgba(16,16,16,.86);
      backdrop-filter: blur(16px);
    }
    .gm-shell-search {
      display: flex; width: min(480px, 100%); height: 46px; align-items: center; gap: 11px;
      padding: 0 16px; border: 1px solid transparent; border-radius: 24px;
      background: #fff; color: #171717;
    }
    .gm-shell-search:focus-within { outline: 2px solid var(--gm-accent); }
    .gm-shell-search-icon { font-size: 23px; }
    .gm-shell-search-input {
      width: 100%; border: 0; outline: 0; background: transparent;
      color: #171717; font: 14px Arial, sans-serif;
    }
    .gm-shell-content {
      box-sizing: border-box; width: min(100%, 1200px); margin-inline: auto; padding: 12px 32px 32px;
    }
    .gm-shell-heading { margin: 8px 0 22px; font-size: clamp(24px, 3vw, 34px); }
    .gm-shell-empty { color: #aaa; }
    .gm-shell-grid {
      display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 18px;
    }
    .gm-shell-track {
      min-width: 0; padding: 10px; border: 0; border-radius: 8px;
      background: #181818; color: #fff; text-align: left; cursor: pointer;
      transition: background .16s ease, transform .16s ease;
    }
    .gm-shell-track:hover { background: #282828; transform: translateY(-2px); }
    .gm-shell-art {
      display: block; width: 100%; aspect-ratio: 1; margin-bottom: 11px;
      border-radius: 6px; background: #292929; object-fit: cover;
    }
    .gm-shell-track-title {
      display: -webkit-box; overflow: hidden; font-size: 13px; font-weight: 700;
      line-height: 1.4; -webkit-box-orient: vertical; -webkit-line-clamp: 2;
    }
    .gm-shell-player {
      grid-column: 1 / -1; grid-row: 2; z-index: 1;
      display: grid; grid-template-columns: minmax(0, 1fr) minmax(240px, 1fr) minmax(0, 1fr);
      align-items: center; padding: 0 18px; border-top: 1px solid #282828;
      background: #090909;
    }
    .gm-shell-player-track { display: flex; min-width: 0; align-items: center; gap: 12px; }
    .gm-shell-player-art { width: 54px; height: 54px; border-radius: 4px; background: #252525; object-fit: cover; }
    .gm-shell-player-copy { display: grid; min-width: 0; gap: 6px; }
    .gm-shell-player-title, .gm-shell-player-artist { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .gm-shell-player-title { font-size: 13px; }
    .gm-shell-player-artist { color: #aaa; font-size: 11px; }
    .gm-shell-player-controls { display: flex; justify-content: center; align-items: center; gap: 18px; }
    .gm-shell-control {
      border: 0; background: transparent; color: #ddd; font-size: 16px; cursor: pointer;
    }
    .gm-shell-control:hover { color: var(--gm-accent); }
    .gm-shell-play {
      width: 38px; height: 38px; border-radius: 50%;
      background: #fff; color: #111; font-size: 18px;
    }
    .gm-shell-play:hover { background: var(--gm-accent); color: #111; }
    .gm-shell-timeline {
      display: flex; align-items: center; gap: 9px; justify-content: flex-end;
      color: #aaa; font-size: 10px;
    }
    .gm-shell-seek { width: min(100%, 340px); accent-color: var(--gm-accent); }
    @media (max-width: 700px) {
      .gm-shell { grid-template-columns: 72px minmax(0, 1fr); }
      .gm-shell-sidebar { padding: 16px 7px; }
      .gm-shell-brand { justify-content: center; padding: 0 0 20px; }
      .gm-shell-brand strong, .gm-shell-nav-item > span:last-child { display: none; }
      .gm-shell-nav-item { justify-content: center; padding: 12px 4px; }
      .gm-shell-header { padding: 10px 16px; }
      .gm-shell-content { padding: 10px 16px 24px; }
      .gm-shell-player { grid-template-columns: minmax(0, 1fr) auto; }
      .gm-shell-timeline { grid-column: 1 / -1; grid-row: 2; }
      .gm-shell-player { grid-template-rows: 1fr 20px; padding-bottom: 6px; }
    }
  `;
  document.head.appendChild(style);
}

function clickServiceControl(selector) {
  const control = findDeepElements(selector)[0];
  if (control) control.click();
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

function syncYouTubeProfileButton(isFullscreen) {
  const nativeProfile = document.querySelector('ytmusic-nav-bar ytmusic-settings-button');
  if (!youtubeProfileButton) {
    youtubeProfileButton = el('button', {
      className: 'gm-youtube-profile',
      type: 'button',
      title: 'YouTube account',
      'aria-label': 'YouTube account menu',
    });
    youtubeProfileButton.append(el('img', { alt: '' }));
    youtubeProfileButton.addEventListener('click', () => {
      const nativeButton = document.querySelector('ytmusic-nav-bar ytmusic-settings-button button');
      if (!nativeButton) {
        console.error('YouTube profile menu is unavailable: the native account button was not found.');
        toast('YouTube profile is currently unavailable');
        return;
      }
      nativeButton.click();
    });
    document.documentElement.append(youtubeProfileButton);
  }

  const roots = nativeProfile ? [nativeProfile, nativeProfile.shadowRoot].filter(Boolean) : [];
  let avatar = null;
  while (roots.length && !avatar) {
    const root = roots.shift();
    avatar = root.querySelector('yt-img-shadow img, img');
    if (!avatar) {
      for (const node of root.querySelectorAll('*')) {
        if (node.shadowRoot) roots.push(node.shadowRoot);
      }
    }
  }
  const image = youtubeProfileButton.querySelector('img');
  const avatarUrl = avatar?.currentSrc || avatar?.src || '';
  if (avatarUrl && image.src !== avatarUrl) image.src = avatarUrl;
  if (!avatarUrl) image.removeAttribute('src');
  youtubeProfileButton.style.display = nativeProfile && avatarUrl && !isFullscreen ? 'flex' : 'none';
}

function moveUiToFullscreen() {
  const target = document.fullscreenElement
    || document.querySelector('#movie_player.ytp-fullscreen, .html5-video-player.ytp-fullscreen')
    || document.body;
  const isFullscreen = nativeWindowFullscreen || target !== document.body;
  syncYouTubeProfileButton(isFullscreen);
  document.documentElement.classList.toggle('gm-window-fullscreen', isFullscreen);
  document.documentElement.style.setProperty('--gm-app-top', isFullscreen ? '0px' : '80px');
  if (appTitleBar) appTitleBar.style.display = isFullscreen ? 'none' : 'flex';
  if (windowTitleBar) windowTitleBar.style.display = isFullscreen ? 'none' : 'flex';
  if (target === fullscreenMount && fullscreenUiNodes.every((node) => node.parentElement === target)) return;
  fullscreenMount = target;
  for (const node of fullscreenUiNodes) target.appendChild(node);
}

function buildAppTitleBar() {
  appTitleBar = el('div', { className: 'gm-titlebar', 'aria-label': 'Gmajna Music' });
  windowTitleBar = el('div', { className: 'gm-window-titlebar gm-titlebar', 'aria-label': 'Window controls' });
  const menuGroup = el('div', { className: 'gm-titlebar-menus' });
  const updateOpenMenuState = () => {
    appTitleBar.classList.toggle('gm-has-open-menu', Boolean(menuGroup.querySelector('.gm-menu-open')));
  };
  const menus = [
    {
      title: 'Plugins',
      items: [
        { label: 'Manage Plugins', action: 'plugins' },
        { label: 'Gmajna Jam', action: 'jam' },
      ],
    },
    {
      title: 'Options',
      items: [{ label: 'Appearance and themes', action: 'plugins' }],
    },
    {
      title: 'View',
      items: [
        { label: 'Reload', action: 'reload' },
        { label: 'Toggle Full Screen', action: 'fullscreen' },
        { separator: true },
        { label: 'Zoom In', action: 'zoom-in' },
        { label: 'Zoom Out', action: 'zoom-out' },
        { label: 'Reset Zoom', action: 'zoom-reset' },
      ],
    },
    {
      title: 'Navigation',
      items: [
        { label: 'Back', action: 'back' },
        { label: 'Forward', action: 'forward' },
      ],
    },
    { title: 'About', items: [{ label: 'About Gmajna Music', action: 'about' }] },
  ];

  for (const menu of menus) {
    const group = el('div', { className: 'gm-titlebar-menu' });
    const trigger = el('button', {
      className: 'gm-titlebar-menu-trigger',
      textContent: menu.title,
      'aria-haspopup': 'menu',
      'aria-expanded': 'false',
    });
    const popover = el('div', { className: 'gm-titlebar-menu-popover', role: 'menu' });
    for (const item of menu.items) {
      if (item.separator) {
        popover.append(el('div', { className: 'gm-titlebar-menu-separator' }));
        continue;
      }
      const menuItem = el('button', {
        className: 'gm-titlebar-menu-item',
        textContent: item.label,
        role: 'menuitem',
      });
      menuItem.addEventListener('click', () => {
        for (const openGroup of menuGroup.querySelectorAll('.gm-titlebar-menu')) {
          openGroup.classList.remove('gm-menu-open');
          openGroup.querySelector('.gm-titlebar-menu-trigger').setAttribute('aria-expanded', 'false');
        }
        updateOpenMenuState();
        if (item.action === 'plugins' || item.action === 'jam') handleMenuAction(item.action);
        else ipcRenderer.send('gm-menu-action', item.action);
      });
      popover.append(menuItem);
    }
    trigger.addEventListener('click', () => {
      const wasOpen = group.classList.contains('gm-menu-open');
      for (const openGroup of menuGroup.querySelectorAll('.gm-titlebar-menu')) {
        openGroup.classList.remove('gm-menu-open');
        openGroup.querySelector('.gm-titlebar-menu-trigger').setAttribute('aria-expanded', 'false');
      }
      if (!wasOpen) {
        group.classList.add('gm-menu-open');
        trigger.setAttribute('aria-expanded', 'true');
      }
      updateOpenMenuState();
    });
    group.append(trigger, popover);
    menuGroup.append(group);
  }

  const searchForm = el('form', {
    className: 'gm-titlebar-search',
    role: 'search',
  });
  const searchInput = el('input', {
    className: 'gm-titlebar-search-input',
    type: 'search',
    placeholder: 'Iščite skladbe, albume, izvajalce, podcaste',
    'aria-label': 'Išči v YouTube Music',
  });
  searchForm.append(
    el('span', { className: 'gm-titlebar-search-icon', textContent: '⌕', 'aria-hidden': 'true' }),
    searchInput,
  );
  searchForm.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = searchInput.value.trim();
    if (query) location.assign(`/search?q=${encodeURIComponent(query)}`);
  });

  const brand = el('div', { className: 'gm-nav-brand', 'aria-label': 'Gmajna Music' });
  brand.textContent = 'Gmajna Music';
  const windowControls = el('div', { className: 'gm-window-controls' });
  const controls = [
    { label: 'Minimize', icon: 'minimize', action: 'minimize', className: 'gm-window-button' },
    { label: 'Maximize', icon: 'maximize', action: 'toggle-maximize', className: 'gm-window-button gm-maximize-button' },
    { label: 'Close', icon: 'close', action: 'close', className: 'gm-window-button gm-window-close' },
  ];
  for (const control of controls) {
    const button = el('button', {
      className: control.className,
      title: control.label,
      'aria-label': control.label,
    });
    button.append(createWindowIcon(control.icon));
    button.addEventListener('click', () => ipcRenderer.send('gm-window-control', control.action));
    windowControls.append(button);
  }
  windowTitleBar.append(windowControls);
  appTitleBar.append(menuGroup, searchForm);
  appTitleBar.addEventListener('click', (event) => {
    if (event.target.closest('.gm-titlebar-menu')) return;
    for (const openGroup of menuGroup.querySelectorAll('.gm-titlebar-menu')) {
      openGroup.classList.remove('gm-menu-open');
      openGroup.querySelector('.gm-titlebar-menu-trigger').setAttribute('aria-expanded', 'false');
    }
    updateOpenMenuState();
  });
  document.addEventListener('click', (event) => {
    if (appTitleBar.contains(event.target)) return;
    for (const openGroup of menuGroup.querySelectorAll('.gm-titlebar-menu')) {
      openGroup.classList.remove('gm-menu-open');
      openGroup.querySelector('.gm-titlebar-menu-trigger').setAttribute('aria-expanded', 'false');
    }
    updateOpenMenuState();
  });
  document.documentElement.append(windowTitleBar, appTitleBar, brand);
}

function createWindowIcon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.classList.add('gm-window-icon');
  const shapes = {
    minimize: [['path', { d: 'M3 8h10' }]],
    maximize: [['rect', { x: '3.5', y: '3.5', width: '9', height: '9', rx: '.5' }]],
    restore: [
      ['path', { d: 'M5 5V3.5h8v8h-1.5' }],
      ['rect', { x: '3', y: '5', width: '8', height: '8', rx: '.5' }],
    ],
    close: [['path', { d: 'm4 4 8 8M12 4l-8 8' }]],
  };
  for (const [tag, attributes] of shapes[name] || shapes.close) {
    const shape = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [attribute, value] of Object.entries(attributes)) shape.setAttribute(attribute, value);
    if (tag === 'path') {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', name === 'close' ? '1.5' : '1');
      shape.setAttribute('stroke-linecap', 'round');
    } else {
      shape.setAttribute('fill', 'none');
      shape.setAttribute('stroke', 'currentColor');
      shape.setAttribute('stroke-width', '1');
    }
    svg.append(shape);
  }
  return svg;
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
  if (currentId() === id) {
    const video = getVideo();
    if (video && video.paused) {
      video.play().catch((error) => console.error('Predvajanja ni mogoče začeti:', error));
    }
    return;
  }
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
  const btn = el('button', {
    className: 'gm-jam-trigger',
    'aria-label': 'Odpri Gmajna Jam',
    title: 'Gmajna Jam',
    'aria-haspopup': 'dialog',
    'aria-expanded': 'false',
  });
  const triggerMark = makeBrandMark();
  const triggerLabel = el('span', { textContent: 'Jam' });
  statusDot = el('span', { className: 'gm-status-dot', 'aria-label': 'Povezava ni aktivna' });
  btn.append(triggerMark, triggerLabel, statusDot);

  pluginSettingsPanel = el('div', {
    className: 'gm-plugin-panel',
    role: 'dialog',
    'aria-label': 'Vtičniki in videz',
  });
  const pluginHeader = el('div', { className: 'gm-plugin-header' });
  const pluginHeading = el('div', { className: 'gm-plugin-heading', textContent: 'Vtičniki' });
  const pluginSubtitle = el('div', {
    className: 'gm-plugin-subtitle',
    textContent: 'Prilagodi Gmajna Music po svoje.',
  });
  const pluginClose = el('button', {
    className: 'gm-close-button',
    textContent: '×',
    'aria-label': 'Zapri vtičnike',
  });
  const pluginTitleWrap = el('div');
  pluginTitleWrap.append(pluginHeading, pluginSubtitle);
  pluginHeader.append(pluginTitleWrap, pluginClose);

  const themeLabel = el('label', { className: 'gm-field-label', textContent: 'Barvna tema' });
  const themeSelect = el('select', { className: 'gm-field gm-theme-select', 'aria-label': 'Barvna tema' });
  for (const [id, theme] of Object.entries(THEMES)) {
    themeSelect.append(el('option', { value: id, textContent: theme.name }));
  }
  themeSelect.value = themeId;
  themeSelect.addEventListener('change', () => {
    themeId = themeSelect.value;
    THEME = THEMES[themeId];
    store.set('theme', themeId);
    applyTheme();
  });

  const backgroundLabel = el('label', {
    className: 'gm-field-label gm-background-label',
    textContent: 'Ozadje',
  });
  const backgroundSelect = el('select', {
    className: 'gm-field gm-background-select',
    'aria-label': 'Ozadje aplikacije',
  });
  for (const option of [
    { value: 'ambient', textContent: 'Ambient po barvi albuma' },
    { value: 'image', textContent: 'Lastna slika' },
    { value: 'default', textContent: 'Privzeto' },
  ]) {
    backgroundSelect.append(el('option', option));
  }
  backgroundSelect.value = backgroundMode;
  let ambientPluginToggle = null;
  backgroundSelect.addEventListener('change', () => {
    if (backgroundSelect.value === 'image' && !backgroundImage) {
      backgroundSelect.value = backgroundMode;
      toast('Najprej naloži sliko ozadja.');
      return;
    }
    backgroundMode = backgroundSelect.value;
    store.set('backgroundMode', backgroundMode);
    if (backgroundMode === 'ambient') {
      store.set('plugin_ambient-background', '1');
      if (ambientPluginToggle) ambientPluginToggle.checked = true;
    }
    applyPluginSettings();
  });
  const backgroundUploadLabel = el('label', {
    className: 'gm-field-label gm-background-upload-label',
    textContent: 'Slika ozadja',
  });
  const backgroundUpload = el('input', {
    className: 'gm-field gm-background-upload',
    type: 'file',
    accept: 'image/*',
    'aria-label': 'Naloži sliko ozadja',
  });
  backgroundUpload.addEventListener('change', async () => {
    const [file] = backgroundUpload.files || [];
    if (!file) return;
    if (!file.type.startsWith('image/') || file.size > 20 * 1024 * 1024) {
      toast(file.size > 20 * 1024 * 1024
        ? 'Slika je prevelika. Izberi sliko, manjšo od 20 MB.'
        : 'Izberi slikovno datoteko.');
      backgroundUpload.value = '';
      return;
    }
    try {
      const image = await createImageBitmap(file);
      const scale = Math.min(1, 1920 / image.width, 1080 / image.height);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(image.width * scale));
      canvas.height = Math.max(1, Math.round(image.height * scale));
      const context = canvas.getContext('2d');
      if (!context) {
        image.close();
        throw new Error('Canvas 2D ni na voljo.');
      }
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      image.close();
      const dataUrl = canvas.toDataURL('image/jpeg', 0.78);
      localStorage.setItem('gm_backgroundImage', dataUrl);
      backgroundImage = dataUrl;
      backgroundMode = 'image';
      store.set('backgroundMode', backgroundMode);
      backgroundSelect.value = backgroundMode;
      applyPluginSettings();
      toast('Slika ozadja je shranjena.');
    } catch (error) {
      console.error('Slike ozadja ni mogoče shraniti:', error);
      toast('Slike ozadja ni mogoče shraniti. Poskusi z manjšo sliko.');
    } finally {
      backgroundUpload.value = '';
    }
  });

  const pluginListHeading = el('div', { className: 'gm-plugin-list-heading', textContent: 'Razširitve' });
  const pluginList = el('div', { className: 'gm-plugin-list' });
  for (const plugin of PLUGINS) {
    const row = el('label', { className: 'gm-plugin-row' });
    const copy = el('span', { className: 'gm-plugin-copy' });
    copy.append(
      el('span', { className: 'gm-plugin-name', textContent: plugin.name }),
      el('span', { className: 'gm-plugin-description', textContent: plugin.description })
    );
    const toggle = el('input', {
      className: 'gm-plugin-toggle',
      type: 'checkbox',
      checked: pluginEnabled(plugin.id),
      'aria-label': `Vključi vtičnik ${plugin.name}`,
    });
    if (plugin.id === 'ambient-background') ambientPluginToggle = toggle;
    toggle.addEventListener('change', () => {
      store.set(`plugin_${plugin.id}`, toggle.checked ? '1' : '0');
      if (plugin.id === 'album-color-theme' && toggle.checked
          && nowPlayingArt?.complete && nowPlayingArt.naturalWidth > 0) {
        applyAlbumColor(nowPlayingArt);
      }
      applyPluginSettings();
    });
    row.append(copy, toggle);
    pluginList.append(row);
  }

  const jamPluginRow = el('div', { className: 'gm-plugin-row gm-plugin-core' });
  const jamPluginCopy = el('span', { className: 'gm-plugin-copy' });
  jamPluginCopy.append(
    el('span', { className: 'gm-plugin-name', textContent: 'Gmajna Jam' }),
    el('span', { className: 'gm-plugin-description', textContent: 'Skupno poslušanje je vgrajen del aplikacije.' })
  );
  jamPluginRow.append(jamPluginCopy, el('span', { className: 'gm-plugin-badge', textContent: 'Vgrajen' }));
  pluginSettingsPanel.append(
    pluginHeader,
    themeLabel,
    themeSelect,
    backgroundLabel,
    backgroundSelect,
    backgroundUploadLabel,
    backgroundUpload,
    pluginListHeading,
    pluginList,
    jamPluginRow
  );
  pluginClose.onclick = () => {
    pluginSettingsPanel.style.display = 'none';
    document.documentElement.classList.remove('gm-plugin-settings-open');
  };

  const panel = el('div', { className: 'gm-jam-panel', role: 'dialog', 'aria-label': 'Gmajna Jam' });
  jamPanel = panel;
  jamTrigger = btn;
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
    btn.setAttribute('aria-expanded', 'false');
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
    const isOpen = getComputedStyle(panel).display !== 'none';
    panel.style.display = isOpen ? 'none' : 'block';
    btn.setAttribute('aria-expanded', String(!isOpen));
    if (!isOpen && pluginSettingsPanel) pluginSettingsPanel.style.display = 'none';
    document.documentElement.classList.remove('gm-plugin-settings-open');
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
  document.body.append(panel, btn, pluginSettingsPanel);
  buildAppTitleBar();
  fullscreenUiNodes = [panel, btn, pluginSettingsPanel];
  document.addEventListener('fullscreenchange', moveUiToFullscreen);
  document.addEventListener('webkitfullscreenchange', moveUiToFullscreen);
  const fullscreenWatcher = setInterval(moveUiToFullscreen, 500);
  window.addEventListener('beforeunload', () => clearInterval(fullscreenWatcher), { once: true });
  moveUiToFullscreen();
  applyPluginSettings();
  if (pendingMenuAction) {
    const action = pendingMenuAction;
    pendingMenuAction = '';
    handleMenuAction(action);
  }

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

    const updateProgressState = () => {
      document.documentElement.classList.toggle(
        'gm-progress-playing',
        !v.paused && !v.ended
      );
    };
    updateProgressState();
    v.addEventListener('play', () => {
      updateProgressState();
      pollPlayerId();
      setTimeout(() => send(msg('play')), 150);
    });
    v.addEventListener('playing', updateProgressState);
    v.addEventListener('pause', () => {
      updateProgressState();
      send(msg('pause'));
    });
    v.addEventListener('ended', updateProgressState);
    v.addEventListener('seeked', () => send(msg('seek')));
    v.addEventListener('loadedmetadata', pollPlayerId);
  };
  setInterval(attachVideoEvents, PLAYER_POLL_MS);
  setInterval(pollPlayerId, PLAYER_POLL_MS);
}

function installProgressStyles() {
  const observedRoots = new WeakSet();
  let scanRoots = () => {};
  const progressCss = `
    #progress-bar, tp-yt-paper-progress {
      --paper-progress-active-color: var(--gm-accent) !important;
      --paper-progress-container-color: rgba(255,255,255,.14) !important;
      --paper-progress-height: 2px !important;
      --paper-slider-active-color: var(--gm-accent) !important;
      --paper-slider-knob-color: var(--gm-accent) !important;
      --paper-slider-knob-start-color: var(--gm-accent) !important;
    }
    #activeProgress {
      position: relative;
      overflow: hidden;
      filter: var(--gm-progress-glow, none);
      transition: var(--gm-progress-transition, none);
      will-change: width;
    }
    #activeProgress::after {
      content: ''; position: absolute; inset: 0; pointer-events: none;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,.75), transparent);
      background-size: 96px 100%; background-repeat: no-repeat;
      background-position: -96px 0;
      opacity: 0;
      animation: var(--gm-progress-animation, none);
    }
    :host-context(html.gm-progress-playing) #activeProgress::after {
      opacity: var(--gm-progress-wave-opacity, 0);
    }
    #progress-bar:active #activeProgress { transition: none; }
    @keyframes gm-progress-shimmer {
      from { background-position: -96px 0; }
      to { background-position: calc(100% + 96px) 0; }
    }
    @media (prefers-reduced-motion: reduce) {
      #activeProgress { transition: none; }
      #activeProgress::after { animation: none !important; }
    }
    ytmusic-mealbar-promo-renderer,
    ytmusic-statement-banner-renderer {
      display: var(--gm-promo-display, revert) !important;
    }
    ytmusic-guide-renderer,
    ytmusic-guide-entry-renderer { background: var(--gm-panel) !important; }
    :host(ytmusic-guide-renderer),
    :host(ytmusic-guide-entry-renderer),
    :host(ytmusic-player-bar) {
      background-color: var(--gm-panel) !important;
    }
    :host(ytmusic-nav-bar) {
      z-index: 100012 !important;
      overflow: visible !important;
      background: transparent !important;
    }
    :host(ytmusic-nav-bar) #nav-bar,
    :host(ytmusic-nav-bar) #container,
    :host(ytmusic-nav-bar) #header {
      overflow: visible !important;
      background: transparent !important;
    }
    :host(ytmusic-nav-bar) #nav-bar,
    :host(ytmusic-nav-bar) #container,
    :host(ytmusic-nav-bar) #header,
    :host(ytmusic-app-layout) #content,
    :host(ytmusic-app-layout) ytmusic-page-manager,
    :host(ytmusic-page-manager) #content,
    :host(ytmusic-browse-response) #contents,
    :host(ytmusic-search-page) #contents,
    :host(ytmusic-playlist-page) #contents,
    :host(ytmusic-artist-page) #contents,
    :host(ytmusic-guide-renderer) #guide-wrapper,
    :host(ytmusic-guide-renderer) #sections,
    :host(ytmusic-guide-renderer) #header,
    :host(ytmusic-guide-renderer) #header-content,
    :host(ytmusic-guide-renderer) #items,
    :host(ytmusic-guide-renderer) #guide-content,
    :host(ytmusic-guide-entry-renderer) #endpoint {
      background-color: var(--gm-panel) !important;
    }
    ytmusic-logo { display: none !important; }
    :host-context(body.gm-hide-promotions) ytmusic-mealbar-promo-renderer,
    :host-context(body.gm-hide-promotions) ytmusic-statement-banner-renderer {
      display: none !important;
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
  scanRoots = () => observeRoot(document.documentElement);
  progressObserver = new MutationObserver(() => window.requestAnimationFrame(scanRoots));
  progressPageObserver = new MutationObserver(() => window.requestAnimationFrame(scanRoots));
  progressPageObserver.observe(document.documentElement, { childList: true, subtree: true });
  scanRoots();
}

function applyTheme() {
  logoDataUrl = loadThemeLogo();
  for (const image of document.querySelectorAll('.gm-mark img')) {
    if (logoDataUrl) image.src = logoDataUrl;
  }
  const rootStyle = document.documentElement.style;
  rootStyle.setProperty('--gm-accent', THEME.accent);
  rootStyle.setProperty('--gm-bg', THEME.bg);
  rootStyle.setProperty('--gm-panel', THEME.panel);
  rootStyle.setProperty('--gm-app-top',
    document.documentElement.classList.contains('gm-window-fullscreen') ? '0px' : '80px');
  if (themeStyle) return;
  const style = el('style');
  themeStyle = style;
  style.textContent = `
    html, body {
      --ytmusic-color-white-pure: #fff;
      height: 100%;
      background: var(--gm-panel) !important;
    }
    body {
      box-sizing: border-box; margin: 0;
      overflow-x: hidden !important; overflow-y: auto !important;
    }
    ytmusic-app {
      position: relative !important;
      inset: auto !important;
      display: block !important;
      width: 100% !important;
      height: auto !important;
      min-height: calc(100vh - var(--gm-app-top, 80px)) !important;
      margin-top: var(--gm-app-top, 80px) !important;
      overflow: visible !important;
      background: var(--gm-bg) !important;
      transition: background 900ms ease;
    }
    html.gm-window-fullscreen ytmusic-app {
      min-height: 100vh !important;
      margin-top: 0 !important;
    }
    body.gm-ambient-background ytmusic-app {
      background: color-mix(in srgb, var(--gm-album-color, var(--gm-accent)) 36%, var(--gm-bg)) !important;
      transition: background-color 900ms ease;
    }
    body.gm-custom-background ytmusic-app {
      background-color: var(--gm-bg) !important;
      background-image:
        linear-gradient(rgba(13,13,18,.16), rgba(13,13,18,.24)),
        var(--gm-custom-background-image) !important;
      background-position: center !important;
      background-size: cover !important;
      background-repeat: no-repeat !important;
      background-attachment: fixed !important;
    }
    html.gm-album-theme-enabled { --gm-theme-accent: var(--gm-album-color, var(--gm-accent)); }
    ytmusic-app-layout,
    ytmusic-nav-bar,
    ytmusic-nav-bar #nav-bar,
    ytmusic-nav-bar #container,
    ytmusic-nav-bar #header { background: transparent !important; }
    ytmusic-guide-renderer,
    ytmusic-guide-entry-renderer { background: var(--gm-panel) !important; }
    ytmusic-player-bar {
      background: var(--gm-panel) !important;
      transition: background 900ms ease;
    }
    #progress-bar, tp-yt-paper-progress { --paper-progress-active-color: var(--gm-accent) !important; }
    ytmusic-logo { display: none !important; }
    body.gm-hide-promotions ytmusic-mealbar-promo-renderer,
    body.gm-hide-promotions ytmusic-statement-banner-renderer { display: none !important; }
    .gm-titlebar {
      position: fixed; inset: 0 0 auto; z-index: 2147483647;
      box-sizing: border-box; height: 48px; display: flex; align-items: center;
      padding-left: 4px; background: var(--gm-panel); color: #f3f3f3;
      font: 12px Roboto, Arial, sans-serif;
      -webkit-app-region: drag; user-select: none;
    }
    .gm-window-titlebar { top: 0; justify-content: flex-end; }
    .gm-titlebar:not(.gm-window-titlebar) { top: 48px; right: 46px; height: 32px; }
    .gm-youtube-profile {
      position: fixed !important; top: 51px !important; right: 10px !important;
      display: flex !important; width: 26px !important; height: 26px !important;
      align-items: center; justify-content: center; padding: 0;
      border: 0; border-radius: 50%; background: transparent; cursor: pointer;
      z-index: 2147483647 !important; pointer-events: auto !important;
      -webkit-app-region: no-drag;
    }
    html.gm-window-fullscreen .gm-youtube-profile { display: none !important; }
    .gm-youtube-profile img {
      display: block; width: 100%; height: 100%; border-radius: 50%; object-fit: cover;
    }
    .gm-nav-brand {
      --gm-brand-offset-y: 10px;
      position: fixed; inset: 0 0 auto; z-index: 2147483647;
      height: 48px; display: flex; align-items: center; justify-content: center;
      transform: translateY(var(--gm-brand-offset-y));
      color: var(--gm-accent); font: 600 39px Roboto, Arial, sans-serif;
      text-shadow: 0 0 5px color-mix(in srgb, var(--gm-accent) 45%, transparent);
      text-decoration: none; white-space: nowrap; pointer-events: none;
    }
    html.gm-window-fullscreen .gm-nav-brand { display: none; }
    .gm-titlebar-menus, .gm-window-controls, .gm-titlebar-menu-trigger,
    .gm-titlebar-menu-popover, .gm-window-button, .gm-titlebar-search {
      -webkit-app-region: no-drag;
    }
    .gm-titlebar-menus { height: 100%; display: flex; align-items: stretch; }
    .gm-titlebar-menu { position: relative; display: flex; align-items: stretch; }
    .gm-titlebar-menu-trigger {
      padding: 0 8px; border: 0; background: transparent; color: inherit;
      font: inherit; cursor: pointer;
    }
    .gm-titlebar-menu-trigger:hover, .gm-menu-open .gm-titlebar-menu-trigger {
      background: rgba(255,255,255,.12);
    }
    .gm-titlebar-menu-popover {
      position: absolute; top: 30px; left: 0; z-index: 1;
      display: none; min-width: 190px; padding: 5px;
      border: 1px solid #393939; border-radius: 5px;
      background: #242424; box-shadow: 0 8px 26px rgba(0,0,0,.5);
    }
    .gm-menu-open .gm-titlebar-menu-popover { display: block; }
    .gm-titlebar-menu-item {
      display: block; width: 100%; padding: 8px 10px; border: 0;
      border-radius: 3px; background: transparent; color: #f2f2f2;
      text-align: left; font: inherit; cursor: pointer;
    }
    .gm-titlebar-menu-item:hover, .gm-titlebar-menu-item:focus-visible {
      outline: 0; background: color-mix(in srgb, var(--gm-accent) 28%, #333);
    }
    .gm-titlebar-menu-separator { height: 1px; margin: 4px 5px; background: #444; }
    .gm-titlebar-search {
      position: absolute; top: 50%; left: clamp(180px, 22vw, 340px);
      display: flex; width: min(460px, calc(100vw - 520px)); height: 24px;
      align-items: center; gap: 8px; box-sizing: border-box; padding: 0 10px;
      transform: translateY(-50%); border: 1px solid rgba(255,255,255,.12);
      border-radius: 5px; background: color-mix(in srgb, var(--gm-panel) 88%, white);
      color: #d9d7df;
    }
    .gm-titlebar-search-icon { flex: 0 0 auto; font: 20px/1 Arial, sans-serif; }
    .gm-titlebar-search-input {
      width: 100%; min-width: 0; padding: 0; border: 0; outline: 0;
      background: transparent; color: #f3f3f3; font: 11px Roboto, Arial, sans-serif;
    }
    .gm-titlebar-search-input::placeholder { color: #aaa6b0; opacity: 1; }
    .gm-titlebar-search:focus-within {
      border-color: color-mix(in srgb, var(--gm-accent) 75%, white);
      background: color-mix(in srgb, var(--gm-panel) 75%, white);
    }
    .gm-window-controls { display: flex; height: 100%; margin-left: auto; }
    .gm-window-button {
      display: flex; width: 46px; height: 48px; flex: 0 0 46px; align-items: center; justify-content: center;
      padding: 0; border: 0; border-radius: 0; background: transparent;
      color: #eee; font: 16px Arial,sans-serif;
      cursor: pointer;
    }
    .gm-window-icon { display: block; width: 12px; height: 12px; overflow: visible; }
    .gm-window-button:hover { background: rgba(255,255,255,.13); }
    .gm-window-close:hover { background: #c42b1c; color: #fff; }
    .gm-maximized .gm-maximize-button .gm-window-icon { width: 13px; height: 13px; }
    .gm-titlebar button:focus-visible {
      outline: 1px solid color-mix(in srgb, var(--gm-accent) 70%, white);
      outline-offset: -2px;
    }
    .gm-mark {
      display: inline-flex; width: 30px; height: 30px; flex: 0 0 30px;
      align-items: center; justify-content: center; border-radius: 50%;
      overflow: hidden; border: 1px solid rgba(255,190,64,.72);
      background: #080604; color: #fff; font: 700 19px Georgia, serif;
      box-shadow: 0 3px 16px color-mix(in srgb, var(--gm-accent) 38%, transparent);
    }
    .gm-mark img {
      display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover;
    }
    .gm-jam-trigger {
      position: fixed; left: 18px; bottom: 88px; z-index: 99999;
      display: flex; align-items: center; gap: 8px; padding: 6px 12px 6px 6px;
      border: 1px solid color-mix(in srgb, var(--gm-accent) 38%, transparent);
      border-radius: 24px; background: color-mix(in srgb, var(--gm-panel) 92%, var(--gm-bg));
      color: #fff; font: 600 12px Roboto,sans-serif; cursor: pointer;
      box-shadow: 0 4px 18px rgba(0,0,0,.38);
      transition: background .18s ease, border-color .18s ease, box-shadow .18s ease;
    }
    .gm-jam-trigger:hover {
      border-color: color-mix(in srgb, var(--gm-accent) 40%, transparent);
      background: color-mix(in srgb, var(--gm-accent) 18%, var(--gm-panel));
      box-shadow: 0 0 18px color-mix(in srgb, var(--gm-accent) 20%, transparent);
    }
    .gm-jam-trigger:focus-visible,
    .gm-jam-panel button:focus-visible, .gm-jam-panel input:focus-visible,
    .gm-plugin-panel button:focus-visible, .gm-plugin-panel input:focus-visible,
    .gm-plugin-panel select:focus-visible {
      outline: 2px solid color-mix(in srgb, var(--gm-accent) 70%, white); outline-offset: 3px;
    }
    .gm-jam-trigger .gm-mark {
      width: 28px; height: 28px; flex-basis: 28px; font-size: 18px;
      border-color: color-mix(in srgb, var(--gm-accent) 60%, transparent);
      box-shadow: 0 2px 9px color-mix(in srgb, var(--gm-accent) 25%, transparent);
    }
    .gm-status-dot {
      width: 8px; height: 8px; margin-left: 1px; border-radius: 50%;
      background: #888; box-shadow: 0 0 0 1px rgba(255,255,255,.15);
    }
    .gm-jam-panel {
      position: fixed; left: 18px; bottom: 145px; z-index: 99999;
      box-sizing: border-box; width: min(350px, calc(100vw - 32px)); max-height: min(78vh, 700px); overflow-y: auto;
      padding: 20px; display: none;
      border: 1px solid color-mix(in srgb, var(--gm-accent) 36%, #30303a); border-radius: 20px;
      background: linear-gradient(155deg, color-mix(in srgb, var(--gm-panel) 82%, var(--gm-accent)),
        color-mix(in srgb, var(--gm-bg) 96%, var(--gm-panel)) 48%);
      color: #fff; font-family: Roboto,sans-serif;
      box-shadow: 0 18px 54px rgba(0,0,0,.68), 0 0 28px color-mix(in srgb, var(--gm-accent) 12%, transparent);
      backdrop-filter: blur(22px); animation: gm-panel-in .2s ease-out;
    }
    .gm-plugin-panel {
      position: fixed; top: 60px; left: 12px; right: auto; z-index: 100020;
      box-sizing: border-box; width: min(360px, calc(100vw - 32px));
      max-height: min(78vh, 700px); overflow-y: auto; padding: 18px;
      display: none; border: 1px solid color-mix(in srgb, var(--gm-accent) 36%, #30303a);
      border-radius: 16px; background: color-mix(in srgb, var(--gm-panel) 94%, #08080b);
      color: #fff; font-family: Roboto,sans-serif;
      box-shadow: 0 18px 54px rgba(0,0,0,.62);
      backdrop-filter: blur(22px); animation: gm-panel-in .2s ease-out;
    }
    .gm-plugin-header {
      display: flex; align-items: center; gap: 12px; margin: 0 0 12px;
      padding: 0 0 13px; border-bottom: 1px solid rgba(255,255,255,.1);
    }
    .gm-plugin-heading { font-size: 16px; font-weight: 750; }
    .gm-plugin-subtitle { margin-top: 4px; color: #aaaab5; font-size: 11px; }
    .gm-plugin-header .gm-close-button { margin-left: auto; }
    .gm-background-label { margin-top: 16px; }
    .gm-background-upload-label { margin-top: 10px; }
    .gm-background-upload {
      box-sizing: border-box; margin: 6px 0 0; padding: 7px;
      font-size: 11px;
    }
    .gm-background-upload::file-selector-button {
      margin-right: 9px; padding: 6px 9px; border: 0; border-radius: 6px;
      background: color-mix(in srgb, var(--gm-accent) 24%, var(--gm-panel));
      color: #fff; font: 600 11px Roboto, Arial, sans-serif; cursor: pointer;
    }
    .gm-plugin-list-heading {
      margin: 17px 0 5px; color: #a6a6b0; font-size: 10px;
      font-weight: 700; letter-spacing: 1px; text-transform: uppercase;
    }
    .gm-plugin-list { border-top: 1px solid rgba(255,255,255,.08); }
    .gm-plugin-row {
      display: flex; min-height: 56px; align-items: center; gap: 14px;
      padding: 9px 2px; border-bottom: 1px solid rgba(255,255,255,.08);
    }
    .gm-plugin-copy { display: flex; min-width: 0; flex: 1; flex-direction: column; gap: 4px; }
    .gm-plugin-name { color: #f1f1f4; font-size: 12px; font-weight: 650; }
    .gm-plugin-description { color: #9999a4; font-size: 10px; line-height: 1.4; }
    .gm-plugin-toggle {
      width: 34px; height: 18px; flex: 0 0 34px; margin: 0; appearance: none;
      border: 1px solid #555560; border-radius: 12px; background: #303039;
      cursor: pointer; transition: background .16s ease, border-color .16s ease;
    }
    .gm-plugin-toggle::before {
      display: block; width: 12px; height: 12px; margin: 2px; border-radius: 50%;
      background: #c4c4cc; content: ''; transition: transform .16s ease, background .16s ease;
    }
    .gm-plugin-toggle:checked {
      border-color: var(--gm-accent); background: color-mix(in srgb, var(--gm-accent) 52%, #24242c);
    }
    .gm-plugin-toggle:checked::before { transform: translateX(16px); background: #fff; }
    .gm-plugin-core { border-bottom: 0; margin-top: 5px; }
    .gm-plugin-badge {
      flex: 0 0 auto; padding: 4px 7px; border-radius: 10px;
      background: color-mix(in srgb, var(--gm-accent) 17%, transparent);
      color: color-mix(in srgb, var(--gm-accent) 65%, white); font-size: 9px; font-weight: 700;
    }
    .gm-theme-select { margin-top: 6px; }
    @media (max-width: 520px) {
      .gm-jam-trigger { left: 12px; bottom: 74px; }
      .gm-jam-panel { left: 12px; bottom: 126px; }
      .gm-plugin-panel { left: 12px; right: auto; }
      .gm-window-button { width: 38px; }
    }
    @keyframes gm-panel-in {
      from { opacity: 0; transform: translateY(8px) scale(.985); }
      to { opacity: 1; transform: translateY(0) scale(1); }
    }
    .gm-panel-header {
      position: sticky; top: -20px; z-index: 1; display: flex; align-items: center; gap: 11px;
      margin: -2px -2px 16px; padding: 2px 2px 14px;
      border-bottom: 1px solid rgba(255,255,255,.1);
      background: linear-gradient(155deg, color-mix(in srgb, var(--gm-panel) 78%, var(--gm-accent)),
        color-mix(in srgb, var(--gm-panel) 88%, var(--gm-bg)));
    }
    .gm-panel-mark { width: 40px; height: 40px; flex-basis: 40px; font-size: 23px; }
    .gm-close-button {
      width: 30px; height: 30px; flex: 0 0 30px; margin-left: auto; padding: 0;
      border: 1px solid #393943; border-radius: 50%; background: transparent;
      color: #bbb; font: 22px/1 Roboto,sans-serif; cursor: pointer;
    }
    .gm-close-button:hover { border-color: var(--gm-accent); color: #fff; }
    .gm-panel-title { font-size: 17px; font-weight: 800; letter-spacing: -.2px; }
    .gm-panel-subtitle { margin-top: 4px; color: color-mix(in srgb, var(--gm-accent) 50%, white); font-size: 12px; }
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
      margin-bottom: 5px; color: color-mix(in srgb, var(--gm-accent) 60%, white); font-size: 9px; font-weight: 800;
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
      flex: 0 0 24px; border-radius: 50%; background: #353540;
      color: color-mix(in srgb, var(--gm-accent) 62%, white); font-weight: 700;
    }
    .gm-peer-name { overflow: hidden; flex: 1; color: #eee; font-size: 12px; text-overflow: ellipsis; }
    .gm-peer-role, .gm-empty-peer { color: #999; font-size: 11px; }
    .gm-empty-peer { padding: 4px 0 10px; }
    .gm-action-button {
      width: 100%; margin-top: 8px; padding: 11px 12px; border: 1px solid rgba(255,255,255,.11);
      border-radius: 10px; background: rgba(255,255,255,.035); color: #f5edf3;
      text-align: left; font: 600 12px Roboto,sans-serif; cursor: pointer;
    }
    .gm-action-button:hover {
      border-color: color-mix(in srgb, var(--gm-accent) 45%, transparent);
      background: rgba(255,255,255,.08);
    }
    .gm-connect-form { margin-top: 14px; padding-top: 10px; border-top: 1px solid rgba(255,255,255,.12); }
    .gm-close-jam-button {
      width: 100%; margin-top: 10px; padding: 11px;
      border: 1px solid color-mix(in srgb, var(--gm-accent) 34%, transparent);
      border-radius: 9px; background: color-mix(in srgb, var(--gm-accent) 7%, transparent);
      color: color-mix(in srgb, var(--gm-accent) 65%, white);
      font: 600 12px Roboto,sans-serif; cursor: pointer;
    }
    .gm-close-jam-button:hover { background: color-mix(in srgb, var(--gm-accent) 14%, transparent); }
    .gm-field-label { display: block; margin: 10px 0 5px; color: #b9b9c2; font-size: 12px; }
    .gm-field {
      box-sizing: border-box; width: 100%; padding: 10px 11px; border: 1px solid #373741;
      border-radius: 9px; outline: none; background: #0e0e13; color: #fff;
      font: 13px Roboto,sans-serif; transition: border-color .18s ease;
    }
    .gm-field:focus { border-color: var(--gm-accent); }
    .gm-primary-button, .gm-secondary-button {
      box-sizing: border-box; width: 100%; margin-top: 10px; padding: 10px 12px;
      border-radius: 9px; font: 600 13px Roboto,sans-serif; cursor: pointer;
      transition: filter .18s ease, background .18s ease;
    }
    .gm-primary-button { border: 0; background: var(--gm-accent); color: #fff; }
    .gm-primary-button {
      background: linear-gradient(105deg, var(--gm-accent), color-mix(in srgb, var(--gm-accent) 58%, white));
      box-shadow: 0 5px 16px color-mix(in srgb, var(--gm-accent) 20%, transparent);
    }
    .gm-primary-button:hover {
      filter: brightness(1.12); box-shadow: 0 7px 20px color-mix(in srgb, var(--gm-accent) 30%, transparent);
    }
    .gm-secondary-button { border: 1px solid #393943; background: transparent; color: #ddd; }
    .gm-secondary-button:hover { background: rgba(255,255,255,.06); }
    .gm-host-button {
      border-color: color-mix(in srgb, var(--gm-accent) 55%, transparent);
      color: color-mix(in srgb, var(--gm-accent) 65%, white);
    }
    .gm-room-info {
      margin-top: 12px; color: #c6c6cf; font-size: 12px; line-height: 1.55;
      white-space: pre-line; overflow-wrap: anywhere;
    }
    #movie_player.ytp-fullscreen, .html5-video-player.ytp-fullscreen { overflow: visible !important; }
  `;
  document.head.appendChild(style);
  installProgressStyles();

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
  if (process.env.GMAJNA_CUSTOM_UI === '1') {
    installMusicShellStyles();
    buildMusicShell();
  }
  hookVideo();
  adSkipper();
  setTimeout(() => toast('Gmajna Music ' + VERSION), 1500);
});