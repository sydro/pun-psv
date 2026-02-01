/* extension.js - GNOME 45+ (ESModules) */

import St from 'gi://St'
import GObject from 'gi://GObject'
import GLib from 'gi://GLib'
import Soup from 'gi://Soup?version=3.0'
import Clutter from 'gi://Clutter'
import Gio from 'gi://Gio'

import { Extension } from 'resource:///org/gnome/shell/extensions/extension.js'
import * as Main from 'resource:///org/gnome/shell/ui/main.js'
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js'
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js'

import { getPunData, getPsvData } from './data.js'

const DEFAULT_REFRESH_MINUTES = 1440

const PUN_DISPLAY_DECIMALS = 2 // €/kWh
const PSV_DISPLAY_DECIMALS = 2 // €/Smc
const PUN_TABLE_DECIMALS = 3
const PSV_TABLE_DECIMALS = 3
const CHART_HEIGHT = 120
const MONTHS_SHORT = ['gen', 'feb', 'mar', 'apr', 'mag', 'giu', 'lug', 'ago', 'set', 'ott', 'nov', 'dic']

function formatNumber(value, decimals = 3) {
  if (value === null || value === undefined || Number.isNaN(value)) return '—'
  return Number(value).toFixed(decimals).replace('.', ',')
}

const PunPsvIndicator = GObject.registerClass(
class PunPsvIndicator extends PanelMenu.Button {
  constructor(extension) {
    super(0.0, 'PUN/PSV Indicator', false)

    this._extension = extension
    this._settings = null

    this._session = new Soup.Session()

    this._pun = null
    this._psv = null
    this._punSeries = []
    this._psvSeries = []
    this._punMonthlySeries = []
    this._psvMonthlySeries = []
    this._punPrevMonth = null
    this._psvPrevMonth = null
    this._lastUpdate = null
    this._timeoutId = 0

    // Top bar box (icons + values)
    this._box = new St.BoxLayout({
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'punpsv-box',
    })

    const punIconPath = GLib.build_filenamev([this._extension.path, 'icons', 'lightbulb-symbolic.svg'])
    const psvIconPath = GLib.build_filenamev([this._extension.path, 'icons', 'fire-symbolic.svg'])

    this._punButton = new St.Button({
      style_class: 'punpsv-click',
      reactive: true,
      can_focus: true,
      track_hover: true,
    })
    this._punButtonBox = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER })
    this._punIcon = new St.Icon({
      gicon: Gio.icon_new_for_string(punIconPath),
      style_class: 'punpsv-icon',
    })
    this._punValue = new St.Label({
      text: '—',
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'punpsv-label',
    })
    this._punButtonBox.add_child(this._punIcon)
    this._punButtonBox.add_child(this._punValue)
    this._punButton.set_child(this._punButtonBox)

    this._separator = new St.Label({
      text: ' | ',
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'punpsv-sep',
    })

    this._psvButton = new St.Button({
      style_class: 'punpsv-click',
      reactive: true,
      can_focus: true,
      track_hover: true,
    })
    this._psvButtonBox = new St.BoxLayout({ y_align: Clutter.ActorAlign.CENTER })
    this._psvIcon = new St.Icon({
      gicon: Gio.icon_new_for_string(psvIconPath),
      style_class: 'punpsv-icon',
    })
    this._psvValue = new St.Label({
      text: '—',
      y_align: Clutter.ActorAlign.CENTER,
      style_class: 'punpsv-label',
    })
    this._psvButtonBox.add_child(this._psvIcon)
    this._psvButtonBox.add_child(this._psvValue)
    this._psvButton.set_child(this._psvButtonBox)

    this._box.add_child(this._punButton)
    this._box.add_child(this._separator)
    this._box.add_child(this._psvButton)

    this.add_child(this._box)

    // Menu dropdown
    this._punItem = new PopupMenu.PopupMenuItem('PUN: —', { reactive: false })
    this._psvItem = new PopupMenu.PopupMenuItem('PSV: —', { reactive: false })
    this._timeItem = new PopupMenu.PopupMenuItem('Aggiornato: —', { reactive: false })

    this.menu.addMenuItem(this._punItem)
    this.menu.addMenuItem(this._psvItem)
    this.menu.addMenuItem(this._timeItem)

    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

    this._punTableItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false })
    this._psvTableItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false })
    this._punChartItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false })
    this._psvChartItem = new PopupMenu.PopupBaseMenuItem({ reactive: false, can_focus: false })

    this._punHeader = new PopupMenu.PopupMenuItem('Serie ultimi 30 giorni (PUN €/kWh)', { reactive: false })
    this._psvHeader = new PopupMenu.PopupMenuItem('Serie ultimi 30 giorni (PSV €/Smc)', { reactive: false })
    this._punPrevItem = new PopupMenu.PopupMenuItem('Mese precedente: —', { reactive: false })
    this._psvPrevItem = new PopupMenu.PopupMenuItem('Mese precedente: —', { reactive: false })
    this._seriesSeparator = new PopupMenu.PopupSeparatorMenuItem()

    this.menu.addMenuItem(this._punHeader)
    this.menu.addMenuItem(this._punPrevItem)
    this.menu.addMenuItem(this._punTableItem)
    this.menu.addMenuItem(this._punChartItem)
    this.menu.addMenuItem(this._seriesSeparator)
    this.menu.addMenuItem(this._psvHeader)
    this.menu.addMenuItem(this._psvPrevItem)
    this.menu.addMenuItem(this._psvTableItem)
    this.menu.addMenuItem(this._psvChartItem)
    this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem())

    const refreshNow = new PopupMenu.PopupMenuItem('Aggiorna ora')
    refreshNow.connect('activate', () => this.refresh())
    this.menu.addMenuItem(refreshNow)

    this._summaryItems = [
      this._punItem,
      this._psvItem,
      this._timeItem,
      this._seriesSeparator,
      refreshNow,
    ]

    this._punButton.connect('button-press-event', () => {
      this._setMenuMode('pun')
      this.menu.open()
      return Clutter.EVENT_STOP
    })
    this._psvButton.connect('button-press-event', () => {
      this._setMenuMode('psv')
      this.menu.open()
      return Clutter.EVENT_STOP
    })

    this.menu.connect('open-state-changed', (menu, isOpen) => {
      if (!isOpen) this._setMenuMode('full')
    })
  }

  start() {
    this.refresh()

    const minutes = this._getRefreshMinutes()
    this._timeoutId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, minutes * 60, () => {
      this.refresh()
      return GLib.SOURCE_CONTINUE
    })
  }

  stop() {
    if (this._timeoutId) {
      GLib.Source.remove(this._timeoutId)
      this._timeoutId = 0
    }
  }

  _getRefreshMinutes() {
    // Se aggiungi gsettings puoi leggerlo da schema; per ora fallback
    try {
      if (this._settings && this._settings.get_int) return Math.max(1, this._settings.get_int('refresh-minutes'))
    } catch (e) {}
    return DEFAULT_REFRESH_MINUTES
  }

  async refresh() {
    try {
      const refreshMinutes = this._getRefreshMinutes()
      const results = await Promise.allSettled([
        getPunData(this._session, refreshMinutes),
        getPsvData(this._session, refreshMinutes),
      ])

      const punRes = results[0].status === 'fulfilled' ? results[0].value : null
      const psvRes = results[1].status === 'fulfilled' ? results[1].value : null

      if (punRes) {
        this._pun = punRes.latest
        this._punSeries = punRes.series
        this._punMonthlySeries = punRes.monthlySeries ?? []
        this._punPrevMonth = punRes.previousMonth ?? null
      }
      if (psvRes) {
        this._psv = psvRes.latest
        this._psvSeries = psvRes.series
        this._psvMonthlySeries = psvRes.monthlySeries ?? []
        this._psvPrevMonth = psvRes.previousMonth ?? null
      }
      this._lastUpdate = new Date()

      const isError = results.some(r => r.status === 'rejected')
      this._render(isError)
      this._setMenuMode('full')
    } catch (e) {
      // Non blocchiamo l’estensione: mostriamo “—”
      log(`[PUN/PSV] refresh error: ${e}`)
      this._lastUpdate = new Date()
      this._render(true)
    }
  }

  _render(isError = false) {
    const punTxt = formatNumber(this._pun, PUN_DISPLAY_DECIMALS)
    const psvTxt = formatNumber(this._psv, PSV_DISPLAY_DECIMALS)

    // Top bar text (stile simile allo screenshot: testo compatto)
    this._punValue.set_text(`${punTxt} €/kWh`)
    this._psvValue.set_text(`${psvTxt} €/Smc${isError ? ' !' : ''}`)

    // Menu dettagli
    this._punItem.label.set_text(`PUN: ${punTxt} €/kWh`)
    this._psvItem.label.set_text(`PSV: ${psvTxt} €/Smc`)

    const t = this._lastUpdate ? this._lastUpdate.toLocaleString() : '—'
    this._timeItem.label.set_text(`Aggiornato: ${t}`)

    const punPrev = this._punPrevMonth
      ? `<b>${this._punPrevMonth.label}: ${formatNumber(this._punPrevMonth.value, PUN_TABLE_DECIMALS)} €/kWh</b>`
      : 'Mese precedente: —'
    const psvPrev = this._psvPrevMonth
      ? `<b>${this._psvPrevMonth.label}: ${formatNumber(this._psvPrevMonth.value, PSV_TABLE_DECIMALS)} €/Smc</b>`
      : 'Mese precedente: —'
    this._punPrevItem.label.clutter_text.set_markup(punPrev)
    this._psvPrevItem.label.clutter_text.set_markup(psvPrev)

    this._renderSeries()
  }

  _renderSeries() {
    this._punTableItem.remove_all_children()
    this._psvTableItem.remove_all_children()
    this._punChartItem.remove_all_children()
    this._psvChartItem.remove_all_children()

    const punPrevValue = this._punPrevMonth ? this._punPrevMonth.value : null
    const psvPrevValue = this._psvPrevMonth ? this._psvPrevMonth.value : null
    const punSeries = this._ensureMinSeries(this._punSeries)
    const psvSeries = this._ensureMinSeries(this._psvSeries)

    this._punTableItem.add_child(this._buildSeriesTable(punSeries, PUN_TABLE_DECIMALS, punPrevValue))
    this._psvTableItem.add_child(this._buildSeriesTable(psvSeries, PSV_TABLE_DECIMALS, psvPrevValue))
    const punChartSeries = this._punMonthlySeries.length ? this._punMonthlySeries : this._punSeries
    const psvChartSeries = this._psvMonthlySeries.length ? this._psvMonthlySeries : this._psvSeries
    this._punChartItem.add_child(this._buildChart(punChartSeries, PUN_TABLE_DECIMALS, '€/kWh'))
    this._psvChartItem.add_child(this._buildChart(psvChartSeries, PSV_TABLE_DECIMALS, '€/Smc'))
  }

  _buildSeriesTable(series, decimals, prevValue) {
    const pairsPerRow = 3
    const container = new St.BoxLayout({
      vertical: true,
      style_class: 'punpsv-table',
    })

    const rows = []
    for (let i = 0; i < series.length; i += pairsPerRow) {
      rows.push(series.slice(i, i + pairsPerRow))
    }

    let maxAbsDiff = 0
    if (prevValue !== null && prevValue !== undefined) {
      for (const item of series) {
        const diff = Math.abs(item.value - prevValue)
        if (diff > maxAbsDiff) maxAbsDiff = diff
      }
    }

    for (let i = 0; i < rows.length; i += 1) {
      const row = rows[i]
      const rowBox = new St.BoxLayout({
        style_class: i % 2 === 0 ? 'punpsv-row punpsv-row-even' : 'punpsv-row',
      })
      for (const cell of row) {
        const isPlaceholder = cell.placeholder === true
        const d = cell.date
        const day = isPlaceholder ? '—' : String(d.getDate()).padStart(2, '0')
        const month = isPlaceholder ? '—' : String(d.getMonth() + 1).padStart(2, '0')
        const dateLabel = new St.Label({
          text: `${day}/${month}`,
          style_class: 'punpsv-cell punpsv-date',
        })
        const valueLabel = new St.Label({
          text: isPlaceholder ? '—' : formatNumber(cell.value, decimals),
          style_class: 'punpsv-cell punpsv-value',
        })
        if (!isPlaceholder && prevValue !== null && prevValue !== undefined && maxAbsDiff > 0) {
          const diff = cell.value - prevValue
          const intensity = Math.min(1, Math.abs(diff) / maxAbsDiff)
          const alpha = 0.08 + 0.32 * intensity
          if (diff < 0) {
            valueLabel.set_style(`background-color: rgba(0, 140, 0, ${alpha.toFixed(2)}); color: #000000;`)
          } else if (diff > 0) {
            valueLabel.set_style(`background-color: rgba(180, 0, 0, ${alpha.toFixed(2)}); color: #000000;`)
          }
        }
        rowBox.add_child(dateLabel)
        rowBox.add_child(valueLabel)
      }
      container.add_child(rowBox)
    }

    return container
  }

  _buildPlaceholderSeries() {
    const rows = 5
    const pairsPerRow = 3
    const total = rows * pairsPerRow
    const placeholder = []
    for (let i = 0; i < total; i += 1) {
      placeholder.push({
        date: new Date(1970, 0, 1),
        value: null,
        placeholder: true,
      })
    }
    return placeholder
  }

  _ensureMinSeries(series) {
    const minCells = 15
    if (!series || series.length === 0) return this._buildPlaceholderSeries()
    if (series.length >= minCells) return series
    const padded = [...series]
    const missing = minCells - series.length
    for (let i = 0; i < missing; i += 1) {
      padded.push({
        date: new Date(1970, 0, 1),
        value: null,
        placeholder: true,
      })
    }
    return padded
  }

  _buildChart(series, decimals, unitLabel) {
    const box = new St.BoxLayout({ vertical: true, style_class: 'punpsv-chart-box', x_expand: true })
    const label = new St.Label({ text: unitLabel, style_class: 'punpsv-chart-unit' })
    const area = new St.DrawingArea({ style_class: 'punpsv-chart', x_expand: true })
    area.set_size(1, CHART_HEIGHT)
    area.set_x_expand(true)

    area.connect('repaint', () => {
      if (!series.length) return
      const cr = area.get_context()

      const width = area.get_width()
      const height = area.get_height()
      const padLeft = 18
      const padRight = 10
      const padTop = 8
      const padBottom = 14
      const plotW = Math.max(1, width - padLeft - padRight)
      const plotH = Math.max(1, height - padTop - padBottom)

      let min = series[0].value
      let max = series[0].value
      for (const p of series) {
        if (p.value < min) min = p.value
        if (p.value > max) max = p.value
      }
      const range = Math.max(0.00001, max - min)
      const paddedMin = min - range * 0.05
      const paddedMax = max + range * 0.05
      const paddedRange = Math.max(0.00001, paddedMax - paddedMin)

      // Grid
      cr.setSourceRGBA(0, 0, 0, 0.08)
      cr.setLineWidth(1)
      for (let i = 0; i <= 3; i += 1) {
        const y = padTop + (plotH * i) / 3
        cr.moveTo(padLeft, y)
        cr.lineTo(padLeft + plotW, y)
      }
      cr.stroke()

      // Line
      cr.setSourceRGBA(0.13, 0.65, 0.27, 1)
      cr.setLineWidth(2.5)
      series.forEach((p, idx) => {
        const x = padLeft + (plotW * idx) / Math.max(1, series.length - 1)
        const y = padTop + plotH * (1 - (p.value - paddedMin) / paddedRange)
        if (idx === 0) cr.moveTo(x, y)
        else cr.lineTo(x, y)
      })
      cr.stroke()

      // Dots
      cr.setSourceRGBA(0.08, 0.5, 0.2, 1)
      for (let i = 0; i < series.length; i += 1) {
        const p = series[i]
        const x = padLeft + (plotW * i) / Math.max(1, series.length - 1)
        const y = padTop + plotH * (1 - (p.value - paddedMin) / paddedRange)
        cr.arc(x, y, 2.4, 0, Math.PI * 2)
        cr.fill()
      }

      // Labels
      cr.setSourceRGBA(0.05, 0.45, 0.18, 1)
      cr.selectFontFace('Sans', 0, 0)
      cr.setFontSize(9)
      for (let i = 0; i < series.length; i += 1) {
        const p = series[i]
        const x = padLeft + (plotW * i) / Math.max(1, series.length - 1)
        const y = padTop + plotH * (1 - (p.value - paddedMin) / paddedRange)
        const text = formatNumber(p.value, decimals)
        const ext = cr.textExtents(text)
        const tx = Math.min(Math.max(padLeft, x - ext.width / 2), padLeft + plotW - ext.width)
        const ty = Math.max(padTop + ext.height + 2, y - 6)
        cr.moveTo(tx, ty)
        cr.showText(text)
      }

      // X-axis month labels
      cr.setSourceRGBA(0, 0, 0, 0.55)
      cr.setFontSize(8)
      const step = Math.max(1, Math.ceil(series.length / 12))
      for (let i = 0; i < series.length; i += step) {
        const p = series[i]
        const month = MONTHS_SHORT[p.date.getMonth()] ?? ''
        if (!month) continue
        const x = padLeft + (plotW * i) / Math.max(1, series.length - 1)
        const y = padTop + plotH + 11
        const ext = cr.textExtents(month)
        const tx = Math.min(Math.max(padLeft, x - ext.width / 2), padLeft + plotW - ext.width)
        cr.moveTo(tx, y)
        cr.showText(month)
      }
    })

    box.add_child(label)
    box.add_child(area)
    return box
  }

  _setMenuMode(mode) {
    const showPun = mode === 'pun'
    const showPsv = mode === 'psv'

    this._punHeader.actor.visible = showPun
    this._punPrevItem.actor.visible = showPun
    this._punTableItem.actor.visible = showPun
    this._punChartItem.actor.visible = showPun
    this._psvHeader.actor.visible = showPsv
    this._psvPrevItem.actor.visible = showPsv
    this._psvTableItem.actor.visible = showPsv
    this._psvChartItem.actor.visible = showPsv

    for (const item of this._summaryItems) {
      item.actor.visible = mode === 'full'
    }

    // Hide separator between series when only one table is shown
    this._seriesSeparator.actor.visible = mode === 'full'
  }
})

export default class PunPsvExtension extends Extension {
  enable() {
    this._indicator = new PunPsvIndicator(this)

    // Posizione: a destra vicino alle icone (come nello screenshot)
    Main.panel.addToStatusArea(this.uuid, this._indicator, 0, 'right')

    this._indicator.start()
  }

  disable() {
    if (this._indicator) {
      this._indicator.stop()
      this._indicator.destroy()
      this._indicator = null
    }
  }
}
