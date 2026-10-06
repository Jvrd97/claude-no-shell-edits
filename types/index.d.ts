/** How a Bash command wrote (or, with blockReads, read) a file. */
export type ShellEditKind = 'in-place' | 'redirect' | 'heredoc' | 'tee' | 'script' | 'truncate' | 'overwrite' | 'read'

/** One file a command touched: the kind, the spelling the reason uses (`sed -i`, `echo >`) and the target as written. */
export type ShellEditHit = {
  kind: ShellEditKind
  via: string
  /** The path as the command spells it; null when the command does not name it (`xargs sed -i`). */
  target: string | null
}

/** One flagged Bash command, as /no-shell-edits lists it. */
export type ShellEditEvent = {
  at: number
  command: string
  action: 'blocked' | 'warned'
  hits: ShellEditHit[]
}

declare module 'claude-code' {
  interface PluginState {
    'no-shell-edits': {
      events: ShellEditEvent[]
      toasted: ShellEditKind[]
    }
  }
}
