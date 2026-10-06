import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { ShellEditEvent } from '../types'
import type { Context, Finding, Settings } from './logic'
import {
  analyze,
  compileGlobs,
  denyReason,
  freshKinds,
  report,
  settingsOf,
  statusText,
  toastText,
  warnContext,
} from './logic'

const COMMAND = 'no-shell-edits'
const TOAST_MS = 6_000
/** Events kept per session; /no-shell-edits lists them all. */
const MAX_EVENTS = 200

const events = atom({ plugin: 'no-shell-edits', key: 'events' } as const, [])
const toasted = atom({ plugin: 'no-shell-edits', key: 'toasted' } as const, [])

async function contextOf($: EngineInterface, settings: Settings): Promise<Context> {
  const cwd = await $.session.cwd()
  const home = await $.env.get('HOME')
  const tmpDir = await $.env.get('TMPDIR')

  return { cwd, home, tmpDir, allow: compileGlobs(settings.allowPaths), blockReads: settings.blockReads }
}

/** cp/mv count only when they replace a file that is already there; everything else stands as found. */
async function existing($: EngineInterface, findings: readonly Finding[]): Promise<Finding[]> {
  const kept: Finding[] = []

  for (const finding of findings) {
    if (!finding.mustExist || finding.path === null) {
      kept.push(finding)
      continue
    }

    const stat = await $.fs.stat(finding.path).catch(() => undefined)

    if (stat?.kind === 'file') {
      kept.push(finding)
    }
  }

  return kept
}

async function record($: EngineInterface, command: string, findings: readonly Finding[], settings: Settings): Promise<void> {
  const at = await $.clock.now()
  const event: ShellEditEvent = {
    at,
    command,
    action: settings.mode === 'warn' ? 'warned' : 'blocked',
    hits: findings.map(finding => ({ kind: finding.kind, via: finding.via, target: finding.target })),
  }
  const list = await update($, events, all => [...all, event].slice(-MAX_EVENTS))
  const fresh = freshKinds(findings, await read($, toasted))

  if (fresh.length > 0) {
    await update($, toasted, kinds => [...kinds, ...fresh.map(finding => finding.kind)])

    for (const finding of fresh) {
      $.ui.toast(toastText(finding, settings.mode), { timeoutMs: TOAST_MS })
    }
  }

  if (settings.showsStatus) {
    $.ui.status(statusText(list.length, settings.mode))
  }
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)

  on('session.start', async ($, e, next) => {
    await $.command.register({ name: COMMAND, description: 'Show the shell edits blocked this session and the no-shell-edits settings' })

    return next(e)
  })

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const findings = await existing($, analyze(e.command, await contextOf($, settings)))

    if (findings.length === 0) {
      return next(e)
    }

    if (settings.mode === 'deny') {
      await record($, e.command, findings, settings)

      return { deny: denyReason(findings) }
    }

    const ran = await next(e)

    if (ran.deny !== undefined) {
      return ran
    }

    await record($, e.command, findings, settings)

    return { ...ran, context: [...(ran.context ?? []), warnContext(findings)] }
  })

  on('command.run', { command: COMMAND }, async $ => ({ text: report(await read($, events), settings) }))
}
