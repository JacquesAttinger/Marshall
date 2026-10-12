# Marshall dashboard

<!-- Last edited: 2026-10-11 22:30 PDT -->

**TLDR:** The dashboard is a small web page that shows what each Marshall agent does now.
It runs on the laptop as its own program (`marshall dashboard`), so it stays up when the daemon stops.
Open it at `http://127.0.0.1:7474` on the Mac, or through Tailscale on the phone.
It is read-only except for one button: Kill.

## Open it

On the Mac, while the dashboard runs:

```bash
bin/marshall dashboard          # in a terminal, until Ctrl-C
open http://127.0.0.1:7474
```

As a login service, from the main checkout (never from a worktree; the script refuses):

```bash
bash scripts/install-launchd.sh dashboard
```

That installs `~/Library/LaunchAgents/com.jacques.marshall-dashboard.plist`.
It is a separate launchd job: `marshall start` and `marshall stop` do not touch it.
Its logs are `~/.marshall/logs/dashboard.{out,err}.log`; its events also go to `marshall.log`.

The port is `dashboardPort` in `marshall.config.json` (default `7474`).
The server listens on `127.0.0.1` only, so no other machine can reach it directly.

## Open it for the Oracle VM

Marshall now runs only on the VM, so the dashboard does too.
It is a systemd user unit, `marshall-dashboard`, next to `marshall`.
The unit file is `scripts/systemd/marshall-dashboard.service`.

To install it on the VM:

```bash
cp scripts/systemd/marshall-dashboard.service ~/.config/systemd/user/
systemctl --user daemon-reload && systemctl --user enable --now marshall-dashboard
```

The server listens on the VM's `127.0.0.1:7474` only.
To open it from a phone, see the Tailscale section below.
From the Mac, open an SSH tunnel and then the page:

```bash
scripts/vm-dashboard.sh         # in a terminal, until Ctrl-C
open http://127.0.0.1:7474
```

Check the unit: `systemctl --user is-active marshall-dashboard`.
Logs: `journalctl --user -u marshall-dashboard -f`.
The Mac no longer runs a dashboard or a daemon (`scripts/uninstall-launchd.sh all` removed both).
The sections below about launchd and the Mac still describe the Mac install, for anyone who wants it back.

## Open it on the phone (Tailscale)

Tailscale makes a private network (a "tailnet") of your own devices.
`tailscale serve` gives that network an HTTPS address for the local port.
Only devices logged in to your Tailscale account can open it.
It is not on the public internet: do not use `tailscale funnel`, which is public.

Marshall runs on the Oracle VM, so Tailscale goes on the VM and on the phone.
Do these steps in order.
Each step you do by hand is marked (you).

1. (you) Make a free Tailscale account at <https://login.tailscale.com> if you have none.
2. (you) Install the Tailscale app on the iPhone (App Store) and log in with that account.
3. On the VM, install Tailscale from its official apt repository:

   ```bash
   scripts/install-tailscale.sh --dry-run   # prints the steps, changes nothing
   scripts/install-tailscale.sh
   ```

   It is safe to rerun.
4. (you) On the VM: `sudo tailscale up`.
   It prints a login URL.
   Open it in a browser and approve the VM.
5. (you) In the admin console (<https://login.tailscale.com/admin/dns>), turn on **MagicDNS**, then **HTTPS Certificates**.
   `tailscale serve` needs both.
6. On the VM, publish the dashboard:

   ```bash
   scripts/tailscale-serve.sh        # runs: tailscale serve --bg 7474
   ```

   Use `PORT=<n> scripts/tailscale-serve.sh` if `dashboardPort` is not 7474.
   `--bg` keeps the setting after a reboot.
   The script prints `tailscale serve status` last.
7. Find the URL: it is the `https://<vm-name>.<tailnet>.ts.net` line in that output.
   Run `tailscale serve status` on the VM any time to see it again.
8. (you) On the phone, with the Tailscale app connected, open the URL in Safari.
   Tap Share, then **Add to Home Screen**.
   The app must be connected for the page to load.

To stop sharing: `scripts/tailscale-serve.sh --reset` (this removes every `serve` setting on the machine).

To revoke a device (a lost phone): open the admin console, **Machines**, find the device, open its menu, and choose **Remove**.
A removed device cannot reach any tailnet address, including the dashboard.
To lock the page to certain people instead of every device on the tailnet, set `tailscaleUsers` (next section).

On the Mac, the same works: install the macOS app, log in, then `tailscale serve --bg 7474`.

The server accepts only these `Host` names: `localhost`, `127.0.0.1`, and any `*.ts.net`.
Other names get 403, so a web page that points its own domain at your laptop cannot read the dashboard (DNS rebinding).

### Limit it to your own login (`tailscaleUsers`)

By default any device on your tailnet can open the page.
That matters if you share the tailnet, or share a device with someone.
Add your login to `marshall.config.json`, then restart the dashboard:

```jsonc
"tailscaleUsers": ["you@example.com"]
```

What it does, on every route:

- `tailscale serve` adds a `Tailscale-User-Login` header to each request from the tailnet.
  It removes any copy of that header that the client sent.
  A request whose login is not in the list gets 403.
  The match ignores case.
- A request to a `*.ts.net` name with no such header did not come through `tailscale serve`.
  It gets 403.
  Tagged devices send no header, so they are refused too.
- Requests to `localhost` or `127.0.0.1` (the SSH tunnel) are not affected.
- Unset, nothing is checked and behavior is unchanged.

The list must not be empty.
Tailscale documents the header at <https://tailscale.com/kb/1312/serve>.
Check that it works: open the page on the phone (200), then remove your login from the list and restart: the page should say "Forbidden".

## What each section means

The page refreshes every 5 seconds while the tab is visible.
"Updated N s ago" under the strip turns amber with "Connection lost" when a refresh fails.

### Header: project and help

- Under the page title, **Project `<repo>`** says which repo Marshall edits, which Linear workspace it watches, and which branch PRs go into.
  It comes from the config the dashboard started with, so after a config change restart the dashboard and reload the tab.
- The project button at the top right names the active project and opens the project menu: every registered project, with a **Switch** button on the others.
  See "Switch project" below.
- The **?** button at the top right opens a list of terminal commands that check on Marshall: is it running, full status, recent log lines, restart.
  Set `sshCommand` in the config (for example `ssh -i ~/.ssh/key ubuntu@host`) and each command is shown ready to paste on your laptop.
  Without it, the commands are plain and run on the machine that serves the dashboard.

### Status strip

- **Daemon running / down.**
  Running means the orchestrator's pidfile names a live process, or launchd reports the job running.
- **Paused by hand since HH:MM** — `marshall pause` is on; `marshall resume` clears it.
- **Rate-limited until HH:MM** — an agent hit the usage limit; new starts wait until then.
- **Queue empty** — no Todo issue is waiting to start (spec section 7).
  It does not show when the Linear call failed.
- `1/3 agents · 4/10 today · 2/10 in 3 h window` — busy slots, starts today, starts in the rolling window, against the caps in the config.

### Needs you

Issues that wait on a person: Needs Verification, Blocked, or Rebasing.
A row shows only while Linear still lists the issue as Needs Verification or Blocked.
If Linear is unreachable, all rows show with a "Not checked against Linear" note.

- **Needs Verification** — the hand-off's TLDR, the PR, the round, and **Show hand-off**, which loads the full six sections.
- **Blocked** — why: the comment Marshall posted to Linear, or (for older rows) the reason from `implement.json`, or the short code in plain words.
- **Rebasing** — rebased and pushed; CI is running.

### Agents

One panel per slot, `maxAgents` slots in all; an empty slot says "idle".
A panel shows the issue, the phase (and the implementer's step, for example "review cycle 2/4"), the model, the time since the claim, the tokens of the current run, and the session's last action.

**Needs you** on a panel means the session waits on input, or it has done nothing for `stallMinutes`.

### Queue

The pickable issues in pickup order, from the same dry run as `marshall queue`, and what the next tick does with each:

| Status | Meaning |
|---|---|
| next start · slot N | It starts on the next tick. |
| slots full | Every agent slot is busy. |
| daily cap | The daily start cap is used up; it resets at local midnight. |
| window cap · frees HH:MM | The rolling-window cap is used up; a slot frees at that time. |
| paused / rate-limited | A pause holds every start. |
| live | Marshall still holds a claim on it. |
| bounce limit | It bounced back too often; the next tick marks it Blocked. |
| human only | It has the `human-only` label; Marshall never picks it up. |

A **bounce #N** tag means a human sent it back and this is its next run.
The Linear lists are cached for 60 seconds.
When a refresh fails, the queue shows the error and the last good list with its time.

## Kill

Tap **Kill** once: the button turns red and says "Tap again to kill TOD-17".
Tap again within 4 seconds to send it; otherwise it resets.

Kill does the same as `marshall kill`:

- With a live orchestrator, it writes the kill flag; the next pulse stops the agent and marks the issue Blocked.
  The panel then says "Kill requested".
- With no orchestrator, it stops the runs itself and marks the issue Blocked in Linear.

Kill is not offered on a conflict resolver (phase "Resolving conflicts"): the orchestrator builds no agent for it, so the flag would be dropped.
Use `marshall stop`, then Kill (or `marshall kill`) stops it directly.

## Switch project

Tap **Switch** next to a project in the project menu: the button turns red and says "Tap again to switch".
Tap again within 4 seconds to send it.

- If any agent is live in the current project, the switch is refused (HTTP 409) and the menu says how many agents are still working.
  Nothing changes.
  Wait for them to finish and try again.
- Otherwise the dashboard makes the project active, restarts `marshall`, and then restarts itself.
  The page says "Switching…", waits until the dashboard answers again, and reloads on the new project.
  This needs Linux and a dashboard started by systemd (`Restart=always` brings it back).
- On macOS, or when the dashboard was started by hand, it only records the switch and says to restart Marshall and the dashboard yourself.
- If the units set `MARSHALL_CONFIG`, the config is fixed and the menu lists the projects without Switch buttons.
- Like Kill, the switch route checks the Host and Origin headers, so only this page can send it.

To add a project from a terminal, see "Projects" in `docs/runbook.md`.
To add one from the dashboard, see the next section.

## Add a project from the dashboard

Tap **Add project** in the header to point Marshall at a new project from your phone.
It needs the project registry (`~/.marshall-projects`, see `src/projects.ts`).
The dashboard must run on the machine that holds your repos (the VM), because it runs `gh` and `git` there.

**What you need first.**
Marshall cannot do these two things for you:

1. Create a Linear workspace for the project.
2. Create a personal API key in it: Settings, Account, Security & access, Personal API keys, New key.

The VM also needs `gh` logged in to the GitHub account that will own the repo, and Claude Code run once (so `~/.claude.json` exists).

**The form.**
Enter a project name and paste the key, then tap **Check key**.
The panel shows the Linear workspace and a team picker (a team is chosen for you when there is only one).
Choose a new private repo (named, or the project id by default) or an existing repo (`owner/name` or an `https://github.com/owner/name` address), then tap **Create project**.

**What Create does.**
Each step shows a result line.
The first failure stops the run.

1. Check the Linear key: reads the workspace and teams. Stores nothing.
2. Check the project name: a name that exists for another workspace or repo is refused.
3. Save the key: writes `~/.marshall-projects/<id>/secrets.env`, mode 0600.
4. Get the repo: `gh repo create <owner>/<name> --private --add-readme` for a new repo, then `gh repo clone` into `~/code/<name>`. Reads the default branch, which becomes the PR base.
5. Set up Linear: the Needs Verification and Blocked states and the `marshall` labels (`ensureWorkspaceSetup`).
6. Trust the repo in Claude Code's config.
7. Write `~/.marshall-projects/<id>/config.json` and register the project.
   The config starts from the active project's config, so limits you tuned carry over (and `sshCommand` and `dashboardPort`).
   Only `workspace`, `teamId`, `repoPath` and `baseBranch` change.

The new project is not made active, unless it is the first one.
When it is not, the panel offers a **Switch** button: tap it twice, like the Switch button in the project menu (see "Switch project" above; it uses the same route and has the same refusals).
Without that button (the dashboard is fixed by `MARSHALL_CONFIG`), use `marshall project use <id>`, then restart Marshall and the dashboard.

**When a step fails.**
Read the red line, fix the cause, paste the key again, and tap **Create project** again.
Every step is safe to run twice: a step that is done says "Already done" and is skipped.

| Step fails | Likely cause | Fix |
|---|---|---|
| Check the Linear key | Key copied in part, or revoked | Make a new key in Linear and paste all of it |
| Check the project name | Same name used for another workspace or repo | Pick another name |
| Get the repo, "Could not read the GitHub login" | `gh` is not logged in on the VM | Run `gh auth login` on the VM |
| Get the repo, "already exists" | `~/code/<name>` is a different repo or not a git repo | Move that folder, or pick another repo name |
| Get the repo, "Could not create" | The repo name is taken, or `gh` lacks the permission | Use "existing repo", or fix the `gh` login |
| Set up Linear | The key lacks access to the team | Use a key from a member of that team |
| Trust the repo | `~/.claude.json` is damaged | Fix the file, then run again |

The key never appears in a log line, a result line, or `config.json`.
Only `secrets.env` holds it.
The dashboard log shows the project name and each step's result.

## Security

- `127.0.0.1` only; the tailnet reaches it through `tailscale serve`.
- Optional `tailscaleUsers`: only the listed Tailscale logins get in through the tailnet.
- `Host` allow-list on every request; Kill and the add-project routes also need an `Origin` with the same host.
- The add-project routes take small JSON bodies only (4 KB), run one create at a time (a second gets 409), and answer failures with a plain message.
- Content Security Policy: scripts, styles, and requests only from the page itself; no frames.
- Hand-off Markdown is rendered without raw HTML, without images, and with only `http(s)` and `#` links.
- The dashboard never migrates the database.
  If the database is missing or older than the code, the page says to start the daemon once.
