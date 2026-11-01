import { expect, it, vi } from 'vitest'
import { QueryObserver } from '@tanstack/react-query'
import { requestOptions } from './requests'
import { auditOptions } from './audit'
import { memberOptions } from './members'
import { statisticsOptions } from './statistics'
import { authKey, authOptions } from './auth'
import { createQueryClient } from './query'
import {
  authenticated,
  memberAuthenticated,
  system,
  hourlyActivity,
} from '@/test/fixtures'

it('separates cached activity when the instance time zone changes', () => {
  const client = createQueryClient()
  client.setQueryData(authKey, { ...authenticated, time_zone: 'UTC' })
  const previous = statisticsOptions(client, 1, 'personal', 7)
  client.setQueryData<{ activity: typeof hourlyActivity }>(previous.queryKey, {
    activity: hourlyActivity,
  })
  client.setQueryData(authKey, { ...authenticated, time_zone: 'Asia/Shanghai' })
  const current = statisticsOptions(client, 1, 'personal', 7)
  expect(current.queryKey).not.toEqual(previous.queryKey)
  expect(client.getQueryData(current.queryKey)).toBeUndefined()
  client.clear()
})

it.each(['audit', 'members'] as const)(
  'does not seed a clamped %s page after switching administrators',
  async (kind) => {
    const client = createQueryClient()
    client.setQueryData(authKey, authenticated)
    let complete!: (response: Response) => void
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            complete = resolve
          }),
      ),
    )
    const pending =
      kind === 'audit'
        ? client.fetchQuery(auditOptions(client, 4, '', ''))
        : client.fetchQuery(memberOptions(client, 4, 50))
    client.setQueryData(authKey, {
      ...authenticated,
      user: { ...authenticated.user, id: 99 },
    })
    complete(
      new Response(
        JSON.stringify({
          [kind === 'audit' ? 'events' : 'members']: [],
          total: 0,
          page: 1,
          page_size: 50,
          next_cursor: 0,
        }),
      ),
    )
    await pending
    const destination =
      kind === 'audit'
        ? auditOptions(client, 1, '', '')
        : memberOptions(client, 1, 50)
    expect(client.getQueryData(destination.queryKey)).toBeUndefined()
    client.clear()
  },
)

it.each(['personal', 'all'] as const)(
  'stops a mounted %s history observer when the active identity changes',
  async (scope) => {
    const client = createQueryClient()
    client.setQueryData(authKey, authenticated)
    const fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          requests: [],
          next_cursor: 0,
          total: 0,
          page: 1,
          page_size: 50,
        }),
      ),
    )
    vi.stubGlobal('fetch', fetch)
    const options = requestOptions(client, authenticated.user.id, scope, 1, {})
    await client.fetchQuery(options)
    const observer = new QueryObserver(client, options)
    const unsubscribe = observer.subscribe(() => {})
    try {
      client.setQueryData(authKey, memberAuthenticated)
      await client.invalidateQueries({ queryKey: ['request-history'] })
      expect(fetch).toHaveBeenCalledTimes(1)
    } finally {
      unsubscribe()
      client.clear()
    }
  },
)

it('removes administrator data when session refresh detects another identity', async () => {
  const client = createQueryClient()
  let state = authenticated as typeof authenticated | typeof memberAuthenticated
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(new Response(JSON.stringify(state))),
      ),
  )
  await client.fetchQuery(authOptions())
  client.setQueryData(['system'], system)
  client.setQueryData(['members', 0], { members: [], next_cursor: 0 })
  state = memberAuthenticated
  await client.fetchQuery({ ...authOptions(), staleTime: 0 })
  expect(client.getQueryData(authKey)).toEqual(memberAuthenticated)
  expect(client.getQueryData(['system'])).toBeUndefined()
  expect(client.getQueryData(['members', 0])).toBeUndefined()
  client.clear()
})

it('stops usage refetches under an obsolete identity', async () => {
  const client = createQueryClient()
  client.setQueryData(authKey, authenticated)
  const options = statisticsOptions(client, authenticated.user.id, 'all', 7)
  client.setQueryData(options.queryKey, {
    activity: hourlyActivity,
    time_zone: 'UTC',
    from_day: 1900000000,
    to_day: 1900086400,
    tracking_since: 1900000000,
    totals: {
      requests: 1,
      completed: 1,
      incomplete: 0,
      errors: 0,
      canceled: 0,
      rejected: 0,
      duration_ms: 120,
      input_tokens: 0,
      output_tokens: 0,
      cached_tokens: 0,
      input_reported: 0,
      output_reported: 0,
      cached_reported: 0,
    },
    days: [],
    members: [],
    models: [],
    groups: [],
  })
  const fetch = vi
    .fn()
    .mockRejectedValue(new Error('Unexpected old-identity fetch'))
  vi.stubGlobal('fetch', fetch)
  const observer = new QueryObserver(client, options)
  const unsubscribe = observer.subscribe(() => {})
  try {
    client.setQueryData(authKey, memberAuthenticated)
    await client.invalidateQueries({ queryKey: ['statistics'] })
    expect(fetch).not.toHaveBeenCalled()
  } finally {
    unsubscribe()
    client.clear()
  }
})
