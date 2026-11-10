import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ExternalLink, RefreshCw, ShieldCheck } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/cn'
import {
  ipReportErrorKey,
  ipReportOptions,
  ipScoreTier,
  refreshIPReport,
  type IPReport,
  type Proxy,
} from '@/lib/proxies'
import { useTimeZone } from '@/lib/timezone'
import { Status } from './Status'
import { Button } from './ui/Button'

const toneText = {
  success: 'text-success',
  info: 'text-info',
  warning: 'text-warning',
  error: 'text-error',
  neutral: 'text-muted-foreground',
} as const

function networkKind(report: IPReport) {
  if (report.mobile) return 'ipReportMobile'
  if (report.residential) return 'ipReportResidential'
  if (report.datacenter || report.company_type === 'hosting')
    return 'ipReportDatacenter'
  if (report.company_type === 'business') return 'ipReportBusiness'
  if (report.company_type === 'isp') return 'ipReportISP'
  return 'ipReportUnknownType'
}

export function ProxyIPReport({ proxy }: { proxy: Proxy }) {
  const { t, i18n } = useTranslation()
  const timeZone = useTimeZone()
  const client = useQueryClient()
  const ready = proxy.reachable && proxy.exit_ip !== ''
  const options = ipReportOptions(proxy.id, proxy.exit_ip)
  const query = useQuery({ ...options, enabled: ready })
  const refresh = useMutation({
    mutationFn: () => refreshIPReport(proxy.id),
    onSuccess: (data) => client.setQueryData(options.queryKey, data),
  })
  const report = query.data
  const error = refresh.error ?? query.error
  const locale = i18n.resolvedLanguage ?? 'en'
  const busy = query.isFetching || refresh.isPending
  return (
    <section
      aria-label={t('ipReportLabel', { name: proxy.name })}
      className="min-w-0 space-y-3"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <ShieldCheck aria-hidden="true" className="size-3.5" />
          {t('ipReportTitle')}
        </h3>
        {ready && (
          <div className="flex items-center gap-1">
            <Button
              asChild
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground [@media(pointer:coarse)]:size-11"
            >
              <a
                href={`https://ip.net.coffee/ip/${encodeURIComponent(proxy.exit_ip)}`}
                target="_blank"
                rel="noopener noreferrer"
                title={t('ipReportOpen')}
                aria-label={t('ipReportOpen')}
              >
                <ExternalLink aria-hidden="true" className="size-3.5" />
              </a>
            </Button>
            <Button
              variant="ghost"
              size="icon"
              className="size-7 text-muted-foreground [@media(pointer:coarse)]:size-11"
              disabled={busy}
              title={t('ipReportRefresh')}
              aria-label={t('ipReportRefreshNamed', { name: proxy.name })}
              onClick={() => refresh.mutate()}
            >
              <RefreshCw
                aria-hidden="true"
                className={cn('size-3.5', busy && 'motion-safe:animate-spin')}
              />
            </Button>
          </div>
        )}
      </div>
      {!ready ? (
        <p className="text-sm leading-5 text-muted-foreground">
          {t('ipReportNeedsCheck')}
        </p>
      ) : query.isPending ? (
        <p role="status" className="text-xs text-muted-foreground">
          {t('ipReportLoading')}
        </p>
      ) : !report ? (
        <p role="alert" className="text-xs text-warning">
          {t(ipReportErrorKey(error))}
        </p>
      ) : (
        <ReportBody report={report} locale={locale} timeZone={timeZone} />
      )}
      {report && error && (
        <p role="alert" className="text-xs text-warning">
          {t(ipReportErrorKey(error))}
        </p>
      )}
    </section>
  )
}

function ReportBody({
  report,
  locale,
  timeZone,
}: {
  report: IPReport
  locale: string
  timeZone: string
}) {
  const { t } = useTranslation()
  const tier = ipScoreTier(report.trust_score)
  const tone = tier.tone
  const flags = (
    [
      ['vpn', 'ipReportVPN'],
      ['proxy', 'ipReportProxy'],
      ['tor', 'ipReportTor'],
      ['abuser', 'ipReportAbuser'],
      ['crawler', 'ipReportCrawler'],
    ] as const
  ).filter(([key]) => report[key])
  const country = (() => {
    if (!report.country_code) return report.country
    try {
      return (
        new Intl.DisplayNames(locale, { type: 'region' }).of(
          report.country_code,
        ) ?? report.country
      )
    } catch {
      return report.country
    }
  })()
  const location = [report.city, report.region, country]
    .filter((value, index, values) => value && values.indexOf(value) === index)
    .join(', ')
  return (
    <div className="space-y-3">
      <div className="flex items-end justify-between gap-3">
        <div className="flex items-baseline gap-1">
          <span
            className={cn(
              'text-3xl font-semibold tabular-nums leading-none',
              toneText[tone],
            )}
          >
            {report.trust_score ?? '—'}
          </span>
          <span className="text-xs text-muted-foreground">/ 100</span>
        </div>
        <Status kind={tone}>{t(tier.label)}</Status>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-label={t('ipReportScore')}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={report.trust_score ?? undefined}
      >
        <div
          className={cn('h-full rounded-full bg-current', toneText[tone])}
          style={{ width: `${report.trust_score ?? 0}%` }}
        />
      </div>
      <div className="flex flex-wrap gap-1.5">
        <Status kind="info">{t(networkKind(report))}</Status>
        {flags.length === 0 ? (
          <Status kind="success">{t('ipReportNoRisk')}</Status>
        ) : (
          flags.map(([key, label]) => (
            <Status
              key={key}
              kind={key === 'tor' || key === 'abuser' ? 'error' : 'warning'}
            >
              {t(label)}
            </Status>
          ))
        )}
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs">
        <dt className="text-muted-foreground">{t('ipReportIP')}</dt>
        <dd className="break-all font-mono">{report.ip}</dd>
        {report.asn > 0 && (
          <>
            <dt className="text-muted-foreground">ASN</dt>
            <dd className="break-words">
              AS{report.asn}
              {report.as_organization && ` · ${report.as_organization}`}
            </dd>
          </>
        )}
        {report.isp && report.isp !== report.as_organization && (
          <>
            <dt className="text-muted-foreground">{t('ipReportISPLabel')}</dt>
            <dd className="break-words">{report.isp}</dd>
          </>
        )}
        {location && (
          <>
            <dt className="text-muted-foreground">
              {t('ipReportLocationLabel')}
            </dt>
            <dd className="break-words">{location}</dd>
          </>
        )}
        {report.verdict && (
          <>
            <dt className="text-muted-foreground">
              {t('ipReportVerdictLabel')}
            </dt>
            <dd className="break-words">{report.verdict}</dd>
          </>
        )}
      </dl>
      <p className="text-[11px] leading-4 text-muted-foreground">
        {t('ipReportSource', {
          time: new Intl.DateTimeFormat(locale, {
            timeZone,
            dateStyle: 'short',
            timeStyle: 'short',
          }).format(report.fetched_at * 1000),
        })}
      </p>
    </div>
  )
}
