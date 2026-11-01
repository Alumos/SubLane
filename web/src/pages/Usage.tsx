import { useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ChevronDown, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { authOptions } from '@/lib/auth'
import { useTimeZone } from '@/lib/timezone'
import type { APIKey } from '@/lib/keys'
import {
  statisticsOptions,
  trackedDays,
  ownLimitOptions,
  type UsageScope,
} from '@/lib/statistics'
import { Button } from '@/components/ui/Button'
import { ExportCSV } from '@/components/ExportCSV'
import { statisticsRows } from '@/lib/csv'
import { UsageChart } from '@/components/UsageChart'
import { PersonalAllocations } from '@/components/PersonalAllocations'
import { ActivityMap } from '@/components/ActivityMap'
import { UsageKey } from '@/components/UsageKey'
import {
  metricLabels,
  type UsageMetric,
  type Statistic,
} from '@/lib/statistics'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/DropdownMenu'

export function Usage() {
  return <UsageScopeView scope="personal" />
}
export function TeamUsage() {
  return <UsageScopeView scope="all" />
}

function UsageScopeView({ scope }: { scope: UsageScope }) {
  const { data } = useQuery(authOptions())
  if (!data?.user || (scope === 'all' && data.user.role !== 'admin'))
    return null
  return (
    <UsageReport
      key={scope + data.user.id}
      scope={scope}
      userID={data.user.id}
    />
  )
}
function UsageReport({ scope, userID }: { scope: UsageScope; userID: number }) {
  const { t, i18n } = useTranslation()
  const configuredTimeZone = useTimeZone()
  const client = useQueryClient()
  const [days, setDays] = useState(7)
  // Retain the selected label when its key is on another result page.
  const [selectedKey, setSelectedKey] = useState<APIKey | null>(null)
  const [metric, setMetric] = useState<UsageMetric>('requests')
  const [showDetails, setShowDetails] = useState(false)
  const [view, setView] = useState<'days' | 'models' | 'groups' | 'members'>(
    'days',
  )
  const query = useQuery(
    statisticsOptions(client, userID, scope, days, selectedKey?.id),
  )
  const timeZone = query.data?.time_zone ?? configuredTimeZone
  const limits = useQuery(ownLimitOptions(client, userID, scope))
  const number = new Intl.NumberFormat(i18n.resolvedLanguage ?? 'en', {
    maximumFractionDigits: 1,
  })
  const compact = new Intl.NumberFormat('en-US', {
    notation: 'compact',
    maximumFractionDigits: 1,
  })
  const date = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
    dateStyle: 'medium',
    timeZone,
  })
  const timestamp = new Intl.DateTimeFormat(i18n.resolvedLanguage ?? 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone,
  })
  const periods = [1, 7, 30, 90]
  const period = (value: number) =>
    value === 1 ? t('usageToday') : t('usageLastDays', { days: value })
  const labels = {
    days: 'usageDaily',
    models: 'usageModels',
    groups: 'accountGroups',
    members: 'usageMembers',
  } as const
  const rows = query.data
    ? view === 'days'
      ? trackedDays(query.data)
      : query.data[view]
    : []
  const totals = query.data?.totals
  const rowName = (row: Statistic) =>
    view === 'days'
      ? date.format(Number(row.id) * 1000)
      : row.name === '[other models]'
        ? t('usageOtherModels')
        : row.name || t('statisticsUnknown')
  const tokens = (count: number, reported: number) =>
    reported > 0 ? number.format(count) : '—'
  const compactTokens = (count: number, reported: number) =>
    reported > 0 ? compact.format(count) : '—'
  const percentage = (completed: number, requests: number) =>
    requests ? number.format((completed / requests) * 100) + '%' : '—'
  const duration = (sum: number, requests: number) =>
    requests ? number.format(sum / requests) + ' ms' : '—'
  return (
    <section
      aria-labelledby={
        scope === 'personal' ? 'personal-usage-title' : 'team-usage-title'
      }
      className={
        scope === 'personal'
          ? 'space-y-6 border-t border-border pt-8'
          : 'space-y-6'
      }
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          {scope === 'personal' ? (
            <h2 id="personal-usage-title" className="text-xl font-semibold">
              {t('yourUsage')}
            </h2>
          ) : (
            <h1 id="team-usage-title" className="page-title">
              {t('teamUsage')}
            </h1>
          )}
        </div>
        <div className="flex flex-wrap items-start gap-2">
          <ExportCSV
            userID={userID}
            filename="sublane-usage.csv"
            disabled={!query.data || query.isFetching}
            load={async () => statisticsRows(query.data!)}
          />
          <Button
            variant="outline"
            aria-label={
              scope === 'personal'
                ? `${t('yourUsage')}: ${t('refresh')}`
                : undefined
            }
            disabled={query.isFetching}
            onClick={() =>
              Promise.all([
                query.refetch(),
                ...(scope === 'personal' ? [limits.refetch()] : []),
              ])
            }
          >
            <RefreshCw
              aria-hidden="true"
              className={query.isFetching ? 'motion-safe:animate-spin' : ''}
            />
            {t('refresh')}
          </Button>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-label={t('usagePeriod')}>
              {period(days)}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={String(days)}
              onValueChange={(value) => setDays(Number(value))}
            >
              {periods.map((value) => (
                <DropdownMenuRadioItem key={value} value={String(value)}>
                  {period(value)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        {scope === 'personal' && (
          <UsageKey
            userID={userID}
            value={selectedKey}
            onChange={setSelectedKey}
          />
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-label={t('usageBreakdown')}>
              {t(labels[view])}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={view}
              onValueChange={(value) => setView(value as typeof view)}
            >
              {(Object.keys(labels) as (keyof typeof labels)[])
                .filter((value) => scope === 'all' || value !== 'members')
                .map((value) => (
                  <DropdownMenuRadioItem key={value} value={value}>
                    {t(labels[value])}
                  </DropdownMenuRadioItem>
                ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" aria-label={t('usageMetric')}>
              {t(metricLabels[metric])}
              <ChevronDown aria-hidden="true" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuRadioGroup
              value={metric}
              onValueChange={(value) => setMetric(value as UsageMetric)}
            >
              {(Object.keys(metricLabels) as UsageMetric[]).map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {t(metricLabels[value])}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button
          variant="ghost"
          className="ml-auto"
          aria-expanded={showDetails}
          aria-controls="usage-details"
          onClick={() => setShowDetails((value) => !value)}
        >
          {t(showDetails ? 'usageHideDetails' : 'usageViewDetails')}
        </Button>
      </div>
      {query.isPending ? (
        <p role="status" className="py-10 text-sm text-muted-foreground">
          {t('loadingUsageSummary')}
        </p>
      ) : query.isError ? (
        <div role="alert" className="space-y-3">
          <p className="text-sm text-error">{t('usageSummaryFailed')}</p>
          <Button variant="outline" onClick={() => query.refetch()}>
            {t('reconnect')}
          </Button>
        </div>
      ) : (
        totals && (
          <>
            <p className="text-xs text-muted-foreground">
              {t('usageTrackingSince', {
                time: timestamp.format(query.data.tracking_since * 1000),
                zone: timeZone,
              })}
            </p>
            <dl className="grid grid-cols-2 gap-x-6 gap-y-6 border-y border-border py-6 lg:grid-cols-4">
              {(
                [
                  {
                    label: 'usageRequests',
                    value: number.format(totals.requests),
                  },
                  {
                    label: 'usageCompletionRate',
                    value: percentage(totals.completed, totals.requests),
                  },
                  {
                    label: 'usageAverageDuration',
                    value: duration(totals.duration_ms, totals.requests),
                  },
                  {
                    label: 'requestTokens',
                    value:
                      compactTokens(
                        totals.input_tokens,
                        totals.input_reported,
                      ) +
                      ' / ' +
                      compactTokens(
                        totals.output_tokens,
                        totals.output_reported,
                      ),
                  },
                ] as const
              ).map((item) => (
                <div key={item.label} className="min-w-0">
                  <dt className="text-sm text-muted-foreground">
                    {t(item.label)}
                  </dt>
                  <dd
                    className="mt-2 break-words text-2xl font-semibold tracking-tight tabular-nums"
                    title={
                      item.label === 'requestTokens'
                        ? tokens(totals.input_tokens, totals.input_reported) +
                          ' / ' +
                          tokens(totals.output_tokens, totals.output_reported)
                        : undefined
                    }
                  >
                    {item.value}
                  </dd>
                </div>
              ))}
            </dl>
            {totals.requests > 0 && (
              <>
                <p className="text-sm text-muted-foreground">
                  {t('usageOutcomes', {
                    completed: number.format(totals.completed),
                    incomplete: number.format(totals.incomplete),
                    errors: number.format(totals.errors),
                    canceled: number.format(totals.canceled),
                    rejected: number.format(totals.rejected),
                  })}
                </p>
                {(totals.input_reported < totals.requests ||
                  totals.output_reported < totals.requests) && (
                  <p className="text-sm text-warning">
                    {t('usagePartialTokens')}
                  </p>
                )}
              </>
            )}
            {totals.requests === 0 ? (
              <>
                <div className="rounded-xl border border-dashed border-border p-10 text-center">
                  <h2 className="font-medium">{t('noUsageSummary')}</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    {t('noUsageSummaryHint')}
                  </p>
                </div>
                <ActivityMap
                  key={days + ':' + selectedKey?.id}
                  activity={query.data.activity}
                  metric={metric}
                />
              </>
            ) : (
              <div className="space-y-5">
                <section
                  aria-label={t('usageChart')}
                  className="rounded-xl border border-border bg-card p-4 sm:p-6"
                >
                  <UsageChart
                    key={view + days + metric + selectedKey?.id}
                    rows={rows.map((row) => ({ ...row, name: rowName(row) }))}
                    metric={metric}
                    daily={view === 'days'}
                    timeZone={timeZone}
                    label={t(labels[view]) + ' · ' + t(metricLabels[metric])}
                  />
                </section>
                <ActivityMap
                  key={days + ':' + selectedKey?.id}
                  activity={query.data.activity}
                  metric={metric}
                />
                {showDetails && (
                  <div
                    id="usage-details"
                    className="overflow-x-auto rounded-xl border border-border bg-card"
                  >
                    <table className="w-full text-left text-sm">
                      <caption className="sr-only">{t(labels[view])}</caption>
                      <thead className="border-b border-border text-muted-foreground">
                        <tr>
                          {(
                            [
                              labels[view],
                              'usageRequests',
                              'usageCompletionRate',
                              'usageAverageDuration',
                              'requestTokens',
                            ] as const
                          ).map((label) => (
                            <th
                              key={label}
                              scope="col"
                              className="whitespace-nowrap px-4 py-3 font-medium"
                            >
                              {t(label)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-border">
                        {rows.map((row) => (
                          <tr key={row.id}>
                            <th
                              scope="row"
                              className="max-w-64 px-4 py-4 font-medium"
                            >
                              <span
                                className="block max-w-64 truncate"
                                title={row.name}
                              >
                                {rowName(row)}
                              </span>
                            </th>
                            <td className="px-4 py-4 tabular-nums">
                              {number.format(row.requests)}
                            </td>
                            <td className="px-4 py-4 tabular-nums">
                              {percentage(row.completed, row.requests)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-4 tabular-nums">
                              {duration(row.duration_ms, row.requests)}
                            </td>
                            <td className="whitespace-nowrap px-4 py-4 tabular-nums">
                              {tokens(row.input_tokens, row.input_reported)} /{' '}
                              {tokens(row.output_tokens, row.output_reported)}
                              {row.requests > 0 &&
                                (row.input_reported < row.requests ||
                                  row.output_reported < row.requests) && (
                                  <span className="mt-1 block text-xs text-muted-foreground">
                                    {t('usageReportedOnly')}
                                  </span>
                                )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {t('usageRetentionNote', { zone: timeZone })}
            </p>
          </>
        )
      )}
      {scope === 'personal' && <PersonalAllocations userID={userID} />}
      {scope === 'personal' && (
        <section className="space-y-3 border-t border-border pt-5">
          <h2 className="font-medium">{t('yourRequestLimits')}</h2>
          {limits.isPending ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('loadingMemberLimits')}
            </p>
          ) : limits.isError ? (
            <p role="alert" className="text-sm text-error">
              {t('memberLimitsFailed')}
            </p>
          ) : (
            <dl className="flex flex-wrap gap-x-10 gap-y-4 text-sm">
              <div>
                <dt className="text-muted-foreground">
                  {t('requestsPerMinute')}
                </dt>
                <dd className="mt-1 tabular-nums">
                  {limits.data.requests_per_minute
                    ? number.format(limits.data.requests_this_minute) +
                      ' / ' +
                      number.format(limits.data.requests_per_minute)
                    : t('unlimited')}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t('memberConcurrency')}
                </dt>
                <dd className="mt-1 tabular-nums">
                  {number.format(limits.data.in_flight)} /{' '}
                  {limits.data.max_concurrency
                    ? number.format(limits.data.max_concurrency)
                    : t('unlimited')}
                </dd>
              </div>
            </dl>
          )}
          <p className="text-xs text-muted-foreground">
            {t('personalLimitsNotice')}
          </p>
        </section>
      )}
    </section>
  )
}
