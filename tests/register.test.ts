import type { SessionStartInput } from 'claude-code'
import { describe, expect, mock, test } from 'claude-code/testing'

const SESSION: SessionStartInput = { surface: 'terminal', isInteractive: true, cwd: '/work' }
const NOW = Date.parse('2026-10-06T12:00:00Z')
const RUN = { origin: { kind: 'composer' as const }, presentation: { isFullscreen: true, columns: 140 } }

type Answer = { deny?: string; isError?: true; text?: string }

/** The refusal a call got: `{ deny }` from the kit, or the errored result a session's hooks see. */
const refusalOf = (answer: Answer): string | undefined => answer.deny ?? (answer.isError === true ? answer.text : undefined)

type TestOn = Parameters<Extract<Parameters<typeof test>[1], (...args: never[]) => unknown>>[1]

/** The engine beneath the plugin: a project at /work whose existing files are `files`. */
const world = (on: TestOn, files: readonly string[] = ['/work/a.txt']) => {
  const state = { ran: [] as string[], toasts: [] as string[], status: [] as (string | undefined)[], commands: [] as string[] }

  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('session.cwd', () => ({ value: '/work' }))
  on('env.get', ($, e) => ({ value: e.name === 'HOME' ? '/Users/me' : e.name === 'TMPDIR' ? '/var/folders/xy/T/' : undefined }))
  on('fs.stat', ($, e) => {
    if (!files.includes(e.path)) {
      throw new Error(`ENOENT: ${e.path}`)
    }

    return { value: { kind: 'file' as const, size: 1, mtimeMs: NOW, isLink: false } }
  })
  on('ui.toast', ($, e) => {
    state.toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    state.status.push(e.text)

    return { value: undefined }
  })
  on('command.register', ($, e) => {
    state.commands.push(e.name)

    return { value: { command: e.name } }
  })
  on('tool.call', ($, e) => {
    state.ran.push(e.tool === 'Bash' ? e.command : e.tool)

    return { result: 'ok', text: 'ok' }
  })

  return state
}

describe('no-shell-edits in a session', () => {
  test('the session start registers /no-shell-edits', async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    expect(state.commands).toEqual(['no-shell-edits'])
  })

  test('sed -i is denied with a reason that names Edit and the file, and never runs', async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'Bash', command: "sed -i '' 's/a/b/' a.txt" })

    expect(refusalOf(answer) ?? '').toContain('Use Edit for changes to a.txt (or Write for a new file)')
    expect(state.ran).toEqual([])
  })

  test('look-alikes run untouched', async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    for (const command of ['npm test 2>&1 | tail', 'git diff > /tmp/x.patch', 'echo "a > b"', 'cat a.txt']) {
      const answer = await $.tool.call({ tool: 'Bash', command })

      expect(refusalOf(answer)).toBe(undefined)
    }

    expect(state.ran.length).toBe(4)
    expect(state.toasts).toEqual([])
  })

  test('each kind toasts once, however often it is blocked', async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    await $.tool.call({ tool: 'Bash', command: 'echo a > a.txt' })
    await $.tool.call({ tool: 'Bash', command: 'echo b > b.txt' })
    await $.tool.call({ tool: 'Bash', command: "sed -i 's/a/b/' a.txt" })

    expect(state.toasts.length).toBe(2)
    expect(state.toasts[0]).toContain('echo >')
    expect(state.toasts[1]).toContain('sed -i')
  })

  test('mv over an existing file is blocked; mv to a new name is not', async ($, on) => {
    const state = world(on, ['/work/a.txt'])
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    expect(refusalOf(await $.tool.call({ tool: 'Bash', command: 'mv /tmp/edited a.txt' }))).toContain('`mv` on a.txt')
    expect(refusalOf(await $.tool.call({ tool: 'Bash', command: 'mv /tmp/edited fresh.txt' }))).toBe(undefined)
    expect(state.ran).toEqual(['mv /tmp/edited fresh.txt'])
  })

  test('/no-shell-edits lists what was blocked and the settings', async ($, on) => {
    world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: "cat > src/new.ts <<'EOF'\nexport {}\nEOF" })

    const answer = await $.command.run({ command: 'no-shell-edits', args: '', ...RUN })

    expect(answer.text).toContain('1 command blocked this session')
    expect(answer.text).toContain('cat <<EOF > → src/new.ts')
    expect(answer.text).toContain('mode        deny')
  })
})

describe('settings', () => {
  test('warn mode lets the command run and tells the model afterwards', { options: { mode: 'warn' } }, async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'Bash', command: 'echo hi > a.txt' })

    expect(state.ran).toEqual(['echo hi > a.txt'])
    expect(refusalOf(answer)).toBe(undefined)
    expect((answer.context ?? []).join('\n')).toContain('changed a.txt through the shell')
    expect(state.toasts[0]).toContain('ran; Claude was told to use Edit')
  })

  test('blockReads sends a single-file cat to Read', { options: { blockReads: true } }, async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    const answer = await $.tool.call({ tool: 'Bash', command: 'cat src/app.ts' })

    expect(refusalOf(answer) ?? '').toContain('Use Read for src/app.ts')
    expect(state.ran).toEqual([])
  })

  test('allowPaths lets a generated folder through', { options: { allowPaths: 'dist/**' } }, async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    await $.tool.call({ tool: 'Bash', command: 'echo x > dist/bundle.js' })
    const log = await $.tool.call({ tool: 'Bash', command: 'make > build.log' })

    expect(state.ran).toEqual(['echo x > dist/bundle.js'])
    expect(refusalOf(log), 'the default *.log is replaced, not extended').toContain('build.log')
  })

  test('statusLine pins the running count', { options: { statusLine: true } }, async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)

    await $.tool.call({ tool: 'Bash', command: 'echo a > a.txt' })
    await $.tool.call({ tool: 'Bash', command: 'echo x | tee b.txt' })

    expect(state.status).toEqual(['no-shell-edits: 1 blocked', 'no-shell-edits: 2 blocked'])
  })

  test('with statusLine off nothing is pinned', async ($, on) => {
    const state = world(on)
    mock.clock(on, { now: NOW })
    await $.session.start(SESSION)
    await $.tool.call({ tool: 'Bash', command: 'echo a > a.txt' })

    expect(state.status).toEqual([])
  })
})
