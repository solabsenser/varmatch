const express = require('express');
const cron = require('node-cron');
const Fuse = require('fuse.js');
const fs = require('fs');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = './streams_db.json';
const DONOR_URL = process.env.DONOR_URL || '';
const SCRAPE_ENABLED = process.env.SCRAPE_ENABLED !== 'false';

if (!fs.existsSync(DB_FILE)) {
  fs.writeFileSync(DB_FILE, JSON.stringify([]));
}

app.use(express.static('public'));

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

    console.log('🚀 Воркер запущен: поиск трансляций...');
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });

    const page = await browser.newPage();
    await page.goto(DONOR_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    const matches = await page.evaluate(() => {
      const items = Array.from(document.querySelectorAll('.match-item a'));
      return items
        .map((el) => ({
          title: (el.innerText || '').trim().toLowerCase(),
          url: el.href
        }))
        .filter((item) => item.title && item.url);
    });

    const results = [];

    for (const match of matches.slice(0, 10)) {
      const matchPage = await browser.newPage();
      let m3u8 = null;

      matchPage.on('request', (request) => {
        if (request.url().includes('.m3u8')) {
          m3u8 = request.url();
        }
      });

      await matchPage.goto(match.url, { waitUntil: 'networkidle2', timeout: 60000 });
      await new Promise((resolve) => setTimeout(resolve, 5000));

      if (m3u8) {
        results.push({ title: match.title, stream: m3u8 });
      }

      await matchPage.close();
    }

    fs.writeFileSync(DB_FILE, JSON.stringify(results, null, 2));
    console.log(`✅ Найдено стримов: ${results.length}`);
  } catch (error) {
    console.error('❌ Ошибка воркера:', error.message);
  } finally {
    if (browser) {
      await browser.close();
    }
  }
}

app.get('/healthz', (_req, res) => {
  res.json({ status: 'ok' });
});

app.get('/api/matches', (_req, res) => {
  const db = JSON.parse(fs.readFileSync(DB_FILE));
  res.json(db);
});

app.get('/api/search', (req, res) => {
  const query = String(req.query.q || '').trim();
  const db = JSON.parse(fs.readFileSync(DB_FILE));

  if (!query) {
    return res.json([]);
  }

  const fuse = new Fuse(db, { keys: ['title'], threshold: 0.4 });
  return res.json(fuse.search(query));
});

if (SCRAPE_ENABLED && DONOR_URL) {
  cron.schedule('*/30 * * * *', scrapeStreams);
  scrapeStreams();
} else {
  console.log('ℹ️ Воркер не запущен. Установите DONOR_URL и проверьте SCRAPE_ENABLED.');
}

app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));
