import { useMemo, useRef, useState, type FormEvent } from 'react'
import { formatInstanceDate, useTimeZone } from '@/lib/timezone'
import { useTranslation } from 'react-i18next'
import { ChevronDown } from 'lucide-react'
import {
  type Scheme,
  type SchemeInput,
  type AllocationMode,
  type AllocationConfig,
  modeLabels,
  parseAllocationValue,
  allocationValue,
  allocationStructure,
} from '@/lib/allocations'
import { Button } from './ui/Button'
import { Input } from './ui/Input'
import { AllocationPriceWarning } from './AllocationPriceWarning'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from './ui/DropdownMenu'

function SchemeChoice({
  id,
  label,
  value,
  options,
  disabled,
  placeholder,
  onChange,
}: {
  id: string
  label: string
  value: string
  options: { value: string; label: string }[]
  disabled: boolean
  placeholder?: string
  onChange: (value: string) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          id={id}
          type="button"
          variant="outline"
          className="w-full min-w-0 justify-between gap-3"
          aria-label={label}
          disabled={disabled}
        >
          <span className="truncate">
            {options.find((option) => option.value === value)?.label ??
              placeholder}
          </span>
          <ChevronDown className="size-4 shrink-0" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-[var(--radix-dropdown-menu-trigger-width)] overflow-y-auto"
      >
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          {options.map((option) => (
            <DropdownMenuRadioItem key={option.value} value={option.value}>
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type WindowDraft = {
  id: string
  duration: string
  unit: 'hours' | 'days'
  limit: string
}

function durationSeconds(draft: WindowDraft): number | null {
  if (!/^[1-9]\d{0,3}$/.test(draft.duration)) return null
  const seconds =
    Number(draft.duration) * (draft.unit === 'days' ? 86400 : 3600)
  return seconds <= 365 * 86400 ? seconds : null
}

function memberFields(
  config: AllocationConfig | undefined,
  rules: WindowDraft[],
) {
  const values: Record<number, string> = {}
  const selected: Record<number, boolean> = {}
  const customization: Record<number, boolean> = {}
  const overrides: Record<number, Record<string, string>> = {}
  if (!config) return { values, selected, customization, overrides }
  for (const member of config.members) {
    values[member.user_id] =
      config.mode === 'windows' && member.limit === 0
        ? ''
        : allocationValue(member.limit, config.mode)
    selected[member.user_id] = true
    if (config.mode === 'windows') {
      customization[member.user_id] = (member.window_overrides?.length ?? 0) > 0
      const limits: Record<string, string> = {}
      for (const override of member.window_overrides ?? []) {
        const rule = rules.find(
          (rule) => durationSeconds(rule) === override.duration_seconds,
        )
        if (rule)
          limits[rule.id] = override.limit
            ? allocationValue(override.limit, 'amount')
            : ''
      }
      overrides[member.user_id] = limits
    }
  }
  return { values, selected, customization, overrides }
}

export function SchemeForm(
  props: Omit<Parameters<typeof SchemeFields>[0], 'membersOnly'>,
) {
  const { t } = useTranslation()
  // A live list refresh must not attach new version IDs to an old unsaved draft.
  const [snapshot] = useState(props.scheme)
  const [membersOnly, setMembersOnly] = useState(false)
  return (
    <div className="space-y-5">
      {snapshot && (
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={membersOnly}
            disabled={
              props.pending ||
              !snapshot.write_conditions?.expected_current_revision_id
            }
            onChange={(e) => setMembersOnly(e.target.checked)}
            className="size-4 accent-primary"
          />
          {t('allocationApplyNow')}
        </label>
      )}
      <SchemeFields
        key={membersOnly ? 'current' : 'next'}
        {...props}
        scheme={snapshot}
        membersOnly={membersOnly}
      />
    </div>
  )
}

function SchemeFields({
  groups,
  groupID,
  onGroupChange,
  members,
  scheme,
  onSubmit,
  onCancel,
  pending,
  membersOnly,
}: {
  groups: { id: number; name: string; enabled: boolean }[]
  groupID: number
  onGroupChange: (id: number) => void
  members: { id: number; username: string }[]
  scheme?: Scheme
  onSubmit: (input: SchemeInput) => void
  onCancel: () => void
  pending: boolean
  membersOnly: boolean
}) {
  const { t, i18n } = useTranslation()
  const timeZone = useTimeZone()
  const initial = membersOnly
    ? scheme?.config
    : (scheme?.next?.config ?? scheme?.config)
  const [name, setName] = useState(scheme?.name ?? '')
  const [mode, setMode] = useState<AllocationMode>(initial?.mode ?? 'ratio')
  const [ratioUnit, setRatioUnit] = useState<'amount' | 'tokens'>(
    initial?.ratio_unit ?? 'tokens',
  )
  const [period, setPeriod] = useState<'day' | 'month' | 'durations'>(
    initial?.period ?? 'month',
  )
  const [resetTime, setResetTime] = useState(initial?.reset_time ?? '00:00')
  const [resetDay, setResetDay] = useState(String(initial?.reset_day ?? 1))
  const [enabled, setEnabled] = useState(scheme?.enabled ?? true)
  const [ratioTotal, setRatioTotal] = useState(
    initial?.total
      ? allocationValue(initial.total, initial.ratio_unit ?? 'tokens')
      : '',
  )
  const [windowRules, setWindowRules] = useState<WindowDraft[]>(
    initial?.period === 'durations'
      ? (initial.windows ?? []).map((rule, index) => ({
          id: `saved-${index}`,
          duration: String(
            rule.duration_seconds % 86400 === 0
              ? rule.duration_seconds / 86400
              : rule.duration_seconds / 3600,
          ),
          unit: rule.duration_seconds % 86400 === 0 ? 'days' : 'hours',
          limit: rule.limit
            ? allocationValue(
                rule.limit,
                initial.mode === 'ratio'
                  ? (initial.ratio_unit ?? 'tokens')
                  : 'amount',
              )
            : '',
        }))
      : [],
  )
  const nextRuleID = useRef(0)
  const [startNext, setStartNext] = useState(false)
  const applyNow = membersOnly
  const [confirmReplacement, setConfirmReplacement] = useState(false)
  const [previewAnchor] = useState(() => Math.floor(Date.now() / 1000))
  const originalMembers = useMemo(
    () => memberFields(initial, windowRules),
    [initial, windowRules],
  )
  const [draftValues, setValues] = useState<Record<number, string>>(
    originalMembers.values,
  )
  const [draftSelected, setSelectedMembers] = useState<Record<number, boolean>>(
    originalMembers.selected,
  )
  const [draftCustomization, setMemberCustomization] = useState<
    Record<number, boolean>
  >(originalMembers.customization)
  const [draftOverrides, setWindowOverrideValues] = useState<
    Record<number, Record<string, string>>
  >(originalMembers.overrides)
  const [invalid, setInvalid] = useState(false)
  const shareMode = mode === 'ratio'
  const durationMode = period === 'durations'
  const longestDraftWindow = Math.max(
    0,
    ...windowRules.map((rule) => durationSeconds(rule) ?? 0),
  )
  const effectivePreview = applyNow
    ? 0
    : scheme
      ? (scheme.edit_effective_at ?? 0)
      : startNext && durationMode && longestDraftWindow > 0
        ? previewAnchor + longestDraftWindow
        : 0
  const effectivePreviewDate = effectivePreview
    ? formatInstanceDate(
        effectivePreview * 1000,
        i18n.resolvedLanguage ?? 'en',
        timeZone,
        { dateStyle: 'medium', timeStyle: 'short' },
      )
    : ''
  const changeMode = (next: AllocationMode) => {
    if (next !== mode) {
      setMode(next)
      if (next === 'windows') setPeriod('durations')
      else if (period === 'durations') setPeriod('month')
      setValues({})
      setWindowRules([])
      setSelectedMembers({})
      setMemberCustomization({})
      setWindowOverrideValues({})
      setInvalid(false)
    }
  }
  const draftStructure = allocationStructure({
    mode,
    period,
    reset_time: period === 'durations' ? undefined : resetTime,
    reset_day: period === 'month' ? Number(resetDay) : undefined,
    ratio_unit: shareMode ? ratioUnit : undefined,
    members: [],
    rates: [],
    windows: durationMode
      ? windowRules.map((w) => ({
          duration_seconds: durationSeconds(w) ?? 0,
          limit: 0,
        }))
      : undefined,
  })
  const structureChanged =
    !!scheme && !!initial && allocationStructure(initial) !== draftStructure
  const initialPending =
    !!scheme?.next &&
    scheme.write_conditions?.expected_current_revision_id === null
  const replacementBase =
    scheme?.write_conditions?.expected_current_revision_id != null
      ? scheme.config
      : initial
  const replacementAvailable =
    !!scheme &&
    !applyNow &&
    !!replacementBase &&
    allocationStructure(replacementBase) !== draftStructure
  const replacing = replacementAvailable && confirmReplacement
  const preserveMembers =
    !!scheme && !applyNow && !initialPending && !structureChanged && !replacing
  // Locked rows must display the saved member instruction that will actually be submitted.
  const values = preserveMembers ? originalMembers.values : draftValues
  const selectedMembers = preserveMembers
    ? originalMembers.selected
    : draftSelected
  const memberCustomization = preserveMembers
    ? originalMembers.customization
    : draftCustomization
  const windowOverrideValues = preserveMembers
    ? originalMembers.overrides
    : draftOverrides
  const selectedCount = members.filter(
    (member) => selectedMembers[member.id],
  ).length
  const total = preserveMembers
    ? (initial?.members.reduce((sum, member) => sum + member.limit, 0) ?? 0)
    : members.reduce(
        (sum, m) =>
          sum +
          (selectedMembers[m.id]
            ? (parseAllocationValue(values[m.id] ?? '', mode) ?? 0)
            : 0),
        0,
      )
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (pending) return
    const windowLimit = (value: string | undefined) =>
      parseAllocationValue(
        value?.trim() ? value : shareMode ? '' : '0',
        shareMode ? ratioUnit : 'amount',
      ) ?? -1
    const parsedWindows = durationMode
      ? windowRules.map((rule) => ({
          duration_seconds: durationSeconds(rule) ?? -1,
          limit: windowLimit(rule.limit),
        }))
      : []
    // The access roster can omit revoked recipients; a budget edit preserves the saved instruction.
    const shares = preserveMembers
      ? initial!.members
      : members
          .filter((m) => selectedMembers[m.id])
          .map((m) => {
            if (mode !== 'windows')
              return {
                user_id: m.id,
                limit: parseAllocationValue(values[m.id], mode) ?? -1,
              }
            const overrides = memberCustomization[m.id]
              ? windowRules.flatMap((rule, index) => {
                  const value = windowOverrideValues[m.id]?.[rule.id]
                  return value === undefined
                    ? []
                    : [
                        {
                          duration_seconds:
                            parsedWindows[index].duration_seconds,
                          limit: windowLimit(value),
                        },
                      ]
                })
              : []
            return {
              user_id: m.id,
              limit: 0,
              ...(overrides.length > 0 ? { window_overrides: overrides } : {}),
            }
          })
    const totalBudget = shareMode
      ? (parseAllocationValue(ratioTotal, ratioUnit) ?? -1)
      : 0
    const validShareBudget = (budget: number) =>
      budget > 0 &&
      budget <= 1_000_000_000_000 &&
      shares.every((m) => Math.floor((budget * m.limit) / 10000) > 0)
    const bad =
      !name.trim() ||
      !groupID ||
      (!durationMode && !/^(?:[01][0-9]|2[0-3]):[0-5][0-9]$/.test(resetTime)) ||
      (period === 'month' &&
        (!/^\d{1,2}$/.test(resetDay) ||
          Number(resetDay) < 1 ||
          Number(resetDay) > 31)) ||
      shares.length === 0 ||
      (durationMode &&
        (parsedWindows.length === 0 ||
          parsedWindows.length > 8 ||
          new Set(parsedWindows.map((rule) => rule.duration_seconds)).size !==
            parsedWindows.length ||
          parsedWindows.some(
            (rule) => rule.duration_seconds < 3600 || rule.limit < 0,
          ))) ||
      shares.some((m) =>
        mode === 'windows'
          ? (m.window_overrides ?? []).some((override) => override.limit < 0)
          : m.limit <= 0,
      ) ||
      (shareMode && total > 10000) ||
      (shareMode &&
        !(durationMode
          ? parsedWindows.every((w) => validShareBudget(w.limit))
          : validShareBudget(totalBudget))) ||
      (!!scheme && !scheme.write_conditions) ||
      (!!scheme && structureChanged && !replacing)
    setInvalid(bad)
    if (bad) return
    onSubmit({
      name: name.trim(),
      group_id: groupID,
      enabled,
      start_next: startNext,
      apply_now: applyNow,
      ...(scheme
        ? {
            ...scheme.write_conditions,
            expected_effective_at: scheme.edit_effective_at,
            confirm_replacement: replacing,
          }
        : {}),
      config: {
        mode,
        period,
        ...(period !== 'durations' ? { reset_time: resetTime } : {}),
        ...(period === 'month' ? { reset_day: Number(resetDay) } : {}),
        members: shares,
        rates: [],
        ...(shareMode
          ? {
              ratio_unit: ratioUnit,
              ...(!durationMode ? { total: totalBudget } : {}),
            }
          : {}),
        ...(durationMode ? { windows: parsedWindows } : {}),
      },
    })
  }
  return (
    <form onSubmit={submit} className="space-y-8" noValidate>
      <fieldset disabled={pending} className="space-y-8">
        <section className="space-y-4">
          <h3 className="text-base font-semibold">
            {t('allocationSectionDetails')}
          </h3>
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-2">
              <label htmlFor="scheme-name" className="text-sm font-medium">
                {t('allocationName')}
              </label>
              <Input
                id="scheme-name"
                disabled={applyNow}
                value={name}
                onChange={(e) => setName(e.target.value)}
                maxLength={64}
              />
            </div>
            <div className="space-y-2">
              <label htmlFor="scheme-pool" className="text-sm font-medium">
                {t('keyGroup')}
              </label>
              <SchemeChoice
                id="scheme-pool"
                label={t('keyGroup')}
                value={String(groupID)}
                disabled={!!scheme || pending}
                options={groups.map((pool) => ({
                  value: String(pool.id),
                  label: pool.name,
                }))}
                onChange={(value) => {
                  onGroupChange(Number(value))
                  setValues({})
                  setSelectedMembers({})
                  setMemberCustomization({})
                  setWindowOverrideValues({})
                }}
              />
            </div>
          </div>
          <p className="text-sm leading-6 text-muted-foreground">
            {t('allocationExclusiveHint')}
          </p>
        </section>
        <fieldset
          disabled={applyNow}
          className="space-y-4 border-t border-border pt-7"
        >
          <h3 className="text-base font-semibold">
            {t('allocationSectionPolicy')}
          </h3>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium">
              {t('allocationMode')}
            </legend>
            <div className="grid gap-x-8 gap-y-1 sm:grid-cols-2">
              {(['ratio', 'amount', 'tokens', 'windows'] as const).map(
                (value) => (
                  <label
                    key={value}
                    className="flex min-h-12 items-start gap-3 py-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="allocation-mode"
                      value={value}
                      checked={mode === value}
                      onChange={() => changeMode(value)}
                      aria-label={t(modeLabels[value])}
                      className="mt-0.5 size-4 accent-primary"
                    />
                    <span className="space-y-0.5">
                      <span className="block font-medium">
                        {t(modeLabels[value])}
                      </span>
                      <span className="block text-xs leading-5 text-muted-foreground">
                        {t(
                          value === 'ratio'
                            ? 'allocationModeRatioSummary'
                            : value === 'amount'
                              ? 'allocationModeAmountSummary'
                              : value === 'tokens'
                                ? 'allocationModeTokensSummary'
                                : 'allocationModeWindowsSummary',
                        )}
                      </span>
                    </span>
                  </label>
                ),
              )}
            </div>
          </fieldset>
          {shareMode && (
            <fieldset className="space-y-3">
              <legend className="text-sm font-medium">
                {t('allocationRatioUnit')}
              </legend>
              <div className="grid max-w-lg grid-cols-2 gap-4">
                {(['tokens', 'amount'] as const).map((unit) => (
                  <label
                    key={unit}
                    className="flex min-h-10 items-center gap-2 text-sm"
                  >
                    <input
                      type="radio"
                      name="allocation-ratio-unit"
                      value={unit}
                      checked={ratioUnit === unit}
                      onChange={() => {
                        if (ratioUnit !== unit) {
                          setRatioUnit(unit)
                          setRatioTotal('')
                        }
                      }}
                      className="size-4 accent-primary"
                    />
                    {t(
                      unit === 'tokens'
                        ? 'allocationRatioTokens'
                        : 'allocationRatioAmount',
                    )}
                  </label>
                ))}
              </div>
            </fieldset>
          )}
          <div className="grid max-w-2xl gap-4 sm:grid-cols-2">
            {shareMode && !durationMode && (
              <div className="space-y-2">
                <label
                  htmlFor="scheme-token-total"
                  className="text-sm font-medium"
                >
                  {t('allocationTotalBudget')}
                </label>
                <div className="flex items-center gap-2">
                  <Input
                    id="scheme-token-total"
                    value={ratioTotal}
                    onChange={(e) => setRatioTotal(e.target.value)}
                    inputMode="decimal"
                    className="min-w-0 text-right tabular-nums"
                  />
                  <span className="text-sm text-muted-foreground">
                    {ratioUnit === 'amount' ? 'USD' : 'M'}
                  </span>
                </div>
              </div>
            )}
            {durationMode && (
              <div className="space-y-3 sm:col-span-2">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="space-y-1">
                    <h4 className="text-sm font-medium">
                      {t('allocationWindowConditions')}
                    </h4>
                    <p className="text-xs leading-5 text-muted-foreground">
                      {t(
                        shareMode
                          ? 'allocationWindowSharesHint'
                          : 'allocationWindowConditionsHint',
                      )}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={windowRules.length >= 8}
                    onClick={() => {
                      const id = `new-${nextRuleID.current++}`
                      setWindowRules((all) => [
                        ...all,
                        { id, duration: '', unit: 'hours', limit: '' },
                      ])
                    }}
                  >
                    {t('allocationAddCondition')}
                  </Button>
                </div>
                <div className="divide-y divide-border border-y border-border">
                  {windowRules.map((rule, index) => (
                    <div
                      key={rule.id}
                      className="grid grid-cols-2 gap-3 py-3 sm:grid-cols-[7rem_8rem_minmax(0,1fr)_auto] sm:items-end"
                    >
                      <div className="space-y-2">
                        <label
                          htmlFor={`window-duration-${rule.id}`}
                          className="text-sm"
                        >
                          {t('allocationConditionDuration', {
                            index: index + 1,
                          })}
                        </label>
                        <Input
                          id={`window-duration-${rule.id}`}
                          type="number"
                          min={1}
                          max={rule.unit === 'days' ? 365 : 8760}
                          step={1}
                          value={rule.duration}
                          onChange={(event) =>
                            setWindowRules((all) =>
                              all.map((item) =>
                                item.id === rule.id
                                  ? { ...item, duration: event.target.value }
                                  : item,
                              ),
                            )
                          }
                          inputMode="numeric"
                          className="tabular-nums"
                        />
                      </div>
                      <div className="space-y-2">
                        <label
                          htmlFor={`window-unit-${rule.id}`}
                          className="text-sm"
                        >
                          {t('allocationConditionUnit', { index: index + 1 })}
                        </label>
                        <select
                          id={`window-unit-${rule.id}`}
                          value={rule.unit}
                          onChange={(event) =>
                            setWindowRules((all) =>
                              all.map((item) =>
                                item.id === rule.id
                                  ? {
                                      ...item,
                                      unit: event.target.value as
                                        | 'hours'
                                        | 'days',
                                    }
                                  : item,
                              ),
                            )
                          }
                          className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/50"
                        >
                          <option value="hours">{t('allocationHours')}</option>
                          <option value="days">{t('allocationDays')}</option>
                        </select>
                      </div>
                      <div className="col-span-2 space-y-2 sm:col-span-1">
                        <label
                          htmlFor={`window-limit-${rule.id}`}
                          className="text-sm"
                        >
                          {t('allocationConditionLimit', { index: index + 1 })}
                        </label>
                        <div className="flex items-center gap-2">
                          <Input
                            id={`window-limit-${rule.id}`}
                            value={rule.limit}
                            onChange={(event) =>
                              setWindowRules((all) =>
                                all.map((item) =>
                                  item.id === rule.id
                                    ? { ...item, limit: event.target.value }
                                    : item,
                                ),
                              )
                            }
                            placeholder={
                              shareMode ? undefined : t('allocationUnlimited')
                            }
                            inputMode="decimal"
                            className="min-w-0 text-right tabular-nums"
                          />
                          <span className="text-sm text-muted-foreground">
                            {shareMode && ratioUnit === 'tokens' ? 'M' : 'USD'}
                          </span>
                        </div>
                      </div>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        className="col-span-2 justify-self-end sm:col-span-1"
                        aria-label={t('allocationRemoveCondition', {
                          index: index + 1,
                        })}
                        onClick={() =>
                          setWindowRules((all) =>
                            all.filter((item) => item.id !== rule.id),
                          )
                        }
                      >
                        {t('allocationRemove')}
                      </Button>
                    </div>
                  ))}
                </div>
              </div>
            )}
            {mode !== 'windows' && (
              <div className="space-y-2">
                <label htmlFor="scheme-period" className="text-sm font-medium">
                  {t('allocationPeriod')}
                </label>
                <SchemeChoice
                  id="scheme-period"
                  label={t('allocationPeriod')}
                  value={period}
                  disabled={pending}
                  options={[
                    {
                      value: 'day',
                      label: t('periodDaily', { zone: timeZone }),
                    },
                    {
                      value: 'month',
                      label: t('periodMonthly', { zone: timeZone }),
                    },
                    ...(shareMode
                      ? [{ value: 'durations', label: t('allocationWindows') }]
                      : []),
                  ]}
                  onChange={(value) =>
                    setPeriod(value as 'day' | 'month' | 'durations')
                  }
                />
              </div>
            )}
            {period === 'month' && (
              <div className="space-y-2">
                <label
                  htmlFor="scheme-reset-day"
                  className="text-sm font-medium"
                >
                  {t('allocationResetDay')}
                </label>
                <Input
                  id="scheme-reset-day"
                  type="number"
                  min={1}
                  max={31}
                  step={1}
                  value={resetDay}
                  onChange={(e) => setResetDay(e.target.value)}
                  inputMode="numeric"
                  className="tabular-nums"
                />
              </div>
            )}
            {period !== 'durations' && (
              <div className="space-y-2">
                <label
                  htmlFor="scheme-reset-time"
                  className="text-sm font-medium"
                >
                  {t('allocationResetTime')}
                </label>
                <Input
                  id="scheme-reset-time"
                  type="time"
                  step={60}
                  value={resetTime}
                  onChange={(e) => setResetTime(e.target.value)}
                  className="tabular-nums"
                />
              </div>
            )}
            <p className="text-xs leading-5 text-muted-foreground sm:col-span-2">
              {period === 'durations'
                ? t('allocationWindowDurationHint', { zone: timeZone })
                : t('allocationResetZoneHint', { zone: timeZone })}{' '}
              {period === 'month' && t('allocationResetShortMonthHint')}
            </p>
            {durationMode && !applyNow && longestDraftWindow > 0 && (
              <p className="text-sm leading-6 text-warning sm:col-span-2">
                {t('allocationFutureEditDelay', {
                  duration: t(
                    longestDraftWindow % 86400 === 0
                      ? 'allocationDurationDays'
                      : 'allocationDurationHours',
                    {
                      value:
                        longestDraftWindow % 86400 === 0
                          ? longestDraftWindow / 86400
                          : longestDraftWindow / 3600,
                    },
                  ),
                })}
              </p>
            )}
            {shareMode && (
              <p className="text-sm leading-6 text-muted-foreground sm:col-span-2">
                {t(
                  ratioUnit === 'amount'
                    ? 'allocationTotalAmountHint'
                    : 'allocationTotalTokensHint',
                )}
              </p>
            )}
          </div>
          {(mode === 'amount' ||
            mode === 'windows' ||
            (shareMode && ratioUnit === 'amount')) && (
            <p className="text-sm leading-6 text-muted-foreground">
              {t('allocationAutoPricingHint')}
            </p>
          )}
          {scheme && (
            <AllocationPriceWarning
              coverage={scheme.next?.price_coverage ?? scheme.price_coverage}
              effectiveAt={scheme.edit_effective_at}
            />
          )}
        </fieldset>
        {scheme?.next && replacementAvailable && !structureChanged && (
          <p className="text-sm leading-6 text-muted-foreground">
            {t('allocationReplacePendingHint')}
          </p>
        )}
        {scheme && replacementAvailable && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmReplacement}
              onChange={(e) => setConfirmReplacement(e.target.checked)}
              className="mt-1 size-4 accent-primary"
            />
            {t('allocationConfirmReplacement')}
          </label>
        )}
        <fieldset
          disabled={preserveMembers}
          className="space-y-4 border-t border-border pt-7"
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h3 className="text-base font-semibold">
              {t(shareMode ? 'allocationShares' : 'allocationMembers')}
            </h3>
            {shareMode && (
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={!members.length}
                onClick={() => {
                  setValues(
                    Object.fromEntries(
                      members.map((member, index) => [
                        member.id,
                        allocationValue(
                          Math.floor(10000 / members.length) +
                            (index < 10000 % members.length ? 1 : 0),
                          'ratio',
                        ),
                      ]),
                    ),
                  )
                  setSelectedMembers(
                    Object.fromEntries(
                      members.map((member) => [member.id, true]),
                    ),
                  )
                }}
              >
                {t('allocationSplitEqually')}
              </Button>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={members.length > 0 && selectedCount === members.length}
                disabled={!members.length}
                onChange={(event) =>
                  setSelectedMembers(
                    Object.fromEntries(
                      members.map((member) => [
                        member.id,
                        event.target.checked,
                      ]),
                    ),
                  )
                }
                aria-label={t('allocationSelectAllMembers')}
                className="size-4 accent-primary"
              />
              {t('allocationSelectAllMembers')}
            </label>
          </div>
          <p className="text-sm text-muted-foreground">
            {t(
              mode === 'windows'
                ? 'allocationWindowBlankHint'
                : 'allocationBlankHint',
            )}
          </p>
          <div className="divide-y divide-border">
            {members.map((m) => (
              <div
                key={m.id}
                className={
                  mode === 'windows'
                    ? 'space-y-3 py-3'
                    : 'grid gap-2 py-3 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center sm:gap-4'
                }
              >
                {mode === 'windows' ? (
                  <>
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <label className="flex items-center gap-2 text-sm font-medium">
                        <input
                          type="checkbox"
                          checked={!!selectedMembers[m.id]}
                          onChange={(e) =>
                            setSelectedMembers((all) => ({
                              ...all,
                              [m.id]: e.target.checked,
                            }))
                          }
                          aria-label={t('allocationIncludeMember', {
                            name: m.username,
                          })}
                          className="size-4 accent-primary"
                        />
                        <span className="min-w-0 break-words">
                          {m.username}
                        </span>
                      </label>
                      {selectedMembers[m.id] && (
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            type="checkbox"
                            checked={!!memberCustomization[m.id]}
                            onChange={(e) =>
                              setMemberCustomization((all) => ({
                                ...all,
                                [m.id]: e.target.checked,
                              }))
                            }
                            aria-label={t('allocationOverrideMember', {
                              name: m.username,
                            })}
                            className="size-4 accent-primary"
                          />
                          {t('allocationOverrideLimits')}
                        </label>
                      )}
                    </div>
                    {selectedMembers[m.id] && memberCustomization[m.id] && (
                      <div className="divide-y divide-border ps-6">
                        {windowRules.map((rule, index) => {
                          const duration =
                            durationSeconds(rule) === null
                              ? t('allocationCondition', { index: index + 1 })
                              : t(
                                  rule.unit === 'days'
                                    ? 'allocationDurationDays'
                                    : 'allocationDurationHours',
                                  { value: rule.duration },
                                )
                          const value = windowOverrideValues[m.id]?.[rule.id]
                          return (
                            <div
                              key={rule.id}
                              className="grid gap-2 py-2 sm:grid-cols-[minmax(0,1fr)_12rem] sm:items-center"
                            >
                              <label className="flex items-center gap-2 text-sm">
                                <input
                                  type="checkbox"
                                  checked={value !== undefined}
                                  onChange={(event) =>
                                    setWindowOverrideValues((all) => {
                                      const personal = { ...(all[m.id] ?? {}) }
                                      if (event.target.checked)
                                        personal[rule.id] = ''
                                      else delete personal[rule.id]
                                      return { ...all, [m.id]: personal }
                                    })
                                  }
                                  aria-label={t('allocationOverrideWindow', {
                                    duration,
                                    name: m.username,
                                  })}
                                  className="size-4 accent-primary"
                                />
                                {duration}
                              </label>
                              {value !== undefined && (
                                <div className="flex items-center gap-2">
                                  <Input
                                    aria-label={t('allocationWindowFor', {
                                      duration,
                                      name: m.username,
                                    })}
                                    value={value}
                                    onChange={(event) =>
                                      setWindowOverrideValues((all) => ({
                                        ...all,
                                        [m.id]: {
                                          ...(all[m.id] ?? {}),
                                          [rule.id]: event.target.value,
                                        },
                                      }))
                                    }
                                    placeholder={t('allocationUnlimited')}
                                    inputMode="decimal"
                                    className="min-w-0 text-right tabular-nums"
                                  />
                                  <span className="text-sm text-muted-foreground">
                                    USD
                                  </span>
                                </div>
                              )}
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                ) : (
                  <>
                    <label className="flex min-w-0 items-center gap-2 text-sm">
                      <input
                        type="checkbox"
                        checked={!!selectedMembers[m.id]}
                        onChange={(event) =>
                          setSelectedMembers((all) => ({
                            ...all,
                            [m.id]: event.target.checked,
                          }))
                        }
                        aria-label={t('allocationIncludeMember', {
                          name: m.username,
                        })}
                        className="size-4 accent-primary"
                      />
                      <span className="break-words">{m.username}</span>
                    </label>
                    <div className="flex w-full items-center gap-2 sm:w-48">
                      <Input
                        id={`share-${m.id}`}
                        aria-label={t('allocationFor', { name: m.username })}
                        value={values[m.id] ?? ''}
                        onChange={(e) => {
                          setValues((v) => ({ ...v, [m.id]: e.target.value }))
                          if (e.target.value.trim()) {
                            setSelectedMembers((all) => ({
                              ...all,
                              [m.id]: true,
                            }))
                          }
                        }}
                        inputMode="decimal"
                        className="w-full text-right tabular-nums"
                      />
                      <span className="w-9 text-sm text-muted-foreground">
                        {shareMode ? '%' : mode === 'amount' ? 'USD' : 'M'}
                      </span>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
          {shareMode && (
            <p
              className={
                total > 10000
                  ? 'text-sm text-error'
                  : 'text-sm text-muted-foreground'
              }
            >
              {t('allocationTotal', {
                total: allocationValue(total, 'ratio'),
                remaining: allocationValue(Math.max(0, 10000 - total), 'ratio'),
              })}
            </p>
          )}
          {shareMode && (
            <p className="text-sm leading-6 text-muted-foreground">
              {t(
                ratioUnit === 'amount'
                  ? 'allocationRatioAmountRule'
                  : 'allocationRatioTokenRule',
              )}
            </p>
          )}
        </fieldset>
        <section className="space-y-4 border-t border-border pt-7">
          <h3 className="text-base font-semibold">
            {t('allocationSectionActivation')}
          </h3>
          {!scheme && (
            <p className="text-sm leading-6 text-muted-foreground">
              {t('allocationExistingKeysHint')}
            </p>
          )}
          {scheme && !applyNow && !initialPending && (
            <p className="text-sm leading-6 text-muted-foreground">
              {t('allocationNextHint')}
            </p>
          )}
          {effectivePreviewDate && (
            <p role="status" className="text-sm leading-6 text-warning">
              {t(
                scheme
                  ? 'allocationEditEffectivePreview'
                  : 'allocationStartEffectivePreview',
                { date: effectivePreviewDate },
              )}
            </p>
          )}
          <div className="space-y-3">
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-primary"
                checked={enabled}
                disabled={!!scheme}
                onChange={(e) => setEnabled(e.target.checked)}
              />
              {t('allocationEnabled')}
            </label>
            {!scheme && (
              <label className="flex items-start gap-2 text-sm leading-6">
                <input
                  type="checkbox"
                  className="mt-1 size-4 shrink-0 accent-primary"
                  checked={startNext}
                  onChange={(e) => setStartNext(e.target.checked)}
                />
                {t('allocationStartNext')}
              </label>
            )}

            {!scheme && !startNext && (
              <p className="text-sm leading-6 text-muted-foreground">
                {t('allocationImmediateHint')}
              </p>
            )}
            {scheme && applyNow && (
              <p className="text-sm leading-6 text-yellow-600 dark:text-yellow-500">
                {t('allocationApplyNowWarning')}
              </p>
            )}
            {scheme && !applyNow && (
              <p className="text-sm leading-6 text-muted-foreground">
                {t(
                  initialPending
                    ? 'allocationInitialEditHint'
                    : 'allocationScheduledHint',
                )}
              </p>
            )}
          </div>
        </section>
      </fieldset>
      {invalid && (
        <p role="alert" className="text-sm text-error">
          {t('allocationInvalid')}
        </p>
      )}
      <div className="flex flex-wrap justify-end gap-2 border-t border-border pt-6">
        <Button
          type="button"
          variant="outline"
          onClick={onCancel}
          disabled={pending}
        >
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={pending}>
          {t('allocationSave')}
        </Button>
      </div>
    </form>
  )
}
