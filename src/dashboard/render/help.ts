// Last edited: 2026-10-11 19:38 PDT
// The "?" help panel: terminal commands that check on Marshall. A <details> element, so it needs no
// script (the CSP forbids inline script) and the 5 s section swap never closes it.

import { html, type SafeHtml } from "../html.ts";

export interface HelpInfo {
  /** `ssh -i ~/.ssh/key user@host`, or undefined when the commands run on this machine. */
  sshCommand?: string;
  /** Checkout the daemon runs from, with `~` for the home directory. */
  repoDir: string;
  /** Config path as `marshall` is told about it: relative to `repoDir` when inside it. */
  configPath: string;
  /** Set when the daemon keeps its state outside `~/.marshall`. */
  marshallHome?: string;
  platform: NodeJS.Platform;
}

interface HelpCommand {
  title: string;
  note: string;
  command: string;
}

/** `ssh ... '<remote>'` when the checks run over SSH, else the bare command. */
function viaSsh(info: HelpInfo, remote: string): string {
  return info.sshCommand ? `${info.sshCommand} '${remote}'` : remote;
}

function statusCommand(info: HelpInfo): string {
  const env = [`MARSHALL_CONFIG=${info.configPath}`];
  if (info.marshallHome) env.push(`MARSHALL_HOME=${info.marshallHome}`);
  return `export PATH=$HOME/.bun/bin:$PATH; cd ${info.repoDir} && ${env.join(" ")} bin/marshall status`;
}

export function helpCommands(info: HelpInfo): HelpCommand[] {
  const status: HelpCommand = {
    title: "Full status",
    note: "Workspace, agents, the queue, and what needs you.",
    command: viaSsh(info, statusCommand(info)),
  };
  if (info.platform !== "linux") {
    return [
      status,
      {
        title: "Is the daemon running?",
        note: "The first lines of the status output say so.",
        command: `cd ${info.repoDir} && bin/marshall status`,
      },
    ];
  }
  return [
    {
      title: "Is Marshall running?",
      note: "Prints active or inactive.",
      command: viaSsh(info, "systemctl --user is-active marshall"),
    },
    status,
    {
      title: "Recent log lines",
      note: "Add -f after the unit name to follow them live.",
      command: viaSsh(info, "journalctl --user -u marshall -n 50 --no-pager"),
    },
    {
      title: "Is the dashboard itself running?",
      note: "Prints active or inactive.",
      command: viaSsh(info, "systemctl --user is-active marshall-dashboard"),
    },
    {
      title: "Restart Marshall",
      note: "Running agents survive; the daemon picks them up again.",
      command: viaSsh(info, "systemctl --user restart marshall"),
    },
    {
      title: "Open this dashboard from your laptop",
      note: "Run it in the Marshall checkout, then open http://127.0.0.1:7474.",
      command: "scripts/vm-dashboard.sh",
    },
  ];
}

export function renderHelp(info: HelpInfo): SafeHtml {
  const items = helpCommands(info).map(
    (c) =>
      html`<li><strong>${c.title}</strong><span class="help-note">${c.note}</span><pre><code>${c.command}</code></pre></li>`,
  );
  return html`<details class="help"><summary aria-label="Help: commands to check on Marshall" title="Help">?</summary>
<div class="help-body">
<p class="help-title">Check on Marshall from a terminal</p>
<ul class="help-list">${items}</ul>
</div>
</details>`;
}
