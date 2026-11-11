import { QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { createQueryClient } from '@/lib/query'
import { authKey, type AuthState } from '@/lib/auth'
import { authenticated, memberAuthenticated } from '@/test/fixtures'
import { Updates } from './Updates'

const state = {
  current_version: '1.2.0',
  latest_version: '1.3.0',
  release_url: 'https://github.com/Alumos/SubLane/releases/tag/v1.3.0',
  checked_at: 1900000000,
  check_failed: false,
  available: true,
  enabled: true,
  job: null,
}
const job = {
  id: 'a'.repeat(32),
  version: '1.3.0',
  status: 'queued',
  updated_at: 1900000000,
}
const response = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status })
function mount(identity: AuthState = authenticated) {
  const client = createQueryClient()
  client.setQueryData(authKey, identity)
  render(
    <QueryClientProvider client={client}>
      <Updates />
    </QueryClientProvider>,
  )
  return client
}
it('requires a backup acknowledgement and submits the inspected release exactly once', async () => {
  const fetch = vi.fn((url: string) =>
    Promise.resolve(
      response(url.endsWith('/install') ? { ...state, job } : state),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  const user = userEvent.setup()
  mount()
  await user.click(
    await screen.findByRole('button', { name: 'Update to 1.3.0' }),
  )
  const dialog = screen.getByRole('dialog', { name: 'Update SubLane' })
  const confirm = within(dialog).getByRole('button', { name: 'Install update' })
  expect(confirm.hasAttribute('disabled')).toBe(true)
  await user.click(within(dialog).getByRole('checkbox'))
  await user.click(confirm)
  expect(
    await screen.findByText('Update queued. Waiting for the host updater.'),
  ).toBeTruthy()
  const calls = fetch.mock.calls.filter(([url]) => url.endsWith('/install'))
  expect(calls).toHaveLength(1)
  expect((calls[0] as unknown[])[1]).toMatchObject({
    method: 'POST',
    body: JSON.stringify({ version: '1.3.0', backup_confirmed: true }),
  })
  expect(
    screen.queryByText('Update completed. Reload to use the new version.'),
  ).toBeNull()
})
it('keeps release checks available when host updates are not enabled', async () => {
  const fetch = vi.fn(() =>
    Promise.resolve(response({ ...state, enabled: false })),
  )
  vi.stubGlobal('fetch', fetch)
  mount()
  expect(
    await screen.findByText(
      'Enable the host updater to install updates from this page.',
    ),
  ).toBeTruthy()
  expect(screen.queryByRole('button', { name: 'Update to 1.3.0' })).toBeNull()
  await userEvent.click(
    screen.getByRole('button', { name: 'Check for updates' }),
  )
  expect(fetch.mock.calls.length).toBeGreaterThan(1)
})
it.each(['running', 'succeeded'])(
  'retains progress during a restart with worker status %s until the target is serving',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(response({ ...state, job: { ...job, status } })),
      ),
    )
    const client = mount()
    expect(
      await screen.findByText('Installing the update. SubLane will restart.'),
    ).toBeTruthy()
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new TypeError('Synthetic restart'))),
    )
    await act(async () => {
      await client.refetchQueries({ queryKey: ['software-updates'] })
    })
    expect(await screen.findByText('Reconnecting to SubLane…')).toBeTruthy()
    expect(
      screen.queryByText('Update completed. Reload to use the new version.'),
    ).toBeNull()
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          response({
            ...state,
            current_version: '1.3.0',
            available: false,
            job: { ...job, status: 'succeeded' },
          }),
        ),
      ),
    )
    await act(async () => {
      await client.refetchQueries({ queryKey: ['software-updates'] })
    })
    expect(
      await screen.findByText(
        'Update completed. Reload to use the new version.',
      ),
    ).toBeTruthy()
  },
)
it('shows a failed installation without claiming success', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        response({ ...state, job: { ...job, status: 'failed' } }),
      ),
    ),
  )
  mount()
  expect(await screen.findByRole('alert')).toHaveProperty(
    'textContent',
    expect.stringContaining('The update failed.'),
  )
  expect(
    screen.queryByText('Update completed. Reload to use the new version.'),
  ).toBeNull()
})
it.each([
  memberAuthenticated,
  { ...authenticated, user: { ...authenticated.user, id: 2 } },
])(
  'does not query software updates for an unauthorized identity',
  async (identity) => {
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    mount(identity)
    await waitFor(() => expect(fetch).not.toHaveBeenCalled())
    expect(
      screen.queryByRole('button', { name: 'Check for updates' }),
    ).toBeNull()
  },
)

it('accepts fork revision releases from this repository', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        response({
          ...state,
          current_version: '0.19.2-revised.8',
          latest_version: '0.19.2-revised.9',
          release_url:
            'https://github.com/Alumos/SubLane/releases/tag/v0.19.2-revised.9',
        }),
      ),
    ),
  )
  mount()
  // A revision build is a stable build: the page offers the newer revision instead of failing.
  expect(
    await screen.findByRole('button', { name: /0\.19\.2-revised\.9/ }),
  ).toBeTruthy()
  expect(screen.queryByText(/could not confirm/i)).toBeNull()
})
