import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { useState } from 'react'
import { SchemeForm } from './SchemeForm'
import { AllocationPriceWarning } from './AllocationPriceWarning'
import {
  parseAllocationValue,
  schemeSchema,
  allocationDetailSchema,
} from '@/lib/allocations'

function scheduledShares() {
  const config = {
    mode: 'ratio',
    ratio_unit: 'tokens',
    period: 'durations',
    windows: [
      { duration_seconds: 18000, limit: 100_000_000 },
      { duration_seconds: 604800, limit: 1_000_000_000 },
    ],
    members: [
      { user_id: 101, limit: 5000 },
      { user_id: 102, limit: 5000 },
    ],
    rates: [],
  }
  return schemeSchema.parse({
    id: 1,
    name: 'Synthetic scheduled shares',
    group_id: 2,
    group_name: 'Synthetic pool',
    enabled: true,
    created_at: 1900000000,
    effective_at: 1900000000,
    accounting_anchor_at: 1900000000,
    edit_effective_at: 1900604800,
    config,
    next: {
      effective_at: 1900604800,
      accounting_anchor_at: 1900604800,
      config: {
        ...config,
        windows: [
          { duration_seconds: 14400, limit: 100_000_000 },
          { duration_seconds: 604800, limit: 1_000_000_000 },
        ],
      },
    },
    write_conditions: {
      expected_current_revision_id: 41,
      expected_next_revision_id: 42,
    },
  })
}

const scheduledFormProps = {
  groups: [{ id: 2, name: 'Synthetic pool', enabled: true }],
  groupID: 2,
  onGroupChange: () => {},
  members: [
    { id: 101, username: 'synthetic-a' },
    { id: 102, username: 'synthetic-b' },
  ],
  onCancel: () => {},
  pending: false,
}

it('reconfirms an approved pending structure before editing its members', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  const scheme = scheduledShares()
  const view = render(
    <SchemeForm {...scheduledFormProps} scheme={scheme} onSubmit={submit} />,
  )
  expect(
    screen.getByLabelText('Allowance for synthetic-a').matches(':disabled'),
  ).toBe(true)
  await user.click(
    screen.getByRole('checkbox', { name: /Confirm a new accounting period/ }),
  )
  expect(
    screen.getByLabelText('Allowance for synthetic-a').matches(':disabled'),
  ).toBe(false)
  fireEvent.change(screen.getByLabelText('Allowance for synthetic-a'), {
    target: { value: '40' },
  })
  fireEvent.change(screen.getByLabelText('Allowance for synthetic-b'), {
    target: { value: '60' },
  })
  view.rerender(
    <SchemeForm
      {...scheduledFormProps}
      scheme={{
        ...scheme,
        write_conditions: {
          expected_current_revision_id: 51,
          expected_next_revision_id: 52,
        },
      }}
      onSubmit={submit}
    />,
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0]).toMatchObject({
    apply_now: false,
    confirm_replacement: true,
    expected_current_revision_id: 41,
    expected_next_revision_id: 42,
    expected_effective_at: 1900604800,
    config: {
      members: [
        { user_id: 101, limit: 4000 },
        { user_id: 102, limit: 6000 },
      ],
    },
  })
})

it('keeps an ordinary pending budget edit separate from replacement confirmation', () => {
  const submit = vi.fn()
  render(
    <SchemeForm
      {...scheduledFormProps}
      members={[scheduledFormProps.members[0]]}
      scheme={scheduledShares()}
      onSubmit={submit}
    />,
  )
  fireEvent.change(screen.getByLabelText('Shared limit for condition 1'), {
    target: { value: '120' },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0]).toMatchObject({
    confirm_replacement: false,
    expected_effective_at: 1900604800,
    config: {
      members: [
        { user_id: 101, limit: 5000 },
        { user_id: 102, limit: 5000 },
      ],
    },
  })
})

it('shows and saves the original member plan after replacement consent is withdrawn', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      {...scheduledFormProps}
      scheme={scheduledShares()}
      onSubmit={submit}
    />,
  )
  const confirm = screen.getByRole('checkbox', {
    name: /Confirm a new accounting period/,
  })
  await user.click(confirm)
  fireEvent.change(screen.getByLabelText('Allowance for synthetic-a'), {
    target: { value: '40' },
  })
  fireEvent.change(screen.getByLabelText('Allowance for synthetic-b'), {
    target: { value: '60' },
  })
  await user.click(confirm)
  expect(
    (screen.getByLabelText('Allowance for synthetic-a') as HTMLInputElement)
      .value,
  ).toBe('50')
  expect(
    screen.getByLabelText('Allowance for synthetic-a').matches(':disabled'),
  ).toBe(true)
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0]).toMatchObject({
    confirm_replacement: false,
    config: {
      members: [
        { user_id: 101, limit: 5000 },
        { user_id: 102, limit: 5000 },
      ],
    },
  })
})

it('corrects an initial member list at its reviewed start without an immediate edit', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  const scheduled = scheduledShares()
  const config = {
    ...scheduled.next!.config,
    members: [{ user_id: 101, limit: 10000 }],
  }
  const initial = {
    ...scheduled,
    config,
    effective_at: scheduled.next!.effective_at,
    next: { ...scheduled.next!, config },
    write_conditions: {
      expected_current_revision_id: null,
      expected_next_revision_id: 42,
    },
  }
  render(
    <SchemeForm {...scheduledFormProps} scheme={initial} onSubmit={submit} />,
  )
  expect(
    screen.getByLabelText('Allowance for synthetic-b').matches(':disabled'),
  ).toBe(false)
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Edit current members',
      }) as HTMLInputElement
    ).disabled,
  ).toBe(true)
  await user.click(
    screen.getByRole('checkbox', { name: 'Include synthetic-a' }),
  )
  await user.click(
    screen.getByRole('checkbox', { name: 'Include synthetic-b' }),
  )
  fireEvent.change(screen.getByLabelText('Allowance for synthetic-b'), {
    target: { value: '100' },
  })
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0]).toMatchObject({
    apply_now: false,
    confirm_replacement: false,
    expected_current_revision_id: null,
    expected_next_revision_id: 42,
    expected_effective_at: 1900604800,
    config: { members: [{ user_id: 102, limit: 10000 }] },
  })
})

it('requires authoritative initial-version metadata before unlocking members', () => {
  const scheme = scheduledShares()
  render(
    <SchemeForm
      {...scheduledFormProps}
      scheme={{
        ...scheme,
        config: scheme.next!.config,
        effective_at: scheme.next!.effective_at,
        write_conditions: undefined,
      }}
      onSubmit={vi.fn()}
    />,
  )
  expect(
    screen.getByLabelText('Allowance for synthetic-a').matches(':disabled'),
  ).toBe(true)
})

it('identifies a single ratio window and explains the shared budget blocker', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  const detail = allocationDetailSchema.parse({
    id: 1,
    name: 'Synthetic window',
    group_id: 2,
    group_name: 'Synthetic',
    enabled: true,
    effective_at: 1,
    created_at: 1,
    next: null,
    config: {
      mode: 'ratio',
      ratio_unit: 'tokens',
      period: 'durations',
      members: [{ user_id: 101, limit: 10000 }],
      rates: [],
      windows: [{ duration_seconds: 18000, limit: 100 }],
    },
    available: true,
    pending: [],
    balances: [
      {
        user_id: 101,
        username: 'synthetic-member',
        window_kind: 'duration',
        window_seconds: 18000,
        mode: 'tokens',
        limit: 100,
        used: 0,
        tokens: 0,
        pending: 2,
        pending_current: 1,
        in_flight: 0,
        reserved: 0,
        admission_room: 110,
        admission: 'exhausted',
        reset_at: 1900018000,
        shared_budget_blocked: true,
      },
    ],
  })
  render(<AllocationBalances detail={detail} />)
  expect(screen.getByRole('heading', { name: '5 hours' })).toBeTruthy()
  expect(
    screen.getByText(/Pending records across this allowance: 2/),
  ).toBeTruthy()
  expect(
    screen.getByText(/shared group budget is temporarily unavailable/),
  ).toBeTruthy()
})

it('keeps reviewed version conditions when polling replaces the form props', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  const original = schemeSchema.parse({
    id: 1,
    name: 'Synthetic draft',
    group_id: 2,
    group_name: 'Synthetic pool',
    enabled: true,
    created_at: 1,
    effective_at: 1,
    edit_effective_at: 1900086400,
    next: null,
    write_conditions: {
      expected_current_revision_id: 41,
      expected_next_revision_id: null,
    },
    config: {
      mode: 'tokens',
      period: 'day',
      members: [{ user_id: 7, limit: 1_000_000 }],
      rates: [],
    },
  })
  const props = {
    groups: [{ id: 2, name: 'Synthetic pool', enabled: true }],
    groupID: 2,
    onGroupChange: () => {},
    members: [{ id: 7, username: 'synthetic-member' }],
    onSubmit: submit,
    onCancel: () => {},
    pending: false,
  }
  const view = render(<SchemeForm {...props} scheme={original} />)
  await user.click(
    screen.getByRole('checkbox', { name: 'Edit current members' }),
  )
  expect(
    screen.queryByText(/changes saved now are expected to take effect/),
  ).toBeNull()
  view.rerender(
    <SchemeForm
      {...props}
      scheme={{
        ...original,
        write_conditions: {
          expected_current_revision_id: 42,
          expected_next_revision_id: null,
        },
      }}
    />,
  )
  await user.clear(screen.getByLabelText('Allowance for synthetic-member'))
  await user.type(
    screen.getByLabelText('Allowance for synthetic-member'),
    '0.5',
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0]).toMatchObject({
    apply_now: true,
    expected_current_revision_id: 41,
  })
})

it('preserves the saved member section when budget editing omits a revoked member from the roster', async () => {
  const submit = vi.fn()
  const scheme = schemeSchema.parse({
    id: 1,
    name: 'Synthetic preserved members',
    group_id: 2,
    group_name: 'Synthetic pool',
    enabled: true,
    created_at: 1,
    effective_at: 1,
    edit_effective_at: 1900086400,
    next: null,
    write_conditions: {
      expected_current_revision_id: 41,
      expected_next_revision_id: null,
    },
    config: {
      mode: 'ratio',
      ratio_unit: 'tokens',
      total: 100_000_000,
      period: 'day',
      members: [
        { user_id: 7, limit: 5000 },
        { user_id: 8, limit: 5000 },
      ],
      rates: [],
    },
  })
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      scheme={scheme}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  expect(screen.getByText('Allocated 100% · Unallocated 0%')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Total budget'), {
    target: { value: '120' },
  })
  fireEvent.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0].config.members).toEqual(
    scheme.config.members,
  )
})

it('creates token shares across independent duration windows', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic window shares',
  )
  await user.click(screen.getByRole('button', { name: 'Reset period' }))
  await user.click(
    screen.getByRole('menuitemradio', { name: 'By time window' }),
  )
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.type(screen.getByLabelText('Duration for condition 1'), '5')
  await user.type(screen.getByLabelText('Shared limit for condition 1'), '1')
  await user.type(
    screen.getByLabelText('Allowance for synthetic-member'),
    '100',
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0]?.[0].config).toMatchObject({
    mode: 'ratio',
    period: 'durations',
    ratio_unit: 'tokens',
    windows: [{ duration_seconds: 18000, limit: 1_000_000 }],
    members: [{ user_id: 7, limit: 10000 }],
  })
  expect(submit.mock.calls[0][0].config.total).toBeUndefined()
})

it('groups the allowance form and keeps activation outside optional pricing', () => {
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={() => {}}
      onCancel={() => {}}
      pending={false}
    />,
  )
  expect(screen.getByRole('heading', { name: 'Rule details' })).toBeTruthy()
  expect(
    screen.getByRole('heading', { name: 'Allowance and reset' }),
  ).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Member shares' })).toBeTruthy()
  expect(screen.getByRole('heading', { name: 'Activation' })).toBeTruthy()
  expect(
    screen.getByLabelText('Enable this resource allowance').closest('details'),
  ).toBeNull()
})

it('selects and clears all granted members for a direct token allowance', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[
        { id: 2, username: 'synthetic-first' },
        { id: 3, username: 'synthetic-second' },
      ]}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic direct',
  )
  await user.click(screen.getByLabelText('By tokens'))
  const selectAll = screen.getByRole('checkbox', { name: 'Select all members' })
  await user.click(selectAll)
  expect((selectAll as HTMLInputElement).checked).toBe(true)
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Include synthetic-first',
      }) as HTMLInputElement
    ).checked,
  ).toBe(true)
  await user.type(screen.getByLabelText('Allowance for synthetic-first'), '1')
  await user.type(screen.getByLabelText('Allowance for synthetic-second'), '2')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config.members).toEqual([
    { user_id: 2, limit: 1_000_000 },
    { user_id: 3, limit: 2_000_000 },
  ])
  await user.click(selectAll)
  expect((selectAll as HTMLInputElement).checked).toBe(false)
  expect(
    (
      screen.getByRole('checkbox', {
        name: 'Include synthetic-first',
      }) as HTMLInputElement
    ).checked,
  ).toBe(false)
})

it('uses pool model prices automatically without price inputs in the allowance form', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SchemeForm
        groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
        groupID={2}
        onGroupChange={() => {}}
        members={[{ id: 7, username: 'synthetic-member' }]}
        onSubmit={submit}
        onCancel={() => {}}
        pending={false}
      />
    </QueryClientProvider>,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic priced',
  )
  await user.click(screen.getByLabelText('By amount'))
  await user.type(screen.getByLabelText('Allowance for synthetic-member'), '1')
  expect(screen.queryByRole('heading', { name: 'Model prices' })).toBeNull()
  expect(screen.queryByRole('button', { name: 'Add model price' })).toBeNull()
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config.rates).toEqual([])
})

it('shows the server-calculated effective date before editing a long window', () => {
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      scheme={{
        id: 1,
        name: 'Synthetic long window',
        group_id: 2,
        group_name: 'Synthetic pool',
        enabled: true,
        created_at: 1,
        effective_at: 1,
        edit_effective_at: 1_896_048_000,
        price_coverage: { uncovered_models: ['synthetic-new'] },
        next: null,
        config: {
          mode: 'windows',
          period: 'durations',
          windows: [{ duration_seconds: 30 * 86400, limit: 1_000_000 }],
          members: [{ user_id: 7, limit: 0 }],
          rates: [],
        },
      }}
      onSubmit={() => {}}
      onCancel={() => {}}
      pending={false}
    />,
  )
  const preview = screen.getByText(
    /changes saved now are expected to take effect on/,
  )
  expect(preview.textContent).toContain('2030')
  expect(screen.getByText(/synthetic-new/).textContent).toContain('2030')
})

it('updates the scheduled-start preview as the longest new window changes', () => {
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2030, 0, 1))
  try {
    render(
      <SchemeForm
        groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
        groupID={2}
        onGroupChange={() => {}}
        members={[{ id: 7, username: 'synthetic-member' }]}
        onSubmit={() => {}}
        onCancel={() => {}}
        pending={false}
      />,
    )
    fireEvent.click(screen.getByLabelText('By time window'))
    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
    fireEvent.change(screen.getByLabelText('Duration for condition 1'), {
      target: { value: '30' },
    })
    fireEvent.change(screen.getByLabelText('Unit for condition 1'), {
      target: { value: 'days' },
    })
    fireEvent.click(screen.getByLabelText('Start next period'))
    expect(
      screen.getByText(/If saved now, this rule is expected to start/)
        .textContent,
    ).toContain('2030')
    fireEvent.change(screen.getByLabelText('Duration for condition 1'), {
      target: { value: '365' },
    })
    expect(
      screen.getByText(/If saved now, this rule is expected to start/)
        .textContent,
    ).toContain('2031')
  } finally {
    clock.mockRestore()
  }
})

it('shows the future edit delay while configuring a time window', () => {
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={() => {}}
      onCancel={() => {}}
      pending={false}
    />,
  )
  fireEvent.click(screen.getByLabelText('By time window'))
  fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))
  fireEvent.change(screen.getByLabelText('Duration for condition 1'), {
    target: { value: '30' },
  })
  fireEvent.change(screen.getByLabelText('Unit for condition 1'), {
    target: { value: 'days' },
  })
  expect(screen.getByText(/Future edits may wait up to 30 days/)).toBeTruthy()
})

it('distinguishes a missing catalog price from a model absent in the saved revision', () => {
  render(
    <AllocationPriceWarning
      effectiveAt={1_893_456_000}
      coverage={{
        missing_catalog_prices: ['synthetic-old'],
        uncovered_models: ['synthetic-new'],
        catalog_unavailable: true,
      }}
    />,
  )
  expect(screen.getByText(/synthetic-old/)).toBeTruthy()
  expect(screen.getByText(/synthetic-new/)).toBeTruthy()
  expect(
    screen.getByText(/Save the allowance to include its price/),
  ).toBeTruthy()
  expect(
    screen.getByText(/If saved now, this change is expected to take effect/)
      .textContent,
  ).toContain('2030')
  expect(screen.getByText(/Saved prices are retained/)).toBeTruthy()
})

it('uses the saved revision date when warning about scheduled price coverage', () => {
  render(
    <AllocationPriceWarning
      coverage={{ uncovered_models: ['synthetic-scheduled'] }}
      effectiveAt={1_893_456_000}
      timing="scheduled"
    />,
  )
  expect(
    screen.getByText(/This saved version is scheduled to take effect/)
      .textContent,
  ).toContain('2030')
  expect(
    screen.getByText(/will remain blocked after this version takes effect/),
  ).toBeTruthy()
  expect(screen.queryByText(/If saved now/)).toBeNull()
})

it('adds custom hour and day windows with one personal override', async () => {
  const user = userEvent.setup()
  const submit = mountModelPrices('synthetic-basic', [
    { id: 2, username: 'synthetic-member' },
    { id: 3, username: 'synthetic-second' },
  ])
  await user.click(screen.getByLabelText('By time window'))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.type(screen.getByLabelText('Duration for condition 1'), '2')
  await user.type(screen.getByLabelText('Shared limit for condition 1'), '1')
  await user.type(screen.getByLabelText('Duration for condition 2'), '3')
  await user.selectOptions(
    screen.getByLabelText('Unit for condition 2'),
    'days',
  )
  await user.type(screen.getByLabelText('Shared limit for condition 2'), '10')
  await user.click(screen.getByRole('checkbox', { name: 'Select all members' }))
  await user.click(
    screen.getByLabelText('Override limits for synthetic-second'),
  )
  await user.click(
    screen.getByLabelText('Override 2 hours for synthetic-second'),
  )
  await user.type(
    screen.getByLabelText('2 hours limit for synthetic-second'),
    '2',
  )
  await user.click(
    screen.getByRole('checkbox', { name: /Confirm a new accounting period/ }),
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config).toEqual(
    expect.objectContaining({
      mode: 'windows',
      period: 'durations',
      windows: [
        { duration_seconds: 2 * 3600, limit: 1_000_000 },
        { duration_seconds: 3 * 86400, limit: 10_000_000 },
      ],
      members: [
        { user_id: 2, limit: 0 },
        {
          user_id: 3,
          limit: 0,
          window_overrides: [{ duration_seconds: 2 * 3600, limit: 2_000_000 }],
        },
      ],
      rates: [],
    }),
  )
})

it('omits an override when its time-window condition is removed', async () => {
  const user = userEvent.setup()
  const submit = mountModelPrices()
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic conditions',
  )
  await user.click(screen.getByLabelText('By time window'))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.type(screen.getByLabelText('Duration for condition 1'), '5')
  await user.type(screen.getByLabelText('Shared limit for condition 1'), '1')
  await user.type(screen.getByLabelText('Duration for condition 2'), '7')
  await user.selectOptions(
    screen.getByLabelText('Unit for condition 2'),
    'days',
  )
  await user.type(screen.getByLabelText('Shared limit for condition 2'), '2')
  await user.click(screen.getByLabelText('Include synthetic-member'))
  await user.click(
    screen.getByLabelText('Override limits for synthetic-member'),
  )
  await user.click(
    screen.getByLabelText('Override 5 hours for synthetic-member'),
  )
  await user.type(
    screen.getByLabelText('5 hours limit for synthetic-member'),
    '3',
  )
  await user.click(screen.getByRole('button', { name: 'Remove condition 1' }))
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config.windows).toEqual([
    { duration_seconds: 7 * 86400, limit: 2_000_000 },
  ])
  expect(submit.mock.calls[0][0].config.members).toEqual([
    { user_id: 2, limit: 0 },
  ])
})

it('assigns a pool allowance directly to its granted members', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Pool allowance',
  )
  await user.click(screen.getByLabelText('By tokens'))
  await user.type(screen.getByLabelText('Allowance for synthetic-member'), '1')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      group_id: 2,
      config: expect.objectContaining({
        members: [{ user_id: 7, limit: 1000000 }],
      }),
    }),
  )
})

it('requires a total token budget and saves percentage shares', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic shares',
  )
  await user.type(screen.getByLabelText('Allowance for synthetic-member'), '25')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).not.toHaveBeenCalled()
  await user.type(screen.getByLabelText('Total budget'), '1')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        mode: 'ratio',
        period: 'month',
        reset_day: 1,
        reset_time: '00:00',
        ratio_unit: 'tokens',
        total: 1_000_000,
        members: [{ user_id: 7, limit: 2500 }],
        rates: [],
      },
    }),
  )
})

it('lets a selected member use an unlimited time-window condition', async () => {
  const user = userEvent.setup()
  const submit = mountModelPrices('synthetic-basic')
  await user.click(screen.getByLabelText('By time window'))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.type(screen.getByLabelText('Duration for condition 1'), '5')
  await user.click(screen.getByRole('checkbox', { name: 'Select all members' }))
  await user.click(
    screen.getByRole('checkbox', { name: /Confirm a new accounting period/ }),
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config).toEqual(
    expect.objectContaining({
      period: 'durations',
      windows: [{ duration_seconds: 5 * 3600, limit: 0 }],
      members: [{ user_id: 2, limit: 0 }],
      rates: [],
    }),
  )
})

it('removes a time-window condition without saving it', async () => {
  const user = userEvent.setup()
  const submit = mountModelPrices('synthetic-basic')
  await user.click(screen.getByLabelText('By time window'))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.click(screen.getByRole('button', { name: 'Add condition' }))
  await user.type(screen.getByLabelText('Duration for condition 1'), '5')
  await user.type(screen.getByLabelText('Duration for condition 2'), '7')
  await user.selectOptions(
    screen.getByLabelText('Unit for condition 2'),
    'days',
  )
  await user.click(screen.getByRole('button', { name: 'Remove condition 1' }))
  await user.click(screen.getByRole('checkbox', { name: 'Select all members' }))
  await user.click(
    screen.getByRole('checkbox', { name: /Confirm a new accounting period/ }),
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config.windows).toEqual([
    { duration_seconds: 7 * 86400, limit: 0 },
  ])
})

it('offers an internal USD basis below the share choice', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic shares',
  )
  await user.click(screen.getByLabelText('By amount share'))
  await user.type(screen.getByLabelText('Total budget'), '2')
  await user.type(screen.getByLabelText('Allowance for synthetic-member'), '25')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        mode: 'ratio',
        ratio_unit: 'amount',
        total: 2_000_000,
        period: 'month',
        reset_day: 1,
        reset_time: '00:00',
        members: [{ user_id: 7, limit: 2500 }],
        rates: [],
        auto_prices: true,
      },
    }),
  )
})

it('splits amount shares exactly while editing', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  client.setQueryData(['auth'], {
    initialized: true,
    user: { id: 1, username: 'synthetic-admin', role: 'admin' },
  })
  const team = {
    id: 1,
    name: 'Synthetic team',
    enabled: true,
    created_at: 1,
    member_ids: [2, 3, 4],
    members: [2, 3, 4].map((id) => ({
      id,
      username: `synthetic-${id}`,
      enabled: true,
    })),
  }
  const rates = [
    {
      model: 'synthetic-model',
      input: 1000000,
      cached: 100000,
      output: 4000000,
    },
  ]
  render(
    <QueryClientProvider client={client}>
      <SchemeForm
        groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
        groupID={2}
        onGroupChange={() => {}}
        members={team.members}
        scheme={{
          id: 1,
          name: 'Synthetic',
          group_id: 2,
          group_name: 'Synthetic pool',
          enabled: true,
          created_at: 1,
          effective_at: 1,
          next: null,
          edit_effective_at: 1_900_000_000,
          write_conditions: {
            expected_current_revision_id: 41,
            expected_next_revision_id: null,
          },
          config: {
            mode: 'ratio',
            ratio_unit: 'amount',
            total: 1_000_000,
            period: 'month',
            members: [],
            rates,
          },
        }}
        pending={false}
        onCancel={() => {}}
        onSubmit={submit}
      />
    </QueryClientProvider>,
  )
  expect(screen.queryByRole('heading', { name: 'Model prices' })).toBeNull()
  await user.click(
    screen.getByRole('checkbox', { name: 'Edit current members' }),
  )
  await user.click(screen.getByRole('button', { name: 'Split equally' }))
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        mode: 'ratio',
        ratio_unit: 'amount',
        total: 1_000_000,
        period: 'month',
        reset_day: 1,
        reset_time: '00:00',
        members: [
          { user_id: 2, limit: 3334 },
          { user_id: 3, limit: 3333 },
          { user_id: 4, limit: 3333 },
        ],
        rates: [],
        auto_prices: true,
      },
    }),
  )
})

it.each([false, true])(
  'retains token-share balances when removed=%s',
  async (removed) => {
    const { AllocationBalances } = await import('./AllocationBalances')
    render(
      <AllocationBalances
        detail={{
          id: 1,
          name: 'Synthetic shares',
          group_id: 2,
          group_name: 'Synthetic pool',
          enabled: true,
          created_at: 1,
          effective_at: 1,
          next: null,
          edit_effective_at: 1_900_000_000,
          write_conditions: {
            expected_current_revision_id: 41,
            expected_next_revision_id: null,
          },
          config: {
            mode: 'ratio',
            period: 'month',
            ratio_unit: 'tokens',
            total: 1_000_000,
            members: [{ user_id: 2, limit: 2500 }],
            rates: [],
          },
          available: true,
          pending: [],
          balances: [
            {
              user_id: 2,
              username: 'synthetic-member',
              removed,
              window_kind: 'month',
              window_seconds: 0,
              mode: 'tokens',
              limit: 250_000,
              used: 210_000,
              tokens: 210_000,
              pending: 1,
              pending_current: 1,
              in_flight: 0,
              reserved: 0,
              admission_room: 65_000,
              admission: 'active',
              reset_at: 2_000_000_000,
            },
          ],
        }}
      />,
    )
    expect(
      screen.getByText(/total token budget × assigned percentage/),
    ).toBeTruthy()
    expect(screen.getByText('0.25 M')).toBeTruthy()
    expect(screen.getByText(removed ? 'Removed' : 'Active')).toBeTruthy()
    expect(screen.queryByText(/temporarily reserved/)).toBeNull()
    expect(screen.getByText(/1 awaiting usage this cycle/)).toBeTruthy()
    expect(
      screen.getByText(/unconfirmed usage is not charged or reserved/),
    ).toBeTruthy()
  },
)

it('shows a risk pause and provisional usage beside positive remaining allowance', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  render(
    <AllocationBalances
      detail={{
        id: 1,
        name: 'Synthetic shares',
        group_id: 2,
        group_name: 'Synthetic pool',
        enabled: true,
        created_at: 1,
        effective_at: 1,
        next: null,
        config: {
          mode: 'ratio',
          period: 'month',
          ratio_unit: 'tokens',
          total: 1_000_000,
          members: [{ user_id: 2, limit: 2500 }],
          rates: [],
        },
        available: true,
        pending: [],
        balances: [
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'month',
            window_seconds: 0,
            mode: 'tokens',
            limit: 250_000,
            used: 240_000,
            tokens: 240_000,
            pending: 2,
            pending_current: 1,
            in_flight: 1,
            reserved: 25_000,
            admission_room: 0,
            admission: 'risk_limited',
            reset_at: 2_000_000_000,
          },
        ],
      }}
    />,
  )
  expect(screen.getByText('New requests temporarily paused')).toBeTruthy()
  expect(screen.getByText('0.01 M')).toBeTruthy()
  expect(
    screen.getByText(/1 in flight · 0.025 M temporarily reserved/),
  ).toBeTruthy()
  expect(screen.getByText(/1 awaiting usage this cycle/)).toBeTruthy()
  expect(screen.getByText(/Admission headroom: 0 M/)).toBeTruthy()
  expect(screen.getByText(/Older pending requests: 1/)).toBeTruthy()
})

it('shows both windows under one member and the blocking seven-day status', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  render(
    <AllocationBalances
      detail={{
        id: 1,
        name: 'Synthetic dual',
        group_id: 2,
        group_name: 'Synthetic pool',
        enabled: true,
        created_at: 1,
        effective_at: 1,
        next: null,
        config: {
          mode: 'windows',
          period: 'durations',
          windows: [
            { duration_seconds: 5 * 3600, limit: 250_000 },
            { duration_seconds: 7 * 86400, limit: 2_500_000 },
          ],
          members: [{ user_id: 2, limit: 0 }],
          rates: [
            {
              model: 'synthetic-model',
              input: 1_000_000,
              cached: 0,
              output: 1_000_000,
            },
          ],
        },
        available: true,
        pending: [],
        balances: [
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'duration',
            window_seconds: 5 * 3600,
            mode: 'amount',
            limit: 250_000,
            used: 100_000,
            tokens: 100_000,
            pending: 0,
            pending_current: 0,
            in_flight: 0,
            reserved: 0,
            admission_room: 175_000,
            admission: 'active',
            reset_at: 2_000_000_000,
          },
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'duration',
            window_seconds: 7 * 86400,
            mode: 'amount',
            limit: 2_500_000,
            used: 2_500_000,
            tokens: 2_500_000,
            pending: 0,
            pending_current: 0,
            in_flight: 0,
            reserved: 0,
            admission_room: 250_000,
            admission: 'exhausted',
            reset_at: 2_000_500_000,
          },
        ],
      }}
    />,
  )
  expect(
    screen.getAllByRole('heading', { name: 'synthetic-member' }),
  ).toHaveLength(1)
  expect(screen.getByText('Allowance exhausted')).toBeTruthy()
  expect(screen.getByText('5 hours')).toBeTruthy()
  expect(screen.getByText('7 days')).toBeTruthy()
  expect(screen.getByText('0.15 USD')).toBeTruthy()
  expect(screen.getByText('0 USD')).toBeTruthy()
})

it('shows an unlimited window without a misleading zero remaining balance', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  render(
    <AllocationBalances
      detail={{
        id: 1,
        name: 'Synthetic unlimited window',
        group_id: 2,
        group_name: 'Synthetic pool',
        enabled: true,
        created_at: 1,
        effective_at: 1,
        next: null,
        config: {
          mode: 'windows',
          period: 'durations',
          windows: [
            { duration_seconds: 6 * 3600, limit: 0 },
            { duration_seconds: 10 * 3600, limit: 2_000_000 },
          ],
          members: [{ user_id: 2, limit: 0 }],
          rates: [
            {
              model: 'synthetic-model',
              input: 1_000_000,
              cached: 0,
              output: 1_000_000,
            },
          ],
        },
        available: true,
        pending: [],
        balances: [
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'duration',
            window_seconds: 6 * 3600,
            mode: 'amount',
            limit: 0,
            used: 500_000,
            tokens: 500_000,
            pending: 1,
            pending_current: 1,
            in_flight: 0,
            reserved: 0,
            admission_room: 0,
            admission: 'unlimited',
            reset_at: 2_000_000_000,
          },
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'duration',
            window_seconds: 10 * 3600,
            mode: 'amount',
            limit: 2_000_000,
            used: 500_000,
            tokens: 500_000,
            pending: 1,
            pending_current: 0,
            in_flight: 0,
            reserved: 0,
            admission_room: 1_700_000,
            admission: 'active',
            reset_at: 2_000_500_000,
          },
        ],
      }}
    />,
  )
  expect(screen.getByText('Unlimited')).toBeTruthy()
  expect(screen.getByText('Active')).toBeTruthy()
  expect(screen.getAllByText('0.5 USD')).toHaveLength(2)
  expect(screen.queryByText('0 USD')).toBeNull()
  expect(
    screen.getByText(/Pending records across this allowance: 1/),
  ).toBeTruthy()
  expect(screen.queryByText(/Older pending requests/)).toBeNull()
})

it('keeps the current cycle active when only an older request is pending', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  render(
    <AllocationBalances
      detail={{
        id: 1,
        name: 'Synthetic',
        group_id: 2,
        group_name: 'Synthetic pool',
        enabled: true,
        created_at: 1,
        effective_at: 1,
        next: null,
        config: {
          mode: 'tokens',
          period: 'day',
          members: [{ user_id: 2, limit: 100 }],
          rates: [],
        },
        available: true,
        pending: [],
        balances: [
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'day',
            window_seconds: 0,
            mode: 'tokens',
            limit: 100,
            used: 0,
            tokens: 0,
            pending: 1,
            pending_current: 0,
            in_flight: 0,
            reserved: 0,
            admission_room: 110,
            admission: 'active',
            reset_at: 2_000_000_000,
          },
        ],
      }}
    />,
  )
  expect(screen.getByText('Active')).toBeTruthy()
  expect(screen.getByText(/Older pending requests: 1/)).toBeTruthy()
  expect(screen.queryByText('Usage pending reconciliation')).toBeNull()
})

it('shows exhausted amount-share balances even with pending usage', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  render(
    <AllocationBalances
      detail={{
        id: 1,
        name: 'Synthetic amount shares',
        group_id: 2,
        group_name: 'Synthetic pool',
        enabled: true,
        created_at: 1,
        effective_at: 1,
        next: null,
        config: {
          mode: 'ratio',
          ratio_unit: 'amount',
          total: 2_000_000,
          period: 'month',
          reset_day: 31,
          reset_time: '09:30',
          members: [{ user_id: 2, limit: 5000 }],
          rates: [
            {
              model: 'synthetic-model',
              input: 2_000_000,
              cached: 200_000,
              output: 4_000_000,
            },
          ],
        },
        available: true,
        pending: [],
        balances: [
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'month',
            window_seconds: 0,
            mode: 'amount',
            limit: 1_000_000,
            used: 1_000_000,
            tokens: 250_000,
            pending: 1,
            pending_current: 1,
            in_flight: 0,
            reserved: 100_000,
            admission_room: 0,
            admission: 'exhausted',
            reset_at: 2_000_000_000,
          },
        ],
      }}
    />,
  )
  expect(
    screen.getByText(/total internal USD budget × assigned percentage/),
  ).toBeTruthy()
  expect(screen.getAllByText('1 USD').length).toBeGreaterThan(0)
  expect(screen.getByText('Allowance exhausted')).toBeTruthy()
  expect(screen.getByText(/0\.25 M tokens/)).toBeTruthy()
  expect(screen.getByText(/Monthly on day 31 at 09:30 · UTC/)).toBeTruthy()
})

it('converts the three units without losing small values', () => {
  expect(parseAllocationValue('50.25', 'ratio')).toBe(5025)
  expect(parseAllocationValue('1.000001', 'tokens')).toBe(1000001)
  expect(parseAllocationValue('0.000001', 'amount')).toBe(1)
  expect(parseAllocationValue('0.001', 'ratio')).toBeNull()
  expect(parseAllocationValue('-1', 'amount')).toBeNull()
})
it('submits exactly one mode and rejects an overallocated ratio', async () => {
  const submit = vi.fn()
  const user = userEvent.setup()
  render(
    <QueryClientProvider client={new QueryClient()}>
      <SchemeForm
        groups={[{ id: 1, name: 'Synthetic pool', enabled: true }]}
        groupID={1}
        onGroupChange={() => {}}
        members={[{ id: 2, username: 'synthetic-member' }]}
        onSubmit={submit}
        onCancel={() => {}}
        pending={false}
      />
    </QueryClientProvider>,
  )
  await user.type(
    screen.getByLabelText('Resource allowance name'),
    'Synthetic scheme',
  )
  await user.click(screen.getByLabelText('By tokens'))
  await user.type(
    screen.getByLabelText('Allowance for synthetic-member'),
    '1.5',
  )
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      config: {
        mode: 'tokens',
        period: 'month',
        reset_day: 1,
        reset_time: '00:00',
        members: [{ user_id: 2, limit: 1500000 }],
        rates: [],
      },
    }),
  )
  submit.mockClear()
  await user.click(screen.getByLabelText('By share'))
  await user.type(screen.getByLabelText('Total budget'), '1')
  const allowance = screen.getByLabelText('Allowance for synthetic-member')
  await user.clear(allowance)
  await user.type(allowance, '101')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).not.toHaveBeenCalled()
  expect(screen.getByRole('alert')).toBeTruthy()
})

it('offers only enabled, nonempty, dedicated pools without a scheme', async () => {
  const { availableAllocationPools } = await import('@/lib/allocations')
  const pool = (id: number, enabled = true, account_count = 1) => ({
    id,
    enabled,
    account_count,
  })
  expect(
    availableAllocationPools(
      [pool(1), pool(2), pool(3, false), pool(4, true, 0), pool(5)],
      [{ group_id: 2 }],
    ),
  ).toEqual([pool(1), pool(5)])
})

it('does not label a paused scheme balance as active', async () => {
  const { AllocationBalances } = await import('./AllocationBalances')
  render(
    <AllocationBalances
      detail={{
        id: 1,
        name: 'Synthetic',
        group_id: 2,
        group_name: 'Synthetic',
        enabled: false,
        effective_at: 1,
        created_at: 1,
        next: null,
        config: {
          mode: 'tokens',
          period: 'month',
          members: [{ user_id: 2, limit: 100 }],
          rates: [],
        },
        available: false,
        pending: [],
        balances: [
          {
            user_id: 2,
            username: 'synthetic-member',
            window_kind: 'month',
            window_seconds: 0,
            mode: 'tokens',
            limit: 100,
            used: 0,
            tokens: 0,
            pending: 0,
            pending_current: 0,
            in_flight: 0,
            reserved: 0,
            admission_room: 110,
            admission: 'active',
            reset_at: 2000000000,
          },
        ],
      }}
    />,
  )
  expect(screen.queryByText('Active')).toBeNull()
  expect(screen.getByText('Unavailable')).toBeTruthy()
})

it('changes pool and period with accessible dropdowns and clears old shares', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  function Harness() {
    const [groupID, setGroupID] = useState(2)
    return (
      <SchemeForm
        groups={[
          { id: 2, name: 'Synthetic first pool', enabled: true },
          { id: 3, name: 'Synthetic second pool', enabled: true },
        ]}
        groupID={groupID}
        onGroupChange={setGroupID}
        members={[{ id: 2, username: 'synthetic-member' }]}
        onSubmit={submit}
        onCancel={() => {}}
        pending={false}
      />
    )
  }
  render(<Harness />)
  await user.type(screen.getByLabelText('Resource allowance name'), 'Synthetic')
  await user.click(screen.getByLabelText('By tokens'))
  await user.type(
    screen.getByLabelText('Allowance for synthetic-member'),
    '1.5',
  )
  await user.click(screen.getByRole('button', { name: 'Resource group' }))
  await user.click(
    screen.getByRole('menuitemradio', { name: 'Synthetic second pool' }),
  )
  expect(
    (
      screen.getByLabelText(
        'Allowance for synthetic-member',
      ) as HTMLInputElement
    ).value,
  ).toBe('')
  await user.type(screen.getByLabelText('Allowance for synthetic-member'), '2')
  await user.click(screen.getByRole('button', { name: 'Reset period' }))
  await user.click(screen.getByRole('menuitemradio', { name: 'Daily · UTC' }))
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).toHaveBeenCalledWith(
    expect.objectContaining({
      group_id: 3,
      config: {
        mode: 'tokens',
        period: 'day',
        reset_time: '00:00',
        members: [{ user_id: 2, limit: 2000000 }],
        rates: [],
      },
    }),
  )
})

it('saves a daily reset clock or monthly date and clock per allowance', async () => {
  const user = userEvent.setup()
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={[{ id: 7, username: 'synthetic-member' }]}
      onSubmit={submit}
      onCancel={() => {}}
      pending={false}
    />,
  )
  await user.type(screen.getByLabelText('Resource allowance name'), 'Synthetic')
  await user.click(screen.getByLabelText('By tokens'))
  await user.type(screen.getByLabelText('Allowance for synthetic-member'), '1')
  await user.clear(screen.getByLabelText('Day of month'))
  await user.type(screen.getByLabelText('Day of month'), '32')
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).not.toHaveBeenCalled()
  await user.clear(screen.getByLabelText('Day of month'))
  await user.type(screen.getByLabelText('Day of month'), '31')
  fireEvent.change(screen.getByLabelText('Reset time'), {
    target: { value: '' },
  })
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit).not.toHaveBeenCalled()
  fireEvent.change(screen.getByLabelText('Reset time'), {
    target: { value: '09:30' },
  })
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[0][0].config).toEqual(
    expect.objectContaining({
      period: 'month',
      reset_day: 31,
      reset_time: '09:30',
    }),
  )
  await user.click(screen.getByRole('button', { name: 'Reset period' }))
  await user.click(screen.getByRole('menuitemradio', { name: 'Daily · UTC' }))
  expect(screen.queryByLabelText('Day of month')).toBeNull()
  fireEvent.change(screen.getByLabelText('Reset time'), {
    target: { value: '18:45' },
  })
  await user.click(
    screen.getByRole('button', { name: 'Save resource allowance' }),
  )
  expect(submit.mock.calls[1][0].config).toEqual(
    expect.objectContaining({ period: 'day', reset_time: '18:45' }),
  )
  expect(submit.mock.calls[1][0].config.reset_day).toBeUndefined()
})

function mountModelPrices(
  savedModel?: string,
  members = [{ id: 2, username: 'synthetic-member' }],
) {
  const submit = vi.fn()
  render(
    <SchemeForm
      groups={[{ id: 2, name: 'Synthetic pool', enabled: true }]}
      groupID={2}
      onGroupChange={() => {}}
      members={members}
      scheme={
        savedModel
          ? {
              id: 1,
              name: 'Synthetic saved',
              group_id: 2,
              group_name: 'Synthetic pool',
              enabled: true,
              created_at: 1,
              effective_at: 1,
              next: null,
              edit_effective_at: 1_900_000_000,
              write_conditions: {
                expected_current_revision_id: 41,
                expected_next_revision_id: null,
              },
              config: {
                mode: 'amount',
                period: 'month',
                members: [{ user_id: 2, limit: 10_000_000 }],
                rates: [
                  {
                    model: savedModel,
                    input: 3_000_000,
                    cached: 0,
                    output: 7_000_000,
                  },
                ],
              },
            }
          : undefined
      }
      pending={false}
      onCancel={() => {}}
      onSubmit={submit}
    />,
  )
  return submit
}
