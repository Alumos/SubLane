import { useId, useRef, useState, type KeyboardEvent } from 'react'
import { useTranslation } from 'react-i18next'
import {
  metricLabels,
  metricValue,
  metricPartial,
  type Activity,
  type ActivityCell,
  type UsageMetric,
} from '@/lib/statistics'

import { heatmapTone } from '@/lib/heatmap'
import { HeatmapLegend } from './HeatmapLegend'

function amount(cell: ActivityCell, metric: UsageMetric) {
  return metricValue(cell, metric, cell.samples > 0)
}

export function ActivityMap({
  activity,
  metric,
}: {
  activity: Activity
  metric: UsageMetric
}) {
  const { t, i18n } = useTranslation()
  const timeZone = activity.time_zone
  const title = useId()
  const help = useId()
  const buttons = useRef<(HTMLButtonElement | null)[]>([])
  const [selected, setSelected] = useState<number | null>(null)
  const [focusIndex, setFocusIndex] = useState(0)
  const locale = i18n.resolvedLanguage ?? 'en'
  const weekdayFormat = new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    timeZone: 'UTC',
  })
  const weekdays = Array.from({ length: 7 }, (_, index) =>
    weekdayFormat.format(Date.UTC(2024, 0, 1 + index)),
  )
  const number = new Intl.NumberFormat(locale)
  const date = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })
  const values = activity.cells.map((cell) => amount(cell, metric))
  const maximum = Math.max(1, ...values.map((value) => value ?? 0))
  const hour = (value: number) => String(value).padStart(2, '0') + ':00'
  const caption = (cell: ActivityCell) =>
    weekdays[cell.weekday] + ' ' + hour(cell.hour) + '–' + hour(cell.hour + 1)
  const reading = (cell: ActivityCell) => {
    const value = amount(cell, metric)
    return cell.samples === 0
      ? t('activityNotCollected')
      : value === null
        ? t('usageTokenNotReported')
        : number.format(value)
  }
  const navigate = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const day = Math.floor(index / 24),
      column = index % 24
    let next: number
    switch (event.key) {
      case 'ArrowLeft':
        next = day * 24 + Math.max(0, column - 1)
        break
      case 'ArrowRight':
        next = day * 24 + Math.min(23, column + 1)
        break
      case 'ArrowUp':
        next = Math.max(0, day - 1) * 24 + column
        break
      case 'ArrowDown':
        next = Math.min(6, day + 1) * 24 + column
        break
      case 'Home':
        next = event.ctrlKey ? 0 : day * 24
        break
      case 'End':
        next = event.ctrlKey ? 167 : day * 24 + 23
        break
      default:
        return
    }
    event.preventDefault()
    setFocusIndex(next)
    setSelected(next)
    buttons.current[next]?.focus()
  }
  const cell = selected === null ? null : activity.cells[selected]
  const partial =
    cell &&
    cell.samples > 0 &&
    cell.requests > 0 &&
    metricPartial(cell, metric) &&
    amount(cell, metric) !== null
  return (
    <section
      aria-labelledby={title}
      className="space-y-4 rounded-xl border border-border bg-card p-4 sm:p-6"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={title} className="font-medium">
          {t('activityTitle')}
        </h2>
        <span className="text-xs text-muted-foreground">
          {t(metricLabels[metric])} · {timeZone}
        </span>
      </div>
      <p className="text-xs text-muted-foreground">
        {t('activityCoverage', {
          time: date.format(activity.tracking_since * 1000),
          zone: timeZone,
        })}
      </p>
      <div className="overflow-x-auto px-1 py-1">
        <div
          role="grid"
          aria-label={t('activityGrid')}
          aria-describedby={help}
          aria-rowcount={7}
          aria-colcount={24}
          className="min-w-[720px] space-y-1"
        >
          {weekdays.map((weekday, day) => (
            <div
              key={day}
              role="row"
              aria-rowindex={day + 1}
              aria-label={weekday}
              className="grid grid-cols-[3rem_repeat(24,minmax(0,1fr))] items-center gap-1"
            >
              <span
                aria-hidden="true"
                className="text-xs text-muted-foreground"
              >
                {weekday}
              </span>
              {activity.cells
                .slice(day * 24, day * 24 + 24)
                .map((item, column) => {
                  const index = day * 24 + column
                  const value = values[index]
                  const tone = heatmapTone(value, maximum)
                  return (
                    <button
                      key={column}
                      ref={(element) => {
                        buttons.current[index] = element
                      }}
                      type="button"
                      role="gridcell"
                      aria-colindex={column + 1}
                      aria-selected={selected === index}
                      tabIndex={focusIndex === index ? 0 : -1}
                      aria-label={
                        caption(item) +
                        ' · ' +
                        t(metricLabels[metric]) +
                        ': ' +
                        reading(item)
                      }
                      className={
                        'aspect-square w-full min-w-0 rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring ' +
                        tone
                      }
                      onPointerEnter={() => setSelected(index)}
                      onFocus={() => {
                        setFocusIndex(index)
                        setSelected(index)
                      }}
                      onClick={() => {
                        setFocusIndex(index)
                        setSelected(index)
                      }}
                      onKeyDown={(event) => navigate(event, index)}
                    />
                  )
                })}
            </div>
          ))}
        </div>
        <div
          aria-hidden="true"
          className="mt-2 grid min-w-[720px] grid-cols-[3rem_repeat(24,minmax(0,1fr))] gap-1 text-center text-xs tabular-nums text-muted-foreground"
        >
          <span />
          {Array.from({ length: 24 }, (_, index) => (
            <span key={index}>
              {index % 3 === 0 ? String(index).padStart(2, '0') : ''}
            </span>
          ))}
        </div>
      </div>
      <p id={help} className="sr-only">
        {t('activityKeys')}
      </p>
      <div className="flex flex-wrap items-start justify-between gap-x-6 gap-y-3">
        <div
          role="status"
          aria-live="polite"
          className="flex min-h-10 flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground"
        >
          {cell ? (
            <>
              <span>{caption(cell)}</span>
              <strong className="font-medium tabular-nums text-foreground">
                {reading(cell)}
              </strong>
              {partial && <span>{t('usageReportedOnly')}</span>}
              {cell.samples > 0 && (
                <span>
                  {t('activitySamples', { count: number.format(cell.samples) })}
                </span>
              )}
            </>
          ) : (
            <span>{t('activityHint')}</span>
          )}
        </div>
        <HeatmapLegend />
      </div>
    </section>
  )
}
