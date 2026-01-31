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

    this._punHeader = new PopupMenu.PopupMenuItem('Serie ultimi 30 giorni (PUN €/kWh)', { reactive: false })
    this._psvHeader = new PopupMenu.PopupMenuItem('Serie ultimi 30 giorni (PSV €/Smc)', { reactive: false })
    this._punPrevItem = new PopupMenu.PopupMenuItem('Mese precedente: —', { reactive: false })
    this._psvPrevItem = new PopupMenu.PopupMenuItem('Mese precedente: —', { reactive: false })
    this._seriesSeparator = new PopupMenu.PopupSeparatorMenuItem()

    this.menu.addMenuItem(this._punHeader)
    this.menu.addMenuItem(this._punPrevItem)
    this.menu.addMenuItem(this._punTableItem)
    this.menu.addMenuItem(this._seriesSeparator)
    this.menu.addMenuItem(this._psvHeader)
    this.menu.addMenuItem(this._psvPrevItem)
    this.menu.addMenuItem(this._psvTableItem)
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
      const [punResult, psvResult] = await Promise.all([
        getPunData(this._session, refreshMinutes),
        getPsvData(this._session, refreshMinutes),
      ])

      this._pun = punResult.latest
      this._psv = psvResult.latest
      this._punSeries = punResult.series
      this._psvSeries = psvResult.series
      this._punPrevMonth = punResult.previousMonth ?? null
      this._psvPrevMonth = psvResult.previousMonth ?? null
      this._lastUpdate = new Date()

      this._render()
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
      ? `<b>${this._punPrevMonth.label}: ${formatNumber(this._punPrevMonth.value, PUN_DISPLAY_DECIMALS)} €/kWh</b>`
      : 'Mese precedente: —'
    const psvPrev = this._psvPrevMonth
      ? `<b>${this._psvPrevMonth.label}: ${formatNumber(this._psvPrevMonth.value, PSV_DISPLAY_DECIMALS)} €/Smc</b>`
      : 'Mese precedente: —'
    this._punPrevItem.label.clutter_text.set_markup(punPrev)
    this._psvPrevItem.label.clutter_text.set_markup(psvPrev)

    this._renderSeries()
  }

  _renderSeries() {
    this._punTableItem.remove_all_children()
    this._psvTableItem.remove_all_children()

    const punPrevValue = this._punPrevMonth ? this._punPrevMonth.value : null
    const psvPrevValue = this._psvPrevMonth ? this._psvPrevMonth.value : null
    this._punTableItem.add_child(this._buildSeriesTable(this._punSeries, PUN_DISPLAY_DECIMALS, punPrevValue))
    this._psvTableItem.add_child(this._buildSeriesTable(this._psvSeries, PSV_DISPLAY_DECIMALS, psvPrevValue))
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
        const d = cell.date
        const day = String(d.getDate()).padStart(2, '0')
        const month = String(d.getMonth() + 1).padStart(2, '0')
        const dateLabel = new St.Label({
          text: `${day}/${month}`,
          style_class: 'punpsv-cell punpsv-date',
        })
        const valueLabel = new St.Label({
          text: formatNumber(cell.value, decimals),
          style_class: 'punpsv-cell punpsv-value',
        })
        if (prevValue !== null && prevValue !== undefined && maxAbsDiff > 0) {
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

  _setMenuMode(mode) {
    const showPun = mode === 'pun'
    const showPsv = mode === 'psv'

    this._punHeader.actor.visible = showPun
    this._punPrevItem.actor.visible = showPun
    this._punTableItem.actor.visible = showPun
    this._psvHeader.actor.visible = showPsv
    this._psvPrevItem.actor.visible = showPsv
    this._psvTableItem.actor.visible = showPsv

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
