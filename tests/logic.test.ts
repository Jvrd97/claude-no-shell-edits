import { describe, expect, test } from 'claude-code/testing'

import type { ShellEditEvent, ShellEditKind } from '../types'
import type { Context, Finding } from '../hooks/logic'
import {
  analyze,
  compileGlobs,
  DEFAULT_ALLOW,
  denyReason,
  freshKinds,
  isAllowedPath,
  report,
  settingsOf,
  statusText,
  warnContext,
} from '../hooks/logic'

const CTX: Context = {
  cwd: '/work',
  home: '/Users/me',
  tmpDir: '/var/folders/xy/abc/T/',
  allow: compileGlobs(DEFAULT_ALLOW),
  blockReads: false,
}

type Hit = readonly [kind: ShellEditKind, target: string | null]

const hitsOf = (command: string, ctx: Context = CTX): Hit[] => analyze(command, ctx).map(finding => [finding.kind, finding.target])

/** Commands that write a file through the shell, and what the guard must report. */
const FLAGGED: readonly (readonly [command: string, hits: readonly Hit[]])[] = [
  ["sed -i '' 's/a/b/' a.txt", [['in-place', 'a.txt']]],
  ["sed -i 's/a/b/' src/app.ts", [['in-place', 'src/app.ts']]],
  ["sed -i.bak -e 's/a/b/' -e 's/c/d/' a.txt b.txt", [['in-place', 'a.txt'], ['in-place', 'b.txt']]],
  ["sed --in-place 's/a/b/' a.txt", [['in-place', 'a.txt']]],
  ["gsed -E -i 's/a/b/' a.txt", [['in-place', 'a.txt']]],
  ["perl -pi -e 's/a/b/' a.txt", [['in-place', 'a.txt']]],
  ["perl -i.bak -pe 's/a/b/' a.txt", [['in-place', 'a.txt']]],
  ["perl -0777 -pi -e 's/a\\nb/c/' a.txt", [['in-place', 'a.txt']]],
  ["awk -i inplace '{print}' a.txt", [['in-place', 'a.txt']]],
  ['echo hi > a.txt', [['redirect', 'a.txt']]],
  ["printf 'x\\n' >> notes.md", [['redirect', 'notes.md']]],
  ['echo hi >| a.txt', [['redirect', 'a.txt']]],
  ['echo hi 1> a.txt', [['redirect', 'a.txt']]],
  ['make &> out.txt', [['redirect', 'out.txt']]],
  ['git diff > changes.patch', [['redirect', 'changes.patch']]],
  ['echo ok >> ~/.zshrc', [['redirect', '~/.zshrc']]],
  ["cat > src/new.ts <<'EOF'\nexport const a = 1 > 0\nEOF", [['heredoc', 'src/new.ts']]],
  ['cat <<EOF > config.json\n{"a": 1}\nEOF', [['heredoc', 'config.json']]],
  ['echo x | tee a.txt', [['tee', 'a.txt']]],
  ['echo x | tee -a a.txt b.txt', [['tee', 'a.txt'], ['tee', 'b.txt']]],
  ['sudo tee /etc/hosts < hosts.new', [['tee', '/etc/hosts']]],
  [`python3 -c "open('a.txt', 'w').write('x')"`, [['script', 'a.txt']]],
  [`python -c "from pathlib import Path; Path('a.txt').write_text('x')"`, [['script', 'a.txt']]],
  [`node -e "require('fs').writeFileSync('a.json', '{}')"`, [['script', 'a.json']]],
  [`ruby -e 'File.write("a.rb", "x")'`, [['script', 'a.rb']]],
  ["python3 - <<'EOF'\nwith open('a.txt', 'w') as f:\n    f.write('x')\nEOF", [['script', 'a.txt']]],
  ['truncate -s 0 a.txt', [['truncate', 'a.txt']]],
  ["find . -name '*.ts' | xargs sed -i 's/a/b/'", [['in-place', null]]],
  ["find src -name '*.js' -exec sed -i 's/a/b/' {} \\;", [['in-place', null]]],
  ["cd src && sed -i 's/a/b/' app.ts", [['in-place', 'app.ts']]],
  ['bash -c "echo hi > a.txt"', [['redirect', 'a.txt']]],
  ["for f in src/*.ts; do sed -i 's/a/b/' \"$f\"; done", [['in-place', '$f']]],
  ["echo \"$(sed -i 's/a/b/' a.txt)\"", [['in-place', 'a.txt']]],
  ["if [ -f a.txt ]; then sed -i 's/a/b/' a.txt; fi", [['in-place', 'a.txt']]],
]

/** Look-alikes that must pass untouched. */
const SAFE: readonly string[] = [
  'npm test 2>&1 | tail',
  'npm test 2>&1 | tail -20',
  'git diff > /tmp/x.patch',
  'ls > /dev/null',
  'ls -la > /dev/null 2>&1',
  'echo "a > b"',
  "grep -n '>' file",
  'make build',
  'cargo build',
  '[[ $a > $b ]] && echo yes',
  'if [[ "$x" < "$y" ]]; then echo less; fi',
  'jq . f.json > /tmp/out.json',
  'npm run build > build.log 2>&1',
  'echo hi > "$TMPDIR/x"',
  'tmp=$(mktemp) && sort a.txt > "$tmp"',
  'echo x > /private/tmp/y',
  'echo x > /var/folders/xy/abc/T/z',
  'cd /tmp && echo hi > x.txt',
  "sed -n '1,20p' a.txt",
  "sed 's/a/b/' a.txt",
  'cat a.txt',
  "git commit -m \"$(cat <<'EOF'\nfix: don't > break (it's fine)\nEOF\n)\"",
  "cat <<'EOF' | git commit -F -\nmsg > here\nEOF",
  'echo $((3 > 2))',
  '(( n > 3 )) && echo big',
  `python3 -c "print(open('a.txt').read())"`,
  'python3 script.py > /dev/null',
  'echo done >&2',
  `node -e "console.log(1 > 0)"`,
  "git log --format='%h > %s' -n 3",
  'echo x > .git/info/exclude',
  'curl -sSLo out.zip https://example.com/x.zip',
  'while read l; do echo "$l"; done < in.txt',
  "perl -ne 'print if /x/' a.txt",
  "awk '{print $1}' a.txt > /tmp/cols",
  'echo hi > "$out"',
  'echo x | tee /tmp/log.txt',
  'command -v sed',
  "# echo hi > a.txt\nls",
  'echo a\\>b',
]

describe('flags shell writes', () => {
  for (const [command, expected] of FLAGGED) {
    test(`flags: ${command.replace(/\n/g, '⏎')}`, () => {
      expect(hitsOf(command)).toEqual(expected.map(hit => [...hit]))
    })
  }
})

describe('passes look-alikes', () => {
  for (const command of SAFE) {
    test(`passes: ${command.replace(/\n/g, '⏎')}`, () => {
      expect(hitsOf(command)).toEqual([])
    })
  }
})

describe('details of what is found', () => {
  test('cp and mv count only over an existing file, which the hook checks', () => {
    const [found] = analyze('mv /tmp/x a.txt', CTX)

    expect(found?.kind).toBe('overwrite')
    expect(found?.mustExist).toBe(true)
    expect(found?.path).toBe('/work/a.txt')
    expect(analyze('cp -t dist a.txt b.txt', CTX)).toEqual([])
    expect(analyze('cp a.txt /tmp/a.txt', CTX)).toEqual([])
  })

  test('a cd earlier in the command moves where targets resolve', () => {
    expect(analyze("cd src && sed -i 's/a/b/' app.ts", CTX)[0]?.path).toBe('/work/src/app.ts')
  })

  test('the via names how the write was made', () => {
    expect(analyze('echo hi > a.txt', CTX)[0]?.via).toBe('echo >')
    expect(analyze("cat > f.ts <<'EOF'\nx\nEOF", CTX)[0]?.via).toBe('cat <<EOF >')
    expect(analyze("perl -pi -e 's/a/b/' a.txt", CTX)[0]?.via).toBe('perl -i')
    expect(analyze('echo x | tee -a a.txt', CTX)[0]?.via).toBe('tee -a')
  })

  test('the same write spelled twice is reported once', () => {
    expect(hitsOf('echo a > a.txt; echo b > a.txt')).toEqual([['redirect', 'a.txt']])
  })

  test('an unclosed quote or heredoc does not throw', () => {
    expect(() => analyze("echo 'never closed > a.txt", CTX)).not.toThrow()
    expect(() => analyze('cat <<EOF > a.txt\nno end', CTX)).not.toThrow()
    expect(hitsOf('cat <<EOF > a.txt\nno end')).toEqual([['heredoc', 'a.txt']])
  })
})

describe('blockReads', () => {
  const READS: Context = { ...CTX, blockReads: true }

  test('a single-file cat/head/tail/less/more is a read', () => {
    expect(hitsOf('cat src/app.ts', READS)).toEqual([['read', 'src/app.ts']])
    expect(hitsOf('head -n 50 src/app.ts', READS)).toEqual([['read', 'src/app.ts']])
    expect(hitsOf('less README.md', READS)).toEqual([['read', 'README.md']])
  })

  test('following, piping, several files and logs are not', () => {
    expect(hitsOf('tail -f app.out', READS)).toEqual([])
    expect(hitsOf('cat a.txt | grep x', READS)).toEqual([])
    expect(hitsOf('cat a.txt b.txt', READS)).toEqual([])
    expect(hitsOf('tail -n 20 server.log', READS)).toEqual([])
    expect(hitsOf('cat /tmp/out.txt', READS)).toEqual([])
  })
})

describe('allowPaths', () => {
  test('a glob without a slash matches a file name anywhere, one with a slash from the root', () => {
    const ctx: Context = { ...CTX, allow: compileGlobs('*.gen.ts, dist/**, ./build/out.txt') }

    expect(isAllowedPath('/work/src/a.gen.ts', ctx)).toBe(true)
    expect(isAllowedPath('/work/dist/deep/x.js', ctx)).toBe(true)
    expect(isAllowedPath('/work/build/out.txt', ctx)).toBe(true)
    expect(isAllowedPath('/work/src/dist/x.js', ctx)).toBe(false)
    expect(isAllowedPath('/work/src/a.ts', ctx)).toBe(false)
  })

  test('a project that lives in a temp folder is still guarded, its scratch neighbours are not', () => {
    const ctx: Context = { ...CTX, cwd: '/var/folders/xy/abc/T/tmp.123' }

    expect(hitsOf("sed -i '' 's/a/b/' a.txt", ctx)).toEqual([['in-place', 'a.txt']])
    expect(hitsOf('echo x > /tmp/scratch.txt', ctx)).toEqual([])
    expect(hitsOf('echo x > ../other/out.txt', ctx)).toEqual([])
  })

  test('an empty list leaves only /dev and temp folders', () => {
    const ctx: Context = { ...CTX, allow: compileGlobs('') }

    expect(hitsOf('npm run build > build.log', ctx)).toEqual([['redirect', 'build.log']])
    expect(hitsOf('echo > /dev/stderr', ctx)).toEqual([])
  })
})

const finding = (kind: ShellEditKind, via: string, target: string | null): Finding => ({ kind, via, target, path: null, mustExist: false })

describe('what the model and the person read', () => {
  test('the deny reason says exactly which tool to use', () => {
    const reason = denyReason([finding('in-place', 'sed -i', 'a.txt')])

    expect(reason).toContain('`sed -i` on a.txt')
    expect(reason).toContain('Use Edit for changes to a.txt (or Write for a new file) so the change shows as a diff and /rewind can undo it.')
    expect(reason).toContain('allowPaths')
  })

  test('a read is sent to Read, and unnamed files are said as such', () => {
    expect(denyReason([finding('read', 'cat', 'src/a.ts')])).toContain('Use Read for src/a.ts instead of cat.')
    expect(denyReason([finding('in-place', 'sed -i', null)])).toContain('Use Edit for changes to the files it changes')
  })

  test('warn mode explains what went wrong after the fact', () => {
    const note = warnContext([finding('redirect', 'echo >', 'a.txt')])

    expect(note).toContain('changed a.txt through the shell')
    expect(note).toContain('/rewind cannot undo it')
  })

  test('each kind toasts once per session', () => {
    const found = [finding('redirect', 'echo >', 'a.txt'), finding('redirect', 'echo >', 'b.txt'), finding('tee', 'tee', 'c.txt')]

    expect(freshKinds(found, []).map(f => f.target)).toEqual(['a.txt', 'c.txt'])
    expect(freshKinds(found, ['redirect', 'tee'])).toEqual([])
  })

  test('the status line counts blocked or flagged commands', () => {
    expect(statusText(3, 'deny')).toBe('no-shell-edits: 3 blocked')
    expect(statusText(1, 'warn')).toBe('no-shell-edits: 1 flagged')
  })

  test('the report lists time, target and command, then the settings', () => {
    const event: ShellEditEvent = { at: Date.now(), command: "sed -i '' 's/a/b/' a.txt", action: 'blocked', hits: [{ kind: 'in-place', via: 'sed -i', target: 'a.txt' }] }
    const text = report([event], settingsOf({}))

    expect(text).toContain('1 command blocked this session')
    expect(text).toMatch(/\d\d:\d\d:\d\d {2}blocked {2}sed -i → a\.txt/)
    expect(text).toContain("$ sed -i '' 's/a/b/' a.txt")
    expect(text).toContain('mode        deny')
    expect(text).toContain('allowPaths  *.log, .git/**')
    expect(report([], settingsOf({ mode: 'warn' }))).toContain('Nothing flagged this session')
  })

  test('settings fall back to safe defaults', () => {
    expect(settingsOf({})).toEqual({ mode: 'deny', blockReads: false, allowPaths: DEFAULT_ALLOW, showsStatus: false })
    expect(settingsOf({ mode: 'bogus', blockReads: true, statusLine: true }).mode).toBe('deny')
  })
})
