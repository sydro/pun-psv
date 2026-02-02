import GLib from 'gi://GLib'
import Soup from 'gi://Soup?version=3.0'

const PUN_URL = 'https://www.abbassalebollette.it/glossario/pun-prezzo-unico-nazionale/'
const PSV_URL = 'https://www.abbassalebollette.it/glossario/psv/'

const MAX_DAYS = 30

const MONTHS_IT = [
  'gennaio',
  'febbraio',
  'marzo',
  'aprile',
  'maggio',
  'giugno',
  'luglio',
  'agosto',
  'settembre',
  'ottobre',
  'novembre',
  'dicembre',
]
const MONTH_INDEX = Object.fromEntries(MONTHS_IT.map((m, i) => [m, i]))

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
    if (Array.isArray(data.monthlySeries) && data.monthlySeries.length > 0) {
      data.monthlySeries = data.monthlySeries.map(row => ({
        date: new Date(row.date),
        value: row.value,
      }))
    } else {
      data.monthlySeries = null
    }
    if (data.previousMonth && typeof data.previousMonth.value === 'number') {
      data.previousMonth = {
        label: data.previousMonth.label ?? null,
        value: data.previousMonth.value,
      }
    } else {
      data.previousMonth = null
    }
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
      previousMonth: data.previousMonth ?? null,
      monthlySeries: Array.isArray(data.monthlySeries)
        ? data.monthlySeries.map(row => ({
          date: row.date.toISOString().slice(0, 10),
          value: row.value,
        }))
        : null,
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

function extractSection(text, startMarkers, endMarkers) {
  const lower = text.toLowerCase()
  let startIndex = -1
  for (const marker of startMarkers) {
    const idx = lower.indexOf(marker.toLowerCase())
    if (idx !== -1 && (startIndex === -1 || idx < startIndex)) startIndex = idx
  }
  if (startIndex === -1) return text
  let endIndex = -1
  for (const marker of endMarkers) {
    const idx = lower.indexOf(marker.toLowerCase(), startIndex + 1)
    if (idx !== -1 && (endIndex === -1 || idx < endIndex)) endIndex = idx
  }
  if (endIndex === -1) return text.slice(startIndex)
  return text.slice(startIndex, endIndex)
}

function getPreviousMonthInfo(date = new Date()) {
  const year = date.getFullYear()
  const month = date.getMonth()
  const prev = new Date(year, month - 1, 1)
  return {
    monthName: MONTHS_IT[prev.getMonth()],
    year: prev.getFullYear(),
  }
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
  const rows = []

  const regex = /(\d{2}[\/-]\d{2}[\/-]\d{4})[^0-9]{0,50}([0-9]+(?:[.,][0-9]+)?)(?:\s*€\/?(?:kWh|MWh|Smc))?/gi
  let match
  while ((match = regex.exec(text)) !== null) {
    const date = parseDateString(match[1])
    const value = parseNumberString(match[2])
    if (!date || value === null) continue
    rows.push({ date, value })
  }

  if (!rows.length) {
    const dateRegex = /(\d{2}[\/-]\d{2}[\/-]\d{4})/g
    let dateMatch
    while ((dateMatch = dateRegex.exec(text)) !== null) {
      const date = parseDateString(dateMatch[1])
      if (!date) continue
      const start = dateMatch.index + dateMatch[0].length
      const slice = text.slice(start, start + 120)
      const valueMatch = slice.match(/([0-9]+(?:[.,][0-9]+)?)(?:\s*€\/?(?:kWh|MWh|Smc))?/i)
      if (!valueMatch) continue
      const value = parseNumberString(valueMatch[1])
      if (value === null) continue
      rows.push({ date, value })
    }
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

function extractPreviousMonthValue(html, kind) {
  const text = stripHtml(html)
  const { monthName, year } = getPreviousMonthInfo()
  const label = `${monthName.charAt(0).toUpperCase()}${monthName.slice(1)} ${year}`

  if (kind === 'pun') {
    const section = extractSection(
      text,
      ['i valori di pun monorario attuali'],
      ['il pun spiegato', 'storico pun']
    )
    const regex = /PUN\s+([A-Za-zà]+)\s+(\d{4})(?:\s*\[[^\]]+\])?\s+([0-9.,]+)\s*€\/?kWh/gi
    let match
    while ((match = regex.exec(section)) !== null) {
      const m = match[1].toLowerCase()
      const y = Number(match[2])
      if (m === monthName && y === year) {
        const value = parseNumberString(match[3])
        return value === null ? null : { label, value }
      }
    }
    return null
  }

  const section = extractSection(
    text,
    ['valori indice psv per mese e anno', 'valori indice psv'],
    ['indice psv', 'psv spiegato']
  )
  const regex = /PSV\s+([A-Za-zà]+)\s+(\d{4})(?:\s*\[[^\]]+\])?\s+([0-9.,]+)(?:\s*\[[^\]]+\])?\s+([0-9.,]+)/gi
  let match
  while ((match = regex.exec(section)) !== null) {
    const m = match[1].toLowerCase()
    const y = Number(match[2])
    if (m === monthName && y === year) {
      const value = parseNumberString(match[4])
      return value === null ? null : { label, value }
    }
  }

  // Fallback: usa la tabella HTML vera e propria (piu' affidabile)
  const tableSection = extractSection(
    html,
    ['Valori Indice PSV per Mese e Anno'],
    ['</table>']
  )
  const rowRegex = new RegExp(
    '<tr[^>]*>\\s*<td[^>]*>\\s*<strong>\\s*PSV\\s+([A-Za-zà]+)\\s+(\\d{4})[^<]*<\\/strong>\\s*<\\/td>' +
    '\\s*<td[^>]*>\\s*<strong>[^<]*<\\/strong>\\s*<\\/td>' +
    '\\s*<td[^>]*>\\s*<strong>\\s*([0-9.,]+)[^<]*<\\/strong>',
    'gi'
  )
  let row
  while ((row = rowRegex.exec(tableSection)) !== null) {
    const m = row[1].toLowerCase()
    const y = Number(row[2])
    if (m === monthName && y === year) {
      const value = parseNumberString(row[3])
      return value === null ? null : { label, value }
    }
  }

  const rowRegexPlain = new RegExp(
    '<tr[^>]*>\\s*<td[^>]*>\\s*PSV\\s+([A-Za-zà]+)\\s+(\\d{4})[^<]*<\\/td>' +
    '\\s*<td[^>]*>\\s*[^<]*<\\/td>' +
    '\\s*<td[^>]*>\\s*([0-9.,]+)\\s*<\\/td>',
    'gi'
  )
  while ((row = rowRegexPlain.exec(tableSection)) !== null) {
    const m = row[1].toLowerCase()
    const y = Number(row[2])
    if (m === monthName && y === year) {
      const value = parseNumberString(row[3])
      return value === null ? null : { label, value }
    }
  }

  return null
}

function extractMonthlySeries(html, kind) {
  const text = stripHtml(html)
  const rows = []

  if (kind === 'pun') {
    const section = extractSection(
      text,
      ['i valori di pun monorario attuali'],
      ['il pun spiegato', 'storico pun']
    )
    const regex = /PUN\s+([A-Za-zà]+)\s+(\d{4})(?:\s*\[[^\]]+\])?\s+([0-9.,]+)\s*€\/?kWh/gi
    let match
    while ((match = regex.exec(section)) !== null) {
      const monthName = match[1].toLowerCase()
      const year = Number(match[2])
      if (monthName === 'oggi' || !(monthName in MONTH_INDEX)) continue
      const value = parseNumberString(match[3])
      if (value === null) continue
      rows.push({ date: new Date(year, MONTH_INDEX[monthName], 1), value })
    }
  } else {
    const tableSection = extractSection(
      html,
      ['Valori Indice PSV per Mese e Anno'],
      ['</table>']
    )
    const regexStrong = new RegExp(
      '<tr[^>]*>\\s*<td[^>]*>\\s*<strong>\\s*PSV\\s+([A-Za-zà]+)\\s+(\\d{4})[^<]*<\\/strong>\\s*<\\/td>' +
      '\\s*<td[^>]*>\\s*<strong>[^<]*<\\/strong>\\s*<\\/td>' +
      '\\s*<td[^>]*>\\s*<strong>\\s*([0-9.,]+)[^<]*<\\/strong>',
      'gi'
    )
    let match
    while ((match = regexStrong.exec(tableSection)) !== null) {
      const monthName = match[1].toLowerCase()
      const year = Number(match[2])
      if (!(monthName in MONTH_INDEX)) continue
      const value = parseNumberString(match[3])
      if (value === null) continue
      rows.push({ date: new Date(year, MONTH_INDEX[monthName], 1), value })
    }
    const regexPlain = new RegExp(
      '<tr[^>]*>\\s*<td[^>]*>\\s*PSV\\s+([A-Za-zà]+)\\s+(\\d{4})[^<]*<\\/td>' +
      '\\s*<td[^>]*>\\s*[^<]*<\\/td>' +
      '\\s*<td[^>]*>\\s*([0-9.,]+)\\s*<\\/td>',
      'gi'
    )
    while ((match = regexPlain.exec(tableSection)) !== null) {
      const monthName = match[1].toLowerCase()
      const year = Number(match[2])
      if (!(monthName in MONTH_INDEX)) continue
      const value = parseNumberString(match[3])
      if (value === null) continue
      rows.push({ date: new Date(year, MONTH_INDEX[monthName], 1), value })
    }
  }

  rows.sort((a, b) => a.date - b.date)
  return rows
}

async function getData({
  session,
  url,
  cachePath,
  refreshMinutes,
  scaleSeries = 1,
  scalePrev = 1,
  kind,
  forceRefresh = false,
}) {
  const ttlSeconds = Math.max(60, refreshMinutes * 60)
  const cached = readCache(cachePath)
  const needsPrev = cached && cached.previousMonth === null
  const needsMonthly = cached && (!cached.monthlySeries || cached.monthlySeries.length === 0)
  if (!forceRefresh && isFresh(cached, ttlSeconds) && !needsPrev && !needsMonthly) {
    return { ...cached, stale: false }
  }

  try {
    const html = await fetchText(session, url)
    const raw = extractSeriesFromHtml(html)
    if (!raw.length) throw new Error('nessun dato trovato')

    const series = filterLastDays(raw, MAX_DAYS).map(row => ({
      date: row.date,
      value: row.value * scaleSeries,
    }))
    const latest = series[series.length - 1].value
    const previousMonth = kind ? extractPreviousMonthValue(html, kind) : null
    const previousScaled = previousMonth
      ? { label: previousMonth.label, value: previousMonth.value * scalePrev }
      : null
    const monthlyRaw = kind ? extractMonthlySeries(html, kind) : []
    const monthlySeries = monthlyRaw
      .slice(-12)
      .map(row => ({ date: row.date, value: row.value * scalePrev }))
    const payload = {
      fetchedAt: Math.floor(Date.now() / 1000),
      latest,
      previousMonth: previousScaled,
      monthlySeries,
      series,
    }
    writeCache(cachePath, payload)
    return { ...payload, stale: false }
  } catch (e) {
    if (cached) return { ...cached, stale: true }
    throw e
  }
}

export async function getPunData(session, refreshMinutes, forceRefresh = false) {
  const cacheDir = getCacheDir()
  const cachePath = GLib.build_filenamev([cacheDir, 'pun.json'])
  return getData({
    session,
    url: PUN_URL,
    cachePath,
    refreshMinutes,
    scaleSeries: 1 / 1000,
    scalePrev: 1,
    kind: 'pun',
    forceRefresh,
  })
}

export async function getPsvData(session, refreshMinutes, forceRefresh = false) {
  const cacheDir = getCacheDir()
  const cachePath = GLib.build_filenamev([cacheDir, 'psv.json'])
  return getData({
    session,
    url: PSV_URL,
    cachePath,
    refreshMinutes,
    scaleSeries: 1,
    scalePrev: 1,
    kind: 'psv',
    forceRefresh,
  })
}
