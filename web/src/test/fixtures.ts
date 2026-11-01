export const system = {
  name: 'SubLane',
  version: 'synthetic-version',
  status: 'ok',
  uptime_seconds: 42,
  storage: { engine: 'sqlite', status: 'ready' },
  gateway: {
    provider: 'codex',
    status: 'not_configured',
    has_usable_key: false,
  },
}

export const authenticated = {
  initialized: true,
  time_zone: 'UTC',
  user: { id: 1, username: 'admin-test', role: 'admin' as const },
}

export const workspaces = {
  tenants: [{ id: 1, name: 'Synthetic studio', status: 'active' }],
}

export const memberAuthenticated = {
  initialized: true,
  time_zone: 'UTC',
  user: { id: 2, username: 'member-test', role: 'member' as const },
}

export const anonymous = { initialized: true, time_zone: 'UTC', user: null }

export function withPage(value: unknown) {
  if (!value || typeof value !== 'object') return value
  const data = value as Record<string, unknown>
  const rows = [data.keys, data.members, data.events].find(Array.isArray)
  return rows ? { total: rows.length, page: 1, page_size: 50, ...data } : value
}

export const hourlyActivity = {
  time_zone: 'UTC',
  tracking_since: 1900000000,
  observed_until: 1900003600,
  cells: Array.from({ length: 168 }, (_, index) => ({
    weekday: Math.floor(index / 24),
    hour: index % 24,
    samples: index === 0 ? 1 : 0,
    requests: index === 0 ? 2 : 0,
    input_tokens: 0,
    output_tokens: 0,
    input_reported: 0,
    output_reported: 0,
  })),
}
