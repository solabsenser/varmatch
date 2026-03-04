const express = require('express');
const cron = require('node-cron');
const Fuse = require('fuse.js');
const fs = require('fs');

const app = express();

const getEnv = (key, fallback = '') => {
  const value = process.env[key];
  return value === undefined ? fallback : value;
};

const PORT = Number(getEnv('PORT', 3000));
const DB_FILE = getEnv('DB_FILE', './streams_db.json');
const REFRESH_MATCHES_CRON = getEnv('REFRESH_MATCHES_CRON', '*/1 * * * *');
const REFRESH_STATS_CRON = getEnv('REFRESH_STATS_CRON', '*/1 * * * *');
const REFRESH_STREAMS_CRON = getEnv('REFRESH_STREAMS_CRON', '*/5 * * * *');
const APP_TITLE = getEnv('APP_TITLE', 'VarMatch TV');
const APP_VERSION = getEnv('APP_VERSION', 'v3.0');

const LEAGUES = ['Premier League', 'La Liga', 'Champions League', 'Serie A', 'Bundesliga'];
const CLUBS = [
  { name: 'Arsenal', logo: 'https://via.placeholder.com/40x40?text=ARS' },
  { name: 'Chelsea', logo: 'https://via.placeholder.com/40x40?text=CHE' },
  { name: 'Real Madrid', logo: 'https://via.placeholder.com/40x40?text=RMA' },
  { name: 'Barcelona', logo: 'https://via.placeholder.com/40x40?text=BAR' },
  { name: 'Inter', logo: 'https://via.placeholder.com/40x40?text=INT' },
  { name: 'Milan', logo: 'https://via.placeholder.com/40x40?text=MIL' },
  { name: 'Bayern', logo: 'https://via.placeholder.com/40x40?text=BAY' },
  { name: 'Dortmund', logo: 'https://via.placeholder.com/40x40?text=BVB' },
  { name: 'PSG', logo: 'https://via.placeholder.com/40x40?text=PSG' },
  { name: 'Liverpool', logo: 'https://via.placeholder.com/40x40?text=LIV' }
];

const UI_CONFIG = {
  appTitle: APP_TITLE,
  appVersion: APP_VERSION,
  refreshMatchesMs: 60000,
  refreshStatsMs: 30000,
  refreshStreamsMs: 300000,
  accentColor: getEnv('ACCENT_COLOR', '#f43f5e')
};

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ matches: [], updatedAt: null }, null, 2));
}

app.use(express.static('public'));

const readDb = () => {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
  return {
    matches: Array.isArray(raw.matches) ? raw.matches : [],
    updatedAt: raw.updatedAt || null,
    lastStatsUpdateAt: raw.lastStatsUpdateAt || null,
    lastStreamScanAt: raw.lastStreamScanAt || null
  };
};

const writeDb = (payload) => fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2));

const pick = (arr, i) => arr[i % arr.length];
const createId = (home, away, startTime) => Buffer.from(`${home}-${away}-${startTime}`).toString('base64url');

const toStatus = (startIso) => {
  const start = new Date(startIso).getTime();
  const now = Date.now();
  const diff = Math.floor((now - start) / 60000);

  if (diff < 0) return { status: 'UPCOMING', minute: null };
  if (diff < 45) return { status: 'LIVE', minute: `${diff}'` };
  if (diff < 60) return { status: 'HT', minute: 'HT' };
  if (diff < 105) return { status: 'LIVE', minute: `${diff - 15}'` };
  return { status: 'FT', minute: 'FT' };
};

const createMockMatches = () => {
  const now = Date.now();
  return Array.from({ length: 14 }).map((_, i) => {
    const home = pick(CLUBS, i);
    const away = pick(CLUBS, i + 3);
    const startOffsetMin = (i - 6) * 30;
    const startTime = new Date(now + startOffsetMin * 60000).toISOString();
    const state = toStatus(startTime);

    return {
      id: createId(home.name, away.name, startTime),
      competition: pick(LEAGUES, i),
      startTime,
      homeTeam: home,
      awayTeam: away,
      score: {
        home: state.status === 'UPCOMING' ? 0 : Math.floor(Math.random() * 3),
        away: state.status === 'UPCOMING' ? 0 : Math.floor(Math.random() * 3)
      },
      status: state.status,
      minute: state.minute,
      streams: [],
      stats: {
        possessionHome: 50,
        possessionAway: 50,
        shotsHome: 0,
        shotsAway: 0,
        cornersHome: 0,
        cornersAway: 0,
        yellowCardsHome: 0,
        yellowCardsAway: 0
      },
      updatedAt: new Date().toISOString()
    };
  });
};

const buildSearchQueries = (match) => {
  const a = match.homeTeam.name;
  const b = match.awayTeam.name;
  return [
    `${a} vs ${b} live stream`,
    `${a} ${b} live match`,
    `${match.competition} ${a} vs ${b} live`
  ];
};

const attachStreams = (matches) => matches.map((match) => ({
  ...match,
  streams: [
    {
      provider: 'YouTube',
      type: 'iframe',
      url: `https://www.youtube.com/embed/live_stream?channel=UC4R8DWoMoI7CAwX8_LjQHig`,
      embed: true
    },
    {
      provider: 'Twitch',
      type: 'iframe',
      url: `https://player.twitch.tv/?channel=riotgames&parent=localhost`,
      embed: true
    }
  ],
  searchQueries: buildSearchQueries(match)
}));

const updateMatchStates = (matches) => matches.map((match) => {
  const state = toStatus(match.startTime);
  const isLive = state.status === 'LIVE';

  const score = { ...match.score };
  if (isLive && Math.random() < 0.07) {
    if (Math.random() < 0.5) score.home += 1;
    else score.away += 1;
  }

  const stats = { ...match.stats };
  if (isLive) {
    stats.shotsHome += Math.round(Math.random());
    stats.shotsAway += Math.round(Math.random());
    stats.cornersHome += Math.random() < 0.15 ? 1 : 0;
    stats.cornersAway += Math.random() < 0.15 ? 1 : 0;
    stats.yellowCardsHome += Math.random() < 0.05 ? 1 : 0;
    stats.yellowCardsAway += Math.random() < 0.05 ? 1 : 0;
    const swing = Math.floor(Math.random() * 3) - 1;
    stats.possessionHome = Math.max(35, Math.min(65, stats.possessionHome + swing));
    stats.possessionAway = 100 - stats.possessionHome;
  }

  return {
    ...match,
    status: state.status,
    minute: state.minute,
    score,
    stats,
    updatedAt: new Date().toISOString()
  };
});

const sortByStartTime = (a, b) => new Date(a.startTime) - new Date(b.startTime);

function initDb() {
  const db = readDb();
  if (!db.matches.length) {
    const seeded = attachStreams(createMockMatches());
    writeDb({ ...db, matches: seeded, updatedAt: new Date().toISOString() });
  }
}

function refreshMatches() {
  const db = readDb();
  const matches = updateMatchStates(db.matches).sort(sortByStartTime);
  writeDb({ ...db, matches, updatedAt: new Date().toISOString() });
  console.log(`✅ Обновлены матчи: ${matches.length}`);
}

function refreshStats() {
  const db = readDb();
  const matches = updateMatchStates(db.matches);
  writeDb({ ...db, matches, lastStatsUpdateAt: new Date().toISOString() });
  console.log('📊 Обновлена статистика');
}

function refreshStreams() {
  const db = readDb();
  const matches = attachStreams(db.matches);
  writeDb({ ...db, matches, lastStreamScanAt: new Date().toISOString() });
  console.log('🎥 Обновлены источники трансляций');
}

const filterByStatus = (matches, status) => matches.filter((m) => m.status === status);

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', app: APP_TITLE, version: APP_VERSION });
});

app.get('/api/config', (_req, res) => res.json(UI_CONFIG));

app.get('/matches', (req, res) => {
  const db = readDb();
  const status = String(req.query.status || '').toUpperCase();
  const league = String(req.query.league || '').toLowerCase();

  let matches = [...db.matches].sort(sortByStartTime);
  if (status) matches = matches.filter((m) => m.status === status);
  if (league) matches = matches.filter((m) => m.competition.toLowerCase().includes(league));

  res.json({ total: matches.length, updatedAt: db.updatedAt, matches });
});

app.get('/live', (_req, res) => {
  const db = readDb();
  const live = db.matches.filter((m) => m.status === 'LIVE' || m.status === 'HT');
  res.json({ total: live.length, updatedAt: db.updatedAt, matches: live });
});

app.get('/match/:id', (req, res) => {
  const db = readDb();
  const item = db.matches.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Match not found' });
  return res.json(item);
});

app.get('/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  const db = readDb();
  if (!q) return res.json([]);

  const fuse = new Fuse(db.matches, {
    keys: ['homeTeam.name', 'awayTeam.name', 'competition'],
    threshold: 0.35
  });
  return res.json(fuse.search(q).map((x) => x.item));
});

// backward compatibility
app.get('/api/matches', (_req, res) => {
  const db = readDb();
  res.json(db.matches);
});

app.get('/api/matches/today', (_req, res) => {
  const db = readDb();
  const today = new Date().toISOString().slice(0, 10);
  const matches = db.matches.filter((m) => String(m.startTime).slice(0, 10) === today);
  res.json({ date: today, total: matches.length, matches, updatedAt: db.updatedAt });
});

app.get('/api/matches/:id/stream', (req, res) => {
  const db = readDb();
  const item = db.matches.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Матч не найден' });
  const stream = item.streams.find((s) => s.embed);
  if (!stream) return res.status(404).json({ error: 'Поток не найден' });
  return res.json({
    id: item.id,
    title: `${item.homeTeam.name} vs ${item.awayTeam.name}`,
    stream: stream.url,
    streamType: stream.type,
    competition: item.competition,
    status: item.status,
    minute: item.minute,
    score: item.score,
    stats: item.stats
  });
});

initDb();
cron.schedule(REFRESH_MATCHES_CRON, refreshMatches);
cron.schedule(REFRESH_STATS_CRON, refreshStats);
cron.schedule(REFRESH_STREAMS_CRON, refreshStreams);
refreshMatches();
refreshStreams();

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
