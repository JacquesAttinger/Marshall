// Last edited: 2026-10-11 20:30 PDT
// The project menu in the header: a <details> (no script needed to open it, and the 5 s section
// swap never touches it) that lists the registered projects. A "Switch" button on each other
// project is armed by the first tap and sent by the second, like Kill (assets/dashboard.js).

import { html, type SafeHtml } from "../html.ts";

export interface ProjectMenuEntry {
  slug: string;
  name: string;
  /** The Linear workspace in the project's config, or null when it cannot be read. */
  workspace: string | null;
}

export interface ProjectMenuInfo {
  projects: ProjectMenuEntry[];
  /** Slug of the active project, or null when none is. */
  active: string | null;
  /** False when this dashboard cannot switch (started with a fixed MARSHALL_CONFIG). */
  canSwitch: boolean;
}

function row(entry: ProjectMenuEntry, info: ProjectMenuInfo): SafeHtml {
  const isActive = entry.slug === info.active;
  const detail = [entry.workspace ? `Linear ${entry.workspace}` : "config unreadable", entry.slug];
  const control = isActive
    ? html`<span class="pill pill-ok">Active</span>`
    : info.canSwitch &&
      html`<button class="switch" type="button" data-switch="${entry.slug}">Switch</button>`;
  return html`<li class="project-row"><div class="project-row-main"><strong>${entry.name}</strong><span class="help-note">${detail.join(" · ")}</span></div>${control}</li>`;
}

export function renderProjectMenu(info: ProjectMenuInfo): SafeHtml {
  if (info.projects.length === 0) return html``;
  const active = info.projects.find((p) => p.slug === info.active);
  const pinned =
    !info.canSwitch &&
    html`<p class="note">This dashboard is fixed to one config by <code>MARSHALL_CONFIG</code>, so it cannot switch. See docs/runbook.md.</p>`;
  return html`<details class="project-menu"><summary class="project-menu-btn" aria-label="Projects" title="Projects">${active?.name ?? "No project"}</summary>
<div class="project-menu-body">
<p class="help-title">Projects</p>
<ul class="project-list">${info.projects.map((entry) => row(entry, info))}</ul>
${pinned}<p class="note switch-msg" data-switch-msg role="status"></p>
</div>
</details>`;
}
