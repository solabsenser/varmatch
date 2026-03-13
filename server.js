const express = require('express');
const cron = require('node-cron');
const Fuse = require('fuse.js');
const fs = require('fs');
const path = require('path');
const https = require('https');

const loadDotEnv = (envFile = '.env') => {
  if (!fs.existsSync(envFile)) return;
  const lines = fs.readFileSync(envFile, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const separatorIdx = trimmed.indexOf('=');
    if (separatorIdx <= 0) continue;
    const key = trimmed.slice(0, separatorIdx).trim();
    const value = trimmed.slice(separatorIdx + 1).trim();
    if (key && process.env[key] === undefined) process.env[key] = value;
  }
};

loadDotEnv();

const app = express();

const getEnv = (key, fallback = '') => {
  const value = process.env[key];
  return value === undefined ? fallback : value;
};

const PORT = Number(getEnv('PORT', 3000));
const DB_FILE = getEnv('DB_FILE', './streams_db.json');
const APP_TITLE = getEnv('APP_TITLE', 'VarMatch TV');
const APP_VERSION = getEnv('APP_VERSION', 'v3.1');
const DONOR_STREAM_URL = getEnv('DONOR_STREAM_URL', '');
const DONOR_STREAM_SOURCES = String(getEnv('DONOR_STREAM_SOURCES', ''))
  .split(',')
  .map((item) => item.trim())
  .filter(Boolean);
const STREAM_DISCOVERY_ENABLED = getEnv('STREAM_DISCOVERY_ENABLED', '1') !== '0';
const STREAM_SCAN_LIMIT = Math.max(1, Number(getEnv('STREAM_SCAN_LIMIT', 4)) || 4);
const BASE_UPDATE_CRON = getEnv('REFRESH_MATCHES_CRON', '*/10 * * * *');
const FOOTBALL_API_URL = getEnv('FOOTBALL_API_URL', 'https://v3.football.api-sports.io/fixtures');
const FOOTBALL_API_KEY = getEnv('FOOTBALL_API_KEY', '');
const FOOTBALL_API_HOST = getEnv('FOOTBALL_API_HOST', 'v3.football.api-sports.io');

const LIVE_STATUSES = new Set(['LIVE', '1H', '2H', 'HT']);
const SCHEDULED_STATUSES = new Set(['NS', 'TBD', 'PST', 'SUSP', 'INT']);

const UI_CONFIG = {
  appTitle: APP_TITLE,
  appVersion: APP_VERSION,
  refreshMatchesMs: 30000,
  refreshStatsMs: 30000,
  refreshStreamsMs: 600000,
  accentColor: getEnv('ACCENT_COLOR', '#f43f5e')
};

const ensureDbFile = () => {
  if (!fs.existsSync(DB_FILE)) {
    const dbDir = path.dirname(DB_FILE);
    if (dbDir && dbDir !== '.' && !fs.existsSync(dbDir)) {
      fs.mkdirSync(dbDir, { recursive: true });
    }
    fs.writeFileSync(DB_FILE, JSON.stringify({ matches: [], updatedAt: null }, null, 2));
  }
};

ensureDbFile();

app.use(express.static('public'));

const readDb = () => {
  try {
    const file = fs.readFileSync(DB_FILE, 'utf8').trim();
    if (!file) {
      return { matches: [], updatedAt: null, lastStatsUpdateAt: null, lastStreamScanAt: null };
    }

    const raw = JSON.parse(file);
    return {
      matches: Array.isArray(raw.matches) ? raw.matches : [],
      updatedAt: raw.updatedAt || null,
      lastStatsUpdateAt: raw.lastStatsUpdateAt || null,
      lastStreamScanAt: raw.lastStreamScanAt || null
    };
  } catch {
    return { matches: [], updatedAt: null, lastStatsUpdateAt: null, lastStreamScanAt: null };
  }
};

const writeDb = (payload) => fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2));

const fetchJsonWithHttps = (url, headers = {}) => new Promise((resolve, reject) => {
  const request = https.request(url, { method: 'GET', headers }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
    });
    response.on('end', () => {
      const ok = (response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300;
      if (!ok) {
        reject(new Error(`Football API error: ${response.statusCode || 500}`));
        return;
      }

      try {
        resolve(JSON.parse(body));
      } catch {
        reject(new Error('Football API error: invalid JSON response'));
      }
    });
  });

  request.on('error', reject);
  request.end();
});

const fetchTextWithHttps = (url, headers = {}) => new Promise((resolve, reject) => {
  const request = https.request(url, { method: 'GET', headers }, (response) => {
    let body = '';
    response.setEncoding('utf8');
    response.on('data', (chunk) => {
      body += chunk;
    });
    response.on('end', () => {
      const ok = (response.statusCode || 500) >= 200 && (response.statusCode || 500) < 300;
      if (!ok) {
        reject(new Error(`Donor page error: ${response.statusCode || 500}`));
        return;
      }
      resolve(body);
    });
  });

  request.on('error', reject);
  request.end();
});

const createDonorUrl = (match, section = 'search') => {
  return createDonorUrlFromTemplate(DONOR_STREAM_URL, match, section);
};

const createDonorUrlFromTemplate = (template, match, section = 'search') => {
  if (!template) return '';

  const home = (match.homeTeam?.name || '').trim();
  const away = (match.awayTeam?.name || '').trim();
  const teamPair = `${home} ${away}`.trim();

  const withPlaceholders = template
    .replace(/\{home\}/g, encodeURIComponent(home))
    .replace(/\{away\}/g, encodeURIComponent(away))
    .replace(/\{query\}/g, encodeURIComponent(teamPair));

  try {
    const url = new URL(withPlaceholders);
    if (!url.searchParams.get('q') && teamPair) {
      url.searchParams.set('q', teamPair);
    }
    url.searchParams.set('only', 'stream,stats');
    url.searchParams.set('view', section);
    return url.toString();
  } catch {
    if (!teamPair) return withPlaceholders;
    const divider = withPlaceholders.includes('?') ? '&' : '?';
    return `${withPlaceholders}${divider}q=${encodeURIComponent(teamPair)}&only=stream%2Cstats&view=${encodeURIComponent(section)}`;
  }
};

const getDonorSources = () => {
  const sources = DONOR_STREAM_SOURCES.length ? DONOR_STREAM_SOURCES : (DONOR_STREAM_URL ? [DONOR_STREAM_URL] : []);
  return sources.slice(0, STREAM_SCAN_LIMIT);
};

const toIsoDate = (date) => date.toISOString().slice(0, 10);
const addDays = (date, diff) => new Date(date.getTime() + diff * 86400000);

const collectByRegex = (html, regex) => {
  const urls = [];
  let match = regex.exec(html);
  while (match) {
    urls.push(match[1]);
    match = regex.exec(html);
  }
  return urls;
};

const dedupeStreams = (streams) => {
  const seen = new Set();
  const unique = [];
  for (const item of streams) {
    if (!item?.url || seen.has(item.url)) continue;
    seen.add(item.url);
    unique.push(item);
  }
  return unique;
};

const discoverStreamsFromHtml = (html, baseUrl, providerName = 'donor') => {
  const iframeSources = collectByRegex(html, /<iframe[^>]+src=["']([^"']+)["']/gi);
  const sourceSources = collectByRegex(html, /<(?:source|video)[^>]+src=["']([^"']+)["']/gi);
  const directPlaylist = collectByRegex(html, /(https?:\/\/[^"'\s>]+\.(?:m3u8|mpd)(?:\?[^"'\s>]*)?)/gi);
  const hintedEmbed = collectByRegex(html, /(https?:\/\/[^"'\s>]*(?:embed|player)[^"'\s>]*)/gi);
  const base = new URL(baseUrl);

  const toAbsolute = (rawUrl) => {
    try {
      return new URL(rawUrl, base).toString();
    } catch {
      return '';
    }
  };

  const candidates = [
    ...iframeSources.map((url) => ({ provider: `${providerName} iframe`, type: 'embed', url: toAbsolute(url), embed: true })),
    ...sourceSources.map((url) => ({ provider: `${providerName} video`, type: 'direct', url: toAbsolute(url), embed: false })),
    ...directPlaylist.map((url) => ({ provider: `${providerName} playlist`, type: 'direct', url: toAbsolute(url), embed: false })),
    ...hintedEmbed.map((url) => ({ provider: `${providerName} player`, type: 'embed', url: toAbsolute(url), embed: true }))
  ];

  return dedupeStreams(candidates).filter((stream) => stream.url).slice(0, STREAM_SCAN_LIMIT);
};

async function discoverStreamsForMatch(match) {
  if (!STREAM_DISCOVERY_ENABLED) return [];

  const discovered = [];
  const sources = getDonorSources();
  for (const source of sources) {
    const donorSearchUrl = createDonorUrlFromTemplate(source, match, 'search');
    if (!donorSearchUrl) continue;

    try {
      const html = globalThis.fetch
        ? await (await globalThis.fetch(donorSearchUrl, { headers: { 'user-agent': 'Mozilla/5.0 VarMatchBot/1.0' } })).text()
        : await fetchTextWithHttps(donorSearchUrl, { 'user-agent': 'Mozilla/5.0 VarMatchBot/1.0' });

      const providerHost = new URL(donorSearchUrl).hostname.replace(/^www\./, '');
      discovered.push(...discoverStreamsFromHtml(html, donorSearchUrl, providerHost));
    } catch (error) {
      console.warn(`⚠️ Не удалось найти встроенный стрим для ${match.id} (${source}): ${error.message}`);
    }
  }

  return dedupeStreams(discovered).slice(0, STREAM_SCAN_LIMIT);
}

const normalizeStatus = (short) => {
  if (LIVE_STATUSES.has(short)) return short;
  if (short === 'FT' || short === 'AET' || short === 'PEN') return 'FINISHED';
  if (SCHEDULED_STATUSES.has(short)) return 'NOT_STARTED';
  return short || 'UNKNOWN';
};

const normalizeFixture = (item) => {
  const fixture = item.fixture || {};
  const teams = item.teams || {};
  const league = item.league || {};
  const goals = item.goals || {};
  const shortStatus = fixture.status?.short || '';

  return {
    id: String(fixture.id),
    competition: league.name || 'Unknown League',
    startTime: fixture.date,
    homeTeam: {
      name: teams.home?.name || 'Home',
      logo: teams.home?.logo || ''
    },
    awayTeam: {
      name: teams.away?.name || 'Away',
      logo: teams.away?.logo || ''
    },
    score: {
      home: goals.home ?? 0,
      away: goals.away ?? 0
    },
    status: normalizeStatus(shortStatus),
    apiStatus: shortStatus,
    minute: fixture.status?.elapsed ?? null,
    streams: getDonorSources().length
      ? [{ provider: 'Donor', type: 'redirect', url: createDonorUrl({ homeTeam: { name: teams.home?.name }, awayTeam: { name: teams.away?.name } }, 'stream'), embed: false }]
      : [],
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
};

const isLive = (m) => LIVE_STATUSES.has(m.apiStatus) || m.status === 'LIVE';
const isToday = (m, today) => String(m.startTime).slice(0, 10) === today;
const isTomorrow = (m, tomorrow) => String(m.startTime).slice(0, 10) === tomorrow;

const mergeUniqueById = (existing, incoming) => {
  const byId = new Map(existing.map((m) => [m.id, m]));
  for (const match of incoming) {
    const prev = byId.get(match.id);
    byId.set(match.id, {
      ...(prev || {}),
      ...match,
      streams: match.streams?.length ? match.streams : (prev?.streams || [])
    });
  }
  return [...byId.values()];
};

const removeOldFinished = (matches) => {
  const now = Date.now();
  const maxAgeMs = 24 * 60 * 60 * 1000;
  return matches.filter((m) => {
    if (m.status !== 'FINISHED' || !m.startTime) return true;
    return now - new Date(m.startTime).getTime() <= maxAgeMs;
  });
};

const sortForUi = (matches, today, tomorrow) => {
  const rank = (m) => {
    if (isLive(m)) return 0;
    if (isToday(m, today)) return 1;
    if (isTomorrow(m, tomorrow)) return 2;
    return 3;
  };

  return [...matches].sort((a, b) => {
    const byRank = rank(a) - rank(b);
    if (byRank !== 0) return byRank;
    return new Date(a.startTime) - new Date(b.startTime);
  });
};

async function fetchFixturesByDate(dateStr) {
  if (!FOOTBALL_API_KEY) {
    console.warn('⚠️ FOOTBALL_API_KEY отсутствует — данные матчей не обновлены');
    return [];
  }

  const url = new URL(FOOTBALL_API_URL);
  url.searchParams.set('date', dateStr);

  const headers = {
    'x-apisports-key': FOOTBALL_API_KEY,
    'x-apisports-host': FOOTBALL_API_HOST
  };

  const payload = globalThis.fetch
    ? await (await globalThis.fetch(url, { headers })).json()
    : await fetchJsonWithHttps(url, headers);
  return Array.isArray(payload.response) ? payload.response.map(normalizeFixture) : [];
}

async function refreshMatchesFromApi() {
  const now = new Date();
  const today = toIsoDate(now);
  const tomorrow = toIsoDate(addDays(now, 1));

  const [todayMatches, tomorrowMatches] = await Promise.all([
    fetchFixturesByDate(today),
    fetchFixturesByDate(tomorrow)
  ]);

  const candidates = [...todayMatches, ...tomorrowMatches].filter(
    (m) => isLive(m) || isToday(m, today) || isTomorrow(m, tomorrow)
  );

  const db = readDb();
  const merged = mergeUniqueById(db.matches, candidates);
  const pruned = removeOldFinished(merged).filter(
    (m) => isLive(m) || isToday(m, today) || isTomorrow(m, tomorrow)
  );
  const sorted = sortForUi(pruned, today, tomorrow);

  writeDb({ ...db, matches: sorted, updatedAt: new Date().toISOString() });
  console.log(`✅ Обновлены матчи из API: ${sorted.length}`);
}

async function refreshLiveMatches() {
  const db = readDb();
  const live = db.matches.filter(isLive);
  if (!live.length) return;

  try {
    const now = new Date();
    const today = toIsoDate(now);
    const tomorrow = toIsoDate(addDays(now, 1));
    const [todayMatches, tomorrowMatches] = await Promise.all([
      fetchFixturesByDate(today),
      fetchFixturesByDate(tomorrow)
    ]);
    const merged = mergeUniqueById(db.matches, [...todayMatches, ...tomorrowMatches]);
    const sorted = sortForUi(removeOldFinished(merged), today, tomorrow);
    writeDb({ ...db, matches: sorted, lastStatsUpdateAt: new Date().toISOString() });
    console.log('📊 Обновлены LIVE матчи (30с)');
  } catch (error) {
    console.error('❌ Ошибка обновления LIVE матчей:', error.message);
  }
}

async function refreshStreams() {
  const db = readDb();
  try {
    const matches = await Promise.all(db.matches.map(async (match) => {
    const discovered = await discoverStreamsForMatch(match);
    const fallback = getDonorSources().length
      ? [{ provider: 'Donor', type: 'redirect', url: createDonorUrl(match, 'stream'), embed: false }]
      : [];

    return {
      ...match,
      streams: discovered.length ? discovered : fallback,
      streamUpdatedAt: new Date().toISOString()
    };
  }));
    writeDb({ ...db, matches, lastStreamScanAt: new Date().toISOString() });
    console.log('🎥 Обновлены ссылки и встроенные трансляции');
  } catch (error) {
    console.error('❌ Ошибка сканирования трансляций:', error.message);
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', app: APP_TITLE, version: APP_VERSION });
});

app.get('/api/config', (_req, res) => res.json(UI_CONFIG));

app.get('/matches', (req, res) => {
  const db = readDb();
  const status = String(req.query.status || '').toUpperCase();
  const league = String(req.query.league || '').toLowerCase();

  let matches = [...db.matches];
  if (status) matches = matches.filter((m) => String(m.status).toUpperCase() === status);
  if (league) matches = matches.filter((m) => m.competition.toLowerCase().includes(league));

  res.json({ total: matches.length, updatedAt: db.updatedAt, matches });
});

app.get('/live', (_req, res) => {
  const db = readDb();
  const live = db.matches.filter(isLive);
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
  if (!item.streams?.length && !getDonorSources().length) {
    return res.status(404).json({ error: 'Поток не найден: укажите DONOR_STREAM_URL или DONOR_STREAM_SOURCES' });
  }

  const donorStreamUrl = createDonorUrl(item, 'stream');
  const donorStatsUrl = createDonorUrl(item, 'stats');
  const donorSearchUrl = createDonorUrl(item, 'search');

  return res.json({
    id: item.id,
    title: `${item.homeTeam.name} vs ${item.awayTeam.name}`,
    stream: item.streams?.[0]?.url || donorStreamUrl,
    streamType: item.streams?.[0]?.type || 'redirect',
    streamEmbed: Boolean(item.streams?.[0]?.embed),
    streams: item.streams || [],
    donorStatsUrl,
    donorSearchUrl,
    competition: item.competition,
    status: item.status,
    minute: item.minute,
    score: item.score,
    stats: item.stats
  });
});

app.get('/go/:id', (req, res) => {
  const db = readDb();
  const item = db.matches.find((m) => m.id === req.params.id);
  if (!item) return res.status(404).json({ error: 'Матч не найден' });
  if (item.streams?.[0]) {
    return res.redirect(`/player.html?id=${encodeURIComponent(item.id)}`);
  }
  if (!DONOR_STREAM_URL) return res.status(404).json({ error: 'Укажите DONOR_STREAM_URL' });
  return res.redirect(createDonorUrl(item, 'search'));
});

cron.schedule(BASE_UPDATE_CRON, () => {
  refreshMatchesFromApi().catch((error) => {
    console.error('❌ Ошибка обновления матчей:', error.message);
  });
});
setInterval(refreshLiveMatches, 30000);
setInterval(() => {
  refreshStreams();
}, 10 * 60 * 1000);

refreshMatchesFromApi()
  .then(refreshStreams)
  .catch((error) => console.error('❌ Ошибка первичной загрузки:', error.message));

app.listen(PORT, () => console.log(`Server running on :${PORT}`));
