import GLib from 'gi://GLib'
import Soup from 'gi://Soup?version=3.0'

const PUN_URL = 'https://www.abbassalebollette.it/glossario/pun-prezzo-unico-nazionale/'
const PSV_URL = 'https://www.abbassalebollette.it/glossario/psv/'

const MAX_DAYS = 60

function getCacheDir() {
  const base = GLib.get_user_cache_dir()
  const dir = GLib.build_filenamev([base, 'pun-psv'])
  GLib.mkdir_with_parents(dir, 0o755)
  return dir
}

function readCache(path) {
  try {
    const [ok, bytes] = GLib.file_get_contents(path)
    if (!ok) return null
    const text = new TextDecoder('utf-8').decode(bytes)
    const data = JSON.parse(text)
    if (!data || !Array.isArray(data.series) || !data.fetchedAt) return null
    data.series = data.series.map(row => ({
      date: new Date(row.date),
      value: row.value,
    }))
    return data
  } catch {
    return null
  }
}

function writeCache(path, data) {
  try {
    const payload = {
      fetchedAt: data.fetchedAt,
      latest: data.latest,
      series: data.series.map(row => ({
        date: row.date.toISOString().slice(0, 10),
        value: row.value,
      })),
    }
    const text = JSON.stringify(payload)
    GLib.file_set_contents(path, text)
  } catch {
    // Best-effort cache
  }
}

function isFresh(cache, ttlSeconds) {
  if (!cache) return false
  const age = Math.floor(Date.now() / 1000) - cache.fetchedAt
  return age >= 0 && age <= ttlSeconds
}

async function fetchText(session, url) {
  const message = Soup.Message.new('GET', url)
  message.get_request_headers().append('User-Agent', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')
  message.get_request_headers().append('Accept', 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8')
  message.get_request_headers().append('Accept-Language', 'it-IT,it;q=0.9,en;q=0.7')
  const bytes = await session.send_and_read_async(message, GLib.PRIORITY_DEFAULT, null)
  const status = message.get_status()
  if (status < 200 || status >= 300) throw new Error(`HTTP ${status} for ${url}`)
  return new TextDecoder('utf-8').decode(bytes.get_data())
}

function stripHtml(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;|&#160;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function parseDateString(value) {
  const m = value.match(/^(\d{2})[\/-](\d{2})[\/-](\d{4})$/)
  if (!m) return null
  const day = Number(m[1])
  const month = Number(m[2])
  const year = Number(m[3])
  if (!day || !month || !year) return null
  return new Date(year, month - 1, day)
}

function parseNumberString(value) {
  if (!value) return null
  let v = value.replace(/[^\d.,]/g, '')
  if (!v) return null
  if (v.includes(',') && v.includes('.')) {
    v = v.replace(/\./g, '').replace(',', '.')
  } else if (v.includes(',')) {
    v = v.replace(',', '.')
  }
  const n = Number(v)
  return Number.isNaN(n) ? null : n
}

function extractSeriesFromHtml(html) {
  const text = stripHtml(html)
  const regex = /(\d{2}[\/-]\d{2}[\/-]\d{4})[^0-9]{0,20}([\d.,]+)/g
  const rows = []
  let match
  while ((match = regex.exec(text)) !== null) {
    const date = parseDateString(match[1])
    const value = parseNumberString(match[2])
    if (!date || value === null) continue
    rows.push({ date, value })
  }
  rows.sort((a, b) => a.date - b.date)
  return rows
}

function filterLastDays(series, days) {
  const cutoff = new Date()
  cutoff.setDate(cutoff.getDate() - days)
  const filtered = series.filter(r => r.date >= cutoff)
  return filtered.length ? filtered : series
}

async function getData({
  session,
  url,
  cachePath,
  refreshMinutes,
  scale = 1,
}) {
  const ttlSeconds = Math.max(60, refreshMinutes * 60)
  const cached = readCache(cachePath)
  if (isFresh(cached, ttlSeconds)) {
    return { ...cached, stale: false }
  }

  try {
    const html = await fetchText(session, url)
    const raw = extractSeriesFromHtml(html)
    if (!raw.length) throw new Error('nessun dato trovato')

    const series = filterLastDays(raw, MAX_DAYS).map(row => ({
      date: row.date,
      value: row.value * scale,
    }))
    const latest = series[series.length - 1].value
    const payload = {
      fetchedAt: Math.floor(Date.now() / 1000),
      latest,
      series,
    }
    writeCache(cachePath, payload)
    return { ...payload, stale: false }
  } catch (e) {
    if (cached) return { ...cached, stale: true }
    throw e
  }
}

export async function getPunData(session, refreshMinutes) {
  const cacheDir = getCacheDir()
  const cachePath = GLib.build_filenamev([cacheDir, 'pun.json'])
  return getData({
    session,
    url: PUN_URL,
    cachePath,
    refreshMinutes,
    scale: 1 / 1000,
  })
}

export async function getPsvData(session, refreshMinutes) {
  const cacheDir = getCacheDir()
  const cachePath = GLib.build_filenamev([cacheDir, 'psv.json'])
  return getData({
    session,
    url: PSV_URL,
    cachePath,
    refreshMinutes,
    scale: 1,
  })
}
