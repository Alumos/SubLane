import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { expect, it, vi } from 'vitest'
import { Content } from './Content'
import { createQueryClient } from '@/lib/query'
import { authKey } from '@/lib/auth'
import { authenticated } from '@/test/fixtures'

it('adds, tests and saves rules without randomUUID or retaining patterns and samples', async () => {
  vi.stubGlobal('crypto', {})
  const client = createQueryClient()
  client.setQueryData(authKey, authenticated)
  const saved: unknown[] = []
  const tested: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved.push(JSON.parse(String(init.body)))
      if (url.endsWith('/test')) tested.push(JSON.parse(String(init?.body)))
      return Promise.resolve(
        new Response(
          JSON.stringify(
            url.endsWith('/test')
              ? { matched: true }
              : {
                  mode: saved.length ? 'block' : 'off',
                  revision: saved.length,
                  rules: saved.length
                    ? [
                        {
                          id: 'rule_synthetic',
                          name: 'Synthetic rule',
                          kind: 'text',
                          enabled: true,
                        },
                      ]
                    : [],
                },
          ),
        ),
      )
    }),
  )
  render(
    <QueryClientProvider client={client}>
      <Content />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Configure rules' }),
  )
  await user.click(screen.getByRole('button', { name: 'Add rule' }))
  await user.type(screen.getByLabelText('Rule name'), 'Synthetic rule')
  await user.type(screen.getByLabelText('Matching content'), 'SYNTHETIC_SECRET')
  await user.type(screen.getByLabelText('Test sample'), 'SYNTHETIC_SECRET')
  await user.click(screen.getByRole('button', { name: 'Test rule' }))
  expect(await screen.findByText('Sample matched.')).toBeTruthy()
  expect(
    (screen.getByLabelText('Test sample') as HTMLTextAreaElement).value,
  ).toBe('')
  expect(
    (
      screen.getByRole('radio', {
        name: 'Off',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true)
  await user.click(screen.getByRole('radio', { name: 'Block' }))
  expect(
    (
      screen.getByRole('radio', {
        name: 'Block',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true)
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(await screen.findByText('Content rules saved.')).toBeTruthy()
  expect(saved).toEqual([
    {
      mode: 'block',
      revision: 0,
      rules: [
        {
          id: '',
          name: 'Synthetic rule',
          kind: 'text',
          enabled: true,
          pattern: 'SYNTHETIC_SECRET',
        },
      ],
    },
  ])
  expect(tested).toHaveLength(1)
  expect(
    JSON.stringify(client.getQueryData(['content-rules', 1])),
  ).not.toContain('SYNTHETIC_SECRET')
  expect(screen.queryByDisplayValue('SYNTHETIC_SECRET')).toBeNull()
})

it('keeps drafts independent when removing and adding rules', async () => {
  const client = createQueryClient()
  client.setQueryData(authKey, authenticated)
  vi.stubGlobal(
    'fetch',
    vi.fn(() =>
      Promise.resolve(
        new Response(JSON.stringify({ mode: 'off', revision: 0, rules: [] })),
      ),
    ),
  )
  render(
    <QueryClientProvider client={client}>
      <Content />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Configure rules' }),
  )
  for (const name of ['Discarded draft', 'Retained draft']) {
    await user.click(screen.getByRole('button', { name: 'Add rule' }))
    const draft = within(screen.getByRole('group', { name: 'New rule' }))
    await user.type(draft.getByLabelText('Rule name'), name)
    await user.type(draft.getByLabelText('Matching content'), name)
  }
  const retained = within(screen.getByRole('group', { name: 'Retained draft' }))
  await user.type(retained.getByLabelText('Test sample'), 'SYNTHETIC_SAMPLE')
  await user.click(
    within(screen.getByRole('group', { name: 'Discarded draft' })).getByRole(
      'button',
      { name: 'Remove rule' },
    ),
  )
  await user.click(screen.getByRole('button', { name: 'Add rule' }))
  const replacement = within(screen.getByRole('group', { name: 'New rule' }))
  await user.type(replacement.getByLabelText('Rule name'), 'Replacement draft')
  await user.type(replacement.getByLabelText('Matching content'), 'REPLACEMENT')
  expect(
    (retained.getByLabelText('Matching content') as HTMLInputElement).value,
  ).toBe('Retained draft')
  expect(
    (retained.getByLabelText('Test sample') as HTMLTextAreaElement).value,
  ).toBe('SYNTHETIC_SAMPLE')
  await user.click(replacement.getByRole('button', { name: 'Remove rule' }))
  expect(screen.getAllByLabelText('Rule name')).toHaveLength(1)
  expect(screen.getByRole('group', { name: 'Retained draft' })).toBeTruthy()
})

it('preserves a saved pattern on metadata edits and reports stale configuration', async () => {
  const client = createQueryClient()
  client.setQueryData(authKey, authenticated)
  const saved: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') {
        saved.push(JSON.parse(String(init.body)))
        return Promise.resolve(
          new Response(JSON.stringify({ error: 'content_rules_changed' }), {
            status: 409,
          }),
        )
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            mode: 'observe',
            revision: saved.length ? 4 : 3,
            rules: [
              {
                id: 'rule_synthetic',
                name: saved.length ? 'External rule' : 'Synthetic rule',
                kind: 'text',
                enabled: true,
              },
            ],
          }),
        ),
      )
    }),
  )
  render(
    <QueryClientProvider client={client}>
      <Content />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Configure rules' }),
  )
  expect(
    screen.getByLabelText('Matching content').getAttribute('placeholder'),
  ).toBe('Leave blank to keep the saved content')
  await user.clear(screen.getByLabelText('Rule name'))
  await user.type(screen.getByLabelText('Rule name'), 'Renamed rule')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  expect(
    await screen.findByText(
      'Rules changed in another session. Refresh before editing again.',
    ),
  ).toBeTruthy()
  expect(saved).toEqual([
    {
      mode: 'observe',
      revision: 3,
      rules: [
        {
          id: 'rule_synthetic',
          name: 'Renamed rule',
          kind: 'text',
          enabled: true,
        },
      ],
    },
  ])
  await user.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(
    await screen.findByRole('button', { name: 'Configure rules' }),
  ).toBeTruthy()
  await user.click(screen.getByRole('button', { name: 'Configure rules' }))
  expect((screen.getByLabelText('Rule name') as HTMLInputElement).value).toBe(
    'External rule',
  )
})

it('does not fetch management configuration for a member', () => {
  const client = createQueryClient()
  client.setQueryData(authKey, {
    ...authenticated,
    user: { ...authenticated.user, role: 'member' },
  })
  const fetcher = vi.fn()
  vi.stubGlobal('fetch', fetcher)
  render(
    <QueryClientProvider client={client}>
      <Content />
    </QueryClientProvider>,
  )
  expect(fetcher).not.toHaveBeenCalled()
})

it('edits a saved regex with highlighting without revealing its stored pattern', async () => {
  const client = createQueryClient()
  client.setQueryData(authKey, authenticated)
  const saved: unknown[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn((_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') saved.push(JSON.parse(String(init.body)))
      return Promise.resolve(
        new Response(
          JSON.stringify({
            mode: 'block',
            revision: saved.length ? 2 : 1,
            rules: [
              {
                id: 'rule_synthetic',
                name: 'Synthetic regex',
                kind: 'regex',
                enabled: true,
              },
            ],
          }),
        ),
      )
    }),
  )
  const { container } = render(
    <QueryClientProvider client={client}>
      <Content />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Configure rules' }),
  )
  const input = screen.getByLabelText('Matching content') as HTMLTextAreaElement
  expect(input.tagName).toBe('TEXTAREA')
  expect(input.value).toBe('')
  expect(input.placeholder).toBe('Leave blank to keep the saved content')
  await user.type(input, 'DEMO_TOKEN_')
  fireEvent.change(input, { target: { value: '^DEMO_TOKEN_[A-Z0-9]{8}$' } })
  expect(
    container.querySelector('[data-token="char-class"]')?.textContent,
  ).toBe('[A-Z0-9]')
  await user.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Content rules saved.')
  expect(saved).toEqual([
    {
      mode: 'block',
      revision: 1,
      rules: [
        {
          id: 'rule_synthetic',
          name: 'Synthetic regex',
          kind: 'regex',
          enabled: true,
          pattern: '^DEMO_TOKEN_[A-Z0-9]{8}$',
        },
      ],
    },
  ])
  expect(
    JSON.stringify(client.getQueryData(['content-rules', 1])),
  ).not.toContain('DEMO_TOKEN_')
})

it('locks rule inputs during a sample test and clears mutation-held samples after failure', async () => {
  const client = createQueryClient()
  client.setQueryData(authKey, authenticated)
  let finish: (value: Response) => void = () => {
    throw new Error('Test not started')
  }
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('/test')
        ? new Promise<Response>((resolve) => {
            finish = resolve
          })
        : Promise.resolve(
            new Response(
              JSON.stringify({ mode: 'off', revision: 0, rules: [] }),
            ),
          ),
    ),
  )
  render(
    <QueryClientProvider client={client}>
      <Content />
    </QueryClientProvider>,
  )
  const user = userEvent.setup()
  await user.click(
    await screen.findByRole('button', { name: 'Configure rules' }),
  )
  await user.click(screen.getByRole('button', { name: 'Add rule' }))
  await user.type(screen.getByLabelText('Rule name'), 'Synthetic rule')
  await user.type(screen.getByLabelText('Matching content'), 'DEMO')
  await user.click(screen.getByText('Test this rule'))
  await user.type(
    screen.getByLabelText('Test sample'),
    'SYNTHETIC_TRANSIENT_SAMPLE',
  )
  await user.click(screen.getByRole('button', { name: 'Test rule' }))
  for (const label of ['Rule name', 'Matching content', 'Test sample']) {
    expect(screen.getByLabelText(label).matches(':disabled')).toBe(true)
  }
  finish(
    new Response(JSON.stringify({ error: 'invalid_content_rules' }), {
      status: 400,
    }),
  )
  await screen.findByRole('alert')
  expect(
    (screen.getByLabelText('Test sample') as HTMLTextAreaElement).value,
  ).toBe('')
  await waitFor(() =>
    expect(
      JSON.stringify(
        client
          .getMutationCache()
          .getAll()
          .map((mutation) => mutation.state.variables),
      ),
    ).not.toContain('SYNTHETIC_TRANSIENT_SAMPLE'),
  )
})
