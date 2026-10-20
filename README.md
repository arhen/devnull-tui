# herdr-devnull-plugin

The [/dev/null](https://dev-null.sh) commit log, as a timeline in a Herdr pane.

Every post on /dev/null is a git commit drawn on a rail, coloured by its
author's lane: avatars as 6×6 half-block pixels, the short hash on the right,
bodies with inline code, links, quotes, polls, link previews and replies. Enter
opens a commit with its whole conversation, and `c` / `R` commit and reply as
you, signed with your SSH key.

```
▀▀▀▀▀▀ legecha @legecha · 4m                    40dd829
▀▀▀▀▀▀ I haven't done social media for years.
▀▀▀▀▀▀ But this feels different.
│      Hello, World!
│      ★ 3   ↳ 1
○
```

## Requirements

- Herdr 0.9.0 or newer (`herdr plugin` with pane entrypoints).
- Node.js 18 or newer (`fetch`, `Intl.Segmenter`).
- OpenSSH 8.2+ with `ssh-keygen -Y sign`, and a key that is on your GitHub
  account, for committing and replying. Reading needs neither.

## Install

From GitHub, once this repository is public:

```sh
herdr plugin install arhen/herdr-devnull-plugin
herdr server reload-config
```

From a checkout, while developing:

```sh
herdr plugin link ~/Code/personal/herdr-plugin-devnull
```

## Open it

```sh
herdr plugin action invoke devnull.feed.open
```

Or bind a key in `~/.config/herdr/config.toml`:

```toml
[[keys.command]]
key = "prefix+d"
type = "plugin_action"
command = "devnull.feed.open"
description = "open the /dev/null feed"
```

The pane opens as a split beside the calling pane. Agents that install the
`dev-null` skill run that action when you say "open dev-null".

## Keys

| Key | |
| --- | --- |
| `j` / `k` | next / previous commit |
| `g` / `G` | first / last commit |
| `ctrl+d` / `ctrl+u` | half a page |
| `enter` | open the commit and its conversation |
| `e` | expand the selected reply's own replies |
| `R` | reply to the selected commit |
| `c` | commit something new |
| `o` | open the commit in a browser (Herdr browser tab, else the default browser) |
| `r` | refresh |
| `t` / `1` / `2` | latest / trending |
| `?` | keys |
| `esc` | back to the timeline |
| `q` | close the pane |

## Writing

`c` and `R` post as your /dev/null account the same way dev-null's own
`curl -fsSL https://dev-null.sh/commit | bash` does, with no login:

1. It lists your public keys (`ssh-add -L` and `~/.ssh/*.pub`) and asks
   `/api/cli/key-lookups` which of them is on the GitHub account of a /dev/null
   user. Public keys are public; nothing else leaves your machine.
2. It signs `timestamp\nnonce\nreply-to\nbody` with
   `ssh-keygen -Y sign -n devnull-commit`, so your private key — a 1Password or
   hardware key included — never leaves the agent.
3. It posts the payload and the signature to `/api/cli/commits`.

Stars, pastéis, follows and bookmarks are **not** available here: /dev/null
only accepts them from an approved device (a key you approve under
`/settings/devices` from the mobile app), and this plugin does not pretend
otherwise.

## Data

The plugin reads what the website renders for guests, so there is no API key,
no cookie jar, and no scraping of private state:

- `https://dev-null.sh/log/latest` and `/log/trending`: the Inertia
  `data-page` JSON with 20 commits.
- `https://dev-null.sh/@user/commits/{id}` with
  `Cookie: replies_per_page=25`: a commit, its ancestors, and its replies.

`Following` needs your session and is not offered. The timeline refreshes every
60 seconds; `--interval` changes that.

## Text mode

For agents and scripts, and for a quick look without a TUI:

```sh
NO_COLOR=1 node index.js --once --log latest --width 100
```

`herdr plugin action invoke devnull.feed.latest` prints the same into the
plugin log (`herdr plugin log list --plugin devnull.feed`).

## Development

```sh
npm install          # typescript and @types/node, for checking only
npm run typecheck    # tsc --noEmit over the JSDoc-checked sources
node index.js        # run the pane by hand
```

There is no build step and no runtime dependency: Herdr launches
`/bin/sh run.sh` (manifest `[[panes]]`), which execs `node index.js`.

## Layout

| Path | |
| --- | --- |
| `herdr-plugin.toml` | pane, actions, keybinding target |
| `index.js` | state machine: timeline, thread, composer, keys, polling |
| `lib/draw.js` | rows, rails, avatars, links, thread and chrome |
| `lib/devnull.js` | page JSON → commits, threads |
| `lib/avatars.js` | GitHub `?s=6` PNG → half blocks, cached in `HERDR_PLUGIN_STATE_DIR` |
| `lib/auth.js` | SSH key lookup, `ssh-keygen -Y sign`, commit/reply |
| `lib/text.js` | display width, wrapping, link detection |

## Licence

MIT.
