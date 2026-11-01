import { useId, useRef, useState, type FormEvent } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import {
  ChevronDown,
  Info,
  Plus,
  RefreshCw,
  ShieldCheck,
  SlidersHorizontal,
} from 'lucide-react'
import { authOptions } from '@/lib/auth'
import {
  contentOptions,
  contentModes,
  contentKinds,
  contentModeKeys,
  contentKindKeys,
  saveContent,
  testContent,
  contentError,
  type ContentState,
  type ContentRule,
} from '@/lib/content'
import { useAdminMutation } from '@/hooks/use-admin-mutation'
import { Button } from '@/components/ui/Button'
import { Input } from '@/components/ui/Input'
import { RegexInput } from '@/components/RegexInput'
import { Status } from '@/components/Status'
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
} from '@/components/ui/DropdownMenu'

export function Content() {
  const { data } = useQuery(authOptions())
  return data?.user?.role === 'admin' ? (
    <ContentSettings key={data.user.id} userID={data.user.id} />
  ) : null
}

function ContentHeader({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation()
  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 max-w-2xl flex-1 basis-72">
        <h1 className="page-title">{t('contentTitle')}</h1>
        <p className="page-description">{t('contentDescription')}</p>
      </div>
      <div className="flex shrink-0 flex-wrap items-center gap-2">
        {children}
      </div>
    </header>
  )
}

function ContentNotes() {
  const { t } = useTranslation()
  return (
    <details className="group border-t border-border pt-4 text-sm">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
        <Info className="size-4 text-muted-foreground" aria-hidden="true" />
        {t('contentDetails')}
        <ChevronDown
          className="ml-auto size-4 text-muted-foreground group-open:rotate-180"
          aria-hidden="true"
        />
      </summary>
      <div className="max-w-3xl space-y-3 pb-2 pt-3 leading-6 text-muted-foreground">
        <p>{t('contentScope')}</p>
        <p>{t('contentLimits')}</p>
      </div>
    </details>
  )
}

function PolicyInfo({
  mode,
  revision,
  children,
}: {
  mode: ContentState['mode']
  revision: number
  children?: React.ReactNode
}) {
  const { t } = useTranslation()
  return (
    <aside className="space-y-4 border-b border-border pb-6 lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="text-sm font-semibold">{t('contentWorkspacePolicy')}</h2>
        {!children && (
          <Status
            kind={
              mode === 'block'
                ? 'warning'
                : mode === 'observe'
                  ? 'info'
                  : 'neutral'
            }
          >
            {t(contentModeKeys[mode])}
          </Status>
        )}
      </div>
      <div className="space-y-3">
        {children}
        <p className="text-sm leading-6 text-muted-foreground">
          {t(
            mode === 'observe'
              ? 'contentObserveHint'
              : mode === 'block'
                ? 'contentBlockHint'
                : 'contentOffHint',
          )}
        </p>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-t border-border pt-4 text-sm lg:block lg:space-y-3">
        <div className="space-y-1.5 lg:flex lg:justify-between lg:gap-4 lg:space-y-0">
          <dt className="text-muted-foreground">
            {t('requestContentRevision')}
          </dt>
          <dd className="tabular-nums">{revision}</dd>
        </div>
        <div className="space-y-1.5">
          <dt className="text-muted-foreground">{t('contentScanLimit')}</dt>
          <dd>{t('contentScanSummary')}</dd>
        </div>
      </dl>
    </aside>
  )
}

function ContentSettings({ userID }: { userID: number }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const query = useQuery(contentOptions(userID))
  const [editing, setEditing] = useState(false)
  const [saved, setSaved] = useState(false)
  const value = query.data
  const refresh = () => {
    setEditing(false)
    setSaved(false)
    return query.refetch()
  }
  return (
    <div className="space-y-6">
      {editing && value && !query.isError ? (
        <ContentEditor
          key={value.revision}
          value={value}
          userID={userID}
          onCancel={() => setEditing(false)}
          onRefresh={refresh}
          onSaved={async (result) => {
            client.setQueryData(contentOptions(userID).queryKey, result)
            setEditing(false)
            setSaved(true)
            await client.invalidateQueries({ queryKey: ['audit'] })
          }}
        />
      ) : (
        <>
          <ContentHeader>
            <Button
              type="button"
              variant="outline"
              disabled={query.isFetching}
              onClick={refresh}
            >
              <RefreshCw className="size-4" aria-hidden="true" />
              {t('refresh')}
            </Button>
            <Button
              disabled={!value || query.isError}
              onClick={() => {
                setEditing(true)
                setSaved(false)
              }}
            >
              <SlidersHorizontal className="size-4" aria-hidden="true" />
              {t('contentConfigure')}
            </Button>
          </ContentHeader>
          {query.isPending ? (
            <p role="status" className="py-10 text-sm text-muted-foreground">
              {t('loading')}
            </p>
          ) : query.isError ? (
            <p role="alert" className="py-6 text-sm text-error">
              {t('contentUnavailable')}
            </p>
          ) : (
            value && (
              <div className="grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
                <PolicyInfo mode={value.mode} revision={value.revision} />
                <section
                  className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
                  aria-labelledby="content-rules-title"
                >
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-5 py-4">
                    <h2
                      id="content-rules-title"
                      className="text-sm font-semibold"
                    >
                      {t('contentRulesLabel')}
                    </h2>
                    <span className="text-xs text-muted-foreground">
                      {t('contentEnabledCount', {
                        enabled: value.rules.filter((rule) => rule.enabled)
                          .length,
                        count: value.rules.length,
                      })}
                    </span>
                  </div>
                  {value.rules.length ? (
                    <>
                      <div className="hidden grid-cols-[minmax(0,1fr)_9rem_5rem] gap-4 border-b border-border bg-muted/40 px-5 py-2.5 text-xs text-muted-foreground sm:grid">
                        <span>{t('contentRuleName')}</span>
                        <span>{t('contentKind')}</span>
                        <span>{t('contentRuleStatus')}</span>
                      </div>
                      <ul className="divide-y divide-border">
                        {value.rules.map((rule) => (
                          <li
                            key={rule.id}
                            className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 gap-y-1.5 px-5 py-4 sm:grid-cols-[minmax(0,1fr)_9rem_5rem] sm:items-center sm:gap-4"
                          >
                            <div className="min-w-0">
                              <p className="break-words text-sm font-medium">
                                {rule.name}
                              </p>
                              <p
                                className="mt-1.5 truncate font-mono text-xs text-muted-foreground"
                                title={rule.id}
                              >
                                {rule.id}
                              </p>
                            </div>
                            <span className="row-start-2 text-xs text-muted-foreground sm:row-start-auto">
                              {t(contentKindKeys[rule.kind])}
                            </span>
                            <div className="col-start-2 row-span-2 row-start-1 self-center sm:col-start-auto sm:row-span-1 sm:row-start-auto">
                              <Status
                                kind={rule.enabled ? 'success' : 'neutral'}
                              >
                                {t(
                                  rule.enabled
                                    ? 'contentRuleEnabled'
                                    : 'contentRuleDisabled',
                                )}
                              </Status>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </>
                  ) : (
                    <div className="flex min-h-52 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
                      <ShieldCheck
                        className="size-7 text-muted-foreground"
                        aria-hidden="true"
                      />
                      <p className="text-sm font-medium">{t('contentEmpty')}</p>
                      <p className="max-w-sm text-sm leading-6 text-muted-foreground">
                        {t('contentEmptyHint')}
                      </p>
                    </div>
                  )}
                </section>
              </div>
            )
          )}
        </>
      )}
      {saved && (
        <p role="status" className="text-sm text-success">
          {t('contentSaved')}
        </p>
      )}
      <ContentNotes />
    </div>
  )
}

function Choice({
  value,
  options,
  onChange,
  label,
  disabled,
}: {
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  label: string
  disabled?: boolean
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="outline"
          disabled={disabled}
          aria-label={label}
        >
          {options.find((option) => option.value === value)?.label}
          <ChevronDown className="size-4" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
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

type Draft = ContentRule & { draftID: string; pattern: string }

function ruleInput(rule: Draft): ContentRule {
  // An omitted pattern retains the encrypted value; placeholders must never replace it.
  return {
    id: rule.id,
    name: rule.name,
    kind: rule.kind,
    enabled: rule.enabled,
    ...(rule.pattern ? { pattern: rule.pattern } : {}),
  }
}
function ModePicker({
  value,
  onChange,
}: {
  value: ContentState['mode']
  onChange: (value: ContentState['mode']) => void
}) {
  const { t } = useTranslation()
  const id = useId()
  return (
    <fieldset className="space-y-2">
      <legend className="mb-2 text-sm text-muted-foreground">
        {t('contentMode')}
      </legend>
      <div className="flex rounded-md border border-input bg-muted/30 p-1">
        {contentModes.map((mode) => (
          <label key={mode} className="min-w-0 flex-1 cursor-pointer">
            <input
              type="radio"
              name={id}
              value={mode}
              checked={value === mode}
              onChange={() => onChange(mode)}
              className="peer sr-only"
            />
            <span className="flex min-h-9 items-center justify-center rounded-sm px-2 text-sm text-muted-foreground peer-checked:bg-background peer-checked:font-medium peer-checked:text-foreground peer-checked:shadow-xs peer-focus-visible:ring-2 peer-focus-visible:ring-ring peer-disabled:cursor-not-allowed peer-disabled:opacity-50 [@media(pointer:coarse)]:min-h-11">
              {t(contentModeKeys[mode])}
            </span>
          </label>
        ))}
      </div>
    </fieldset>
  )
}

function ContentEditor({
  value,
  userID,
  onCancel,
  onRefresh,
  onSaved,
}: {
  value: ContentState
  userID: number
  onCancel: () => void
  onRefresh: () => unknown
  onSaved: (value: ContentState) => unknown
}) {
  const { t } = useTranslation()
  const [mode, setMode] = useState(value.mode)
  const [rules, setRules] = useState<Draft[]>(() =>
    value.rules.map((rule) => ({ ...rule, draftID: rule.id, pattern: '' })),
  )
  // Local, monotonic keys work over HTTP and never reuse deleted rows' state.
  const nextRuleID = useRef(0)
  const save = useAdminMutation({
    userID,
    mutationFn: saveContent,
    onSuccess: onSaved,
  })
  const submit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (save.isPending) return
    save.mutate({ mode, revision: value.revision, rules: rules.map(ruleInput) })
  }
  return (
    <form className="space-y-6" onSubmit={submit}>
      <ContentHeader>
        <Button
          type="button"
          variant="outline"
          disabled={save.isPending}
          onClick={onCancel}
        >
          {t('cancel')}
        </Button>
        <Button type="submit" disabled={save.isPending}>
          {t(save.isPending ? 'alertsSaving' : 'saveChanges')}
        </Button>
      </ContentHeader>
      {save.isError && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 rounded-md border border-error/30 bg-error-muted px-4 py-3 text-sm text-error"
        >
          <p className="min-w-0 flex-1">{t(contentError(save.error))}</p>
          <Button type="button" variant="outline" onClick={onRefresh}>
            {t('refresh')}
          </Button>
        </div>
      )}
      <fieldset disabled={save.isPending} className="min-w-0">
        <div className="grid items-start gap-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:gap-8">
          <PolicyInfo mode={mode} revision={value.revision}>
            <ModePicker value={mode} onChange={setMode} />
          </PolicyInfo>
          <section
            className="min-w-0 overflow-hidden rounded-lg border border-border bg-card"
            aria-labelledby="content-edit-title"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-5 py-3">
              <div>
                <h2 id="content-edit-title" className="text-sm font-semibold">
                  {t('contentRulesLabel')}
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  {t('contentRuleCount', { count: rules.length })}
                </p>
              </div>
              <Button
                type="button"
                variant="outline"
                disabled={rules.length >= 50}
                onClick={() => {
                  const draftID = `new-${nextRuleID.current++}`
                  setRules((current) => [
                    ...current,
                    {
                      draftID,
                      id: '',
                      name: '',
                      kind: 'text',
                      enabled: true,
                      pattern: '',
                    },
                  ])
                }}
              >
                <Plus className="size-4" aria-hidden="true" />
                {t('contentAdd')}
              </Button>
            </div>
            {rules.length ? (
              <div className="divide-y divide-border px-5">
                {rules.map((rule) => (
                  <RuleEditor
                    key={rule.draftID}
                    userID={userID}
                    rule={rule}
                    onChange={(next) =>
                      setRules((current) =>
                        current.map((item) =>
                          item.draftID === rule.draftID ? next : item,
                        ),
                      )
                    }
                    onRemove={() =>
                      setRules((current) =>
                        current.filter((item) => item.draftID !== rule.draftID),
                      )
                    }
                  />
                ))}
              </div>
            ) : (
              <p className="px-5 py-8 text-sm text-muted-foreground">
                {t('contentEmpty')}
              </p>
            )}
          </section>
        </div>
      </fieldset>
    </form>
  )
}

function RuleEditor({
  userID,
  rule,
  onChange,
  onRemove,
}: {
  userID: number
  rule: Draft
  onChange: (rule: Draft) => void
  onRemove: () => void
}) {
  const { t } = useTranslation()
  const id = useId()
  const [sample, setSample] = useState('')
  const [matched, setMatched] = useState<boolean | null>(null)
  const [testError, setTestError] = useState<Error | null>(null)
  const test = useAdminMutation({
    userID,
    mutationFn: testContent,
    onSuccess: (result) => {
      setSample('')
      setMatched(result.matched)
      test.reset()
    },
    onError: (error) => {
      setSample('')
      setTestError(error)
      test.reset()
    },
  })
  const change = (next: Draft) => {
    setMatched(null)
    setTestError(null)
    test.reset()
    onChange(next)
  }
  const testRule = () => {
    setMatched(null)
    setTestError(null)
    test.mutate({ rule: ruleInput(rule), sample })
  }
  return (
    <fieldset
      className="min-w-0 space-y-4 py-5"
      disabled={test.isPending}
      aria-label={rule.name || t('contentNewRule')}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor={`${id}-name`} className="text-sm font-medium">
            {t('contentRuleName')}
          </label>
          <Input
            id={`${id}-name`}
            value={rule.name}
            maxLength={64}
            required
            onChange={(event) => change({ ...rule, name: event.target.value })}
          />
        </div>
        <div className="space-y-2">
          <p className="text-sm font-medium">{t('contentKind')}</p>
          <Choice
            value={rule.kind}
            label={t('contentKind')}
            options={contentKinds.map((value) => ({
              value,
              label: t(contentKindKeys[value]),
            }))}
            onChange={(value) =>
              change({ ...rule, kind: value as Draft['kind'] })
            }
          />
        </div>
      </div>
      <div className="space-y-2">
        <label htmlFor={`${id}-pattern`} className="text-sm font-medium">
          {t('contentPattern')}
        </label>
        {rule.kind === 'regex' ? (
          <RegexInput
            id={`${id}-pattern`}
            value={rule.pattern}
            required={!rule.id}
            placeholder={rule.id ? t('contentKeepPattern') : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(pattern) => change({ ...rule, pattern })}
          />
        ) : (
          <Input
            id={`${id}-pattern`}
            type="password"
            value={rule.pattern}
            maxLength={1024}
            required={!rule.id}
            autoComplete="off"
            spellCheck={false}
            placeholder={rule.id ? t('contentKeepPattern') : undefined}
            aria-describedby={`${id}-hint`}
            onChange={(event) =>
              change({ ...rule, pattern: event.target.value })
            }
          />
        )}
        <p
          id={`${id}-hint`}
          className="text-xs leading-5 text-muted-foreground"
        >
          {t(rule.kind === 'text' ? 'contentTextHint' : 'contentRegexHint')}
        </p>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={rule.enabled}
            onChange={(event) =>
              change({ ...rule, enabled: event.target.checked })
            }
            className="size-4 accent-primary"
          />
          {t('contentEnableRule')}
        </label>
        <Button type="button" variant="ghost" onClick={onRemove}>
          {t('contentRemove')}
        </Button>
      </div>
      <details className="text-sm">
        <summary className="min-h-11 cursor-pointer rounded-sm py-2 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring">
          {t('contentTestTitle')}
        </summary>
        <div className="mt-3 space-y-3">
          <label htmlFor={`${id}-sample`} className="block text-sm font-medium">
            {t('contentSample')}
          </label>
          <textarea
            id={`${id}-sample`}
            value={sample}
            maxLength={65536}
            autoComplete="off"
            spellCheck={false}
            className="min-h-24 w-full rounded-md border border-input bg-transparent p-3 text-base outline-none focus-visible:ring-2 focus-visible:ring-ring sm:text-sm"
            onChange={(event) => {
              setSample(event.target.value)
              setMatched(null)
              setTestError(null)
              test.reset()
            }}
          />
          <p className="text-xs leading-5 text-muted-foreground">
            {t('contentSampleHint')}
          </p>
          <Button
            type="button"
            variant="outline"
            disabled={test.isPending || !sample || (!rule.id && !rule.pattern)}
            onClick={testRule}
          >
            {t('contentTest')}
          </Button>
          {matched !== null && (
            <p
              role="status"
              className={matched ? 'text-warning' : 'text-muted-foreground'}
            >
              {t(matched ? 'contentMatched' : 'contentNotMatched')}
            </p>
          )}
          {testError && (
            <p role="alert" className="text-error">
              {t(contentError(testError))}
            </p>
          )}
        </div>
      </details>
    </fieldset>
  )
}
