import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { authKey, type AuthState } from './auth'
import { memberLimitSchema } from './limits'
import { request } from './request'

const metricsSchema = z.object({
  requests: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  incomplete: z.number().int().nonnegative(),
  errors: z.number().int().nonnegative(),
  canceled: z.number().int().nonnegative(),
  rejected: z.number().int().nonnegative(),
  duration_ms: z.number().int().nonnegative(),
  input_tokens: z.number().int().nonnegative(),
  output_tokens: z.number().int().nonnegative(),
  cached_tokens: z.number().int().nonnegative(),
  input_reported: z.number().int().nonnegative(),
  output_reported: z.number().int().nonnegative(),
  cached_reported: z.number().int().nonnegative(),
})
const statisticSchema = metricsSchema.extend({
  id: z.string(),
  name: z.string(),
})
const activityCellSchema = z
  .object({
    weekday: z.number().int().min(0).max(6),
    hour: z.number().int().min(0).max(23),
    samples: z.number().int().min(0).max(14),
    requests: z.number().int().nonnegative(),
    input_tokens: z.number().int().nonnegative(),
    output_tokens: z.number().int().nonnegative(),
    input_reported: z.number().int().nonnegative(),
    output_reported: z.number().int().nonnegative(),
  })
  .refine(
    (cell) =>
      cell.input_reported <= cell.requests &&
      cell.output_reported <= cell.requests,
  )
const activitySchema = z.object({
  time_zone: z.string().min(1).max(64),
  tracking_since: z.number().int().nonnegative(),
  observed_until: z.number().int().nonnegative(),
  cells: z
    .array(activityCellSchema)
    .length(168)
    .refine((cells) =>
      cells.every(
        (cell, index) =>
          cell.weekday === Math.floor(index / 24) && cell.hour === index % 24,
      ),
    ),
})
const statisticsSchema = z.object({
  time_zone: z.string().min(1).max(64),
  from_day: z.number().int(),
  to_day: z.number().int(),
  tracking_since: z.number().int(),
  totals: metricsSchema,
  days: z.array(statisticSchema).max(90),
  members: z.array(statisticSchema).max(20),
  models: z.array(statisticSchema).max(20),
  groups: z.array(statisticSchema).max(20),
  activity: activitySchema,
})
export type Activity = z.infer<typeof activitySchema>
export type Statistics = z.infer<typeof statisticsSchema>
export type ActivityCell = z.infer<typeof activityCellSchema>
export type Metrics = z.infer<typeof metricsSchema>
export type Statistic = z.infer<typeof statisticSchema>
export type UsageMetric = 'requests' | 'input_tokens' | 'output_tokens'
export const metricLabels = {
  requests: 'usageRequests',
  input_tokens: 'usageInputTokens',
  output_tokens: 'usageOutputTokens',
} as const
export type UsageScope = 'personal' | 'all'
export function statisticsOptions(
  client: QueryClient,
  userID: number,
  scope: UsageScope,
  days: number,
  keyID?: number,
) {
  const selectedKey = scope === 'personal' ? keyID : undefined
  const timeZone = client.getQueryData<AuthState>(authKey)?.time_zone ?? 'UTC'
  return queryOptions({
    queryKey: [
      'statistics',
      userID,
      scope,
      days,
      selectedKey ?? null,
      timeZone,
    ],
    enabled: () => {
      const user = client.getQueryData<AuthState>(authKey)?.user
      return (
        user?.id === userID && (scope === 'personal' || user.role === 'admin')
      )
    },
    queryFn: ({ signal }) =>
      request(
        `${scope === 'personal' ? '/api/me/usage' : '/api/usage'}?days=${days}${selectedKey === undefined ? '' : `&key_id=${selectedKey}`}`,
        statisticsSchema,
        { signal },
      ),
  })
}

type ReportedUsage = Pick<
  Metrics,
  | 'requests'
  | 'input_tokens'
  | 'output_tokens'
  | 'input_reported'
  | 'output_reported'
>

export function metricValue(
  row: ReportedUsage,
  metric: UsageMetric,
  collected = true,
) {
  if (!collected) return null
  if (metric === 'requests') return row.requests
  const reported =
    metric === 'input_tokens' ? row.input_reported : row.output_reported
  // An observed period without calls is zero; calls without token reports remain unknown.
  return row.requests === 0 || reported > 0 ? row[metric] : null
}

export function metricPartial(row: ReportedUsage, metric: UsageMetric) {
  return (
    metric !== 'requests' &&
    (metric === 'input_tokens' ? row.input_reported : row.output_reported) <
      row.requests
  )
}
export function ownLimitOptions(
  client: QueryClient,
  userID: number,
  scope: UsageScope,
) {
  return queryOptions({
    queryKey: ['own-limits', userID],
    enabled: () =>
      scope === 'personal' &&
      client.getQueryData<AuthState>(authKey)?.user?.id === userID,
    queryFn: ({ signal }) =>
      request('/api/me/limits', memberLimitSchema, { signal }),
  })
}

export function trackedDays(data: Statistics) {
  // Civil days may contain 23 or 25 hours; the next boundary determines coverage.
  return data.days.filter(
    (_, index) =>
      Number(data.days[index + 1]?.id ?? data.to_day) > data.tracking_since,
  )
}
