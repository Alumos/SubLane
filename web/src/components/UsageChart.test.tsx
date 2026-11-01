import { fireEvent, render, screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { UsageChart } from './UsageChart'
import type { Statistic } from '@/lib/statistics'

const row: Statistic = {
  id: '1900000000',
  name: 'Synthetic day',
  requests: 3,
  completed: 3,
  incomplete: 0,
  errors: 0,
  canceled: 0,
  rejected: 0,
  duration_ms: 0,
  input_tokens: 20,
  output_tokens: 5,
  cached_tokens: 0,
  input_reported: 1,
  output_reported: 1,
  cached_reported: 0,
}

it('formats daily buckets in the report time zone', () => {
  render(
    <UsageChart
      rows={[
        { ...row, id: String(Date.parse('2030-01-02T00:00:00+08:00') / 1000) },
      ]}
      metric="requests"
      daily
      label="Daily · Requests"
      timeZone="Asia/Shanghai"
    />,
  )
  fireEvent.keyDown(screen.getByRole('img'), { key: 'Home' })
  expect(
    within(screen.getByRole('status')).getByText(/Jan 2, 2030/),
  ).toBeTruthy()
})

it('exposes daily values to the keyboard and leaves missing token reports unknown', () => {
  render(
    <UsageChart
      rows={[
        row,
        { ...row, id: '1900086400', input_tokens: 0, input_reported: 0 },
      ]}
      metric="input_tokens"
      daily
      label="Daily · Input tokens"
    />,
  )
  const chart = screen.getByRole('img', { name: 'Daily · Input tokens' })
  fireEvent.keyDown(chart, { key: 'Home' })
  expect(within(screen.getByRole('status')).getByText('20')).toBeTruthy()
  fireEvent.keyDown(chart, { key: 'ArrowRight' })
  expect(
    within(screen.getByRole('status')).getByText('Not reported'),
  ).toBeTruthy()
  expect(screen.getByText('Missing token reports appear as gaps.')).toBeTruthy()
})

it('does not turn entirely missing usage into a zero-valued chart', () => {
  render(
    <UsageChart
      rows={[
        { ...row, input_tokens: 0, input_reported: 0 },
        {
          ...row,
          id: '1900086400',
          requests: 0,
          input_tokens: 0,
          input_reported: 0,
        },
      ]}
      metric="input_tokens"
      daily
      label="Daily · Input tokens"
    />,
  )
  expect(
    screen.getByText('No values were reported for this metric in this period.'),
  ).toBeTruthy()
  expect(screen.queryByRole('img')).toBeNull()
})

it('shows ranked model names and exact values without requiring a table', () => {
  render(
    <UsageChart
      rows={[
        { ...row, id: 'codex/synthetic-model', name: 'codex/synthetic-model' },
      ]}
      metric="requests"
      daily={false}
      label="Models · Requests"
    />,
  )
  expect(screen.getByRole('list', { name: 'Models · Requests' })).toBeTruthy()
  expect(screen.getByText('codex/synthetic-model')).toBeTruthy()
  expect(screen.getByText('3')).toBeTruthy()
  expect(screen.queryByRole('table')).toBeNull()
})
