import { expect, it } from 'vitest'
import { encodeCSV, statisticsRows } from './csv'
import type { Statistics } from './statistics'

it('quotes CSV fields and neutralizes spreadsheet formulas including leading whitespace', () => {
  expect(
    encodeCSV([
      ['name', 'value'],
      ['Synthetic, "team"', ' \t=1+1'],
      ['@SUM(1)', 'line\nnext'],
    ]),
  ).toBe(
    '\uFEFF"name","value"\r\n"Synthetic, ""team""","\' \t=1+1"\r\n"\'@SUM(1)","line\nnext"\r\n',
  )
})

it('exports usage coverage without converting unreported tokens to zero', () => {
  const metrics = {
    requests: 1,
    completed: 1,
    errors: 0,
    rejected: 0,
    canceled: 0,
    incomplete: 0,
    duration_ms: 25,
    input_tokens: 0,
    output_tokens: 0,
    cached_tokens: 0,
    input_reported: 0,
    output_reported: 0,
    cached_reported: 0,
  }
  const data = {
    totals: metrics,
    days: [
      { id: '1899913600', name: '', ...metrics },
      { id: '1900000000', name: '', ...metrics },
    ],
    models: [],
    members: [],
    groups: [],
    time_zone: 'UTC',
    from_day: 1900000000,
    to_day: 1900086400,
    tracking_since: 1900000000,
  } as unknown as Statistics
  const rows = statisticsRows(data)
  expect(rows).toHaveLength(3)
  expect(rows[1][rows[0].indexOf('input_tokens')]).toBe('')
  expect(rows[1][rows[0].indexOf('input_reported')]).toBe('0')
  const start = Date.parse('2030-11-03T04:00:00Z') / 1000
  const next = Date.parse('2030-11-04T05:00:00Z') / 1000
  const local = {
    ...data,
    time_zone: 'America/New_York',
    from_day: start,
    to_day: next + 86400,
    tracking_since: next - 1800,
    days: [
      { id: String(start), name: '2030-11-03', ...metrics },
      { id: String(next), name: '2030-11-04', ...metrics },
    ],
  }
  const exported = statisticsRows(local)
  expect(exported.filter((row) => row[0] === 'days')).toHaveLength(2)
  expect(exported[1][exported[0].indexOf('time_zone')]).toBe('America/New_York')
})
