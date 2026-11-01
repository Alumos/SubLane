import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory } from '@tanstack/react-router'
import { expect, it, vi } from 'vitest'
import { App } from '@/App'
import { i18n } from '@/lib/i18n'
import { createAppRouter } from '@/router'
import * as queries from '@/lib/query'
import {
  authenticated,
  memberAuthenticated,
  hourlyActivity,
  system,
  workspaces,
} from '@/test/fixtures'

const metrics = {
  requests: 2,
  completed: 1,
  incomplete: 0,
  errors: 1,
  canceled: 0,
  rejected: 0,
  duration_ms: 840,
  input_tokens: 120,
  output_tokens: 38,
  cached_tokens: 0,
  input_reported: 1,
  output_reported: 1,
  cached_reported: 0,
}
const summary = {
  activity: hourlyActivity,
  time_zone: 'UTC',
  from_day: 1900000000,
  to_day: 1900086400,
  tracking_since: 1900000000,
  totals: metrics,
  days: [{ id: '1900000000', name: '2030-03-17', ...metrics }],
  members: [],
  models: [
    { id: 'codex/synthetic-model', name: 'codex/synthetic-model', ...metrics },
  ],
  groups: [],
}

it.each([
  ['/', memberAuthenticated, '/api/me/usage'],
  ['/admin/usage', authenticated, '/api/usage'],
] as const)(
  'shows honest usage totals at %s and changes the period',
  async (path, session, endpoint) => {
    const fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/state')
        return Promise.resolve(new Response(JSON.stringify(session)))
      if (url === '/api/workspaces')
        return Promise.resolve(new Response(JSON.stringify(workspaces)))
      if (url === '/api/connection')
        return Promise.resolve(
          new Response(JSON.stringify({ status: 'ready' })),
        )
      if (url === '/api/me/allocations')
        return Promise.resolve(new Response(JSON.stringify({ schemes: [] })))
      if (url === '/api/me/limits')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user_id: 2,
              requests_per_minute: 0,
              max_concurrency: 0,
              in_flight: 0,
              requests_this_minute: 0,
              reset_at: 1900000060,
            }),
          ),
        )
      if (url.startsWith(endpoint + '?'))
        return Promise.resolve(
          new Response(
            JSON.stringify({
              ...summary,
              totals: {
                ...metrics,
                input_tokens: 215_000_000,
                output_tokens: 1_200_000,
              },
            }),
          ),
        )
      return Promise.reject(new Error('Unexpected privileged data request'))
    })
    vi.stubGlobal('fetch', fetch)
    const user = userEvent.setup()
    render(
      <App
        router={createAppRouter(
          createMemoryHistory({ initialEntries: [path] }),
        )}
      />,
    )
    await screen.findByRole('heading', {
      name: path === '/' ? 'Your usage' : 'Team usage',
    })
    if (path !== '/')
      expect(screen.queryByRole('button', { name: /^Usage key:/ })).toBeNull()
    if (path === '/') {
      expect(
        screen.getByRole('heading', { name: 'Your workspace', level: 1 }),
      ).toBeTruthy()
      expect(
        screen.getByRole('heading', { name: 'Your usage', level: 2 }),
      ).toBeTruthy()
      expect(screen.queryByRole('link', { name: 'Usage' })).toBeNull()
    }
    await screen.findByText(
      'Some calls did not report token usage; totals include reported values only.',
    )
    await screen.findByRole('img', { name: 'Daily · Requests' })
    expect(screen.getByText('215M / 1.2M').getAttribute('title')).toBe(
      '215,000,000 / 1,200,000',
    )
    await screen.findByRole('region', { name: 'Activity by time' })
    expect(screen.getAllByRole('gridcell')).toHaveLength(168)
    if (path === '/')
      await screen.findByText('No resource allowances assigned.')
    const reads = fetch.mock.calls.filter(
      ([url]) => url === endpoint + '?days=7',
    ).length
    await user.click(
      screen.getByRole('button', {
        name: path === '/' ? 'Your usage: Refresh' : 'Refresh',
      }),
    )
    await waitFor(() =>
      expect(
        fetch.mock.calls.filter(([url]) => url === endpoint + '?days=7').length,
      ).toBeGreaterThan(reads),
    )
    expect(screen.queryByRole('table')).toBeNull()
    await user.click(screen.getByRole('button', { name: 'View details' }))
    expect(screen.getByRole('table', { name: 'Daily' })).toBeTruthy()
    await user.click(screen.getByRole('button', { name: 'Hide details' }))
    await user.click(screen.getByRole('button', { name: 'Usage period' }))
    await user.click(
      screen.getByRole('menuitemradio', { name: 'Last 30 days' }),
    )
    await waitFor(() =>
      expect(
        fetch.mock.calls.some(([url]) => url === endpoint + '?days=30'),
      ).toBe(true),
    )
    await user.click(screen.getByRole('button', { name: 'Breakdown' }))
    await user.click(screen.getByRole('menuitemradio', { name: 'Models' }))
    await screen.findByText('codex/synthetic-model')
    expect(
      screen.getByRole('region', { name: 'Activity by time' }),
    ).toBeTruthy()
    expect(
      fetch.mock.calls.every(
        ([url]) =>
          url === '/api/auth/state' ||
          url === '/api/workspaces' ||
          url === '/api/connection' ||
          url === '/api/me/limits' ||
          url === '/api/me/allocations' ||
          url.startsWith(endpoint + '?'),
      ),
    ).toBe(true)
    await i18n.changeLanguage('zh')
    await screen.findByRole('heading', {
      name: path === '/' ? '我的用量' : '团队用量',
    })
    expect(screen.getByText('215M / 1.2M')).toBeTruthy()
  },
)

it('shows personal usage beneath the administrator overview', async () => {
  const fetch = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/auth/state')
      return Promise.resolve(new Response(JSON.stringify(authenticated)))
    if (url === '/api/workspaces')
      return Promise.resolve(new Response(JSON.stringify(workspaces)))
    if (url === '/api/system')
      return Promise.resolve(new Response(JSON.stringify(system)))
    if (url.startsWith('/api/me/usage?'))
      return Promise.resolve(new Response(JSON.stringify(summary)))
    if (url === '/api/me/allocations')
      return Promise.resolve(new Response(JSON.stringify({ schemes: [] })))
    if (url === '/api/me/limits')
      return Promise.resolve(
        new Response(
          JSON.stringify({
            user_id: 1,
            requests_per_minute: 0,
            max_concurrency: 0,
            in_flight: 0,
            requests_this_minute: 0,
            reset_at: 1900000060,
          }),
        ),
      )
    return Promise.reject(new Error(`Unexpected request: ${url}`))
  })
  vi.stubGlobal('fetch', fetch)
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))}
    />,
  )
  expect(
    await screen.findByRole('heading', {
      name: 'Workspace overview',
      level: 1,
    }),
  ).toBeTruthy()
  expect(
    await screen.findByRole('heading', { name: 'Your usage', level: 2 }),
  ).toBeTruthy()
  expect(
    await screen.findByRole('img', { name: 'Daily · Requests' }),
  ).toBeTruthy()
  expect(screen.queryByRole('heading', { name: 'Service' })).toBeNull()
  expect(screen.getByRole('heading', { name: 'Gateway setup' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Instance status' })).toBeTruthy()
  expect(
    screen
      .getByRole('heading', { name: 'Gateway setup' })
      .compareDocumentPosition(
        screen.getByRole('heading', { name: 'Your usage' }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(
    screen
      .getByText(
        'Some calls did not report token usage; totals include reported values only.',
      )
      .compareDocumentPosition(
        screen.getByRole('heading', { name: 'My resource allowances' }),
      ) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy()
  expect(screen.queryByRole('link', { name: 'Usage' })).toBeNull()
  expect(screen.getByRole('link', { name: 'Team usage' })).toBeTruthy()
  expect(fetch.mock.calls.some(([url]) => url === '/api/me/usage?days=7')).toBe(
    true,
  )
})

const revokedUsageKey = {
  id: 21,
  group_id: 1,
  group_name: 'Synthetic group',
  group_access: 'allowed',
  name: 'Synthetic archived key',
  prefix: 'sl_synthetic',
  copyable: false,
  created_at: 1900000000,
  last_used_at: 1900003600,
  revoked_at: 1900007200,
  enabled: false,
  expires_at: null,
}
const keyMetrics = {
  ...metrics,
  requests: 5,
  completed: 5,
  errors: 0,
  input_reported: 5,
  output_reported: 5,
}
const keySummary = {
  ...summary,
  tracking_since: 1900003600,
  totals: keyMetrics,
  days: [{ ...summary.days[0], ...keyMetrics }],
  models: [{ id: 'key-model', name: 'Synthetic key model', ...keyMetrics }],
  groups: [{ id: 'key-group', name: 'Synthetic key group', ...keyMetrics }],
  activity: {
    ...hourlyActivity,
    tracking_since: 1900003600,
    cells: hourlyActivity.cells.map((cell, index) =>
      index === 0 ? { ...cell, requests: 5 } : cell,
    ),
  },
}

function renderKeyUsage(keys: (url: string) => Promise<Response>) {
  const fetch = vi.fn().mockImplementation((url: string) => {
    const response = (value: unknown) =>
      Promise.resolve(new Response(JSON.stringify(value)))
    if (url === '/api/auth/state') return response(memberAuthenticated)
    if (url === '/api/workspaces') return response(workspaces)
    if (url === '/api/connection') return response({ status: 'ready' })
    if (url === '/api/me/allocations') return response({ schemes: [] })
    if (url === '/api/me/limits')
      return response({
        user_id: 2,
        requests_per_minute: 12,
        max_concurrency: 3,
        in_flight: 1,
        requests_this_minute: 4,
        reset_at: 1900000060,
      })
    if (url.startsWith('/api/me/usage?'))
      return response(url.includes('&key_id=21') ? keySummary : summary)
    if (url.startsWith('/api/keys?')) return keys(url)
    return Promise.reject(new Error(`Unexpected request: ${url}`))
  })
  vi.stubGlobal('fetch', fetch)
  render(
    <App
      router={createAppRouter(createMemoryHistory({ initialEntries: ['/'] }))}
    />,
  )
  return fetch
}

it('filters every personal usage view by a revoked key, retains it across periods, and clears it', async () => {
  const fetch = renderKeyUsage(() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          keys: [revokedUsageKey],
          server_time: 1900008000,
          total: 1,
          page: 1,
          page_size: 50,
          next_cursor: 0,
        }),
      ),
    ),
  )
  const user = userEvent.setup()
  await screen.findByRole('img', { name: 'Daily · Requests' })
  const keyFilter = screen.getByRole('button', { name: /^Usage key:/ })
  expect(keyFilter.textContent).toContain('All keys')
  expect(fetch.mock.calls.some(([url]) => url.startsWith('/api/keys'))).toBe(
    false,
  )
  await user.click(screen.getAllByRole('gridcell')[0])
  await user.click(keyFilter)
  await user.click(
    await screen.findByRole('menuitemradio', {
      name: 'Synthetic archived key · sl_synthetic · Revoked',
    }),
  )
  await waitFor(() =>
    expect(
      screen.getByText('Requests', { selector: 'dt' }).nextElementSibling
        ?.textContent,
    ).toBe('5'),
  )
  expect(keyFilter.textContent).toContain(
    'Synthetic archived key · sl_synthetic · Revoked',
  )
  expect(
    fetch.mock.calls.some(([url]) => url === '/api/me/usage?days=7&key_id=21'),
  ).toBe(true)
  expect(
    screen.getAllByRole('gridcell')[0].getAttribute('aria-label'),
  ).toContain('Requests: 5')
  expect(
    screen
      .getAllByRole('gridcell')
      .some((cell) => cell.getAttribute('aria-selected') === 'true'),
  ).toBe(false)
  expect(screen.getByText('4 / 12')).toBeTruthy()
  expect(screen.getByText('1 / 3')).toBeTruthy()
  expect(
    fetch.mock.calls.filter(([url]) => url === '/api/me/limits'),
  ).toHaveLength(1)
  expect(
    fetch.mock.calls.filter(([url]) => url === '/api/me/allocations'),
  ).toHaveLength(1)
  await user.click(screen.getByRole('button', { name: 'View details' }))
  expect(
    within(screen.getByRole('table', { name: 'Daily' })).getByRole('cell', {
      name: '5',
    }),
  ).toBeTruthy()
  await user.click(screen.getByRole('img', { name: 'Daily · Requests' }))
  expect(
    within(screen.getByRole('region', { name: 'Usage chart' })).getByText('5', {
      selector: 'strong',
    }),
  ).toBeTruthy()
  for (const [breakdown, row] of [
    ['Models', 'Synthetic key model'],
    ['Resource groups', 'Synthetic key group'],
  ]) {
    await user.click(screen.getByRole('button', { name: 'Breakdown' }))
    await user.click(screen.getByRole('menuitemradio', { name: breakdown }))
    expect(
      within(
        screen.getByRole('list', { name: breakdown + ' · Requests' }),
      ).getByText(row),
    ).toBeTruthy()
    expect(
      within(screen.getByRole('table', { name: breakdown })).getByRole(
        'rowheader',
        { name: row },
      ),
    ).toBeTruthy()
  }
  await user.click(screen.getByRole('button', { name: 'Usage period' }))
  await user.click(screen.getByRole('menuitemradio', { name: 'Last 30 days' }))
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url]) => url === '/api/me/usage?days=30&key_id=21',
      ),
    ).toBe(true),
  )
  expect(keyFilter.textContent).toContain(
    'Synthetic archived key · sl_synthetic · Revoked',
  )
  await user.click(keyFilter)
  await user.click(screen.getByRole('menuitemradio', { name: 'All keys' }))
  await waitFor(() =>
    expect(
      screen.getByText('Requests', { selector: 'dt' }).nextElementSibling
        ?.textContent,
    ).toBe('2'),
  )
  expect(keyFilter.textContent).toContain('All keys')
  expect(
    screen.getAllByRole('gridcell')[0].getAttribute('aria-label'),
  ).toContain('Requests: 2')
  expect(
    fetch.mock.calls.some(([url]) => url === '/api/me/usage?days=30'),
  ).toBe(true)
  expect(fetch.mock.calls.some(([url]) => url.includes('/secret'))).toBe(false)
})

it('loads key choices on demand, retries failures, and makes later pages reachable without losing the selected label', async () => {
  let resolveFirst: (response: Response) => void = () => {}
  let first = true
  const fetch = renderKeyUsage((url) => {
    if (first) {
      first = false
      return new Promise<Response>((resolve) => {
        resolveFirst = resolve
      })
    }
    const page = Number(
      new URL(url, 'https://example.test').searchParams.get('page'),
    )
    return Promise.resolve(
      new Response(
        JSON.stringify({
          keys:
            page === 1
              ? Array.from({ length: 50 }, (_, index) => ({
                  ...revokedUsageKey,
                  id: index + 100,
                  name: `Synthetic key ${index + 1}`,
                  revoked_at: null,
                }))
              : [revokedUsageKey],
          server_time: 1900008000,
          total: 51,
          page,
          page_size: 50,
          next_cursor: page === 1 ? 21 : 0,
        }),
      ),
    )
  })
  const user = userEvent.setup()
  await screen.findByRole('img', { name: 'Daily · Requests' })
  const filter = screen.getByRole('button', { name: /^Usage key:/ })
  await user.click(filter)
  expect(
    (await screen.findByText('Loading API keys…')).getAttribute('role'),
  ).toBe('status')
  resolveFirst(
    new Response(JSON.stringify({ error: 'unavailable' }), { status: 503 }),
  )
  await screen.findByText('Could not load your API keys. Please try again.')
  expect(
    screen
      .getByRole('menuitemradio', { name: 'All keys' })
      .getAttribute('aria-checked'),
  ).toBe('true')
  expect(
    screen.getByText('Requests', { selector: 'dt' }).nextElementSibling
      ?.textContent,
  ).toBe('2')
  await user.click(screen.getByRole('menuitem', { name: 'Reconnect' }))
  await screen.findByRole('menuitemradio', {
    name: 'Synthetic key 50 · sl_synthetic',
  })
  await user.click(screen.getByRole('menuitem', { name: 'Next' }))
  await user.click(
    await screen.findByRole('menuitemradio', {
      name: 'Synthetic archived key · sl_synthetic · Revoked',
    }),
  )
  await waitFor(() =>
    expect(filter.textContent).toContain(
      'Synthetic archived key · sl_synthetic · Revoked',
    ),
  )
  await user.click(filter)
  await user.click(screen.getByRole('menuitem', { name: 'Previous' }))
  await screen.findByRole('menuitemradio', {
    name: 'Synthetic key 1 · sl_synthetic',
  })
  await user.keyboard('{Escape}')
  expect(filter.textContent).toContain(
    'Synthetic archived key · sl_synthetic · Revoked',
  )
  expect(
    fetch.mock.calls.some(
      ([url]) => url === '/api/keys?page=2&limit=50&include_revoked=true',
    ),
  ).toBe(true)
  expect(fetch.mock.calls.some(([url]) => url.includes('/secret'))).toBe(false)
})

it('distinguishes duplicate key names and keeps refreshed selected metadata across pages without refetching usage', async () => {
  const client = queries.createQueryClient()
  vi.spyOn(queries, 'createQueryClient').mockReturnValue(client)
  let refreshed = false
  const fetch = renderKeyUsage((url) => {
    const page = Number(
      new URL(url, 'https://example.test').searchParams.get('page'),
    )
    const keys =
      page === 1
        ? Array.from({ length: 50 }, (_, index) => ({
            ...revokedUsageKey,
            id: index === 1 ? 21 : index + 100,
            name: index < 2 ? 'Synthetic duplicate' : `Synthetic key ${index}`,
            prefix: index === 1 ? 'sl_second' : `sl_first${index}`,
            revoked_at: null,
            ...(index === 1 && refreshed
              ? { name: 'Synthetic renamed', revoked_at: 1900007200 }
              : {}),
          }))
        : [{ ...revokedUsageKey, id: 999 }]
    return Promise.resolve(
      new Response(
        JSON.stringify({
          keys,
          server_time: 1900008000,
          total: 51,
          page,
          page_size: 50,
          next_cursor: page === 1 ? 21 : 0,
        }),
      ),
    )
  })
  const user = userEvent.setup()
  await screen.findByRole('img', { name: 'Daily · Requests' })
  const filter = screen.getByRole('button', { name: /^Usage key/ })
  await user.click(filter)
  expect(
    await screen.findByRole('menuitemradio', {
      name: 'Synthetic duplicate · sl_first0',
    }),
  ).toBeTruthy()
  await user.click(
    screen.getByRole('menuitemradio', {
      name: 'Synthetic duplicate · sl_second',
    }),
  )
  await screen.findByRole('button', {
    name: 'Usage key: Synthetic duplicate · sl_second',
  })
  await waitFor(() =>
    expect(
      fetch.mock.calls.some(
        ([url]) => url === '/api/me/usage?days=7&key_id=21',
      ),
    ).toBe(true),
  )
  const usageReads = fetch.mock.calls.filter(([url]) =>
    url.startsWith('/api/me/usage?'),
  ).length
  refreshed = true
  await act(() => client.invalidateQueries({ queryKey: ['keys'] }))
  await user.click(filter)
  await screen.findByRole('menuitemradio', {
    name: 'Synthetic renamed · sl_second · Revoked',
  })
  expect(filter.getAttribute('aria-label')).toBe(
    'Usage key: Synthetic renamed · sl_second · Revoked',
  )
  await user.click(screen.getByRole('menuitem', { name: 'Next' }))
  await screen.findByRole('menuitemradio', {
    name: 'Synthetic archived key · sl_synthetic · Revoked',
  })
  await user.keyboard('{Escape}')
  expect(
    screen.getByRole('button', {
      name: 'Usage key: Synthetic renamed · sl_second · Revoked',
    }),
  ).toBeTruthy()
  expect(
    fetch.mock.calls.filter(([url]) => url.startsWith('/api/me/usage?')),
  ).toHaveLength(usageReads)
  expect(fetch.mock.calls.some(([url]) => url.includes('/secret'))).toBe(false)
})

it('redirects the former personal usage URL to the combined home page', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockImplementation((url: string) => {
      if (url === '/api/auth/state')
        return Promise.resolve(
          new Response(JSON.stringify(memberAuthenticated)),
        )
      if (url === '/api/workspaces')
        return Promise.resolve(new Response(JSON.stringify(workspaces)))
      if (url.startsWith('/api/me/usage?'))
        return Promise.resolve(new Response(JSON.stringify(summary)))
      if (url === '/api/me/allocations')
        return Promise.resolve(new Response(JSON.stringify({ schemes: [] })))
      if (url === '/api/me/limits')
        return Promise.resolve(
          new Response(
            JSON.stringify({
              user_id: 2,
              requests_per_minute: 0,
              max_concurrency: 0,
              in_flight: 0,
              requests_this_minute: 0,
              reset_at: 1900000060,
            }),
          ),
        )
      return Promise.reject(new Error(`Unexpected request: ${url}`))
    }),
  )
  const router = createAppRouter(
    createMemoryHistory({ initialEntries: ['/usage'] }),
  )
  render(<App router={router} />)
  await screen.findByRole('heading', { name: 'Your workspace' })
  expect(router.state.location.pathname).toBe('/')
  expect(
    await screen.findByRole('heading', { name: 'Your usage' }),
  ).toBeTruthy()
})
