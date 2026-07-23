/* Registry Ops Console — no-build-step SPA. Polls the ops API for live state. */
"use strict";

const $ = (sel, el = document) => el.querySelector(sel);
const view = $("#view");
const drawer = $("#drawer");
let pollTimers = [];

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data;
}

function toast(msg, isError = false) {
  const el = document.createElement("div");
  el.className = "toast";
  if (isError) el.style.borderColor = "var(--critical)";
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), 2600);
}

const operator = () => $("#operator").value.trim() || "operator";
$("#operator").value = localStorage.getItem("operator") || "";
$("#operator").addEventListener("change", (e) => localStorage.setItem("operator", e.target.value));

const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "—");
const fmtReq = (t) => (t ? t.replace("T", " ").slice(0, 16) : "—");
const chip = (state, extra = "") => `<span class="chip ${esc(state)} ${extra}">${esc(String(state).replace(/_/g, " "))}</span>`;

function slaCell(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  const abs = Math.abs(ms);
  const mins = Math.floor(abs / 60000);
  const txt = `${ms < 0 ? "-" : ""}${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, "0")}m`;
  const cls = ms < 0 ? "breach" : ms < 10 * 60000 ? "tight" : "";
  return `<span class="sla ${cls}">${txt}</span>`;
}

function clearPolls() {
  pollTimers.forEach(clearInterval);
  pollTimers = [];
}
function poll(fn, ms) {
  fn();
  pollTimers.push(setInterval(fn, ms));
}

/* ---------------- router ---------------- */
const routes = { overview, queue, bookings, merchants, verification, complaints, analytics };

function navigate() {
  clearPolls();
  closeDrawer();
  const name = (location.hash || "#/overview").split("/")[1].split("?")[0];
  document.querySelectorAll(".sidebar a").forEach((a) => a.classList.toggle("active", a.dataset.view === name));
  (routes[name] || overview)();
}
window.addEventListener("hashchange", navigate);

function closeDrawer() {
  drawer.hidden = true;
  drawer.innerHTML = "";
}
function openDrawer(html) {
  drawer.hidden = false;
  drawer.innerHTML = `<button class="drawer-close" onclick="this.parentElement.hidden=true">✕</button>` + html;
}

/* nav badges + city line, refreshed globally */
async function refreshBadges() {
  try {
    const o = await api("/ops/api/overview");
    $("#badge-queue").textContent = o.queue.queued + o.queue.in_progress + o.queue.needs_input || "";
    $("#badge-verification").textContent = o.verification_due || "";
    $("#badge-complaints").textContent = o.open_complaints || "";
    $("#cityline").textContent = `${o.meta.city} · ${o.meta.merchant_count} merchants`;
  } catch {}
}
setInterval(refreshBadges, 5000);

/* ---------------- Overview ---------------- */
async function overview() {
  poll(async () => {
    const o = await api("/ops/api/overview");
    const m = o.meta;
    view.innerHTML = `
      <h1>Overview</h1>
      <p class="sub">${esc(m.city)} · schema ${esc(m.schema_version)} · availability model: ${esc(m.availability_check)}</p>
      <div class="tiles">
        <div class="tile"><div class="k">Merchants</div><div class="v">${m.merchant_count}</div><div class="d">${m.opted_out} opted out</div></div>
        <div class="tile"><div class="k">Bookable now</div><div class="v">${m.bookable_count}</div><div class="d">phone-verified · accepts reservations</div></div>
        <div class="tile ${m.freshness.verified_within_policy_pct >= 95 ? "ok" : "warn"}"><div class="k">Freshness (≤${m.freshness.policy_days}d)</div><div class="v">${m.freshness.verified_within_policy_pct}<span class="unit">%</span></div><div class="d">target ≥ 95% · ${o.verification_due} due for re-verification</div></div>
        <div class="tile"><div class="k">Queue</div><div class="v">${o.queue.queued + o.queue.in_progress}</div><div class="d">${o.queue.in_progress} on calls · ${o.queue.human_queue} awaiting human</div></div>
        <div class="tile ${o.queue.needs_input ? "warn" : ""}"><div class="k">Needs input</div><div class="v">${o.queue.needs_input}</div><div class="d">waiting on agent decision</div></div>
        <div class="tile"><div class="k">Bookings confirmed</div><div class="v">${m.bookings.confirmed}</div><div class="d">of ${m.bookings.total} total</div></div>
        <div class="tile"><div class="k">Feedback events</div><div class="v">${m.feedback_events}</div><div class="d">transaction-verified corpus</div></div>
        <div class="tile ${o.open_complaints ? "bad" : "ok"}"><div class="k">Open complaints</div><div class="v">${o.open_complaints}</div><div class="d">same-day SLA</div></div>
      </div>
      <h2>Simulate agent traffic</h2>
      <div class="card">
        <p class="note">Places a booking exactly as an agent would via <span class="mono">place_booking</span> — random bookable merchant, random near-future time. Watch it move through the state machine in the Queue tab.</p>
        <div class="actions">
          <button class="primary" id="demo1">Place 1 demo booking</button>
          <button id="demo5">Place 5</button>
          <button id="demoHuman">Place 1 for a human-call merchant</button>
        </div>
      </div>`;
    $("#demo1").onclick = () => demoBook(1);
    $("#demo5").onclick = () => demoBook(5);
    $("#demoHuman").onclick = () => demoBook(1, "human_call");
  }, 5000);
  refreshBadges();
}

async function demoBook(n, channel) {
  for (let i = 0; i < n; i++) {
    try {
      const r = await api("/ops/api/demo/place-booking", { method: "POST", body: channel ? { channel } : {} });
      if (!r.ok) throw new Error(r.error);
    } catch (e) {
      return toast(String(e.message || e), true);
    }
  }
  toast(`${n} booking${n > 1 ? "s" : ""} placed — see Queue`);
  refreshBadges();
}

/* ---------------- Queue ---------------- */
async function queue() {
  poll(async () => {
    const rows = await api("/ops/api/queue");
    view.innerHTML = `
      <h1>Fulfillment queue</h1>
      <p class="sub">Active bookings ordered by SLA deadline. Every booking must reach a terminal state within the SLA (REQ-FUL-6).</p>
      ${rows.length === 0 ? `<div class="empty">Queue is clear. Place a demo booking from Overview to see the loop run.</div>` : `
      <div class="tablewrap"><table>
        <thead><tr><th>State</th><th>Merchant</th><th>Request</th><th>Channel</th><th class="num">Attempt</th><th class="num">SLA</th><th></th></tr></thead>
        <tbody>
          ${rows.map((b) => `
            <tr class="rowlink" data-id="${esc(b.booking_id)}">
              <td>${chip(b.state, b.state === "in_progress" ? "live" : "")}</td>
              <td>${esc(b.merchant_name)}<div class="note">${esc(b.neighborhood)} · ${esc(b.phone_primary || "")}</div></td>
              <td>${esc(fmtReq(b.requested_time))} · party ${b.party_size}<div class="note">${esc(b.reservation_name)}${b.window_minutes ? ` · ±${b.window_minutes}m${b.accept_within_window ? " auto-accept" : ""}` : ""}</div></td>
              <td>${esc(b.fulfillment_channel)}${b.current_call && !b.current_call.ended_at ? `<div class="note">${b.current_call.taken_over ? "human has the call" : "voice agent live"}</div>` : ""}</td>
              <td class="num">${b.attempts}/3</td>
              <td class="num">${slaCell(b.sla_deadline)}</td>
              <td><button class="small">Open</button></td>
            </tr>`).join("")}
        </tbody>
      </table></div>`}`;
    view.querySelectorAll("tr.rowlink").forEach((tr) => (tr.onclick = () => bookingDrawer(tr.dataset.id, true)));
  }, 2500);
}

/* ---------------- Booking drawer (live monitor + operator actions) ---------------- */
let drawerBookingId = null;

async function bookingDrawer(id, live = false) {
  drawerBookingId = id;
  const render = async () => {
    if (drawerBookingId !== id || (drawer.hidden === false && !drawer.dataset.booking) === undefined) return;
    const b = await api(`/ops/api/bookings/${id}`);
    const call = b.calls[b.calls.length - 1];
    const isLive = call && !call.ended_at;
    const formState = saveFormState();

    openDrawer(`
      <h3>${esc(b.merchant.name)}</h3>
      <p class="sub">${chip(b.state, b.state === "in_progress" ? "live" : "")} &nbsp; booking <span class="mono">${esc(id.slice(0, 8))}</span>${b.failure_reason ? ` · ${esc(b.failure_reason)}` : ""}</p>
      <div class="kv">
        <div class="k">Requested</div><div>${esc(fmtReq(b.requested_time))} · party ${b.party_size} · ±${b.window_minutes}m ${b.accept_within_window ? "(auto-accept)" : ""}</div>
        <div class="k">Name</div><div>${esc(b.reservation_name)}</div>
        ${b.special_requests ? `<div class="k">Requests</div><div>${esc(b.special_requests)}</div>` : ""}
        ${b.confirmed_time ? `<div class="k">Confirmed</div><div>${esc(fmtReq(b.confirmed_time))} · code <strong>${esc(b.confirmation_code)}</strong></div>` : ""}
        ${b.merchant_instructions ? `<div class="k">Instructions</div><div>${esc(b.merchant_instructions)}</div>` : ""}
        ${b.needs_input_options ? `<div class="k">Options offered</div><div>${b.needs_input_options.map((o) => `<div class="pill">${esc(o.time)}</div>`).join(" ")}<div class="note">agent must resolve via modify_booking · deadline ${esc(fmtTime(b.needs_input_deadline))}</div></div>` : ""}
        <div class="k">SLA deadline</div><div>${slaCell(b.sla_deadline)}</div>
        <div class="k">Status page</div><div><a class="mono" style="color:var(--accent)" href="/status/${esc(id)}" target="_blank">/status/${esc(id.slice(0, 8))}…</a></div>
      </div>

      ${call ? `
        <h2>Call · attempt ${call.attempt_no} · ${esc(call.channel)}${call.operator ? ` · ${esc(call.operator)}` : ""}${call.outcome ? ` · ${esc(call.outcome)}` : isLive ? " · LIVE" : ""}</h2>
        <div class="transcript" id="transcript">
          ${call.transcript.map((l) => `<div class="tline ${esc(l.speaker)}"><span class="speaker">${esc(l.speaker.replace("_", " "))}</span><span class="text">${esc(l.text)}</span></div>`).join("") || `<span class="note">Dialing…</span>`}
        </div>` : ""}

      <div class="actions">
        ${b.state === "queued" && b.merchant.fulfillment_channel === "human_call" ? `<button class="primary" id="claimBtn">Claim call (dial merchant)</button>` : ""}
        ${isLive && !call.taken_over && call.channel === "voice_agent" ? `<button class="danger" id="takeoverBtn">Take over call</button>` : ""}
      </div>

      ${isLive && (call.taken_over || call.channel === "human_call") ? resolveFormHtml(b) : ""}

      <h2>Event log</h2>
      <div class="events">
        ${b.events.map((e) => `
          <div class="ev"><span class="at">${esc(fmtTime(e.at))}</span>
          <div>${esc(e.event)}${e.from_state ? `: ${esc(e.from_state)} → ${esc(e.to_state)}` : ""}${e.detail ? `<pre>${esc(e.detail)}</pre>` : ""}</div></div>`).join("")}
      </div>`);

    restoreFormState(formState);
    const t = $("#transcript");
    if (t) t.scrollTop = t.scrollHeight;

    if ($("#claimBtn"))
      $("#claimBtn").onclick = async () => {
        try {
          await api(`/ops/api/bookings/${id}/claim`, { method: "POST", body: { operator: operator() } });
          toast("Call claimed — record the outcome when done");
          render();
        } catch (e) { toast(e.message, true); }
      };
    if ($("#takeoverBtn"))
      $("#takeoverBtn").onclick = async () => {
        try {
          await api(`/ops/api/calls/${call.call_id}/takeover`, { method: "POST", body: { operator: operator() } });
          toast("You have the call");
          render();
        } catch (e) { toast(e.message, true); }
      };
    wireResolveForm(b, call);
  };

  await render();
  if (live) pollTimers.push(setInterval(() => { if (!drawer.hidden && drawerBookingId === id) render(); }, 2500));
}

function resolveFormHtml(b) {
  return `
    <h2>Wrap-up (disposition)</h2>
    <div class="form-grid" id="resolveForm">
      <label>Outcome</label>
      <select id="rOutcome">
        <option value="confirmed">confirmed</option>
        <option value="counter_offer">counter offer</option>
        <option value="no_answer">no answer</option>
        <option value="failed">failed</option>
      </select>
      <label data-for="confirmed">Confirmed time</label><input data-for="confirmed" id="rTime" value="${esc(b.requested_time)}">
      <label data-for="confirmed">Instructions</label><input data-for="confirmed" id="rInstr" placeholder="e.g. table held 15 min">
      <label data-for="counter_offer" hidden>Offered times</label><input data-for="counter_offer" id="rOffers" hidden placeholder="2026-07-18 20:00, 2026-07-18 20:30">
      <label data-for="failed" hidden>Reason</label>
      <select data-for="failed" id="rReason" hidden>
        <option>fully_booked</option><option>closed</option><option>policy_mismatch</option><option>merchant_declined</option><option>bad_data</option>
      </select>
      <label>Note</label><input id="rNote" placeholder="appended to transcript">
    </div>
    <div class="actions"><button class="primary" id="rSubmit">Record outcome</button></div>`;
}

function wireResolveForm(b, call) {
  const sel = $("#rOutcome");
  if (!sel || !call) return;
  const sync = () => {
    drawer.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== sel.value));
  };
  sel.onchange = sync;
  sync();
  $("#rSubmit").onclick = async () => {
    const body = {
      outcome: sel.value,
      operator: operator(),
      note: $("#rNote").value || undefined,
      confirmed_time: $("#rTime")?.value,
      merchant_instructions: $("#rInstr")?.value || undefined,
      failure_reason: $("#rReason")?.value,
      offered_times: $("#rOffers")?.value ? $("#rOffers").value.split(",").map((s) => s.trim()) : undefined,
      disposition_code: sel.value,
    };
    try {
      await api(`/ops/api/calls/${call.call_id}/resolve`, { method: "POST", body });
      toast("Outcome recorded");
      bookingDrawer(b.booking_id, true);
    } catch (e) { toast(e.message, true); }
  };
}

function saveFormState() {
  const state = {};
  drawer.querySelectorAll("input, select, textarea").forEach((el) => { if (el.id) state[el.id] = el.value; });
  state.__focus = document.activeElement?.id;
  return state;
}
function restoreFormState(state) {
  Object.entries(state).forEach(([id, val]) => {
    if (id.startsWith("__")) return;
    const el = $("#" + id, drawer);
    if (el) el.value = val;
  });
  if (state.__focus) $("#" + state.__focus, drawer)?.focus();
  if ($("#rOutcome", drawer)) drawer.querySelectorAll("[data-for]").forEach((el) => (el.hidden = el.dataset.for !== $("#rOutcome").value));
}

/* ---------------- Bookings ---------------- */
async function bookings() {
  const state = (location.hash.split("?state=")[1] || "");
  const load = async () => {
    const rows = await api(`/ops/api/bookings${state ? `?state=${state}` : ""}`);
    view.innerHTML = `
      <h1>Bookings</h1>
      <p class="sub">Last 200 bookings. Click a row for the full audit trail.</p>
      <div class="toolbar">
        ${["", "queued", "in_progress", "needs_input", "confirmed", "failed", "cancelled"].map((s) =>
          `<button class="small ${s === state ? "primary" : ""}" onclick="location.hash='#/bookings${s ? "?state=" + s : ""}'">${s || "all"}</button>`).join("")}
      </div>
      ${rows.length === 0 ? `<div class="empty">No bookings yet.</div>` : `
      <div class="tablewrap"><table>
        <thead><tr><th>State</th><th>Merchant</th><th>Requested</th><th>Confirmed</th><th>Name</th><th class="num">Attempts</th><th>Created</th></tr></thead>
        <tbody>${rows.map((b) => `
          <tr class="rowlink" data-id="${esc(b.booking_id)}">
            <td>${chip(b.state)}${b.failure_reason ? `<div class="note">${esc(b.failure_reason)}</div>` : ""}</td>
            <td>${esc(b.merchant_name)}<div class="note">${esc(b.neighborhood)}</div></td>
            <td>${esc(fmtReq(b.requested_time))} · ${b.party_size}p</td>
            <td>${esc(fmtReq(b.confirmed_time))}</td>
            <td>${esc(b.reservation_name)}</td>
            <td class="num">${b.attempts}</td>
            <td class="note">${esc(fmtTime(b.created_at))}</td>
          </tr>`).join("")}</tbody>
      </table></div>`}`;
    view.querySelectorAll("tr.rowlink").forEach((tr) => (tr.onclick = () => bookingDrawer(tr.dataset.id, true)));
  };
  await load();
}

/* ---------------- Merchants ---------------- */
async function merchants() {
  view.innerHTML = `
    <h1>Merchants</h1>
    <p class="sub">Registry records. Edits require a provenance note (REQ-OPS-3).</p>
    <div class="toolbar">
      <input id="mq" placeholder="Search name or neighborhood…" style="width:280px">
      <select id="mfilter">
        <option value="">all</option>
        <option value="unverified">unverified</option>
        <option value="human_call">human-call routed</option>
        <option value="opted_out">opted out</option>
      </select>
    </div>
    <div id="mlist"></div>`;
  const load = async () => {
    const q = $("#mq").value;
    const filter = $("#mfilter").value;
    const rows = await api(`/ops/api/merchants?q=${encodeURIComponent(q)}&filter=${filter}`);
    $("#mlist").innerHTML = rows.length === 0 ? `<div class="empty">No merchants match.</div>` : `
      <div class="tablewrap"><table>
        <thead><tr><th>Name</th><th>Neighborhood</th><th>Policy</th><th>Channel</th><th>Verified</th><th>Status</th></tr></thead>
        <tbody>${rows.map((m) => `
          <tr class="rowlink" data-id="${esc(m.merchant_id)}">
            <td>${esc(m.name)}<div class="note">${esc(m.cuisine_tags.join(", "))} · ${"$".repeat(m.price_band)}</div></td>
            <td>${esc(m.location.neighborhood)}</td>
            <td>${esc(m.reservation_policy.replace(/_/g, " "))}</td>
            <td>${esc(m.fulfillment_channel)}</td>
            <td class="note">${m.phone_verified_at ? esc(fmtTime(m.phone_verified_at)) : "—"}</td>
            <td>${m.opt_out ? chip("opted_out") : m.bookable ? chip("confirmed") .replace("confirmed", "bookable").replace(">confirmed<", ">bookable<") : chip("pending").replace(">pending<", ">not bookable<")}</td>
          </tr>`).join("")}</tbody>
      </table></div>
      <p class="note">Showing ${rows.length} (max 100). Refine with search.</p>`;
    $("#mlist").querySelectorAll("tr.rowlink").forEach((tr) => (tr.onclick = () => merchantDrawer(tr.dataset.id)));
  };
  $("#mq").addEventListener("input", () => load());
  $("#mfilter").addEventListener("change", () => load());
  await load();
}

async function merchantDrawer(id) {
  const m = await api(`/ops/api/merchants/${id}`);
  const fs = m.feedback_summary, os = m.operational_stats;
  openDrawer(`
    <h3>${esc(m.name)}</h3>
    <p class="sub">${m.opt_out ? chip("opted_out") : m.bookable ? chip("confirmed").replace(">confirmed<", ">bookable<") : chip("pending").replace(">pending<", ">not bookable<")}
      &nbsp;${esc(m.verification_status.replace(/_/g, " "))} · ${esc(m.location.neighborhood)}</p>
    <div class="kv">
      <div class="k">Address</div><div>${esc(m.location.address)}</div>
      <div class="k">Cuisine</div><div>${esc(m.cuisine_tags.join(", "))}</div>
      <div class="k">Attributes</div><div class="pill-row">${m.attribute_tags.map((t) => `<span class="pill">${esc(t.replace(/_/g, " "))}</span>`).join("")}</div>
      <div class="k">Verified</div><div>${m.phone_verified_at ? esc(fmtTime(m.phone_verified_at)) : "never"}</div>
      ${m.human_call_flag_reason ? `<div class="k">Human-call flag</div><div>${esc(m.human_call_flag_reason)}</div>` : ""}
      <div class="k">Ops stats</div><div>${os.bookings_confirmed}/${os.bookings_attempted} bookings confirmed${os.call_answer_rate !== null ? ` · ${os.call_answer_rate}% answer rate` : ""}</div>
      <div class="k">Feedback</div><div>${fs.count ? `${fs.count} events · ${fs.reservation_honored_pct}% honored` : "none yet"}</div>
    </div>

    <h2>Edit record (with provenance)</h2>
    <div class="form-grid">
      <label>Field</label>
      <select id="eField">
        <option value="phone_primary">phone_primary</option>
        <option value="reservation_policy">reservation_policy</option>
        <option value="fulfillment_channel">fulfillment_channel</option>
        <option value="price_band">price_band</option>
        <option value="address">address</option>
        <option value="name">name</option>
        <option value="max_party_size">max_party_size</option>
      </select>
      <label>New value</label><input id="eValue" placeholder="value">
      <label>Note</label><input id="eNote" placeholder="why / source">
    </div>
    <div class="actions"><button class="primary" id="eSave">Save edit</button></div>

    <h2>Verification call</h2>
    <div class="form-grid">
      <label>Outcome</label>
      <select id="vOutcome">
        <option value="verified">verified (number, hours, policy confirmed)</option>
        <option value="no_answer">no answer</option>
        <option value="wrong_number">wrong number</option>
        <option value="closed_permanently">closed permanently</option>
        <option value="opted_out">merchant requested opt-out</option>
      </select>
      <label>Notes</label><input id="vNotes" placeholder="deposit req? hours changed?">
    </div>
    <div class="actions">
      <button class="primary" id="vSave">Record verification</button>
      <button id="annoyBtn">Log annoyance signal</button>
      <button id="complaintBtn">Log complaint</button>
      ${m.opt_out ? "" : `<button class="danger" id="optoutBtn">Opt out (immediate)</button>`}
    </div>

    <h2>Provenance</h2>
    <div class="events">${m.provenance.slice(0, 12).map((p) => `
      <div class="ev"><span class="at">${esc(fmtTime(p.recorded_at))}</span><div>${esc(p.field)} ← ${esc(p.source)}${p.detail ? `<pre>${esc(p.detail)}</pre>` : ""}</div></div>`).join("")}</div>

    ${m.verification_calls.length ? `<h2>Verification history</h2>
    <div class="events">${m.verification_calls.slice(0, 6).map((v) => `
      <div class="ev"><span class="at">${esc(fmtTime(v.called_at))}</span><div>${esc(v.outcome)} · ${esc(v.operator)}${v.notes ? `<pre>${esc(v.notes)}</pre>` : ""}</div></div>`).join("")}</div>` : ""}
  `);

  $("#eSave").onclick = async () => {
    const field = $("#eField").value;
    let value = $("#eValue").value;
    if (["price_band", "max_party_size"].includes(field)) value = Number(value);
    try {
      await api(`/ops/api/merchants/${id}`, { method: "PATCH", body: { field, value, operator: operator(), note: $("#eNote").value } });
      toast("Saved with provenance");
      merchantDrawer(id);
    } catch (e) { toast(e.message, true); }
  };
  $("#vSave").onclick = async () => {
    try {
      await api(`/ops/api/merchants/${id}/verify`, { method: "POST", body: { operator: operator(), outcome: $("#vOutcome").value, notes: $("#vNotes").value } });
      toast("Verification recorded");
      merchantDrawer(id);
    } catch (e) { toast(e.message, true); }
  };
  $("#annoyBtn").onclick = async () => {
    await api(`/ops/api/merchants/${id}/annoyance`, { method: "POST", body: { note: "logged from console" } });
    toast("Annoyance logged (2 strikes → human_call routing)");
    merchantDrawer(id);
  };
  $("#complaintBtn").onclick = async () => {
    await api(`/ops/api/merchants/${id}/complaint`, { method: "POST", body: { notes: "logged from console" } });
    toast("Complaint opened (same-day SLA)");
  };
  const opt = $("#optoutBtn");
  if (opt)
    opt.onclick = async () => {
      if (!confirm(`Opt out ${m.name}? They will never be called again.`)) return;
      await api(`/ops/api/merchants/${id}/optout`, { method: "POST", body: { notes: "requested removal" } });
      toast("Opted out — record retained, never called again");
      merchantDrawer(id);
    };
}

/* ---------------- Verification queue ---------------- */
async function verification() {
  const rows = await api("/ops/api/verification-queue");
  view.innerHTML = `
    <h1>Verification queue</h1>
    <p class="sub">Merchants never verified or past the ${60}-day freshness policy (REQ-ING-3). Work top-down; record each call.</p>
    ${rows.length === 0 ? `<div class="empty">All merchants are within the freshness window. 🎉</div>` : `
    <div class="tablewrap"><table>
      <thead><tr><th>Merchant</th><th>Neighborhood</th><th>Phone</th><th>Last verified</th><th></th></tr></thead>
      <tbody>${rows.map((m) => `
        <tr>
          <td>${esc(m.name)}</td>
          <td>${esc(m.neighborhood)}</td>
          <td class="mono">${esc(m.phone_primary || "—")}</td>
          <td class="note">${m.phone_verified_at ? esc(fmtTime(m.phone_verified_at)) : "never"}</td>
          <td><button class="small" data-id="${esc(m.merchant_id)}">Open record</button></td>
        </tr>`).join("")}</tbody>
    </table></div>
    <p class="note">${rows.length} merchants due.</p>`}`;
  view.querySelectorAll("button[data-id]").forEach((b) => (b.onclick = () => merchantDrawer(b.dataset.id)));
}

/* ---------------- Complaints ---------------- */
async function complaints() {
  const rows = await api("/ops/api/complaints");
  view.innerHTML = `
    <h1>Complaints & opt-outs</h1>
    <p class="sub">Same-day resolution SLA (REQ-OPS-5).</p>
    ${rows.length === 0 ? `<div class="empty">No complaints on file.</div>` : `
    <div class="tablewrap"><table>
      <thead><tr><th>Opened</th><th>Merchant</th><th>Kind</th><th>Notes</th><th>Status</th><th></th></tr></thead>
      <tbody>${rows.map((c) => `
        <tr>
          <td class="note">${esc(fmtTime(c.opened_at))}</td>
          <td>${esc(c.merchant_name)}</td>
          <td>${esc(c.kind)}</td>
          <td class="note">${esc(c.notes || "")}</td>
          <td>${c.resolved_at ? chip("confirmed").replace(">confirmed<", ">resolved<") : chip("needs_input").replace(">needs input<", ">open<")}</td>
          <td>${c.resolved_at ? "" : `<button class="small" data-id="${c.id}">Resolve</button>`}</td>
        </tr>`).join("")}</tbody>
    </table></div>`}`;
  view.querySelectorAll("button[data-id]").forEach((b) => (b.onclick = async () => {
    const resolution = prompt("Resolution note:", "spoke with merchant, resolved");
    if (resolution === null) return;
    await api(`/ops/api/complaints/${b.dataset.id}/resolve`, { method: "POST", body: { resolution } });
    complaints();
  }));
}

/* ---------------- Analytics ---------------- */
async function analytics() {
  poll(async () => {
    const a = await api("/ops/api/analytics");
    const sc = a.success_criteria;
    const va = a.voice_agent;
    const maxFail = Math.max(1, ...a.failure_reasons.map((r) => r.c));
    view.innerHTML = `
      <h1>Analytics</h1>
      <p class="sub">Disposition analytics (REQ-OPS-4) and the 90-day success-criteria dashboard (§2).</p>
      <div class="tiles">
        <div class="tile ${sc.completion_rate_pct === null ? "" : sc.completion_rate_pct >= sc.completion_rate_target_pct ? "ok" : "warn"}">
          <div class="k">Task completion</div><div class="v">${sc.completion_rate_pct ?? "—"}<span class="unit">%</span></div><div class="d">target ≥ ${sc.completion_rate_target_pct}% of terminal bookings</div></div>
        <div class="tile ${sc.median_confirmation_minutes === null ? "" : sc.median_confirmation_minutes <= sc.median_confirmation_target_minutes ? "ok" : "warn"}">
          <div class="k">Median time to confirm</div><div class="v">${sc.median_confirmation_minutes ?? "—"}<span class="unit">min</span></div><div class="d">target ≤ ${sc.median_confirmation_target_minutes} min</div></div>
        <div class="tile ${va.containment_rate_pct === null ? "" : va.containment_rate_pct >= va.containment_target_pct ? "ok" : "warn"}">
          <div class="k">Voice-agent containment</div><div class="v">${va.containment_rate_pct ?? "—"}<span class="unit">%</span></div><div class="d">${va.calls} calls · target ≥ ${va.containment_target_pct}% (no takeover)</div></div>
        <div class="tile"><div class="k">Developers w/ booking</div><div class="v">${sc.distinct_developers_with_booking}</div><div class="d">target ≥ 25 by day 90</div></div>
        <div class="tile ${a.freshness.verified_within_policy_pct >= 95 ? "ok" : "warn"}"><div class="k">Data freshness</div><div class="v">${a.freshness.verified_within_policy_pct}<span class="unit">%</span></div><div class="d">≤ ${a.freshness.policy_days} days · target ≥ 95%</div></div>
      </div>

      <div class="grid2">
        <div>
          <h2>Failure reasons</h2>
          <div class="card">
            ${a.failure_reasons.length === 0 ? `<span class="note">No failures yet.</span>` :
              a.failure_reasons.map((r) => `
                <div class="bar-row">
                  <span class="bar-label">${esc(r.reason || "unknown")}</span>
                  <div class="bar-track"><div class="bar-fill" style="width:${(r.c / maxFail) * 100}%"></div></div>
                  <span class="bar-val">${r.c}</span>
                </div>`).join("")}
          </div>
          <h2>Call dispositions</h2>
          <div class="tablewrap"><table>
            <thead><tr><th>Outcome</th><th>Channel</th><th class="num">Calls</th></tr></thead>
            <tbody>${a.dispositions.map((d) => `<tr><td>${esc(d.outcome)}</td><td>${esc(d.channel)}</td><td class="num">${d.c}</td></tr>`).join("") || `<tr><td colspan="3" class="note">No calls yet.</td></tr>`}</tbody>
          </table></div>
        </div>
        <div>
          <h2>Per-operator throughput</h2>
          <div class="tablewrap"><table>
            <thead><tr><th>Operator</th><th class="num">Calls</th><th class="num">Confirmed</th></tr></thead>
            <tbody>${a.per_operator.map((o) => `<tr><td>${esc(o.operator)}</td><td class="num">${o.calls}</td><td class="num">${o.confirmed}</td></tr>`).join("") || `<tr><td colspan="3" class="note">No operator-handled calls yet.</td></tr>`}</tbody>
          </table></div>
        </div>
      </div>`;
  }, 5000);
}

/* boot */
refreshBadges();
navigate();
