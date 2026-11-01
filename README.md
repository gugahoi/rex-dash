# rex-dash

A dashboard pane for [Rex](https://www.superlogical.com/rex/docs). It shows:

- **Fleet:** every Rex session and pane, with the status its program reports to Rex (working, blocked, done or idle), the task title, current activity and folder. Claude Code and omp report status; plain shells show dimmed.
- **Usage:** Claude Code tokens by model over the last 30 days, with a daily sparkline, read from `~/.claude/projects`.
- **Review requests:** up to 10 open PRs waiting on your review, across GitHub, with CI and review state.
- **My PRs:** your open PRs, with CI, review and draft state.

Keys: `j`/`k` or the arrow keys select an agent, Enter shows its pane in the Rex app, `s` cycles the shader, `e` cycles the effects, `r` refreshes, `q` quits.

## Effects

Everything is drawn with truecolor text, at 10 frames a second, rewriting only rows that changed.

- **Shaders** (`s`): `aurora`, `plasma`, `ember` or `off`. The shader animates the bands at the top and bottom, the headings and the usage charts.
- **Effects** (`e`): `bloom+scanlines`, `bloom`, `scanlines` or `off`. Bloom puts a soft glow behind coloured text. Scanlines darken every other row and paint the pane's background, replacing your terminal theme's background.

Both start on, at `aurora` and `bloom+scanlines`, and reset when you restart the dashboard.

## Requirements

- Node 20.1 or later
- `rex` on `PATH`
- `gh`, logged in (`gh auth login`)

## Install

Put `rex-dash` on your `PATH`, for example:

```sh
ln -s "$PWD/rex-dash" ~/.local/bin/rex-dash
```

Open it beside your current pane:

```sh
rex split -b "$REX_BLOCK" --split=right --ratio 45 --label Cockpit --focus=false -- rex-dash
```

With several Rex apps connected, set `REX_CLIENT` to the one Enter should switch.

## Usage

```
rex-dash          live dashboard
rex-dash --once   print one frame and exit
rex-dash --test   run the self-check
```

The fleet refreshes every 3 seconds, PRs every minute and usage every 5 minutes.
