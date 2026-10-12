// Last edited: 2026-10-11 20:30 PDT
// The dashboard's only script. Every 5 s it fetches /sections and swaps the sections whose hash
// changed, keeping what the person was doing: open hand-offs stay open (and are not fetched
// again), the scroll position holds, and an armed Kill button stays armed across the swap.
// Polling pauses while the tab is hidden. The project menu's Switch button works like Kill (tap,
// tap again), then waits for the restarted dashboard and reloads. No inline script or style: the
// CSP forbids both.

const POLL_MS = 5000;
const ARM_MS = 4000;
const MESSAGE_MS = 15000;

/** Identifier → timeout id, for Kill buttons tapped once. Lives here, not in the DOM. */
const armed = new Map();
/** Identifier → { text, ok, until }, so a kill result survives the next swap. */
const messages = new Map();
/** Project slug → timeout id, for Switch buttons tapped once. */
const armedSwitch = new Map();
/** Identifier → hand-off HTML already fetched. */
const handoffs = new Map();
/** Identifiers whose hand-off is open. */
const open = new Set();

let lastOk = Date.now();
let lost = false;
let timer = null;
let switching = false;

function $(selector, root = document) {
  return root.querySelector(selector);
}

function renderUpdated() {
  const el = $("#updated");
  if (!el) return;
  const s = Math.max(0, Math.round((Date.now() - lastOk) / 1000));
  const ago = s < 5 ? "just now" : s < 60 ? `${s} s ago` : `${Math.round(s / 60)} min ago`;
  el.textContent = lost ? `Connection lost · updated ${ago}` : `Updated ${ago}`;
  el.classList.toggle("lost", lost);
}

function applyKillState(root) {
  for (const button of root.querySelectorAll("button[data-kill]")) {
    const id = button.dataset.kill;
    const isArmed = armed.has(id);
    button.classList.toggle("armed", isArmed);
    button.textContent = isArmed ? `Tap again to kill ${id}` : "Kill";
  }
  for (const span of root.querySelectorAll("[data-kill-msg]")) {
    const msg = messages.get(span.dataset.killMsg);
    if (msg && msg.until > Date.now()) {
      span.textContent = msg.text;
      span.classList.toggle("bad", !msg.ok);
    }
  }
}

function applyHandoffState(root) {
  for (const details of root.querySelectorAll("details[data-handoff]")) {
    const id = details.dataset.handoff;
    if (handoffs.has(id)) {
      const body = $("[data-handoff-body]", details);
      if (body) body.innerHTML = handoffs.get(id);
    }
    if (open.has(id)) details.open = true;
  }
}

function swap(name, html, hash) {
  const el = document.getElementById(`s-${name}`);
  if (!el || el.dataset.hash === hash) return;
  el.innerHTML = html;
  el.dataset.hash = hash;
  applyHandoffState(el);
  applyKillState(el);
}

async function refresh() {
  try {
    const res = await fetch("/sections", { cache: "no-store" });
    if (!res.ok) throw new Error(String(res.status));
    const body = await res.json();
    const { scrollX, scrollY } = window;
    for (const name of Object.keys(body.sections)) {
      swap(name, body.sections[name], body.hashes[name]);
    }
    window.scrollTo(scrollX, scrollY);
    lastOk = Date.now();
    lost = false;
  } catch {
    lost = true;
  }
  renderUpdated();
}

function schedule() {
  clearTimeout(timer);
  if (document.hidden) return;
  timer = setTimeout(async () => {
    await refresh();
    schedule();
  }, POLL_MS);
}

async function loadHandoff(details) {
  const id = details.dataset.handoff;
  if (handoffs.has(id)) return;
  const body = $("[data-handoff-body]", details);
  try {
    const res = await fetch(`/handoff/${encodeURIComponent(id)}`, { cache: "no-store" });
    const html = res.ok ? await res.text() : '<p class="muted">No hand-off file found.</p>';
    if (res.ok) handoffs.set(id, html);
    if (body) body.innerHTML = html;
  } catch {
    if (body) body.textContent = "Could not load the hand-off.";
  }
}

function disarm(id) {
  clearTimeout(armed.get(id));
  armed.delete(id);
  applyKillState(document);
}

async function kill(id) {
  disarm(id);
  messages.set(id, { text: "Killing…", ok: true, until: Date.now() + MESSAGE_MS });
  applyKillState(document);
  let result;
  try {
    const res = await fetch(`/kill/${encodeURIComponent(id)}`, { method: "POST" });
    result = await res.json();
  } catch {
    result = { ok: false, message: "Could not reach the dashboard." };
  }
  messages.set(id, { text: result.message, ok: result.ok, until: Date.now() + MESSAGE_MS });
  applyKillState(document);
  refresh();
}

function applySwitchState() {
  for (const button of document.querySelectorAll("button[data-switch]")) {
    const isArmed = armedSwitch.has(button.dataset.switch);
    button.classList.toggle("armed", isArmed);
    button.disabled = switching;
    button.textContent = isArmed ? "Tap again to switch" : "Switch";
  }
}

function switchMessage(text, ok) {
  const el = $("[data-switch-msg]");
  if (!el) return;
  el.textContent = text;
  el.classList.toggle("bad", !ok);
}

/** The dashboard exits right after it replies. Wait for the new one to answer, then reload. */
async function reloadWhenBack() {
  await new Promise((resolve) => setTimeout(resolve, 2000));
  for (let tries = 0; tries < 60; tries++) {
    try {
      const res = await fetch("/sections", { cache: "no-store" });
      if (res.ok) {
        location.reload();
        return;
      }
    } catch {
      // Still down. Try again.
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  switching = false;
  applySwitchState();
  switchMessage("The dashboard did not come back. Reload this page in a minute.", false);
}

async function switchProject(slug) {
  clearTimeout(armedSwitch.get(slug));
  armedSwitch.delete(slug);
  switching = true;
  applySwitchState();
  switchMessage("Switching…", true);
  let result;
  try {
    const res = await fetch(`/project/switch/${encodeURIComponent(slug)}`, { method: "POST" });
    result = await res.json();
  } catch {
    result = { ok: false, message: "Could not reach the dashboard." };
  }
  switchMessage(result.message, result.ok);
  if (result.restarting) {
    reloadWhenBack();
    return;
  }
  switching = false;
  applySwitchState();
}

function onSwitchClick(button) {
  const slug = button.dataset.switch;
  if (switching) return;
  if (armedSwitch.has(slug)) {
    switchProject(slug);
    return;
  }
  armedSwitch.set(
    slug,
    setTimeout(() => {
      armedSwitch.delete(slug);
      applySwitchState();
    }, ARM_MS),
  );
  applySwitchState();
}

document.addEventListener("click", (event) => {
  const switchButton = event.target.closest("button[data-switch]");
  if (switchButton) {
    onSwitchClick(switchButton);
    return;
  }
  const button = event.target.closest("button[data-kill]");
  if (!button) return;
  const id = button.dataset.kill;
  if (armed.has(id)) {
    kill(id);
    return;
  }
  armed.set(
    id,
    setTimeout(() => disarm(id), ARM_MS),
  );
  applyKillState(document);
});

// `toggle` does not bubble, so listen in the capture phase.
document.addEventListener(
  "toggle",
  (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement)) return;
    if (details.open && details.matches(".help, .project-menu")) {
      // The two header panels share the same spot: opening one closes the other.
      for (const other of document.querySelectorAll(".help[open], .project-menu[open]")) {
        if (other !== details) other.open = false;
      }
    }
    if (!details.dataset.handoff) return;
    if (details.open) {
      open.add(details.dataset.handoff);
      loadHandoff(details);
    } else {
      open.delete(details.dataset.handoff);
    }
  },
  true,
);

document.addEventListener("visibilitychange", () => {
  if (document.hidden) {
    clearTimeout(timer);
    return;
  }
  refresh().then(schedule);
});

setInterval(renderUpdated, 1000);
schedule();
