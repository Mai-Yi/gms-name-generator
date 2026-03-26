/**
 * Fetch Nexon MapleStory maintenance: latest 5 posts (all types). Translate via DeepSeek only when new.
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

async function scrapeMaintenanceLinksFromPage(page) {
  return page.evaluate(() => {
    const base = 'https://www.nexon.com';
    const seen = new Set();
    const out = [];
    document.querySelectorAll('a[href*="/maplestory/news/maintenance/"]').forEach((a) => {
      let href = a.getAttribute('href') || '';
      if (!href || href.startsWith('#')) return;
      try {
        const u = href.startsWith('http') ? new URL(href) : new URL(href, base);
        const path = u.pathname.split('?')[0];
        if (!path.includes('/maintenance/')) return;
        if (seen.has(path)) return;
        seen.add(path);
        const mid = path.match(/\/maintenance\/(\d+)\//);
        const id = mid ? mid[1] : path;
        let title = (a.innerText || '').trim().replace(/\s+/g, ' ');
        if (title.length < 2) title = path.split('/').filter(Boolean).pop() || path;
        out.push({
          id: String(id),
          title: title.slice(0, 200),
          url: base + path,
          startTime: '',
          endTime: '',
          body: '',
        });
      } catch (_) {}
    });
    return out;
  });
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
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    await page.waitForSelector('a[href*="/maplestory/news/maintenance/"]', { timeout: 30000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
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
    let domItems = [];
    try {
      domItems = await scrapeMaintenanceLinksFromPage(page);
    } catch (_) {}
    return { html, extractedBody, domItems };
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

function extractHeadlineFromBody(body) {
  if (!body || typeof body !== 'string') return '';
  const lines = body.trim().split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  if (lines.length < 2) return '';
  const skipFirst = /^(MAINTENANCE|maintenance)$/i.test(lines[0]) ? 1 : 0;
  const datePattern = /^\d{4}[年\/\-]|\d{1,2}\s+(?:Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)|(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday)\s*,?\s*\d/;
  let i = skipFirst;
  while (i < lines.length && datePattern.test(lines[i])) i++;
  const headline = i < lines.length ? lines[i] : '';
  return (headline.length > 3 && headline.length < 200) ? headline : '';
}

const TITLE_TRANSLATE_SYSTEM = 'Translate the following game maintenance article headline to Simplified Chinese. Output ONLY the translated headline, one line, no prefix, no date, no description. Examples: "V.267 Known Issues" -> "V.267 版本已知问题", "[Completed] Scheduled Game Update - March 18, 2026" -> "[已完成] 计划游戏更新 - 2026年3月18日".';

const TRANSLATE_SYSTEM = `Translate the following English game maintenance notice to Simplified Chinese. Keep the tone professional.

Rules:
(1) Outside the multi-line "Times" block: for inline times (PDT, EDT, UTC, CET, etc.), add Beijing time in parentheses right after, wrapped in <strong class="maintenance-time-beijing"></strong>, e.g. "3:18 PM PDT (<strong class="maintenance-time-beijing">北京时间 2026年3月20日 6:18</strong>)". Use specific dates (year month day), never use "次日" alone without date.

(2) For the maintenance times section (heading such as 维护时间详情、时间详情、时间对照、Times:): after the date line (e.g. "2026年3月26日，星期四"), output ONLY this structure:
    First bullet MUST be Beijing only, with red highlight class:
      * <strong class="maintenance-time-beijing maintenance-time-beijing-highlight">北京时间 (UTC +8): [month]月[day]日 [start] - [end; include next-day date if needed]</strong>
    Use Chinese time words (凌晨/上午/下午/晚上) and colon times like 8:00.
    Second bullet onward: ONLY the source timezones in the SAME ORDER as the English "Times" block (PDT, EDT, CET, AEDT, etc.). Translate zone names to Chinese, keep (UTC ±n). Each line one asterisk line, e.g. "* 太平洋夏令时 (UTC -7): 凌晨5:00 - 上午11:00". No extra parentheses with 北京时间 on these lines.

(3) Keep server/world names in English: Luna, Solis, Scania, Bera, Hyperion, Kronos, NA Challenger World, EU Challenger World, One-Punch Man Special World, Heroic Worlds, etc.

Output only the translation, no explanations.`;

async function translateWithDeepSeek(text, apiKey, opts = {}) {
  if (!text || !apiKey) return text;
  const sysPrompt = opts.titleOnly ? TITLE_TRANSLATE_SYSTEM : TRANSLATE_SYSTEM;
  const maxTokens = opts.titleOnly ? 200 : 8000;
  const res = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: sysPrompt },
        { role: 'user', content: text.slice(0, opts.titleOnly ? 500 : 10000) },
      ],
      max_tokens: maxTokens,
      temperature: opts.titleOnly ? 0.1 : 0.3,
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
    const headlineToTranslate = extractHeadlineFromBody(raw.body) || raw.title;
    if (headlineToTranslate) {
      try {
        titleZh = await translateWithDeepSeek(headlineToTranslate, apiKey, { titleOnly: true });
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
  const earlyCandidates = items.slice(0, 5);
  const earlyNewIds = earlyCandidates.map(c => (c.id || '').trim()).filter(Boolean).sort().join(',');
  const earlyExistingIds = existing.items.map(i => (i?.id || '').trim()).filter(Boolean).sort().join(',');
  if (earlyNewIds && earlyNewIds === earlyExistingIds) {
    console.log('No new maintenance (IDs unchanged), skip update.');
    process.exit(0);
  }
  let browser = null;
  if (items.length === 0) {
    console.log('Fetch returned empty, trying Puppeteer...');
    try {
      const puppeteer = require('puppeteer');
      browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
      const listRes = await fetchWithPuppeteer(MAINTENANCE_URL, browser);
      html = listRes?.html || listRes;
      if (html) items = parseMaintenanceList(html);
      if (items.length === 0 && listRes?.domItems?.length) {
        items = listRes.domItems;
        console.log('Parsed', items.length, 'maintenance links from DOM.');
      }
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

  const candidates = items.slice(0, 5);
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

  if (builtItems.length === 0 && existing.items && existing.items.length > 0) {
    console.warn('Built zero items (fetch/parse failed). Keeping existing file:', DATA_PATH, '(' + existing.items.length + ' items).');
    process.exit(0);
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
