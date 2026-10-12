// Last edited: 2026-10-11 19:38 PDT
// The dashboard's pure templates: escaping, the hand-off sanitizer, every empty state, each card
// and panel variant, every queue status code, and the page shell's CSP-friendly markup.

import { describe, expect, test } from "bun:test";
import type { QueueStatus } from "../../src/cli/queue.ts";
import { html, raw, renderMarkdown } from "../../src/dashboard/html.ts";
import { renderAgents } from "../../src/dashboard/render/agents.ts";
import {
  formatAge,
  formatClock,
  formatTokens,
  prLabel,
} from "../../src/dashboard/render/format.ts";
import { type HelpInfo, helpCommands, renderHelp } from "../../src/dashboard/render/help.ts";
import { renderNeedsYou } from "../../src/dashboard/render/needs-you.ts";
import { renderPage, renderSections, sectionHashes } from "../../src/dashboard/render/page.ts";
import { renderQueue } from "../../src/dashboard/render/queue.ts";
import { type ProjectInfo, renderStrip } from "../../src/dashboard/render/strip.ts";
import { agent, card, NOW, queueReport, queueRow, strip } from "./fixtures.ts";

const PROJECT: ProjectInfo = {
  workspace: "tictactoe1514",
  repo: "tic-tac-toe",
  baseBranch: "main",
};
const HELP: HelpInfo = {
  sshCommand: "ssh -i ~/.ssh/key ubuntu@203.0.113.7",
  repoDir: "~/code/Marshall",
  configPath: "marshall.tictactoe.config.json",
  platform: "linux",
};

describe("html", () => {
  test("escapes every interpolated value; nested html and raw pass through", () => {
    const title = `<script>alert("x")</script> & 'q'`;
    expect(String(html`<p title="${title}">${title}</p>`)).toBe(
      '<p title="&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;">&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;q&#39;</p>',
    );
    expect(String(html`${[1, html`<b>${"<i>"}</b>`, raw("<hr>")]}`)).toBe("1<b>&lt;i&gt;</b><hr>");
    expect(String(html`${null}${undefined}${false}${true}|`)).toBe("|");
  });

  test("an agent title with markup is inert in a panel", () => {
    const out = String(
      renderAgents([{ slot: 0, agent: agent({ title: "<img src=x onerror=1>" }) }]),
    );
    expect(out).toContain("&lt;img src=x onerror=1&gt;");
    expect(out).not.toContain("<img");
  });
});

describe("renderMarkdown", () => {
  test("raw HTML, comments, images, and javascript: links come out inert", () => {
    const md = [
      "<!-- Last edited: 2026-10-03 -->",
      "# Hand-off",
      "",
      "<script>alert(1)</script>",
      "",
      "**TLDR:** <b>bold</b> [bad](javascript:alert(1)) [ok](https://github.com/o/r/pull/1) [frag](#x)",
      "",
      "![tracker](https://evil.example/pixel.png)",
    ].join("\n");
    const out = String(renderMarkdown(md));
    expect(out).not.toContain("Last edited");
    expect(out).not.toContain("<script");
    expect(out).toContain("&lt;script&gt;");
    expect(out).not.toContain("<b>");
    expect(out).not.toContain("javascript:");
    expect(out).not.toContain("<img");
    expect(out).toContain('<a href="https://github.com/o/r/pull/1" rel="noopener noreferrer"');
    expect(out).toContain('<a href="#x"');
    // The rewriter is reusable: a second call works the same.
    expect(String(renderMarkdown("[x](javascript:1)"))).toBe("<p><a>x</a></p>\n");
  });
});

describe("format", () => {
  test("clock, age, tokens, PR label", () => {
    expect(formatClock(new Date(2026, 9, 3, 9, 5).toISOString(), NOW)).toBe("09:05");
    expect(formatClock(new Date(2026, 8, 30, 10, 51).toISOString(), NOW)).toBe("Sep 30 10:51");
    expect(formatAge(30_000)).toBe("just now");
    expect(formatAge(12 * 60_000)).toBe("12 min");
    expect(formatAge(3 * 3_600_000)).toBe("3 h");
    expect(formatAge(4 * 86_400_000)).toBe("4 d");
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(33_553)).toBe("33.6k");
    expect(formatTokens(1_250_000)).toBe("1.3M");
    expect(prLabel("https://github.com/o/r/pull/26")).toBe("PR #26");
    expect(prLabel("https://example.com")).toBe("PR");
  });
});

describe("renderStrip", () => {
  test("running, counts, and the queue-empty badge", () => {
    const out = String(renderStrip(strip({ queueEmpty: true }), NOW, PROJECT));
    expect(out).toContain("Daemon running");
    expect(out).toContain("1/3 agents · 4/10 today · 2/10 in 3 h window");
    expect(out).toContain("Queue empty");
  });

  test("down, paused by hand, rate-limited; no queue badge when unknown", () => {
    const s = strip({ daemonRunning: false, queueEmpty: null });
    s.counts = {
      ...s.counts,
      pausedAt: new Date(2026, 8, 30, 10, 51).toISOString(),
      pausedUntil: new Date(2026, 9, 3, 16, 40).toISOString(),
    };
    const out = String(renderStrip(s, NOW, PROJECT));
    expect(out).toContain("Daemon down");
    expect(out).toContain("Paused by hand since Sep 30 10:51");
    expect(out).toContain("Rate-limited until 16:40");
    expect(out).not.toContain("Queue empty");
  });
});

describe("project chip", () => {
  test("the strip names the repo, the Linear workspace, and the base branch", () => {
    const out = String(renderStrip(strip(), NOW, PROJECT));
    expect(out).toContain("<strong>tic-tac-toe</strong>");
    expect(out).toContain("Linear tictactoe1514");
    expect(out).toContain("PRs into main");
  });

  test("it escapes the names", () => {
    const out = String(renderStrip(strip(), NOW, { ...PROJECT, repo: "<b>x</b>" }));
    expect(out).toContain("&lt;b&gt;x&lt;/b&gt;");
  });
});

describe("renderHelp", () => {
  test("every Linux check runs over SSH, with this repo's config", () => {
    const cmds = helpCommands(HELP).map((c) => c.command);
    expect(cmds[0]).toBe(
      "ssh -i ~/.ssh/key ubuntu@203.0.113.7 'systemctl --user is-active marshall'",
    );
    expect(cmds[1]).toContain("MARSHALL_CONFIG=marshall.tictactoe.config.json bin/marshall status");
    expect(cmds[1]).toContain("cd ~/code/Marshall");
  });

  test("without an ssh command the checks run on this machine", () => {
    const cmds = helpCommands({ ...HELP, sshCommand: undefined }).map((c) => c.command);
    expect(cmds[0]).toBe("systemctl --user is-active marshall");
  });

  test("a custom MARSHALL_HOME reaches the status command", () => {
    const status = helpCommands({ ...HELP, marshallHome: "~/.marshall-x" })[1]?.command;
    expect(status).toContain("MARSHALL_HOME=~/.marshall-x");
  });

  test("macOS gets launchd-free commands", () => {
    const cmds = helpCommands({ ...HELP, platform: "darwin", sshCommand: undefined });
    expect(cmds.some((c) => c.command.includes("systemctl"))).toBe(false);
    expect(cmds[0]?.command).toContain("bin/marshall status");
  });

  test("the panel is a script-free <details> in the page header", () => {
    const out = String(renderHelp(HELP));
    expect(out.startsWith("<details")).toBe(true);
    expect(out).not.toMatch(/<script|onclick=/);
    const page = renderPage(
      renderSections(
        { kind: "no_db", problem: "missing", daemonRunning: false, now: "n" },
        PROJECT,
      ),
      "n",
      renderHelp(HELP),
    );
    expect(page).toMatch(/<div class="brand">Marshall[\s\S]*?<details class="help">/);
  });
});

describe("renderAgents", () => {
  test("a busy panel, an idle slot, and the Kill button", () => {
    const out = String(
      renderAgents([
        { slot: 0, agent: agent() },
        { slot: 2, agent: null },
      ]),
    );
    expect(out).toContain('Agents <span class="count">1</span>');
    expect(out).toContain("Slot 1");
    expect(out).toContain("Implementing · review cycle 2/4");
    expect(out).toContain("1h 05m");
    expect(out).toContain("33.6k");
    expect(out).toContain("plan committed");
    expect(out).toContain('data-kill="TOD-17"');
    expect(out).toContain("Slot 3</span> · idle");
  });

  test("needs-you flag, kill requested, and no Kill on a resolver", () => {
    const flagged = String(
      renderAgents([{ slot: 0, agent: agent({ needsYou: "waiting on input" }) }]),
    );
    expect(flagged).toContain("panel-flag");
    expect(flagged).toContain("Needs you: waiting on input");
    const requested = String(renderAgents([{ slot: 0, agent: agent({ killRequested: true }) }]));
    expect(requested).toContain("Kill requested");
    expect(requested).not.toContain("data-kill=");
    const resolver = agent({ state: "resolving", phase: "Resolving conflicts", killable: false });
    const out = String(renderAgents([{ slot: 1, agent: resolver }]));
    expect(out).not.toContain("data-kill=");
    expect(out).toContain("marshall stop");
  });
});

describe("renderNeedsYou", () => {
  test("empty state", () => {
    const out = String(renderNeedsYou({ cards: [], checkedAgainstLinear: true }, NOW, null));
    expect(out).toContain("Nothing needs you.");
    expect(out).not.toContain("Not checked");
  });

  test("an awaiting card: TLDR rendered safely, round badge, PR link, lazy hand-off", () => {
    const c = card({ tldr: "The **timer** works. <script>x</script>", round: 2, hasHandoff: true });
    const out = String(renderNeedsYou({ cards: [c], checkedAgainstLinear: true }, NOW, null));
    expect(out).toContain("Needs Verification");
    expect(out).toContain("<strong>timer</strong>");
    expect(out).not.toContain("<script>");
    expect(out).toContain("Round 2");
    expect(out).toContain("PR #26");
    expect(out).toContain('<details data-handoff="TOD-12">');
    expect(out).toContain("Show hand-off");
    expect(out).toContain("3 h");
  });

  test("a blocked card shows its reason; a rebasing card says it waits on CI", () => {
    const blocked = card({
      state: "blocked",
      blockReason: "Stopped on request (Kill).",
      prUrl: null,
    });
    const rebasing = card({ identifier: "TOD-13", state: "rebasing" });
    const out = String(
      renderNeedsYou({ cards: [blocked, rebasing], checkedAgainstLinear: false }, NOW, "timeout"),
    );
    expect(out).toContain("Stopped on request (Kill).");
    const md = card({
      state: "blocked",
      blockReason: "`AlarmTests` timed out. <script>x</script>",
    });
    const rendered = String(renderNeedsYou({ cards: [md], checkedAgainstLinear: true }, NOW, null));
    expect(rendered).toContain("<code>AlarmTests</code>");
    expect(rendered).not.toContain("<script>");
    expect(out).toContain("waiting on CI");
    expect(out).toContain("Not checked against Linear (timeout)");
    expect(out).not.toContain("<details");
  });
});

describe("renderQueue", () => {
  test("every status code has a label; next start names the slot; window cap says when", () => {
    const statuses: QueueStatus[] = [
      "next_start",
      "slots_full",
      "daily_cap",
      "window_cap",
      "paused",
      "rate_limited",
      "live",
      "bounce_limit",
      "human_only",
    ];
    const rows = statuses.map((status, i) =>
      queueRow({ identifier: `TOD-${i}`, status, slot: status === "next_start" ? 1 : null }),
    );
    rows.push(queueRow({ identifier: "TOD-99", kind: "bounce", bounces: 1, status: "slots_full" }));
    const freesAt = new Date(2026, 9, 3, 16, 40).toISOString();
    const out = String(
      renderQueue({ report: queueReport(rows, freesAt), fetchedAt: null, error: null }, "w", NOW),
    );
    for (const label of [
      "next start · slot 2",
      "slots full",
      "daily cap",
      "window cap · frees 16:40",
      "paused",
      "rate-limited",
      "live",
      "bounce limit",
      "human only",
      "bounce #2",
    ]) {
      expect(out).toContain(label);
    }
    expect(out).toContain('href="https://linear.app/w/issue/TOD-0"');
  });

  test("empty, error with no list, and error with the last good list", () => {
    const empty = String(
      renderQueue({ report: queueReport([]), fetchedAt: null, error: null }, "w", NOW),
    );
    expect(empty).toContain("Nothing pickable.");
    const none = String(
      renderQueue(
        { report: null, fetchedAt: null, error: "MARSHALL_LINEAR_API_KEY is not set" },
        "w",
        NOW,
      ),
    );
    expect(none).toContain("Linear: MARSHALL_LINEAR_API_KEY is not set.");
    const stale = String(
      renderQueue(
        {
          report: queueReport([queueRow()]),
          fetchedAt: new Date(2026, 9, 3, 13, 58).toISOString(),
          error: "fetch failed",
        },
        "w",
        NOW,
      ),
    );
    expect(stale).toContain("Linear: fetch failed. Showing the list from 13:58.");
    expect(stale).toContain("TOD-20");
  });
});

describe("page", () => {
  test("the shell has no inline script or style, and one hash per section", () => {
    const view = {
      kind: "ok" as const,
      data: {
        now: NOW.toISOString(),
        strip: strip(),
        agents: [{ slot: 0, agent: agent() }],
        needsYou: { cards: [card()], checkedAgainstLinear: true },
        queue: { report: queueReport([queueRow()]), fetchedAt: null, error: null },
      },
    };
    const sections = renderSections(view, PROJECT);
    const page = renderPage(sections, NOW.toISOString(), renderHelp(HELP));
    expect(page.startsWith("<!doctype html>")).toBe(true);
    expect(page).toContain('<script src="/assets/dashboard.js" defer></script>');
    expect(page).not.toMatch(/<script>|<style|style="|onclick=/);
    const hashes = sectionHashes(sections);
    for (const name of ["strip", "needsYou", "agents", "queue"] as const) {
      expect(page).toContain(`id="s-${name}"`);
      expect(page).toContain(`data-hash="${hashes[name]}"`);
    }
  });

  test("a missing or outdated DB says to start the daemon", () => {
    const missing = renderSections(
      { kind: "no_db", problem: "missing", daemonRunning: false, now: NOW.toISOString() },
      PROJECT,
    );
    expect(missing.needsYou).toContain("Start the daemon once");
    expect(missing.strip).toContain("Database not ready");
    const outdated = renderSections(
      { kind: "no_db", problem: "outdated", daemonRunning: true, now: NOW.toISOString() },
      PROJECT,
    );
    expect(outdated.needsYou).toContain("older than this code");
  });
});
