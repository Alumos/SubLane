import { queryOptions, type QueryClient } from '@tanstack/react-query'
import { z } from 'zod'
import { authKey, type AuthState } from './auth'
import { ApiError, request } from './request'

// Stable fork releases are X.Y.Z or X.Y.Z-revised.N, matching the server's update channel.
export const stableVersion =
  /^(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})\.(0|[1-9][0-9]{0,5})(-revised\.[1-9][0-9]{0,5})?$/
const version = z.string().regex(stableVersion)
const schema = z.object({
  current_version: z.string().max(64),
  latest_version: z.union([z.literal(''), version]),
  release_url: z
    .string()
    .regex(
      /^(|https:\/\/github\.com\/Alumos\/SubLane\/releases\/tag\/v[0-9.]+(-revised\.[0-9]+)?)$/,
    ),
  checked_at: z.number().int().nonnegative(),
  check_failed: z.boolean(),
  available: z.boolean(),
  enabled: z.boolean(),
  job: z
    .object({
      id: z.string().regex(/^[a-f0-9]{32}$/),
      version,
      status: z.enum([
        'queued',
        'running',
        'succeeded',
        'failed',
        'interrupted',
      ]),
      updated_at: z.number().int().positive(),
    })
    .nullable(),
})
export type UpdateState = z.infer<typeof schema>
export function updatePending(value: UpdateState) {
  // Worker completion alone does not prove that the target server version is serving.
  return (
    value.job?.status === 'queued' ||
    value.job?.status === 'running' ||
    (value.job?.status === 'succeeded' &&
      value.job.version !== value.current_version)
  )
}
export function updatesOptions(client: QueryClient, userID: number) {
  return queryOptions({
    queryKey: ['software-updates', userID],
    queryFn: ({ signal }) =>
      request('/api/settings/updates', schema, { signal }),
    enabled: () => {
      const user = client.getQueryData<AuthState>(authKey)?.user
      return userID === 1 && user?.id === userID && user.role === 'admin'
    },
    refetchInterval: (query) =>
      query.state.data && updatePending(query.state.data) ? 2000 : 60_000,
  })
}
export function checkUpdate(signal: AbortSignal) {
  return request('/api/settings/updates/check', schema, {
    method: 'POST',
    body: '{}',
    signal,
  })
}
export function installUpdate(version: string, signal: AbortSignal) {
  return request('/api/settings/updates/install', schema, {
    method: 'POST',
    body: JSON.stringify({ version, backup_confirmed: true }),
    signal,
  })
}
export function updateError(error: Error) {
  if (error instanceof ApiError) {
    if (error.code === 'demo_read_only') return 'demoReadOnly'
    if (error.code === 'update_cooldown') return 'updateCooldown'
    if (error.code === 'update_check_failed') return 'updateCheckFailed'
    if (error.code === 'update_unavailable') return 'updateDisabled'
  }
  return 'updateRequestFailed'
}
