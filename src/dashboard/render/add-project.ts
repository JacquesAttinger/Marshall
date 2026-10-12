// Last edited: 2026-10-11 21:15 PDT
// The "Add project" button and its panel (a native <dialog>, opened by assets/add-project.js).
// Static markup only: every dynamic bit (workspace, teams, step results) is filled in by the
// script with textContent, never innerHTML. Built with the `html` template like every renderer.

import { html, type SafeHtml } from "../html.ts";

export function renderAddProject(): SafeHtml {
  return html`<button type="button" class="addp-open" data-addp-open>Add project</button>
<dialog id="addp" class="addp" aria-labelledby="addp-title">
<form id="addp-form" class="addp-form" autocomplete="off" novalidate>
<div class="addp-head">
<h2 id="addp-title" class="addp-title">Add a project</h2>
<button type="button" class="addp-close" data-addp-close aria-label="Close">&times;</button>
</div>
<p class="note addp-note">Do these two things in Linear first. Marshall cannot do them for you:
<br>1. Create a workspace for the project.
<br>2. Create a personal API key: <strong>Settings &rarr; Account &rarr; Security &amp; access &rarr; Personal API keys &rarr; New key</strong>.</p>
<label class="addp-field">Project name
<input id="addp-name" name="project-name" type="text" maxlength="60" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Tic Tac Toe">
</label>
<label class="addp-field">Linear API key
<input id="addp-key" name="linear-key" type="password" autocomplete="off" autocapitalize="off" spellcheck="false" required placeholder="lin_api_...">
</label>
<button type="button" class="addp-btn" id="addp-check">Check key</button>
<div id="addp-key-result" class="addp-result" role="status" aria-live="polite"></div>
<fieldset class="addp-field addp-repo">
<legend>Repo</legend>
<label class="addp-radio"><input type="radio" name="repo-mode" value="new" checked> Create a new private GitHub repo</label>
<label class="addp-radio"><input type="radio" name="repo-mode" value="existing"> Use an existing repo</label>
<label class="addp-field" id="addp-new-wrap">Repo name <span class="addp-hint">(blank: same as the project id)</span>
<input id="addp-repo-new" name="repo-new" type="text" maxlength="100" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="tic-tac-toe">
</label>
<label class="addp-field" id="addp-existing-wrap" hidden>owner/name or GitHub address
<input id="addp-repo-existing" name="repo-existing" type="text" maxlength="200" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="JacquesAttinger/tic-tac-toe">
</label>
</fieldset>
<button type="submit" class="addp-btn addp-primary" id="addp-create" disabled>Create project</button>
<ol id="addp-steps" class="addp-steps" aria-live="polite"></ol>
<p id="addp-summary" class="addp-summary" role="status"></p>
<div id="addp-switch" class="addp-switch" hidden>
<p id="addp-switch-text" class="addp-switch-text"></p>
<button type="button" class="switch">Switch</button>
<p class="note switch-msg" data-switch-msg role="status"></p>
</div>
</form>
</dialog>`;
}
