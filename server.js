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
const DONOR_URL = getEnv('DONOR_URL', '');
const SCRAPE_ENABLED = getEnv('SCRAPE_ENABLED', 'true') !== 'false';
const SCRAPE_CRON = getEnv('SCRAPE_CRON', '*/30 * * * *');
const MAX_MATCHES = Number(getEnv('MAX_MATCHES', 250));
const STREAM_CAPTURE_TIMEOUT_MS = Number(getEnv('STREAM_CAPTURE_TIMEOUT_MS', 12000));

const UI_CONFIG = {
  appTitle: getEnv('APP_TITLE', 'VarMatch TV'),
  appVersion: getEnv('APP_VERSION', 'v2.1'),
  appTagline: getEnv('APP_TAGLINE', 'Матчи сегодня и прямые трансляции'),
  refreshIntervalMs: Number(getEnv('REFRESH_INTERVAL_MS', 60000)),
  accentColor: getEnv('ACCENT_COLOR', '#f43f5e')
};

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify({ matches: [], lastScrapedAt: null }, null, 2));
}

app.use(express.static('public'));

const readDatabase = () => {
  const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));

  if (Array.isArray(raw)) {
    return { matches: raw, lastScrapedAt: null };
  }

  return {
    matches: Array.isArray(raw.matches) ? raw.matches : [],
    lastScrapedAt: raw.lastScrapedAt || null
  };
};

const writeDatabase = (payload) => fs.writeFileSync(DB_FILE, JSON.stringify(payload, null, 2));

const createMatchId = (title, url) => Buffer.from(`${title}|${url}`).toString('base64url');

async function scrapeStreams() {
  if (!SCRAPE_ENABLED) {
    console.log('ℹ️ Парсер отключён (SCRAPE_ENABLED=false).');
    return;
  }

  if (!DONOR_URL) {
    console.log('ℹ️ DONOR_URL не задан. Пропускаем парсинг.');
    return;
  }

  let browser;

  try {
    const puppeteer = require('puppeteer');

    console.log('🚀 Воркер запущен: обновляем список матчей...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(DONOR_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    const nowIso = new Date().toISOString();
    const matches = await page.evaluate(({ maxMatches }) => {
      const items = Array.from(document.querySelectorAll('.match-item a'));

      return items
        .map((el) => {
          const title = (el.innerText || '').replace(/\s+/g, ' ').trim();
          const href = el.href;
          return {
            title,
            donorUrl: href
          };
        })
        .filter((item) => item.title && item.donorUrl)
        .slice(0, maxMatches);
    }, { maxMatches: MAX_MATCHES });

    const prepared = matches.map((match) => ({
      id: createMatchId(match.title, match.donorUrl),
      title: match.title,
      donorUrl: match.donorUrl,
      updatedAt: nowIso
    }));

    writeDatabase({
      matches: prepared,
      lastScrapedAt: nowIso
    });

    console.log(`✅ Найдено матчей: ${prepared.length}`);
  } catch (error) {
    console.error('❌ Ошибка воркера:', error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

async function resolveStreamByDonorUrl(donorUrl) {
  if (!donorUrl) return null;

  let browser;

  try {
    const puppeteer = require('puppeteer');

    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();

    let m3u8 = null;
    page.on('request', (request) => {
      const url = request.url();
      if (!m3u8 && url.includes('.m3u8')) {
        m3u8 = url;
      }
    });

    await page.goto(donorUrl, { waitUntil: 'networkidle2', timeout: 60000 });

    const start = Date.now();
    while (!m3u8 && Date.now() - start < STREAM_CAPTURE_TIMEOUT_MS) {
      await new Promise((resolve) => setTimeout(resolve, 250));
    }

    return m3u8;
  } catch (error) {
    console.error('❌ Ошибка получения потока:', error.message);
    return null;
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok', scrapeEnabled: SCRAPE_ENABLED });
});

app.get('/api/config', (_req, res) => {
  res.json(UI_CONFIG);
});

app.get('/api/matches', (_req, res) => {
  const db = readDatabase();
  res.json(db.matches);
});

app.get('/api/matches/today', (_req, res) => {
  const db = readDatabase();
  const today = new Date().toISOString().slice(0, 10);
  const items = db.matches.filter((match) => String(match.updatedAt || '').slice(0, 10) === today);

  res.json({
    date: today,
    total: items.length,
    lastScrapedAt: db.lastScrapedAt,
    matches: items
  });
});

app.get('/api/matches/:id/stream', async (req, res) => {
  const db = readDatabase();
  const match = db.matches.find((item) => item.id === req.params.id);

  if (!match) {
    return res.status(404).json({ error: 'Матч не найден' });
  }

  const stream = await resolveStreamByDonorUrl(match.donorUrl);
  if (!stream) {
    return res.status(404).json({ error: 'Поток не найден на доноре' });
  }

  return res.json({
    id: match.id,
    title: match.title,
    stream,
    donorUrl: match.donorUrl
  });
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q || '').trim();
  const db = readDatabase();

  if (!query) {
    return res.json([]);
  }

  const fuse = new Fuse(db.matches, { keys: ['title'], threshold: 0.35 });
  return res.json(fuse.search(query).map((result) => result.item));
});

if (SCRAPE_ENABLED && DONOR_URL) {
  cron.schedule(SCRAPE_CRON, scrapeStreams);
  scrapeStreams();
} else {
  console.log('ℹ️ Воркер не запущен. Установите DONOR_URL и проверьте SCRAPE_ENABLED.');
}

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
