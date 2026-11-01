import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react'
import { useTranslation } from 'react-i18next'
import {
  metricLabels,
  metricValue,
  metricPartial,
  type Statistic,
  type UsageMetric,
} from '@/lib/statistics'

const value = metricValue
const partial = metricPartial

export function UsageChart({
  rows,
  metric,
  daily,
  label,
  timeZone = 'UTC',
}: {
  rows: Statistic[]
  metric: UsageMetric
  daily: boolean
  label: string
  timeZone?: string
}) {
  const { t, i18n } = useTranslation()
  const numbers = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en')
  if (!rows.length)
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t('noUsageSummary')}
      </p>
    )
  const amounts = rows.map((row) => value(row, metric))
  if (
    metric !== 'requests' &&
    !rows.some(
      (row) =>
        (metric === 'input_tokens' ? row.input_reported : row.output_reported) >
        0,
    ) &&
    rows.some((row) => row.requests > 0)
  )
    return (
      <p className="py-12 text-center text-sm text-muted-foreground">
        {t('usageNoTokenReports')}
      </p>
    )
  if (daily)
    return (
      <DailyChart
        rows={rows}
        metric={metric}
        amounts={amounts}
        label={label}
        timeZone={timeZone}
      />
    )
  const maximum = Math.max(1, ...amounts.map((amount) => amount ?? 0))
  return (
    <div className="space-y-5">
      <ol
        aria-label={label}
        className="max-h-[28rem] space-y-5 overflow-y-auto pr-2"
      >
        {rows.map((row, index) => (
          <li key={row.id} className="space-y-2">
            <div className="flex items-start justify-between gap-4 text-sm">
              <span
                className="min-w-0 break-words font-medium"
                title={row.name}
              >
                {row.name}
              </span>
              <span className="shrink-0 tabular-nums">
                {amounts[index] === null
                  ? '—'
                  : numbers.format(amounts[index]!)}
              </span>
            </div>
            <div
              aria-hidden="true"
              className="h-2 overflow-hidden rounded-full bg-muted"
            >
              <div
                className="h-full rounded-full bg-foreground"
                style={{ width: ((amounts[index] ?? 0) / maximum) * 100 + '%' }}
              />
            </div>
            {partial(row, metric) && (
              <p className="text-xs text-muted-foreground">
                {t(
                  amounts[index] === null
                    ? 'usageTokenNotReported'
                    : 'usageReportedOnly',
                )}
              </p>
            )}
          </li>
        ))}
      </ol>
      <p className="text-xs text-muted-foreground">{t('usageRankHint')}</p>
    </div>
  )
}

function DailyChart({
  rows,
  metric,
  amounts,
  label,
  timeZone,
}: {
  rows: Statistic[]
  metric: UsageMetric
  amounts: (number | null)[]
  label: string
  timeZone: string
}) {
  const { t, i18n } = useTranslation()
  const help = useId()
  const container = useRef<HTMLDivElement>(null)
  const [width, setWidth] = useState(720)
  const [active, setActive] = useState<number | null>(null)
  useEffect(() => {
    const element = container.current
    if (!element) return
    if (typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver((entries) => {
      const next = entries[0]?.contentRect.width
      if (next) setWidth(Math.max(240, Math.round(next)))
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  const locale = i18n.resolvedLanguage ?? 'en'
  const numbers = new Intl.NumberFormat(locale)
  const compact = new Intl.NumberFormat(locale, {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  const dates = new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    timeZone,
  })
  const fullDates = new Intl.DateTimeFormat(locale, {
    dateStyle: 'medium',
    timeZone,
  })
  const maximum = Math.max(1, ...amounts.map((amount) => amount ?? 0))
  const magnitude = 10 ** Math.floor(Math.log10(maximum / 4))
  const step = Math.max(
    1,
    ([1, 2, 5, 10].find((size) => size * magnitude >= maximum / 4) ?? 10) *
      magnitude,
  )
  const top = Math.ceil(maximum / step) * step
  const left = 52,
    right = 16,
    height = 260,
    bottom = 222
  const x = (index: number) =>
    rows.length === 1
      ? (left + width - right) / 2
      : left + (index / (rows.length - 1)) * (width - left - right)
  const y = (amount: number) => bottom - (amount / top) * (bottom - 16)
  const ticks = Array.from(
    { length: Math.round(top / step) + 1 },
    (_, index) => index * step,
  )
  const tickCount = Math.min(rows.length, width < 480 ? 3 : 6)
  const datesToShow = new Set(
    Array.from({ length: tickCount }, (_, index) =>
      tickCount === 1
        ? 0
        : Math.round((index * (rows.length - 1)) / (tickCount - 1)),
    ),
  )
  const path = amounts
    .map((amount, index) => {
      if (amount === null) return ''
      // Restart after unknown samples; connecting across them would imply observed usage.
      const command = index === 0 || amounts[index - 1] === null ? 'M' : 'L'
      return command + x(index) + ',' + y(amount)
    })
    .join(' ')
  const select = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect()
    const relative = ((event.clientX - bounds.left) * width) / bounds.width
    setActive(
      Math.max(
        0,
        Math.min(
          rows.length - 1,
          Math.round(
            ((relative - left) / (width - left - right)) * (rows.length - 1),
          ),
        ),
      ),
    )
  }
  const navigate = (event: KeyboardEvent<SVGSVGElement>) => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
    event.preventDefault()
    setActive((current) =>
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? rows.length - 1
          : Math.max(
              0,
              Math.min(
                rows.length - 1,
                (current ?? 0) + (event.key === 'ArrowLeft' ? -1 : 1),
              ),
            ),
    )
  }
  const selected = active === null ? null : rows[active]
  return (
    <div ref={container} className="space-y-3">
      <svg
        role="img"
        aria-label={label}
        aria-describedby={help}
        tabIndex={0}
        viewBox={'0 0 ' + width + ' ' + height}
        height={height}
        className="w-full rounded-sm outline-none focus-visible:outline-2 focus-visible:outline-ring"
        onPointerMove={select}
        onPointerDown={select}
        onPointerLeave={() => setActive(null)}
        onFocus={() => setActive(rows.length - 1)}
        onBlur={() => setActive(null)}
        onKeyDown={navigate}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={left}
              x2={width - right}
              y1={y(tick)}
              y2={y(tick)}
              stroke="var(--border)"
              strokeDasharray={tick === 0 ? undefined : '3 4'}
            />
            <text
              x={left - 10}
              y={y(tick) + 4}
              textAnchor="end"
              fontSize={12}
              fill="var(--muted-foreground)"
            >
              {compact.format(tick)}
            </text>
          </g>
        ))}
        <path
          d={path}
          fill="none"
          stroke="var(--foreground)"
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
        />
        {amounts.map((amount, index) =>
          amount !== null && (rows.length <= 14 || index === active) ? (
            <circle
              key={rows[index].id}
              cx={x(index)}
              cy={y(amount)}
              r={index === active ? 5 : 3}
              fill="var(--background)"
              stroke="var(--foreground)"
              strokeWidth={2}
            />
          ) : null,
        )}
        {active !== null && (
          <line
            x1={x(active)}
            x2={x(active)}
            y1={16}
            y2={bottom}
            stroke="var(--muted-foreground)"
            strokeDasharray="3 4"
          />
        )}
        {rows.map((row, index) =>
          datesToShow.has(index) ? (
            <text
              key={row.id}
              x={x(index)}
              y={height - 12}
              textAnchor={
                index === 0
                  ? 'start'
                  : index === rows.length - 1
                    ? 'end'
                    : 'middle'
              }
              fontSize={12}
              fill="var(--muted-foreground)"
            >
              {dates.format(Number(row.id) * 1000)}
            </text>
          ) : null,
        )}
      </svg>
      <p id={help} className="sr-only">
        {t('usageChartKeys')}
      </p>
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1 text-sm"
      >
        {selected && active !== null ? (
          <>
            <span className="text-muted-foreground">
              {fullDates.format(Number(selected.id) * 1000)} ·{' '}
              {t(metricLabels[metric])}
            </span>
            <strong className="font-medium tabular-nums">
              {amounts[active] === null
                ? t('usageTokenNotReported')
                : numbers.format(amounts[active]!)}
            </strong>
            {partial(selected, metric) && amounts[active] !== null && (
              <span className="text-xs text-muted-foreground">
                {t('usageReportedOnly')}
              </span>
            )}
          </>
        ) : (
          <span className="text-muted-foreground">{t('usageChartHint')}</span>
        )}
      </div>
      {amounts.some((amount) => amount === null) && (
        <p className="text-xs text-muted-foreground">{t('usageChartGaps')}</p>
      )}
    </div>
  )
}
