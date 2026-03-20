/**
 * Fetch Nexon MapleStory maintenance: upcoming + last completed. Translate via DeepSeek only when new.
 * Run: node scripts/fetch-maintenance.js
 * Env: DEEPSEEK_API_KEY (optional, for translation)
 */

const fs = require('fs');
const path = require('path');

const MAINTENANCE_URL = 'https://www.nexon.com/maplestory/news/maintenance?page=1';
const DATA_PATH = path.join(__dirname, '..', 'data', 'maintenance.json');

function toBeijingTime(isoStr) {
  if (!isoStr) return '';
  const d = new Date(isoStr);
  if (isNaN(d.getTime())) return isoStr;
  return d.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function parseMaintenanceTime(str) {
  if (!str) return null;
  let d = new Date(str);
  if (!isNaN(d.getTime())) return d;
  const m = str.match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})[\sT](\d{1,2})?:?(\d{1,2})?/);
  if (m) {
    d = new Date(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), parseInt(m[4] || 0, 10), parseInt(m[5] || 0, 10));
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

async function fetchHtml(url) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,application/xhtml+xml',
      'Accept-Language': 'en-US,en;q=0.9',
    },
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function fetchWithPuppeteer(url, browser, opts) {
  const { dismissModal } = opts || {};
  let puppeteer;
  try {
    puppeteer = require('puppeteer');
  } catch {
    return null;
  }
  const ownBrowser = !browser;
  if (!browser) {
    browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  }
  try {
    const page = await browser.newPage();
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await new Promise(r => setTimeout(r, 2500));
    let html = '';
    let extractedBody = '';
    try {
      html = await page.content();
    } catch (e) {
      if (/context was destroyed|Target closed|navigation/i.test(String(e))) {
        await new Promise(r => setTimeout(r, 2000));
        try { html = await page.content(); } catch (_) { html = ''; }
      } else throw e;
    }
    try {
      extractedBody = await page.evaluate(() => {
        const inModal = (el) => el.closest('[class*="modal"],[class*="Modal"],[class*="popup"],[class*="overlay"],[class*="dialog"]');
        const sel = document.querySelector('article') || document.querySelector('main');
        if (sel && !inModal(sel)) {
          const t = sel.innerText.trim();
          if (t.length > 100) return t.slice(0, 12000);
        }
        const contents = document.querySelectorAll('[class*="content"],[class*="Content"],[class*="article"],[class*="Article"]');
        let best = '';
        for (const el of contents) {
          if (inModal(el)) continue;
          const t = el.innerText.trim();
          if (t.length > 150 && t.length > best.length) best = t;
        }
        return best.slice(0, 12000);
      });
    } catch (e) {
      if (!/context was destroyed|Target closed|navigation/i.test(String(e))) throw e;
    }
    return { html, extractedBody };
  } finally {
    if (ownBrowser) await browser.close();
  }
}

function parseArticleBody(html) {
  const MAX = 12000;
  const nextData = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextData) {
    try {
      const data = JSON.parse(nextData[1]);
      const walk = (obj) => {
        if (!obj) return '';
        if (typeof obj === 'string' && obj.length > 200) return obj;
        if (Array.isArray(obj)) return obj.map(walk).filter(Boolean).join('\n\n');
        if (typeof obj === 'object') {
          for (const k of ['content', 'body', 'description', 'text', 'newsContent', 'articleBody', 'htmlContent', 'detail', 'newsDetail']) {
            if (obj[k] && typeof obj[k] === 'string' && obj[k].length > 100) return obj[k];
          }
          for (const v of Object.values(obj)) {
            const r = walk(v);
            if (r && r.length > 200) return r;
          }
        }
        return '';
      };
      let body = walk(data).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      if (!body) {
        const str = JSON.stringify(data);
        const m = str.match(/"content":"([^"]{300,12000})"/) || str.match(/"body":"([^"]{300,12000})"/);
        if (m) body = m[1].replace(/\\n/g, '\n').replace(/\\"/g, '"');
      }
      if (body) return body.slice(0, MAX);
    } catch (_) {}
  }
  const articleMatch = html.match(/<article[^>]*>([\s\S]*?)<\/article>/i);
  if (articleMatch) {
    const text = articleMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 100) return text.slice(0, MAX);
  }
  const mainMatch = html.match(/<main[^>]*>([\s\S]*?)<\/main>/i);
  if (mainMatch) {
    const text = mainMatch[1].replace(/<script[\s\S]*?<\/script>/gi, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    if (text.length > 100) return text.slice(0, MAX);
  }
  return '';
}

function isKnownIssuesOnly(item) {
  const url = (item.url || '').toLowerCase();
  const title = (item.title || '').toLowerCase();
  if (!/known\s*issues/.test(title + ' ' + url)) return false;
  if (/completed|scheduled\s+(game\s+)?update|maintenance\s+and\s+live\s+patch/.test(title)) return false;
  return true;
}

async function checkIsMaintenanceSchedule(title, body, apiKey) {
  if (!apiKey) return true;
  const text = ((title || '') + '\n\n' + (body || '')).slice(0, 3000);
  if (!text.trim()) return false;
  try {
    const res = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [
          { role: 'system', content: 'Does this game maintenance notice mention specific maintenance start/end times (e.g. UTC, date, duration)? Answer only: yes or no.' },
          { role: 'user', content: text },
        ],
        max_tokens: 10,
        temperature: 0,
      }),
    });
    if (!res.ok) return true;
    const data = await res.json();
    const ans = (data?.choices?.[0]?.message?.content || '').trim().toLowerCase();
    return ans.startsWith('yes');
  } catch (_) {
    return true;
  }
}

function parseMaintenanceList(html) {
  const items = [];
  const baseUrl = 'https://www.nexon.com';

  const nextData = html.match(/<script id="__NEXT_DATA__" type="application\/json">([\s\S]*?)<\/script>/);
  if (nextData) {
    try {
      const data = JSON.parse(nextData[1]);
      const props = data?.props?.pageProps;
      const list = props?.newsList ?? props?.list ?? props?.items ?? props?.data ?? [];
      const arr = Array.isArray(list) ? list : (list?.items ?? list?.news ?? []);
      for (const it of arr) {
        const id = it.id ?? it.newsId ?? it.articleId;
        const title = it.title ?? it.name ?? '';
        const urlPath = it.url ?? it.link ?? it.slug ?? (id ? `/maplestory/news/maintenance/${id}` : '');
        const startTime = it.startTime ?? it.start ?? it.startDate ?? it.publishedAt ?? it.date ?? '';
        const endTime = it.endTime ?? it.end ?? it.endDate ?? it.updatedAt ?? '';
        const body = it.body ?? it.content ?? it.description ?? it.summary ?? '';
        items.push({
          id: String(id || ''),
          title: String(title).trim(),
          url: urlPath.startsWith('http') ? urlPath : baseUrl + (urlPath.startsWith('/') ? urlPath : '/maplestory/news/maintenance/' + id),
          startTime: String(startTime),
          endTime: String(endTime),
          body: String(body).trim().slice(0, 8000),
        });
      }
    } catch (e) {
      console.warn('__NEXT_DATA__ parse failed:', e.message);
    }
  }

  if (items.length === 0) {
    const linkRe = /href="(\/maplestory\/news\/(?:maintenance|update)\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const seen = new Set();
    let m;
    while ((m = linkRe.exec(html)) !== null) {
      const urlPath = m[1];
      const inner = m[2].replace(/<[^>]+>/g, '').trim();
      if (inner.length > 3 && !seen.has(urlPath)) {
        seen.add(urlPath);
        const id = urlPath.replace(/.*\/(\d+)(?:\/|$)/, '$1') || urlPath;
        items.push({
          id,
          title: inner.slice(0, 200),
          url: baseUrl + urlPath,
          startTime: '',
          endTime: '',
          body: '',
        });
      }
    }
  }

  return items;
}

function extractTimesFromBody(body) {
  const times = { start: '', end: '' };
  if (!body) return times;
  const utcMatch = body.match(/(\d{4}[-\/]\d{1,2}[-\/]\d{1,2}\s+\d{1,2}:?\d{0,2}\s*[Uu][Tt][Cc]?)/g);
  const dateMatch = body.match(/([A-Za-z]+\s+\d{1,2},?\s+\d{4}\s+\d{1,2}:?\d{0,2}\s*(?:[AP]M)?\s*[Uu][Tt][Cc]?)/g);
  const isoMatch = body.match(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/g);
  const arr = [...(utcMatch || []), ...(dateMatch || []), ...(isoMatch || [])];
  if (arr.length >= 2) {
    times.start = arr[0];
    times.end = arr[1];
  } else if (arr.length >= 1) {
    times.start = arr[0];
  }
  return times;
}

const TRANSLATE_SYSTEM = 'Translate the following English game maintenance notice to Simplified Chinese. Keep the tone professional. Rules: (1) For any time mentioned (PDT, EDT, UTC, CET, etc.), add Beijing time with full date in parentheses right after it, wrapped in <strong class="maintenance-time-beijing"></strong>, e.g. "3:18 PM PDT (<strong class="maintenance-time-beijing">北京时间 2026年3月20日 6:18</strong>)" or "12:00 AM UTC (<strong class="maintenance-time-beijing">北京时间 2026年3月19日 8:00</strong>)". Always use the specific date (year month day), never use "次日". (2) Keep server/world names in English: Luna, Solis, Scania, Bera, Hyperion, Kronos, NA Challenger World, EU Challenger World, One-Punch Man Special World, Heroic Worlds, etc. Output only the translation, no explanations.';

async function translateWithDeepSeek(text, apiKey) {
  if (!text || !apiKey) return text;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: TRANSLATE_SYSTEM },
        { role: 'user', content: text.slice(0, 10000) },
      ],
      max_tokens: 8000,
      temperature: 0.3,
    }),
  });
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`DeepSeek API ${res.status}: ${err}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  return content ? content.trim() : text;
}

async function buildItem(raw, cached, apiKey) {
  const cachedItem = cached && sameIds(raw, cached) ? cached : null;
  const bodyUntranslated = !cachedItem?.bodyZh || cachedItem.bodyZh === (cachedItem?.body || raw.body);
  const needTranslate = (!cachedItem?.titleZh || !cachedItem?.bodyZh) || (apiKey && bodyUntranslated);
  let titleZh = cachedItem?.titleZh || '';
  let bodyZh = cachedItem?.bodyZh || '';
  if (apiKey && needTranslate) {
    if (raw.title) {
      try {
        titleZh = await translateWithDeepSeek(raw.title, apiKey);
      } catch (e) {
        console.warn('Translate title failed:', e.message);
      }
    }
    if (raw.body) {
      try {
        bodyZh = await translateWithDeepSeek(raw.body, apiKey);
      } catch (e) {
        console.warn('Translate body failed:', e.message);
      }
    }
  }
  return {
    id: raw.id,
    title: raw.title,
    titleZh: titleZh || raw.title,
    url: raw.url,
    startTime: raw.startTime || '',
    endTime: raw.endTime || '',
    startTimeBeijing: toBeijingTime(raw.startTime),
    endTimeBeijing: toBeijingTime(raw.endTime),
    body: raw.body || '',
    bodyZh: bodyZh || raw.body || '',
  };
}

function sameIds(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  const idA = a.id || (a.url || '').replace(/#.*$/, '');
  const idB = b.id || (b.url || '').replace(/#.*$/, '');
  return idA === idB;
}

async function main() {
  const apiKey = process.env.DEEPSEEK_API_KEY;
  if (!apiKey) {
    console.warn('DEEPSEEK_API_KEY not set. Will save without translation.');
  }

  let existing = { items: [] };
  try {
    const prev = JSON.parse(fs.readFileSync(DATA_PATH, 'utf8'));
    existing.items = Array.isArray(prev?.items) ? prev.items : [];
  } catch (_) {}

  console.log('Fetching maintenance page...');
  let html = await fetchHtml(MAINTENANCE_URL);
  let items = parseMaintenanceList(html);
  let browser = null;
  if (items.length === 0) {
    console.log('Fetch returned empty, trying Puppeteer...');
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const listRes = await fetchWithPuppeteer(MAINTENANCE_URL, browser);
      html = listRes?.html || listRes;
      if (html) items = parseMaintenanceList(html);
    } catch (e) {
      console.warn('Puppeteer failed:', e.message);
    }
  }
  if (!browser && items.length > 0) {
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
    } catch (_) {}
  }

  const candidates = items.filter(raw => !isKnownIssuesOnly(raw));
  const rawItems = [];
  for (const raw of candidates) {
    if (rawItems.length >= 5) break;
    let body = raw.body;
    if (raw.url && browser) {
      console.log('Fetching detail:', raw.url.slice(0, 55) + '...');
      const detailRes = await fetchWithPuppeteer(raw.url, browser, { dismissModal: true });
      const detailHtml = detailRes?.html ?? detailRes;
      if (detailHtml) {
        body = parseArticleBody(detailHtml) || (detailRes?.extractedBody || '');
        body = (body || '').replace(/^(?:NEWS\s+CHECK OUT THE LATEST NEWS[\s\S]*?MAINTENANCE\s+)?/i, '').trim();
        raw.body = body;
      }
    }
    const combined = ((raw.title || '') + '\n' + (body || '')).trim();
    if (!combined) continue;
    const isSchedule = await checkIsMaintenanceSchedule(raw.title, body, apiKey);
    if (!isSchedule) {
      console.log('Skip (no maintenance time):', (raw.title || '').slice(0, 50) + '...');
      continue;
    }
    const times = extractTimesFromBody(body || '');
    if (times.start && !raw.startTime) raw.startTime = times.start;
    if (times.end && !raw.endTime) raw.endTime = times.end;
    rawItems.push(raw);
  }
  if (browser) await browser.close();

  const forceFetch = process.env.FORCE_FETCH === '1' || process.argv.includes('--force');
  const existingIds = existing.items.map(i => i?.id || '').join(',');
  const newIds = rawItems.map(r => r.id || '').join(',');
  const needDeepSeek = forceFetch || existingIds !== newIds;
  const noChange = existingIds === newIds && rawItems.length > 0;

  if (!forceFetch && noChange) {
    console.log('No new maintenance, skip update.');
    process.exit(0);
  }

  const builtItems = [];
  for (let i = 0; i < rawItems.length; i++) {
    const raw = rawItems[i];
    const cached = forceFetch ? null : existing.items.find(e => sameIds(raw, e));
    builtItems.push(await buildItem(raw, cached, needDeepSeek ? apiKey : null));
  }

  const output = {
    updatedAt: new Date().toISOString(),
    items: builtItems,
  };
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2), 'utf8');
  console.log('Wrote', DATA_PATH);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
