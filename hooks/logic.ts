import type { ShellEditEvent, ShellEditHit, ShellEditKind } from '../types'

export type Mode = 'deny' | 'warn'

/** A file a command writes (or reads, with blockReads), with what the guard needs to judge it. */
export type Finding = ShellEditHit & {
  /** Absolute path the target resolves to; null when the command does not name it literally. */
  path: string | null
  /** cp/mv: an edit only when the destination already exists as a file. */
  mustExist: boolean
}

export type Glob = { pattern: string; regex: RegExp; isBase: boolean }

export type Context = {
  /** The session's working directory, absolute: relative targets resolve against it. */
  cwd: string
  home: string | undefined
  tmpDir: string | undefined
  allow: readonly Glob[]
  blockReads: boolean
}

export type Settings = { mode: Mode; blockReads: boolean; allowPaths: string; showsStatus: boolean }

/** Directories every scratch write goes to; writes there are never flagged. */
export const TMP_ROOTS = ['/tmp', '/private/tmp', '/var/tmp', '/var/folders', '/private/var/folders'] as const
export const DEFAULT_ALLOW = '*.log,.git/**'
/** `bash -c "..."` inside `$(...)` inside `bash -c`: deeper than this is not a habit worth chasing. */
const MAX_DEPTH = 3
const COMMAND_PREVIEW = 100

// ---------------------------------------------------------------- lexer

type Word = { type: 'word'; text: string; isLiteral: boolean; isQuoted: boolean }
type Op = { type: 'op'; op: string }
type Redir = { type: 'redir'; op: string; fd: string | null; target: Word | null; body: string | null }
type Token = Word | Op | Redir

const HEREDOC_OPS = new Set(['<<', '<<-'])
const INPUT_OPS = new Set(['<<', '<<-', '<<<'])
const OUTPUT_OPS = new Set(['>', '>>', '>|', '&>', '&>>', '<>'])
/** Words after which the next word starts a command, as an operator does. */
const COMMAND_LEAD = new Set(['if', 'then', 'elif', 'else', 'while', 'until', 'do', 'for', '!', '{', 'time'])
const NAME_START = /[A-Za-z_]/
const NAME_CHAR = /[A-Za-z0-9_]/
const SPECIAL_PARAM = /[@*#?$!0-9-]/

/** Index just past the `)` closing a `(` opened before `from`, skipping quotes and heredoc bodies. */
const closeParen = (src: string, from: number): number => {
  let depth = 1
  let i = from
  const pending: { delim: string; strip: boolean }[] = []

  while (i < src.length) {
    const c = src[i]

    if (c === '\\') {
      i += 2
      continue
    }

    if (c === "'") {
      const end = src.indexOf("'", i + 1)
      i = end < 0 ? src.length : end + 1
      continue
    }

    if (c === '"') {
      i = closeDouble(src, i + 1)
      continue
    }

    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const found = heredocDelimiter(src, i + 2)

      if (found !== null) {
        pending.push({ delim: found.delim, strip: found.strip })
        i = found.end
        continue
      }
    }

    if (c === '\n' && pending.length > 0) {
      i = skipBodies(src, i, pending.splice(0)).end
      continue
    }

    if (c === '(') {
      depth += 1
    } else if (c === ')') {
      depth -= 1

      if (depth === 0) {
        return i + 1
      }
    }

    i += 1
  }

  return src.length
}

/** Index just past the `"` closing a double-quoted string that starts at `from`. */
const closeDouble = (src: string, from: number): number => {
  let i = from

  while (i < src.length) {
    const c = src[i]

    if (c === '\\') {
      i += 2
    } else if (c === '"') {
      return i + 1
    } else if (c === '$' && src[i + 1] === '(') {
      i = closeParen(src, i + 2)
    } else if (c === '`') {
      const end = src.indexOf('`', i + 1)
      i = end < 0 ? src.length : end + 1
    } else {
      i += 1
    }
  }

  return src.length
}

/** The delimiter of a heredoc whose `<<` ends just before `from`, or null for a malformed one. */
const heredocDelimiter = (src: string, from: number): { delim: string; strip: boolean; end: number } | null => {
  let i = from
  const strip = src[i] === '-'

  if (strip) {
    i += 1
  }

  while (src[i] === ' ' || src[i] === '\t') {
    i += 1
  }

  const quote = src[i]

  if (quote === "'" || quote === '"') {
    const end = src.indexOf(quote, i + 1)

    return end < 0 ? null : { delim: src.slice(i + 1, end), strip, end: end + 1 }
  }

  const match = /^\\?([^\s;&|<>()'"]+)/.exec(src.slice(i))

  return match === null || match[1] === undefined ? null : { delim: match[1], strip, end: i + match[0].length }
}

/** Reads the bodies of heredocs whose lines start after the newline at `at`; `end` is the last delimiter's newline. */
const skipBodies = (src: string, at: number, pending: readonly { delim: string; strip: boolean }[]): { bodies: string[]; end: number } => {
  const bodies: string[] = []
  let i = at + 1

  for (const doc of pending) {
    const lines: string[] = []
    let isClosed = false

    while (i < src.length) {
      const stop = src.indexOf('\n', i)
      const lineEnd = stop < 0 ? src.length : stop
      const line = src.slice(i, lineEnd)
      i = lineEnd + 1

      if ((doc.strip ? line.replace(/^\t+/, '') : line) === doc.delim) {
        isClosed = true
        break
      }

      lines.push(line)
    }

    bodies.push(lines.join('\n'))

    if (!isClosed) {
      i = src.length
    }
  }

  return { bodies, end: Math.min(i, src.length) - 1 }
}

type Lexed = { tokens: Token[]; subs: string[] }

/**
 * Splits a command line into words, operators and redirections the way a POSIX shell
 * reads it: quotes and escapes stay inside a word, `$(...)` and backticks are collected
 * for a recursive look, heredoc bodies attach to their `<<`, and `>`/`<` inside `[[ ]]`
 * or arithmetic are comparisons, not redirections.
 */
export const lex = (src: string): Lexed => {
  const tokens: Token[] = []
  const subs: string[] = []
  const pending: Redir[] = []
  let text = ''
  let inWord = false
  let isLiteral = true
  let isQuoted = false
  let inTest = false
  let i = 0

  const last = (): Token | undefined => tokens[tokens.length - 1]

  const atCommandStart = (): boolean => {
    const prev = last()

    return prev === undefined || prev.type === 'op' || (prev.type === 'word' && !prev.isQuoted && COMMAND_LEAD.has(prev.text))
  }

  const flush = (): void => {
    if (!inWord) {
      return
    }

    const word: Word = { type: 'word', text, isLiteral, isQuoted }
    const prev = last()

    if (prev !== undefined && prev.type === 'redir' && prev.target === null) {
      prev.target = word

      if (HEREDOC_OPS.has(prev.op)) {
        pending.push(prev)
      }
    } else {
      if (!isQuoted && text === '[[' && atCommandStart()) {
        inTest = true
      } else if (!isQuoted && text === ']]') {
        inTest = false
      }

      tokens.push(word)
    }

    text = ''
    inWord = false
    isLiteral = true
    isQuoted = false
  }

  /** `$...` at `i`: appends the expansion as written and returns the index after it. */
  const dollar = (at: number): number => {
    const next = src[at + 1]

    if (next === '(') {
      const end = closeParen(src, at + 2)
      const inner = src.slice(at + 2, end - 1)

      if (!inner.startsWith('(')) {
        subs.push(inner)
      }

      text += src.slice(at, end)
      isLiteral = false

      return end
    }

    if (next === '{') {
      const close = src.indexOf('}', at + 2)
      const end = close < 0 ? src.length : close + 1
      text += src.slice(at, end)
      isLiteral = false

      return end
    }

    if (next !== undefined && NAME_START.test(next)) {
      let end = at + 2

      while (end < src.length && NAME_CHAR.test(src[end] ?? '')) {
        end += 1
      }

      text += src.slice(at, end)
      isLiteral = false

      return end
    }

    if (next !== undefined && SPECIAL_PARAM.test(next)) {
      text += src.slice(at, at + 2)
      isLiteral = false

      return at + 2
    }

    text += '$'

    return at + 1
  }

  const backtick = (at: number): number => {
    const close = src.indexOf('`', at + 1)
    const end = close < 0 ? src.length : close + 1
    subs.push(src.slice(at + 1, close < 0 ? src.length : close))
    text += src.slice(at, end)
    isLiteral = false

    return end
  }

  const op = (value: string): void => {
    flush()
    tokens.push({ type: 'op', op: value })
  }

  const redir = (value: string): void => {
    let fd: string | null = null

    if (inWord && !isQuoted && isLiteral && /^\d+$/.test(text)) {
      fd = text
      text = ''
      inWord = false
    } else {
      flush()
    }

    tokens.push({ type: 'redir', op: value, fd, target: null, body: null })
  }

  while (i < src.length) {
    const c = src[i] ?? ''
    const c1 = src[i + 1]
    const c2 = src[i + 2]

    if (c === ' ' || c === '\t') {
      flush()
      i += 1
    } else if (c === '\n') {
      op('\n')

      if (pending.length > 0) {
        const docs = pending.splice(0)
        const read = skipBodies(
          src,
          i,
          docs.map(doc => ({ delim: doc.target?.text ?? '', strip: doc.op === '<<-' })),
        )
        docs.forEach((doc, k) => {
          doc.body = read.bodies[k] ?? ''
        })
        i = read.end + 1
      } else {
        i += 1
      }
    } else if (c === '#' && !inWord) {
      const stop = src.indexOf('\n', i)
      i = stop < 0 ? src.length : stop
    } else if (c === '\\') {
      if (c1 !== '\n' && c1 !== undefined) {
        text += c1
        inWord = true
        isQuoted = true
      }

      i += 2
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      text += src.slice(i + 1, close < 0 ? src.length : close)
      inWord = true
      isQuoted = true
      i = close < 0 ? src.length : close + 1
    } else if (c === '$' && c1 === "'") {
      let k = i + 2

      while (k < src.length && src[k] !== "'") {
        k += src[k] === '\\' ? 2 : 1
      }

      text += src.slice(i + 2, k)
      inWord = true
      isQuoted = true
      i = k + 1
    } else if (c === '"') {
      inWord = true
      isQuoted = true
      i += 1

      while (i < src.length && src[i] !== '"') {
        const d = src[i]

        if (d === '\\' && i + 1 < src.length && '$`"\\\n'.includes(src[i + 1] ?? '')) {
          text += src[i + 1] === '\n' ? '' : src[i + 1]
          i += 2
        } else if (d === '$') {
          i = dollar(i)
        } else if (d === '`') {
          i = backtick(i)
        } else {
          text += d
          i += 1
        }
      }

      i += 1
    } else if (c === '$') {
      inWord = true
      i = dollar(i)
    } else if (c === '`') {
      inWord = true
      i = backtick(i)
    } else if ((c === '<' || c === '>') && c1 === '(' && !inTest) {
      const end = closeParen(src, i + 2)
      subs.push(src.slice(i + 2, end - 1))
      text += src.slice(i, end)
      inWord = true
      isLiteral = false
      i = end
    } else if (c === '|') {
      op(c1 === '|' ? '||' : c1 === '&' ? '|&' : '|')
      i += c1 === '|' || c1 === '&' ? 2 : 1
    } else if (c === '&') {
      if (c1 === '&') {
        op('&&')
        i += 2
      } else if (c1 === '>' && !inTest) {
        flush()
        tokens.push({ type: 'redir', op: c2 === '>' ? '&>>' : '&>', fd: null, target: null, body: null })
        i += c2 === '>' ? 3 : 2
      } else {
        op('&')
        i += 1
      }
    } else if (c === ';') {
      op(';')
      i += c1 === ';' || c1 === '&' ? 2 : 1
    } else if (c === '(') {
      flush()

      if (c1 === '(' && atCommandStart()) {
        i = closeParen(src, i + 1)
      } else {
        op('(')
        i += 1
      }
    } else if (c === ')') {
      op(')')
      i += 1
    } else if ((c === '>' || c === '<') && !inTest) {
      const three = src.slice(i, i + 3)
      const two = src.slice(i, i + 2)
      const value =
        three === '<<<' || three === '<<-'
          ? three
          : two === '>>' || two === '>|' || two === '>&' || two === '<<' || two === '<>' || two === '<&'
            ? two
            : c
      redir(value)
      i += value.length
    } else {
      text += c
      inWord = true
      i += 1
    }
  }

  flush()

  return { tokens, subs }
}

// ---------------------------------------------------------------- simple commands

type Segment = { words: Word[]; redirs: Redir[]; isPipedOut: boolean }

const segmentsOf = (tokens: readonly Token[]): Segment[] => {
  const segments: Segment[] = []
  let current: Segment = { words: [], redirs: [], isPipedOut: false }

  for (const token of tokens) {
    if (token.type === 'op') {
      current.isPipedOut = token.op === '|' || token.op === '|&'
      segments.push(current)
      current = { words: [], redirs: [], isPipedOut: false }
    } else if (token.type === 'redir') {
      current.redirs.push(token)
    } else {
      current.words.push(token)
    }
  }

  segments.push(current)

  return segments.filter(segment => segment.words.length > 0 || segment.redirs.length > 0)
}

// ---------------------------------------------------------------- paths and targets

const TEMP = '\u0000temp'

type State = { cwd: string; vars: Map<string, string> }

export const normalize = (path: string): string => {
  const parts: string[] = []

  for (const part of path.split('/')) {
    if (part === '' || part === '.') {
      continue
    }

    if (part === '..') {
      parts.pop()
    } else {
      parts.push(part)
    }
  }

  return `/${parts.join('/')}`
}

export const resolvePath = (base: string, path: string): string => normalize(path.startsWith('/') ? path : `${base}/${path}`)

const basename = (path: string): string => path.slice(path.lastIndexOf('/') + 1)

const isUnder = (path: string, root: string): boolean => path === root || path.startsWith(`${root.replace(/\/$/, '')}/`)

const globRegex = (glob: string): RegExp => {
  let out = ''

  for (let k = 0; k < glob.length; k++) {
    const c = glob[k] ?? ''

    if (c === '*' && glob[k + 1] === '*') {
      if (glob[k + 2] === '/') {
        out += '(?:.*/)?'
        k += 2
      } else {
        out += '.*'
        k += 1
      }
    } else if (c === '*') {
      out += '[^/]*'
    } else if (c === '?') {
      out += '[^/]'
    } else {
      out += c.replace(/[.+^${}()|[\]\\]/g, '\\$&')
    }
  }

  return new RegExp(`^${out}$`)
}

/** allowPaths as the settings field spells it: comma-separated globs; one without `/` matches a file name anywhere. */
export const compileGlobs = (text: string): Glob[] =>
  text
    .split(',')
    .map(part => part.trim().replace(/^\.\//, ''))
    .filter(part => part.length > 0)
    .map(pattern => ({ pattern, regex: globRegex(pattern), isBase: !pattern.includes('/') }))

export const isAllowedPath = (path: string, ctx: Context): boolean => {
  if (isUnder(path, '/dev')) {
    return true
  }

  const isInProject = isUnder(path, ctx.cwd)
  // A temp folder is scratch space only outside the project: a project that itself lives in /tmp stays guarded.
  const isScratch = TMP_ROOTS.some(root => isUnder(path, root)) || (ctx.tmpDir !== undefined && isUnder(path, normalize(ctx.tmpDir)))

  if (isScratch && !isInProject) {
    return true
  }

  const rel = isInProject ? path.slice(ctx.cwd.replace(/\/$/, '').length + 1) : null
  const name = basename(path)

  return ctx.allow.some(glob => (glob.isBase ? glob.regex.test(name) : glob.regex.test(path) || (rel !== null && glob.regex.test(rel))))
}

type Target = { kind: 'allowed' } | { kind: 'unknown'; text: string } | { kind: 'file'; text: string; path: string }

/** `$NAME/rest` with NAME set earlier in the command (or TMPDIR/HOME) spelled out; null when it stays unknown. */
const expandVars = (text: string, state: State): string | null => {
  if (/^\$\(\s*mktemp\b/.test(text) || /^`\s*mktemp\b/.test(text)) {
    return TEMP
  }

  const match = /^\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?(.*)$/.exec(text)

  if (match === null || match[1] === undefined) {
    return null
  }

  const value = state.vars.get(match[1])
  const rest = match[2] ?? ''

  if (value === undefined || rest.includes('$') || rest.includes('`')) {
    return null
  }

  return value === TEMP ? TEMP : value + rest
}

const classify = (word: Word, state: State, ctx: Context): Target => {
  let text = word.text

  if (text === '-' || (text === '' && word.isQuoted)) {
    return { kind: 'allowed' }
  }

  if (text === '{}') {
    return { kind: 'unknown', text }
  }

  if (!word.isLiteral) {
    const expanded = expandVars(text, state)

    if (expanded === TEMP) {
      return { kind: 'allowed' }
    }

    if (expanded === null) {
      return { kind: 'unknown', text }
    }

    text = expanded
  }

  if (text.startsWith('~/') || text === '~') {
    if (ctx.home === undefined) {
      return { kind: 'unknown', text }
    }

    text = ctx.home + text.slice(1)
  }

  const path = resolvePath(state.cwd, text)

  return isAllowedPath(path, ctx) ? { kind: 'allowed' } : { kind: 'file', text: word.text, path }
}

// ---------------------------------------------------------------- per-tool argument readers

const ALIASES: Record<string, string> = { gsed: 'sed', gawk: 'awk', mawk: 'awk', nawk: 'awk', nodejs: 'node', python: 'python', gcp: 'cp', gmv: 'mv' }

const nameOf = (word: Word): string => {
  const base = basename(word.text)

  if (/^python[0-9.]*$/.test(base)) {
    return 'python'
  }

  return ALIASES[base] ?? base
}

const isAssignment = (word: Word): boolean => /^[A-Za-z_][A-Za-z0-9_]*=/.test(word.text)

/** Wrappers that run the command after them; each lists its options that take a value. */
const WRAPPERS: Record<string, readonly string[]> = {
  sudo: ['-u', '-g', '-C', '-D', '-h', '-p', '-r', '-t', '-U', '-T'],
  doas: ['-u', '-C'],
  env: ['-u', '-C', '-S', '--unset', '--chdir'],
  command: [],
  builtin: [],
  exec: ['-a'],
  nohup: [],
  time: [],
  nice: ['-n', '--adjustment'],
  ionice: ['-c', '-n', '-p'],
  stdbuf: ['-i', '-o', '-e'],
  timeout: ['-s', '-k', '--signal', '--kill-after'],
  xargs: ['-I', '-n', '-P', '-L', '-d', '-E', '-s', '-a', '--arg-file', '--delimiter', '--max-args', '--max-procs', '--replace'],
}

type Unwrapped = { words: Word[]; isFed: boolean }

/** Drops env assignments and wrappers (`sudo`, `env`, `xargs`, ...); `isFed` when xargs supplies the file names. */
const unwrap = (input: readonly Word[]): Unwrapped => {
  let words = [...input]
  let isFed = false

  for (;;) {
    while (words[0] !== undefined && (isAssignment(words[0]) || (!words[0].isQuoted && COMMAND_LEAD.has(words[0].text)))) {
      words = words.slice(1)
    }

    const head = words[0]

    if (head === undefined) {
      return { words, isFed }
    }

    const name = nameOf(head)
    const takesValue = WRAPPERS[name]

    if (takesValue === undefined) {
      return { words, isFed }
    }

    if (name === 'command' && words[1]?.text.startsWith('-') === true && /[vV]/.test(words[1].text)) {
      return { words: [], isFed }
    }

    isFed = isFed || name === 'xargs'
    let k = 1

    while (k < words.length) {
      const text = words[k]?.text ?? ''

      if (text === '--') {
        k += 1
        break
      }

      if (!text.startsWith('-') || text === '-') {
        break
      }

      k += takesValue.includes(text) ? 2 : 1
    }

    if (name === 'timeout' && k < words.length) {
      k += 1
    }

    words = words.slice(k)
  }
}

type Operands = { flags: string[]; operands: Word[] }

/** Splits arguments into options and operands; `withValue` lists options whose value is the next word. */
const operandsOf = (args: readonly Word[], withValue: readonly string[]): Operands => {
  const flags: string[] = []
  const operands: Word[] = []

  for (let k = 0; k < args.length; k++) {
    const word = args[k]

    if (word === undefined) {
      continue
    }

    if (word.text === '--') {
      operands.push(...args.slice(k + 1))
      break
    }

    if (word.text.startsWith('-') && word.text.length > 1 && !word.isQuoted) {
      flags.push(word.text)

      if (withValue.includes(word.text)) {
        k += 1
      }
    } else {
      operands.push(word)
    }
  }

  return { flags, operands }
}

const SED_SUFFIX = /^\.[\w.~-]*$/

/** `sed -i`/`--in-place` (GNU and BSD spellings): the files it edits, or null when it does not edit in place. */
export const sedInPlace = (args: readonly Word[]): Word[] | null => {
  let isInPlace = false
  let hasScript = false
  const operands: Word[] = []

  for (let k = 0; k < args.length; k++) {
    const word = args[k]

    if (word === undefined) {
      continue
    }

    const text = word.text

    if (text === '--') {
      operands.push(...args.slice(k + 1))
      break
    }

    if (word.isQuoted || !text.startsWith('-') || text.length === 1) {
      operands.push(word)
      continue
    }

    if (text.startsWith('--')) {
      if (text === '--in-place' || text.startsWith('--in-place=')) {
        isInPlace = true
      } else if (text === '--expression' || text === '--file') {
        hasScript = true
        k += 1
      } else if (text.startsWith('--expression=') || text.startsWith('--file=')) {
        hasScript = true
      }

      continue
    }

    for (let c = 1; c < text.length; c++) {
      const flag = text[c]

      if (flag === 'i' || flag === 'I') {
        isInPlace = true
        const next = args[k + 1]
        // BSD sed takes the backup suffix as its own word: `sed -i '' ...` or `sed -i .bak ...`.
        const isBsdSuffix = next !== undefined && ((next.text === '' && next.isQuoted) || SED_SUFFIX.test(next.text))

        if (c === text.length - 1 && isBsdSuffix) {
          k += 1
        }

        break
      }

      if (flag === 'e' || flag === 'f') {
        hasScript = true

        if (c === text.length - 1) {
          k += 1
        }

        break
      }

      if (flag === 'l') {
        if (c === text.length - 1) {
          k += 1
        }

        break
      }
    }
  }

  if (!isInPlace) {
    return null
  }

  return hasScript ? operands : operands.slice(1)
}

type Perl = { isInPlace: boolean; script: string | null; files: Word[] }

const PERL_WITH_VALUE = new Set(['I', 'M', 'm', 'x', 'd', 'D', 'C', 'F'])

export const perlArgs = (args: readonly Word[]): Perl => {
  let isInPlace = false
  let script: string | null = null
  const operands: Word[] = []

  for (let k = 0; k < args.length; k++) {
    const word = args[k]

    if (word === undefined) {
      continue
    }

    const text = word.text

    if (text === '--') {
      operands.push(...args.slice(k + 1))
      break
    }

    if (word.isQuoted || !text.startsWith('-') || text.length === 1) {
      operands.push(word)
      continue
    }

    for (let c = 1; c < text.length; c++) {
      const flag = text[c] ?? ''

      if (flag === 'i') {
        isInPlace = true
        break
      }

      if (flag === 'e' || flag === 'E') {
        const rest = text.slice(c + 1)
        const code = rest.length > 0 ? rest : (args[k + 1]?.text ?? '')
        script = script === null ? code : `${script}\n${code}`

        if (rest.length === 0) {
          k += 1
        }

        break
      }

      if (flag === '0' || flag === 'l') {
        while (/[0-9a-fA-Fx]/.test(text[c + 1] ?? '')) {
          c += 1
        }

        continue
      }

      if (PERL_WITH_VALUE.has(flag)) {
        if (c === text.length - 1 && (flag === 'I' || flag === 'M' || flag === 'm')) {
          k += 1
        }

        break
      }
    }
  }

  return { isInPlace, script, files: script === null ? operands.slice(1) : operands }
}

/** gawk's `-i inplace` (`--include=inplace`): the files it edits, or null. */
export const awkInPlace = (args: readonly Word[]): Word[] | null => {
  let isInPlace = false
  let hasProgram = false
  const operands: Word[] = []
  const isInplaceLib = (name: string | undefined): boolean => name === 'inplace' || name === 'inplace.awk'

  for (let k = 0; k < args.length; k++) {
    const word = args[k]

    if (word === undefined) {
      continue
    }

    const text = word.text

    if (text === '--') {
      operands.push(...args.slice(k + 1))
      break
    }

    if (word.isQuoted || !text.startsWith('-') || text.length === 1) {
      operands.push(word)
    } else if (text === '-i' || text === '--include') {
      isInPlace = isInPlace || isInplaceLib(args[k + 1]?.text)
      k += 1
    } else if (text.startsWith('--include=')) {
      isInPlace = isInPlace || isInplaceLib(text.slice('--include='.length))
    } else if (text.startsWith('-i')) {
      isInPlace = isInPlace || isInplaceLib(text.slice(2))
    } else if (text === '-f' || text === '-e' || text === '--file' || text === '--source') {
      hasProgram = true
      k += 1
    } else if (text === '-v' || text === '-F' || text === '--assign' || text === '--field-separator') {
      k += 1
    } else if (text.startsWith('-f') || text.startsWith('-e')) {
      hasProgram = true
    }
  }

  if (!isInPlace) {
    return null
  }

  return (hasProgram ? operands : operands.slice(1)).filter(word => !isAssignment(word))
}

type ScriptLang = 'python' | 'node' | 'ruby' | 'perl'

/** The inline program of `python -c`, `node -e`, `ruby -e`; null when the command runs a script file. */
const inlineScript = (lang: ScriptLang, args: readonly Word[]): string | null => {
  const flags = lang === 'python' ? ['-c'] : lang === 'node' ? ['-e', '--eval', '-p', '--print'] : ['-e']
  const parts: string[] = []

  for (let k = 0; k < args.length; k++) {
    const text = args[k]?.text ?? ''
    const attached = flags.find(flag => flag.length === 2 && text.startsWith(flag) && text.length > 2)

    if (flags.includes(text)) {
      parts.push(args[k + 1]?.text ?? '')
      k += 1

      if (lang === 'python') {
        break
      }
    } else if (attached !== undefined) {
      parts.push(text.slice(2))
    } else if (!text.startsWith('-')) {
      break
    }
  }

  return parts.length === 0 ? null : parts.join('\n')
}

const WRITE_MODE = /[wax+]/

/** Paths a script opens for writing; null stands for one it names through a variable. */
export const scriptWrites = (lang: ScriptLang, code: string): Array<string | null> => {
  const found: Array<string | null> = []
  const literal = (quoted: string | undefined): string | null => (quoted === undefined || quoted === '' ? null : quoted)

  if (lang === 'python') {
    for (const m of code.matchAll(/\bopen\(\s*(?:(['"])(.*?)\1|[^,()]+)\s*,\s*(?:mode\s*=\s*)?(['"])([rwabxt+]*)\3/g)) {
      if (WRITE_MODE.test(m[4] ?? '')) {
        found.push(literal(m[2]))
      }
    }

    for (const m of code.matchAll(/(?:\bPath\(\s*(?:(['"])(.*?)\1)?[^)]*\)|\w+)\s*\.\s*write_(?:text|bytes)\(/g)) {
      found.push(literal(m[2]))
    }

    if (/\binplace\s*=\s*True\b/.test(code)) {
      found.push(null)
    }
  }

  if (lang === 'node') {
    for (const m of code.matchAll(/\b(?:writeFileSync|writeFile|appendFileSync|appendFile|createWriteStream|outputFileSync|writeJsonSync)\(\s*(?:(['"`])(.*?)\1)?/g)) {
      found.push(literal(m[2]))
    }
  }

  if (lang === 'ruby') {
    for (const m of code.matchAll(/\b(?:File|IO)\.write\(\s*(?:(['"])(.*?)\1)?/g)) {
      found.push(literal(m[2]))
    }

    for (const m of code.matchAll(/\bFile\.open\(\s*(?:(['"])(.*?)\1|[^,()]+)\s*,\s*(['"])([^'"]*)\3/g)) {
      if (WRITE_MODE.test(m[4] ?? '')) {
        found.push(literal(m[2]))
      }
    }
  }

  if (lang === 'perl') {
    for (const m of code.matchAll(/\bopen\s*\(?\s*(?:my\s+)?[$\w]+\s*,\s*(['"])\s*\+?>{1,2}\s*(.*?)\1(?:\s*,\s*(['"])(.*?)\3)?/g)) {
      found.push(literal(m[4]) ?? literal(m[2]?.trim()))
    }
  }

  return found
}

const SCRIPT_LANGS: Record<string, ScriptLang> = { python: 'python', node: 'node', ruby: 'ruby', perl: 'perl' }
const READERS = new Set(['cat', 'head', 'tail', 'less', 'more'])
const READER_WITH_VALUE = ['-n', '-c', '--lines', '--bytes']
const FOLLOW_FLAGS = /^(?:-[a-zA-Z]*[fF][a-zA-Z]*|--follow(?:=.*)?|\+F)$/
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const FIND_EXEC = new Set(['-exec', '-execdir', '-ok', '-okdir'])

// ---------------------------------------------------------------- analysis

type Walk = { state: State; ctx: Context; depth: number; out: Finding[] }

const push = (walk: Walk, kind: ShellEditKind, via: string, word: Word | null, options: { keepUnknown: boolean; mustExist?: boolean }): void => {
  if (word === null) {
    walk.out.push({ kind, via, target: null, path: null, mustExist: false })
    return
  }

  const target = classify(word, walk.state, walk.ctx)

  if (target.kind === 'file') {
    walk.out.push({ kind, via, target: target.text, path: target.path, mustExist: options.mustExist ?? false })
  } else if (target.kind === 'unknown' && options.keepUnknown) {
    walk.out.push({ kind, via, target: target.text === '{}' ? null : target.text, path: null, mustExist: false })
  }
}

const pushScript = (walk: Walk, via: string, lang: ScriptLang, code: string): void => {
  for (const path of scriptWrites(lang, code)) {
    push(walk, 'script', via, path === null ? null : { type: 'word', text: path, isLiteral: true, isQuoted: true }, { keepUnknown: true })
  }
}

const assign = (word: Word, state: State): void => {
  const at = word.text.indexOf('=')
  const name = word.text.slice(0, at)
  const value = word.text.slice(at + 1)

  if (word.isLiteral) {
    state.vars.set(name, value)
    return
  }

  const expanded = expandVars(value, state)

  if (expanded === null) {
    state.vars.delete(name)
  } else {
    state.vars.set(name, expanded)
  }
}

/** One simple command: its redirections, then what its program does to the files it names. */
const walkSegment = (segment: Segment, walk: Walk, isFed: boolean): void => {
  const { words, isFed: fedByWrapper } = unwrap(segment.words)
  const fed = isFed || fedByWrapper
  const head = words[0]
  const name = head === undefined ? '' : nameOf(head)
  const args = words.slice(1)
  const input = segment.redirs.find(redir => INPUT_OPS.has(redir.op))

  if (head === undefined && segment.redirs.length === 0) {
    segment.words.filter(isAssignment).forEach(word => assign(word, walk.state))
    return
  }

  for (const redir of segment.redirs) {
    const isDup = redir.op === '>&' && redir.target !== null && /^(?:\d+|-)$/.test(redir.target.text)

    if (!OUTPUT_OPS.has(redir.op) && (redir.op !== '>&' || isDup)) {
      continue
    }

    const via = input !== undefined && HEREDOC_OPS.has(input.op) ? `${name} <<${input.target?.text ?? 'EOF'} ${redir.op}` : `${name} ${redir.op}`
    push(walk, input !== undefined ? 'heredoc' : 'redirect', via.trim(), redir.target, { keepUnknown: false })
  }

  if (head === undefined) {
    return
  }

  const fedTarget = (files: readonly Word[]): readonly (Word | null)[] => (files.length === 0 && fed ? [null] : files)

  switch (name) {
    case 'cd':
    case 'pushd': {
      const dir = args[0]

      if (dir === undefined) {
        walk.state.cwd = walk.ctx.home ?? walk.state.cwd
      } else if (dir.isLiteral && dir.text !== '-') {
        walk.state.cwd = resolvePath(walk.state.cwd, dir.text.startsWith('~') && walk.ctx.home !== undefined ? walk.ctx.home + dir.text.slice(1) : dir.text)
      }

      return
    }
    case 'export':
    case 'declare':
    case 'local':
    case 'readonly':
      args.filter(isAssignment).forEach(word => assign(word, walk.state))
      return
    case 'eval':
      nested(args.map(word => word.text).join(' '), walk)
      return
    case 'sed': {
      const files = sedInPlace(args)

      if (files !== null) {
        fedTarget(files).forEach(file => push(walk, 'in-place', 'sed -i', file, { keepUnknown: true }))
      }

      return
    }
    case 'awk': {
      const files = awkInPlace(args)

      if (files !== null) {
        fedTarget(files).forEach(file => push(walk, 'in-place', 'awk -i inplace', file, { keepUnknown: true }))
      }

      return
    }
    case 'perl': {
      const perl = perlArgs(args)

      if (perl.isInPlace) {
        fedTarget(perl.files).forEach(file => push(walk, 'in-place', 'perl -i', file, { keepUnknown: true }))
      } else if (perl.script !== null) {
        pushScript(walk, 'perl -e', 'perl', perl.script)
      }

      return
    }
    case 'tee': {
      const { flags, operands } = operandsOf(args, [])
      const via = flags.some(flag => flag === '-a' || flag === '--append') ? 'tee -a' : 'tee'
      operands.forEach(file => push(walk, 'tee', via, file, { keepUnknown: false }))
      return
    }
    case 'truncate': {
      const { operands } = operandsOf(args, ['-s', '-r', '--size', '--reference'])
      fedTarget(operands).forEach(file => push(walk, 'truncate', 'truncate', file, { keepUnknown: true }))
      return
    }
    case 'cp':
    case 'mv': {
      const { flags, operands } = operandsOf(args, ['-t', '-S', '--target-directory', '--suffix'])
      const dest = operands[operands.length - 1]
      const isIntoDir = flags.some(flag => flag === '-t' || flag.startsWith('--target-directory'))

      if (!isIntoDir && operands.length >= 2 && dest !== undefined && !dest.text.endsWith('/')) {
        push(walk, 'overwrite', name, dest, { keepUnknown: false, mustExist: true })
      }

      return
    }
    case 'find': {
      walkFind(args, walk)
      return
    }
    default:
      break
  }

  if (SHELLS.has(name)) {
    const at = args.findIndex(word => /^-[a-z]*c[a-z]*$/.test(word.text))
    const code = at < 0 ? undefined : args[at + 1]

    if (code !== undefined) {
      nested(code.text, walk)
    } else if (input?.body !== null && input?.body !== undefined && args.every(word => word.text.startsWith('-'))) {
      nested(input.body, walk)
    }

    return
  }

  const lang = SCRIPT_LANGS[name]

  if (lang !== undefined) {
    const code = inlineScript(lang, args)
    const flagForm = lang === 'python' ? '-c' : '-e'

    if (code !== null) {
      pushScript(walk, `${name} ${flagForm}`, lang, code)
    } else if (input !== undefined && args.every(word => word.text === '-' || word.text.startsWith('-'))) {
      const body = input.op === '<<<' ? (input.target?.text ?? '') : (input.body ?? '')
      pushScript(walk, `${name} <<${input.op === '<<<' ? '<' : (input.target?.text ?? 'EOF')}`, lang, body)
    }

    return
  }

  if (walk.ctx.blockReads && READERS.has(name) && !segment.isPipedOut && segment.redirs.every(redir => redir.op === '>&' || redir.fd === '2')) {
    const { flags, operands } = operandsOf(args, READER_WITH_VALUE)
    const only = operands[0]

    if (operands.length === 1 && only !== undefined && !flags.some(flag => FOLLOW_FLAGS.test(flag))) {
      push(walk, 'read', name, only, { keepUnknown: false })
    }
  }
}

/** `find ... -exec sed -i ... {} +`: the command after -exec, its files supplied by find. */
const walkFind = (args: readonly Word[], walk: Walk): void => {
  for (let k = 0; k < args.length; k++) {
    if (!FIND_EXEC.has(args[k]?.text ?? '')) {
      continue
    }

    const end = args.findIndex((word, at) => at > k && (word.text === ';' || word.text === '+'))
    const inner = args.slice(k + 1, end < 0 ? args.length : end)
    walkSegment({ words: inner, redirs: [], isPipedOut: false }, walk, true)
    k = end < 0 ? args.length : end
  }
}

const nested = (source: string, walk: Walk): void => {
  if (walk.depth >= MAX_DEPTH) {
    return
  }

  walkSource(source, { ...walk, depth: walk.depth + 1, state: { cwd: walk.state.cwd, vars: new Map(walk.state.vars) } })
}

const walkSource = (source: string, walk: Walk): void => {
  const { tokens, subs } = lex(source)

  for (const sub of subs) {
    nested(sub, walk)
  }

  for (const segment of segmentsOf(tokens)) {
    walkSegment(segment, walk, false)
  }
}

const initialVars = (ctx: Context): Map<string, string> => {
  const vars = new Map<string, string>([['TMPDIR', TEMP]])

  if (ctx.home !== undefined) {
    vars.set('HOME', ctx.home)
  }

  return vars
}

/** Every file a Bash command writes through the shell, minus the allowed ones. */
export const analyze = (command: string, ctx: Context): Finding[] => {
  const walk: Walk = { state: { cwd: ctx.cwd, vars: initialVars(ctx) }, ctx, depth: 0, out: [] }
  walkSource(command, walk)
  const seen = new Set<string>()

  return walk.out.filter(finding => {
    const key = `${finding.kind}\u0000${finding.via}\u0000${finding.target ?? ''}`

    if (seen.has(key)) {
      return false
    }

    seen.add(key)

    return true
  })
}

// ---------------------------------------------------------------- settings

export const parseMode = (value: unknown): Mode => (value === 'warn' ? 'warn' : 'deny')

export const settingsOf = (options: Readonly<Record<string, unknown>>): Settings => ({
  mode: parseMode(options.mode),
  blockReads: options.blockReads === true,
  allowPaths: typeof options.allowPaths === 'string' ? options.allowPaths : DEFAULT_ALLOW,
  showsStatus: options.statusLine === true,
})

// ---------------------------------------------------------------- words for the model and the person

const quoteList = (names: readonly string[]): string => names.join(', ')

const editTargets = (findings: readonly Finding[]): string => {
  const named = [...new Set(findings.map(finding => finding.target).filter((target): target is string => target !== null))]
  const hasUnnamed = findings.some(finding => finding.target === null)

  if (named.length === 0) {
    return 'the files it changes'
  }

  return hasUnnamed ? `${quoteList(named)} and the other files it changes` : quoteList(named)
}

const describe = (findings: readonly Finding[]): string =>
  findings.map(finding => `\`${finding.via}\`${finding.target === null ? '' : ` on ${finding.target}`}`).join(', ')

/** The deny reason: what was caught and exactly which tool to use instead. */
export const denyReason = (findings: readonly Finding[]): string => {
  const edits = findings.filter(finding => finding.kind !== 'read')
  const reads = findings.filter(finding => finding.kind === 'read')
  const lines: string[] = [`no-shell-edits blocked this command: ${describe(findings)}.`]

  if (edits.length > 0) {
    const targets = editTargets(edits)
    lines.push(`Use Edit for changes to ${targets} (or Write for a new file) so the change shows as a diff and /rewind can undo it.`)
    lines.push(
      'Do not retry the same write through another shell command (sed, a redirection, tee, python -c). If this path really needs a shell write, such as a generated file, ask the user to add it to the no-shell-edits allowPaths setting.',
    )
  }

  if (reads.length > 0) {
    lines.push(`Use Read for ${editTargets(reads)} instead of ${[...new Set(reads.map(finding => finding.via))].join('/')}.`)
  }

  return lines.join(' ')
}

/** What the model reads after a command warn mode let run. */
export const warnContext = (findings: readonly Finding[]): string => {
  const edits = findings.filter(finding => finding.kind !== 'read')
  const reads = findings.filter(finding => finding.kind === 'read')
  const lines: string[] = []

  if (edits.length > 0) {
    lines.push(
      `no-shell-edits: this command changed ${editTargets(edits)} through the shell (${describe(edits)}), so the change has no diff and /rewind cannot undo it. From now on use Edit for changes to existing files and Write for new ones.`,
    )
  }

  if (reads.length > 0) {
    lines.push(`no-shell-edits: use Read for ${editTargets(reads)} instead of ${[...new Set(reads.map(finding => finding.via))].join('/')}.`)
  }

  return lines.join(' ')
}

export const toastText = (finding: Finding, mode: Mode): string => {
  const target = finding.target === null ? '' : ` on ${finding.target}`
  const read = finding.kind === 'read'

  if (mode === 'warn') {
    return `Shell ${read ? 'read' : 'edit'} \`${finding.via}\`${target} ran; Claude was told to use ${read ? 'Read' : 'Edit'}`
  }

  return `Blocked \`${finding.via}\`${target}; Claude was told to use ${read ? 'Read' : 'Edit'}`
}

/** The kinds in this command that were not toasted yet this session, first finding of each. */
export const freshKinds = (findings: readonly Finding[], toasted: readonly ShellEditKind[]): Finding[] => {
  const seen = new Set<ShellEditKind>(toasted)

  return findings.filter(finding => {
    if (seen.has(finding.kind)) {
      return false
    }

    seen.add(finding.kind)

    return true
  })
}

export const statusText = (count: number, mode: Mode): string => `no-shell-edits: ${count} ${mode === 'warn' ? 'flagged' : 'blocked'}`

export const preview = (command: string): string => {
  const flat = command.replace(/\s+/g, ' ').trim()

  return flat.length > COMMAND_PREVIEW ? `${flat.slice(0, COMMAND_PREVIEW - 1)}…` : flat
}

const pad2 = (n: number): string => String(n).padStart(2, '0')

export const clockTime = (at: number): string => {
  const date = new Date(at)

  return `${pad2(date.getHours())}:${pad2(date.getMinutes())}:${pad2(date.getSeconds())}`
}

/** What /no-shell-edits prints: this session's flagged commands, then the settings in force. */
export const report = (events: readonly ShellEditEvent[], settings: Settings): string => {
  const verb = settings.mode === 'warn' ? 'flagged' : 'blocked'
  const lines: string[] = [
    events.length === 0
      ? `Nothing ${verb} this session.`
      : `${events.length} command${events.length === 1 ? '' : 's'} ${verb} this session.`,
  ]

  if (events.length > 0) {
    lines.push('')
  }

  for (const event of events) {
    const what = event.hits.map(hit => `${hit.via}${hit.target === null ? '' : ` → ${hit.target}`}`).join(', ')
    lines.push(`${clockTime(event.at)}  ${event.action === 'warned' ? 'warned ' : 'blocked'}  ${what}`)
    lines.push(`          $ ${preview(event.command)}`)
  }

  const allow = compileGlobs(settings.allowPaths).map(glob => glob.pattern)
  lines.push('')
  lines.push('Settings')
  lines.push(`  mode        ${settings.mode}`)
  lines.push(`  blockReads  ${settings.blockReads ? 'on' : 'off'}`)
  lines.push(`  allowPaths  ${allow.length === 0 ? '(none)' : allow.join(', ')}`)
  lines.push(`  statusLine  ${settings.showsStatus ? 'on' : 'off'}`)
  lines.push(`Always allowed: /dev/*; outside the project also ${TMP_ROOTS.join(', ')} and $TMPDIR`)

  return lines.join('\n')
}
