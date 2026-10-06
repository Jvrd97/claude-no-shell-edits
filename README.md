# no-shell-edits

A Claude Code mod that stops Claude from editing files through Bash (`sed -i`, heredocs, `echo >`, `tee`, `python -c`) and sends it to Edit or Write instead, so every change shows as a diff and `/rewind` can undo it.

```
⏺ Bash(sed -i '' 's/foo/bar/' src/app.ts)
  ⎿  Error: no-shell-edits blocked this command: `sed -i` on src/app.ts. Use Edit for changes to
     src/app.ts (or Write for a new file) so the change shows as a diff and /rewind can undo it.

⏺ Update(src/app.ts)
  ⎿  Updated src/app.ts with 1 addition and 1 removal
```

## Why

In auto mode Claude often edits files through the shell instead of its file tools. Such a change has no diff in the transcript, skips your review, and `/rewind` cannot undo it, because checkpoints only track Edit and Write. Three open issues ask for a fix, with about 250 👍 together (checked 2026-10-06):

- [#87971](https://github.com/anthropics/claude-code/issues/87971)
- [#88041](https://github.com/anthropics/claude-code/issues/88041)
- [#19649](https://github.com/anthropics/claude-code/issues/19649)

The mod guards the Bash tool: the model gets the refusal at the moment it reaches for `sed`, together with the exact tool to use instead.

## What it does

| Caught | Example |
|---|---|
| In-place editors | `sed -i`, `sed --in-place`, `perl -pi`, `awk -i inplace`, also through `xargs` and `find -exec` |
| Redirections into a file | `echo x > f`, `printf … >> f`, `cmd &> f`, `>|`, `1> f` |
| Heredocs into a file | `cat > f <<'EOF' … EOF` |
| `tee` | `… \| tee f`, `tee -a f` |
| Inline scripts that write | `python -c "open('f','w')…"`, `Path('f').write_text`, `node -e "fs.writeFileSync('f')"`, `ruby -e 'File.write("f")'`, `python - <<EOF … EOF` |
| `truncate` | `truncate -s 0 f` |
| `cp`/`mv` over an existing file | `mv /tmp/edited f` when `f` exists |
| Shell reads (opt-in) | `cat f`, `head -n 50 f`, `tail f`, `less f`, `more f` with `blockReads` on |

It also looks inside `bash -c '…'`, `eval`, `$(…)` and `sudo`/`env`/`timeout` wrappers, and follows a `cd` earlier in the same command.

Never flagged: `/dev/null` and the rest of `/dev`, fd duplications like `2>&1`, scratch files in `/tmp`, `/var/folders` or `$TMPDIR` outside the project, a `$(mktemp)` variable, paths in `allowPaths`, and build tools that write files on their own (`make`, `cargo build`, `curl -o`). Quotes, `[[ $a > $b ]]` and arithmetic `$(( a > b ))` are understood, so `echo "a > b"` and `grep '>' f` pass.

Besides the refusal:

| Where | What |
|---|---|
| Toast | Once per kind per session: `Blocked \`sed -i\` on a.txt; Claude was told to use Edit` |
| `/no-shell-edits` | Every command blocked this session (time, how, target, the command) and the settings in force |
| Status line (opt-in) | `no-shell-edits: 3 blocked` |

```
1 command blocked this session.

20:41:07  blocked  sed -i → a.txt
          $ sed -i '' 's/a/b/' a.txt

Settings
  mode        deny
  blockReads  off
  allowPaths  *.log, .git/**
  statusLine  off
Always allowed: /dev/*; outside the project also /tmp, /private/tmp, /var/tmp, /var/folders, /private/var/folders and $TMPDIR
```

## Install

You need Claude Code with mods (function hooks); tested on 2.1.285 and 2.1.291. Mods are in early access: if the CLI says hooks modules are not turned on, start it as `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude`.

From the marketplace in this repo:

```
/plugin marketplace add Jvrd97/claude-no-shell-edits
/plugin install no-shell-edits@no-shell-edits
```

Or straight from disk, for one session:

```bash
git clone https://github.com/Jvrd97/claude-no-shell-edits.git
claude --plugin-dir ./claude-no-shell-edits
```

## Settings

Change them in `/config` under the plugin, or in `settings.json` under `pluginConfigs`:

| Field | Default | Meaning |
|---|---|---|
| `mode` | `deny` | `deny` refuses the command. `warn` lets it run and adds a note to the result Claude reads: what went wrong and to use Edit next time |
| `blockReads` | `false` | Also refuse `cat`/`head`/`tail`/`less`/`more` of a single file and tell Claude to use Read. `tail -f`, pipes and several files pass |
| `allowPaths` | `*.log,.git/**` | Comma-separated globs the shell may write. A glob without `/` matches a file name anywhere; one with `/` matches from the project root (`dist/**`). Setting it replaces the default |
| `statusLine` | `false` | Pin `no-shell-edits: N blocked` under the prompt |

## How it works

- `tool.call` on Bash reads the command with a small shell lexer: quotes, escapes, heredoc bodies, `$(…)`, `[[ ]]` and arithmetic. It splits the line into simple commands and checks each one's redirections and program.
- A target resolves against the session's working directory (`$.session.cwd()`), `HOME` and `TMPDIR`, then against the allow rules. A `/tmp` path inside the project counts as a project file: a repo that lives in a temp folder is still guarded.
- For `cp`/`mv` the mod stats the destination and flags only an existing file.
- `deny` returns the refusal before the command runs. `warn` runs it and appends one line of `context` to the result.
- `session.start` registers `/no-shell-edits`. The session's flagged commands (up to 200) and the kinds already toasted live in the session's own state. The mod sends nothing anywhere and writes no files.

What it cannot do:

- Know a target held in a variable it did not see set: `echo x > "$out"` passes. In-place editors (`sed -i "$f"`) are flagged anyway, because editing is all they do.
- See writes a program makes on its own: an awk `print > "f"`, a script file `python fix.py`, `git apply`, `dd of=f`. Only inline `-c`/`-e` scripts and heredoc-fed ones are read, by pattern.
- Stop a determined workaround. It is a guard for a habit, not a sandbox.
- Avoid every false positive: `make > out.txt` or `git diff > changes.patch` inside the project are refused. Add such paths to `allowPaths`, or switch to `warn`.

## Develop

Inside Claude Code run `/plugin-types .claude/types` once: it writes the API types `tsc` reads. Then:

```bash
tsc -p .
claude plugin validate .claude-plugin/plugin.json
claude plugin test .
```

## По-русски

В auto mode Claude часто правит файлы через Bash: `sed -i`, heredoc, `echo >`, `tee`, `python -c`. У такой правки нет diff в транскрипте, она проходит мимо ревью, и `/rewind` её не откатит.

Мод перехватывает такие команды до запуска и отвечает модели, какой инструмент взять: Edit для существующего файла, Write для нового. Временные файлы, `/dev/null`, логи и пути из `allowPaths` проходят. Режим `warn` пропускает команду и только напоминает модели про Edit. `/no-shell-edits` показывает, что заблокировано за сессию.

## License

MIT
