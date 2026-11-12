import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { AccountFingerprint } from './AccountFingerprint'

function json(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
function mount(onClose = vi.fn()) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <AccountFingerprint
        account={{ id: 'synthetic-account', name: 'Synthetic account' }}
        onClose={onClose}
        restoreFocus={vi.fn()}
      />
    </QueryClientProvider>,
  )
  return onClose
}

it('saves a manual Codex platform with the spaces it contains', async () => {
  const calls: { method: string; body: unknown }[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method !== 'GET')
        calls.push({ method, body: JSON.parse(String(init?.body)) })
      return Promise.resolve(
        json({
          provider: 'codex',
          profile: {
            source: method === 'PUT' ? 'manual' : 'learned',
            platform: '(Mac OS 15.5.0; arm64) iTerm.app/3.6.1',
          },
        }),
      )
    }),
  )
  const onClose = mount()
  const field = await screen.findByLabelText('Platform and terminal')
  expect(screen.getByText('Learned from a native client')).toBeTruthy()
  const user = userEvent.setup()
  await user.clear(field)
  await user.type(field, ' (Windows 10.0.26100; x86_64) WindowsTerminal ')
  await user.click(screen.getByRole('button', { name: 'Save fingerprint' }))
  await waitFor(() => expect(onClose).toHaveBeenCalled())
  expect(calls).toEqual([
    {
      method: 'PUT',
      body: {
        platform: '(Windows 10.0.26100; x86_64) WindowsTerminal',
        os: '',
        arch: '',
        runtime_version: '',
        package_version: '',
        mode: 'off',
        tls: false,
      },
    },
  ])
})

it('resets a Claude fingerprint and optionally its device', async () => {
  const calls: { method: string; body: unknown }[] = []
  let device = '1a2b3c4d'
  vi.stubGlobal(
    'fetch',
    vi.fn((_: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET'
      if (method === 'DELETE') {
        calls.push({ method, body: JSON.parse(String(init?.body)) })
        device = '5e6f7a8b'
        return Promise.resolve(
          json({ provider: 'claude', profile: {}, device_id: device }),
        )
      }
      return Promise.resolve(
        json({
          provider: 'claude',
          profile: { source: 'learned', os: 'Windows', arch: 'x64' },
          device_id: device,
        }),
      )
    }),
  )
  mount()
  const os = (await screen.findByLabelText(
    'Operating system',
  )) as HTMLSelectElement
  expect(os.value).toBe('Windows')
  const user = userEvent.setup()
  await user.click(
    screen.getByRole('checkbox', { name: 'Also generate a new device ID' }),
  )
  await user.click(screen.getByRole('button', { name: 'Reset' }))
  await waitFor(() =>
    expect(calls).toEqual([{ method: 'DELETE', body: { device: true } }]),
  )
  await waitFor(() => expect(screen.getByText('5e6f7a8b…')).toBeTruthy())
})
