import type { RequestRecord } from './requests'
import { trackedDays, type Metrics, type Statistics } from './statistics'

export function encodeCSV(rows: string[][]) {
  return (
    '\uFEFF' +
    rows
      .map((row) =>
        row
          .map((value) => {
            // Spreadsheet imports may execute formulas even when the CSV field is quoted.
            const safe = /^[=+\-@]/.test(value.trimStart())
              ? "'" + value
              : value
            return '"' + safe.replaceAll('"', '""') + '"'
          })
          .join(','),
      )
      .join('\r\n') +
    '\r\n'
  )
}

export function requestRows(records: RequestRecord[]) {
  const columns = [
    'request_id',
    'started_at',
    'model',
    'provider',
    'operation',
    'transport',
    'outcome',
    'error_code',
    'upstream_status',
    'duration_ms',
    'first_token_ms',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'estimated_cost_micro_usd',
    'username',
    'key_name',
    'group_name',
    'account_name',
  ] as const
  return [
    [...columns],
    ...records.map((record) =>
      columns.map((column) => String(record[column] ?? '')),
    ),
  ]
}

export function statisticsRows(data: Statistics) {
  const columns: (keyof Metrics)[] = [
    'requests',
    'completed',
    'incomplete',
    'errors',
    'canceled',
    'rejected',
    'duration_ms',
    'input_tokens',
    'output_tokens',
    'cached_tokens',
    'input_reported',
    'output_reported',
    'cached_reported',
  ]
  const rows = [
    [
      'dimension',
      'id',
      'name',
      'from_day',
      'to_day',
      'tracking_since',
      ...columns,
      'time_zone',
    ],
  ]
  const groups = {
    totals: [{ id: '', name: '', ...data.totals }],
    // Exclude days with no tracking coverage, as the usage view does.
    days: trackedDays(data),
    models: data.models,
    groups: data.groups,
    members: data.members,
  }
  for (const [dimension, entries] of Object.entries(groups)) {
    for (const row of entries)
      rows.push([
        dimension,
        row.id,
        row.name,
        String(data.from_day),
        String(data.to_day),
        String(data.tracking_since),
        ...columns.map((key) => {
          if (
            (key === 'input_tokens' && row.input_reported === 0) ||
            (key === 'output_tokens' && row.output_reported === 0) ||
            (key === 'cached_tokens' && row.cached_reported === 0)
          )
            return ''
          return String(row[key])
        }),
        data.time_zone,
      ])
  }
  return rows
}
