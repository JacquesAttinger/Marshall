// Last edited: 2026-10-11 21:15 PDT
// The "Add project" panel. Three moves: "Check key" (POST /projects/validate-key, shows the
// workspace and a team picker), "Create project" (POST /projects, shows one line per step), and
// close. The key lives only in its password field: it is cleared the moment Create is pressed and
// when the panel closes, and nothing is stored in the page. Results are written with textContent.

const dialog = document.getElementById("addp");

if (dialog) {
  const $ = (id) => document.getElementById(id);
  const form = $("addp-form");
  const keyInput = $("addp-key");
  const createBtn = $("addp-create");
  const checkBtn = $("addp-check");
  const keyResult = $("addp-key-result");
  const stepsEl = $("addp-steps");
  const summary = $("addp-summary");
  const switchBox = $("addp-switch");
  const switchMsg = switchBox.querySelector("[data-switch-msg]");
  let teamId = null;
  let busy = false;

  const post = async (url, body) => {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({ ok: false, message: "Unexpected reply." }));
    return { status: res.status, data };
  };

  /** Create needs a checked team and a key in the field (it is cleared after every Create). */
  const sync = () => {
    createBtn.disabled = busy || !teamId || keyInput.value.length === 0;
  };

  /** `kind` is "bad", "ok", or nothing. */
  const say = (el, text, kind) => {
    el.textContent = text;
    el.classList.toggle("bad", kind === "bad");
    el.classList.toggle("addp-ok", kind === "ok");
  };

  function reset() {
    keyInput.value = "";
    teamId = null;
    sync();
    keyResult.replaceChildren();
    stepsEl.replaceChildren();
    say(summary, "");
    switchBox.hidden = true;
    say(switchMsg, "");
  }

  function showTeams(workspace, teams) {
    const line = document.createElement("p");
    line.className = "addp-ok";
    line.textContent = `Workspace: ${workspace}`;
    keyResult.replaceChildren(line);
    teamId = teams.length === 1 ? teams[0].id : null;
    if (teams.length === 1) {
      const only = document.createElement("p");
      only.textContent = `Team: ${teams[0].name} (${teams[0].key})`;
      keyResult.append(only);
    } else {
      const label = document.createElement("label");
      label.className = "addp-field";
      label.textContent = "Team";
      const select = document.createElement("select");
      select.id = "addp-team";
      select.add(new Option("Choose a team", ""));
      for (const t of teams) select.add(new Option(`${t.name} (${t.key})`, t.id));
      select.addEventListener("change", () => {
        teamId = select.value || null;
        sync();
      });
      label.append(select);
      keyResult.append(label);
    }
    sync();
  }

  async function checkKey() {
    if (busy) return;
    busy = true;
    checkBtn.disabled = true;
    teamId = null;
    sync();
    say(keyResult, "Checking…");
    try {
      const { data } = await post("/projects/validate-key", { key: keyInput.value });
      if (data.ok) showTeams(data.workspace, data.teams);
      else say(keyResult, data.message || "That key did not work.", "bad");
    } catch {
      say(keyResult, "Could not reach the dashboard.", "bad");
    }
    busy = false;
    checkBtn.disabled = false;
    sync();
  }

  function renderSteps(result) {
    stepsEl.replaceChildren();
    for (const s of result.steps || []) {
      const li = document.createElement("li");
      li.className = s.ok ? "addp-step ok" : "addp-step bad";
      const title = document.createElement("strong");
      title.textContent = `${s.ok ? "Done" : "Failed"}: ${s.step}`;
      const detail = document.createElement("span");
      detail.textContent = s.detail;
      li.append(title, detail);
      stepsEl.append(li);
    }
  }

  /** Success text, and for a project that is not active, a Switch button the dashboard's own switch code drives. */
  function showDone(data, name) {
    if (data.active) {
      say(summary, "Project added. It is the active project. Restart Marshall and the dashboard to use it.", "ok");
    } else if (data.canSwitch) {
      say(summary, "Project added.", "ok");
      $("addp-switch-text").textContent = `Switch to ${name} now? Marshall and the dashboard restart. Refused while agents are working.`;
      switchBox.querySelector("button").dataset.switch = data.slug;
      switchBox.hidden = false;
    } else {
      say(summary, "Project added, not active. Switch to it from the project menu after reloading this page.", "ok");
    }
  }

  function repoChoice() {
    const mode = form.elements["repo-mode"].value;
    return mode === "new"
      ? { mode, name: $("addp-repo-new").value.trim() }
      : { mode, url: $("addp-repo-existing").value.trim() };
  }

  async function create(event) {
    event.preventDefault();
    if (busy || !teamId || keyInput.value.length === 0) return;
    const body = {
      name: $("addp-name").value.trim(),
      linearApiKey: keyInput.value,
      teamId,
      repo: repoChoice(),
    };
    keyInput.value = "";
    busy = true;
    sync();
    stepsEl.replaceChildren();
    say(summary, "Working… this can take a minute.");
    try {
      const { data } = await post("/projects", body);
      if (data.steps) renderSteps(data);
      if (data.ok) {
        showDone(data, body.name);
      } else {
        const retry = "Paste the key again and press Create to retry; finished steps are skipped.";
        say(
          summary,
          `${data.message || "A step failed."} ${data.steps ? retry : ""}`.trim(),
          "bad",
        );
      }
    } catch {
      say(summary, "Could not reach the dashboard.", "bad");
    }
    busy = false;
    sync();
  }

  function syncRepoMode() {
    const isNew = form.elements["repo-mode"].value === "new";
    $("addp-new-wrap").hidden = !isNew;
    $("addp-existing-wrap").hidden = isNew;
  }

  document.addEventListener("click", (event) => {
    if (event.target.closest("[data-addp-open]")) {
      reset();
      dialog.showModal();
    } else if (event.target.closest("[data-addp-close]")) {
      dialog.close();
    }
  });
  dialog.addEventListener("close", reset);
  checkBtn.addEventListener("click", checkKey);
  form.addEventListener("submit", create);
  form.addEventListener("change", syncRepoMode);
  keyInput.addEventListener("input", sync);
}
