import {
  VERSION,
  DIMENSIONS,
  LABELS,
  makePlan,
  validatePlan,
  shuffle,
  random,
  mergeExports,
  summarize,
  csv,
} from "./core.js";
import { Player, parseWav, decodeFOA, encodeStereoWav, sha256, waveform } from "./audio.js";
const $ = (s) => document.querySelector(s),
  $$ = (s) => [...document.querySelectorAll(s)];
const escape = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const time = (t) =>
  Number(t || 0)
    .toFixed(1)
    .padStart(4, "0");
const state = {
  catalog: null,
  decoder: null,
  user: "",
  profile: {
    records: [],
    exposed: [],
    calibration: null,
    plan: null,
    drafts: {},
  },
  entry: null,
  scene: null,
  question: null,
  reference: null,
  current: 0,
  token: 0,
  summary: [],
  adjudications: {},
  loadErrors: [],
};
let toastTimer;
function toast(message, error = false) {
  const el = $("#toast");
  el.textContent = message;
  el.hidden = false;
  el.style.background = error ? "#843f2a" : "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 6500);
}
function guard(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      console.error(e);
      toast(e.message || "Something went wrong. Please try again.", true);
    }
  };
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw Error(`Unable to load ${url} (${r.status})`);
  return r.json();
}
function save() {
  try {
    localStorage.setItem(
      "dish-profile:" + state.user,
      JSON.stringify(state.profile),
    );
    localStorage.setItem("dish-user", state.user);
    $("#save-status").textContent = "✓ Saved in this browser";
  } catch (e) {
    $("#save-status").textContent = "Save failed. Export your results now.";
    throw Error("Browser storage is full or unavailable. Export your results before continuing.");
  }
}
function needUser() {
  if (!state.user) throw Error("Enter your reviewer ID and open your profile first.");
}
function record() {
  return state.profile.records.find(
    (r) =>
      r.plan_id === state.profile.plan?.id &&
      r.sample_id === state.entry?.sample_id,
  );
}
function draft() {
  const key = state.profile.plan.id + ":" + state.entry.sample_id;
  return (
    state.profile.drafts[key] ??
    (state.profile.drafts[key] = { blind: {}, review: {}, marks: [] })
  );
}
function collect() {
  if (!state.entry) return;
  const d = draft(),
    r = record();
  const stage = r?.blind ? "review" : "blind";
  if (r?.review) return;
  for (const input of $$("#form-panel input[type=radio]:checked"))
    d[stage][input.name] = input.value;
  for (const input of $$("#form-panel textarea"))
    d[stage][input.name] = input.value;
  d[stage].playback_failed = $("#playback-failed")?.checked || false;
  save();
}
function download(name, obj, type = "application/json") {
  const body = typeof obj === "string" || obj instanceof ArrayBuffer
    ? obj : JSON.stringify(obj, null, 2);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([body], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
function exportData() {
  return {
    schema: "dish-reviews-1",
    version: VERSION,
    revision: state.catalog.revision,
    protocol: state.catalog.protocol,
    reviewer: state.user,
    exported_at: new Date().toISOString(),
    records: state.profile.records,
    plan: state.profile.plan,
  };
}
function updateMetrics() {
  const plan = state.profile.plan,
    records = state.profile.records.filter((r) => r.plan_id === plan?.id);
  const completed = records.filter((r) => r.review).length;
  $("#total-scenes").textContent = state.catalog.counts.scenes.toLocaleString();
  $("#plan-count").textContent = String(plan?.samples.length || 0).padStart(
    2,
    "0",
  );
  $("#completed-count").textContent = String(completed).padStart(2, "0");
  $("#issue-count").textContent = String(
    records.filter((r) => Object.values(r.review || {}).includes("issue"))
      .length,
  ).padStart(2, "0");
  $("#profile-label").textContent = state.user
    ? `Reviewer ${state.user}`
    : "Set your reviewer ID first";
  $("#plan-mode").textContent = plan
    ? `${plan.phase === "pilot" ? "Pilot" : "Formal"} · ${plan.samples.filter((s) => s.mode === "static").length} static / ${plan.samples.filter((s) => s.mode === "dynamic").length} dynamic`
    : "No samples selected";
  $("#plan-id").textContent = plan ? "Plan " + plan.id : "Random selection / shared plan";
  $("#queue-progress").textContent =
    completed + " / " + (plan?.samples.length || 0);
  $("#progress-fill").style.width =
    (plan ? (100 * completed) / plan.samples.length : 0) + "%";
  if (!plan) {
    $("#queue").innerHTML =
      '<div class="empty-queue">Choose your settings and draw samples<br>to begin an independent review.</div>';
    return;
  }
  $("#queue").innerHTML = plan.samples
    .map((p, i) => {
      const r = records.find((x) => x.sample_id === p.sample_id),
        q = state.catalog.scenes
          .find((s) => s.id === p.episode_id)
          .questions.find((q) => q.id === p.sample_id);
      return `<button class="queue-item ${i === state.current ? "active" : ""}" data-index="${i}"><div class="queue-top"><span><span class="index">${String(i + 1).padStart(2, "0")}</span>${p.mode === "static" ? "Static scene" : "Dynamic scene"}</span><span class="${r?.review ? "done" : ""}">${r?.review ? "✓" : r?.blind ? "◐" : "○"}</span></div><small>${escape(q.task)} · ${q.setting === "edge" ? "Edge" : "Cloud"}</small></button>`;
    })
    .join("");
  $$(".queue-item").forEach(
    (b) => (b.onclick = guard(() => selectSample(Number(b.dataset.index)))),
  );
}
async function enterUser() {
  const id = $("#reviewer").value.trim();
  if (!id) throw Error("Enter a reviewer ID.");
  if (id.length > 40) throw Error("Reviewer ID is too long.");
  if (state.user && state.entry) collect();
  player.reset();
  state.token++;
  state.user = id;
  const raw = localStorage.getItem("dish-profile:" + id);
  state.profile = raw
    ? JSON.parse(raw)
    : { records: [], exposed: [], calibration: null, plan: null, drafts: {} };
  state.entry = null;
  state.reference = null;
  state.current = 0;
  state.profile.drafts ??= {};
  state.profile.exposed ??= [];
  if (state.profile.plan) validatePlan(state.profile.plan, state.catalog);
  save();
  updateMetrics();
  if (state.profile.plan) await selectSample(0);
  else {
    $("#form-panel").hidden = true;
    $("#sample-panel").innerHTML =
      '<div class="empty-state"><div class="empty-icon">◖◗</div><h2>Your workspace is ready</h2><p>Calibrate your headphones, then draw a set of scenes.</p></div>';
  }
  toast(`Opened independent records for ${id}`);
}
async function sample() {
  needUser();
  collect();
  const plan = makePlan(state.catalog, {
    seed: $("#seed").value || crypto.randomUUID(),
    count: Number($("#count").value),
    mode: $("#mode").value,
    phase: $("#phase").value,
    task: $("#task").value,
    excluded: state.profile.exposed,
  });
  state.entry = null;
  state.profile.plan = plan;
  save();
  await selectSample(0);
  toast(`Selected ${plan.samples.length} scenes. Plan ${plan.id}`);
}
const player = new Player((t) => {
  if ($("#clock"))
    $("#clock").textContent = time(t) + " / " + time(player.duration) + " s";
  if ($("#playhead"))
    $("#playhead").style.left = (100 * t) / (player.duration || 1) + "%";
  if ($("#seek")) $("#seek").value = t;
  if ($("#play")) $("#play").textContent = player.playing ? "Ⅱ" : "▶";
  if ($("#coverage"))
    $("#coverage").textContent = Object.entries(player.coverage())
      .map(([k, v]) => `${k} played ${Math.round(v * 100)}%`)
      .join(" · ");
  if (state.reference) drawMap(t);
});
async function selectSample(index) {
  if (state.entry) collect();
  for (const audio of $$(".source-card audio")) audio.pause();
  player.reset();
  waves.clear();
  const token = ++state.token;
  state.current = index;
  state.entry = state.profile.plan.samples[index];
  state.reference = null;
  state.scene = null;
  state.question = null;
  state.loadErrors = [];
  $("#sample-panel").innerHTML =
    '<div class="empty-state"><h2>Loading scene…</h2><p>Loading the original question and its recordings.</p></div>';
  $("#form-panel").hidden = true;
  updateMetrics();
  const scene = await getJSON(`data/scenes/${state.entry.episode_id}.json`);
  if (token !== state.token) return;
  state.scene = scene;
  state.question = scene.questions.find((q) => q.id === state.entry.sample_id);
  if (!state.question) throw Error("The question does not match this scene.");
  const r = record();
  if (r?.blind) {
    const reference = await getJSON(
      `data/references/${state.entry.episode_id}.json`,
    );
    if (token !== state.token) return;
    state.reference = reference;
  }
  renderSample();
  renderForm();
  await loadAudio(token);
}
function shortPrompt(prompt) {
  const parts = prompt.split("\n");
  const pivot = parts.findIndex((x) => x.startsWith("All directions"));
  return pivot >= 0
    ? parts.slice(pivot + 1).join("\n")
    : parts.slice(-5).join("\n");
}
function currentAudio() {
  const q = state.question;
  if (!state.reference) return q.audio;
  return [
    ...new Map(
      state.scene.questions.flatMap((x) => x.audio).map((a) => [a.id, a]),
    ).values(),
  ];
}
function renderSample() {
  const p = state.entry,
    q = state.question,
    r = record(),
    second = !!r?.blind;
  const seen = state.profile.exposed.includes(p.base) && !r?.blind;
  $("#sample-panel").innerHTML =
    `<div class="sample-head"><div><div class="eyebrow">SAMPLE ${String(state.current + 1).padStart(2, "0")} / ${state.profile.plan.samples.length}</div><h2>${p.mode === "static" ? "Static" : "Dynamic"} scene <span class="mono">${p.episode_id.slice(0, 8)}</span></h2><p>${q.setting === "edge" ? "Edge view" : "Cloud view"} · ${escape(q.task)} · ${state.scene.duration.toFixed(1)} s · ${q.receiver_ids.length} question receiver(s)</p></div><span class="badge">${state.profile.plan.phase === "pilot" ? "Pilot sample" : "Formal sample"}</span></div><div class="stage-tabs"><span class="${second ? "" : "active"}">01 Blind listening ${second ? "✓" : ""}</span><span class="line"></span><span class="${second ? "active" : ""}">02 Reference check ${second ? "" : "⌑"}</span><span class="line"></span><span>03 ${r?.review ? "Complete ✓" : "Save record"}</span></div>${seen ? '<div class="exposure">You have already seen answers from this base scene. This record will be flagged for prior exposure and excluded from formal independent statistics.</div>' : ""}<div class="prompt"><h3>Your task</h3><pre>${escape(shortPrompt(q.prompt))}</pre><details><summary>Show the full original question and allowed information</summary><pre>${escape(q.prompt)}</pre></details></div><div class="audio-deck"><div class="deck-top"><div class="receiver-buttons">${currentAudio()
      .map(
        (a, i) =>
          `<button class="receiver ${i === 0 ? "active" : ""}" data-receiver="${escape(a.id)}">◉ ${escape(a.id)}</button>`,
      )
      .join(
        "",
      )}</div><span class="decoder-label">FOA → KEMAR binaural · Fixed orientation</span><button id="download-binaural" class="button small" disabled>↓ Binaural WAV</button></div><div class="wave-wrap" id="wave-wrap"><canvas id="waveform"></canvas><div id="playhead" class="playhead"></div></div><div class="time-ruler">${[0, 0.25, 0.5, 0.75, 1].map((t) => `<span>${time(t * state.scene.duration)} s</span>`).join("")}</div><div class="transport"><button id="play" class="play-button" aria-label="Play / pause" disabled>▶</button><button id="restart" class="icon-button" aria-label="Restart playback">↺</button><time id="clock">00.0 / ${time(state.scene.duration)} s</time><button id="mark-now" class="button small">＋ Mark this time</button><label>Volume<input id="volume" type="range" min="0" max="1" step="0.05" value="${player.gain}" aria-label="Volume"></label></div><input id="seek" type="range" min="0" max="${state.scene.duration}" step="0.05" value="0" aria-label="Playback position" style="width:100%;accent-color:#789359"><div id="deck-status" class="deck-status">Loading and verifying the original FOA…</div><div id="coverage" class="coverage"></div></div><p class="hint">Switching receivers preserves the playback position. The waveform shows the original W channel; all receivers share one playback gain. Listen to the full recording before inspecting details.</p><div id="reference-area">${second ? referenceHTML() : `<div class="locked">⌑ Reference answers and source speech unlock after you submit your independent ratings.</div>`}</div>`;
  $("#play").onclick = guard(async () => {
    if (player.playing) player.pause();
    else {
      for (const audio of $$(".source-card audio")) audio.pause();
      await player.play();
    }
    $("#play").textContent = player.playing ? "Ⅱ" : "▶";
  });
  $("#restart").onclick = () => player.seek(0);
  $("#download-binaural").onclick = guard(() => {
    const buffer = player.buffers.get(player.receiver);
    if (!buffer) throw Error("Wait for the current receiver audio to load.");
    download(`${p.episode_id}-${player.receiver}-kemar-gain${player.gain}.wav`,
      encodeStereoWav(buffer, player.gain), "audio/wav");
  });
  $("#seek").oninput = (e) => player.seek(Number(e.target.value));
  $("#volume").oninput = (e) => player.setVolume(Number(e.target.value));
  $("#wave-wrap").onclick = (e) => {
    const rect = e.currentTarget.getBoundingClientRect();
    player.seek(((e.clientX - rect.left) / rect.width) * state.scene.duration);
  };
  $("#mark-now").onclick = () => {
    const el = $("#mark-start");
    if (el) {
      el.value = player.position.toFixed(1);
      $("#mark-end").value = Math.min(
        state.scene.duration,
        player.position + 1,
      ).toFixed(1);
      $("#mark-note").focus();
    }
  };
  $$(".receiver").forEach(
    (b) =>
      (b.onclick = () => {
        if (!player.buffers.has(b.dataset.receiver)) {
          toast("This receiver is still loading or failed to load.");
          return;
        }
        player.switch(b.dataset.receiver);
        $$(".receiver").forEach((x) => x.classList.toggle("active", x === b));
        drawWave();
      }),
  );
  wireSourceAudio();
  if (second) drawMap(player.position);
}
const waves = new Map();
async function loadAudio(token) {
  const q = state.question;
  player.duration = state.scene.duration;
  const audio = currentAudio();
  for (const a of audio) {
    try {
      if (player.buffers.has(a.id)) continue;
      const url = `https://huggingface.co/datasets/${state.catalog.repo}/resolve/${state.catalog.revision}/${a.path}`;
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 75000);
      let bytes;
      try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw Error(`HTTP ${response.status}`);
        bytes = await response.arrayBuffer();
      } finally {
        clearTimeout(timeout);
      }
      if (token !== state.token) return;
      if ((await sha256(bytes)) !== a.sha256)
        throw Error("SHA-256 does not match the frozen release.");
      const wav = parseWav(bytes);
      if (wav.length / wav.rate !== state.scene.duration)
        throw Error("Audio duration does not match the scene.");
      const decoded = await decodeFOA(wav, state.decoder);
      if (token !== state.token) return;
      let peak = 0;
      for (let c = 0; c < 2; c++)
        for (const x of decoded.getChannelData(c))
          peak = Math.max(peak, Math.abs(x));
      player.buffers.set(a.id, decoded);
      waves.set(a.id, waveform(wav.data[0]));
      if (!player.receiver) {
        player.receiver = a.id;
        drawWave();
      }
      const r = record();
      if (r?.blind?.coverage?.[a.id] >= 0.95) {
        /* Historical coverage stays in the immutable record; current session starts fresh. */
      }
      $("#play").disabled = false;
      $("#download-binaural").disabled = false;
      $("#deck-status").textContent =
        `${player.buffers.size} / ${audio.length} receivers ready · Original SHA-256 verified${peak > 1 ? " · Decoded peak > 1; lower the volume" : ""}`;
    } catch (e) {
      if (token !== state.token) return;
      state.loadErrors.push(a.id + ": " + e.message);
      $("#deck-status").innerHTML =
        `<span class="error">${escape(state.loadErrors.join("; "))}. Retry or record a playback failure.</span> <button id="retry-audio" class="button small">Retry</button>`;
      $("#retry-audio").onclick = guard(() => loadAudio(++state.token));
    }
  }
  if (token !== state.token) return;
  if (player.buffers.size) {
    $("#play").disabled = false;
      $("#download-binaural").disabled = false;
    drawWave();
    $("#deck-status").textContent =
      `${player.buffers.size} / ${audio.length} receivers ready · Original SHA-256 verified`;
  }
  if (state.loadErrors.length)
    $("#deck-status").innerHTML =
      `<span class="error">${escape(state.loadErrors.join("; "))}</span> <button id="retry-audio" class="button small">Retry loading</button>`;
  if ($("#retry-audio"))
    $("#retry-audio").onclick = guard(() => {
      state.loadErrors = [];
      return loadAudio(++state.token);
    });
}
function drawWave() {
  const canvas = $("#waveform");
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect(),
    dpr = devicePixelRatio || 1;
  canvas.width = rect.width * dpr;
  canvas.height = rect.height * dpr;
  const ctx = canvas.getContext("2d");
  ctx.scale(dpr, dpr);
  const data = waves.get(player.receiver);
  if (!data) return;
  const max = Math.max(...data, 0.001),
    w = rect.width / data.length;
  ctx.fillStyle = "#91ab73";
  for (let i = 0; i < data.length; i++) {
    const h = Math.max(2, (data[i] / max) * (rect.height - 8));
    ctx.fillRect(i * w, (rect.height - h) / 2, Math.max(1, w - 1), h);
  }
}
function radio(name, label, options, value, disabled = false, hint = "") {
  return `<div class="rating-row"><div class="rating-label">${label}${hint ? `<small>${hint}</small>` : ""}</div><div class="choices">${options.map((v) => `<label class="choice"><input type="radio" name="${name}" value="${v}" ${value === v ? "checked" : ""} ${disabled ? "disabled" : ""}><span>${LABELS[v] || v}</span></label>`).join("")}</div></div>`;
}
function renderForm() {
  const r = record(),
    d = draft(),
    second = !!r?.blind,
    finished = !!r?.review,
    values = second ? r?.review || d.review : d.blind;
  $("#form-panel").hidden = false;
  $("#form-panel").innerHTML =
    `<div class="form-heading"><h2>${second ? "02 · Check the reference and investigate concerns" : "01 · Listen independently before seeing answers"}</h2><span class="badge">${finished ? "Complete and locked" : second ? "Blind ratings locked" : "Rate independently"}</span></div>${second ? `<div class="locked">Stage 1: ${escape(LABELS[r.blind.audibility])} · Audio: ${escape(LABELS[r.blind.quality])}<br>${escape(r.blind.notes || "No additional concerns recorded")}${r.blind.response ? "<br>Blind response: " + escape(r.blind.response) : ""}</div>` : ""}<div id="ratings">${second ? ["quality", "text", "target", "spatial", "cross"].map((dim) => radio(dim, DIMENSIONS[dim], ["pass", "issue", "uncertain", "na"], values[dim], finished, dim === "cross" ? "Select Not applicable for scenes with only one receiver" : "")).join("") : radio("audibility", "How discernible is the target in the mixture?", ["clear", "partial", "masked", "empty", "uncertain"], values.audibility) + radio("quality", "Are there any audio or rendering anomalies?", ["pass", "issue", "uncertain"], values.quality)}</div><div class="notes-grid"><label>${second ? "Evidence and concerns (required for concerns or uncertainty)" : "Listening concerns (required for concerns or unclear speech)"}<textarea name="notes" placeholder="e.g. The target is masked at 8–11 s; these words cannot be verified." ${finished ? "disabled" : ""}>${escape(values.notes || "")}</textarea></label><label>${second ? "Suggested action (optional)" : "What you heard or your reasoning (optional)"}<textarea name="response" placeholder="Record your own judgment. There is no need to guess." ${finished ? "disabled" : ""}>${escape(values.response || "")}</textarea></label></div>${!second ? `<label class="check-row"><input id="playback-failed" type="checkbox" ${values.playback_failed ? "checked" : ""}>Playback failed / unable to complete review (recorded as missing, not a pass)</label>` : ""}<div class="marks"><h3>Timestamps and evidence <span class="mono">${second ? "Reference stage" : "Blind stage"}</span></h3>${finished ? "" : `<div class="mark-fields"><label>Start / s<input id="mark-start" type="number" min="0" max="${state.scene.duration}" step="0.1" value="0"></label><label>End / s<input id="mark-end" type="number" min="0" max="${state.scene.duration}" step="0.1" value="1"></label><label>Reason<input id="mark-note" maxlength="1000" placeholder="Describe the issue, affected words or receiver"></label><button id="add-mark" class="button small">Add</button></div>`}<div id="mark-list"></div></div><div class="form-footer"><span class="quiet">${finished ? "Saved in this browser. Remember to export." : second ? "These ratings remain independent. Adjudication is stored separately." : "Submitting locks stage 1 and reveals the references."}</span><button id="submit-stage" class="button primary">${finished ? "Next scene →" : second ? "Complete sample ✓" : "Lock ratings & reveal references →"}</button></div>`;
  $$(
    "#form-panel input[type=radio],#form-panel textarea,#playback-failed",
  ).forEach((el) => (el.onchange = guard(collect)));
  if ($("#add-mark")) $("#add-mark").onclick = guard(addMark);
  renderMarks();
  $("#submit-stage").onclick = guard(
    finished ? nextSample : second ? submitReview : submitBlind,
  );
}
function renderMarks() {
  const r = record(),
    marks = [...(r?.marks || []), ...draft().marks];
  $("#mark-list").innerHTML = marks
    .map(
      (m, i) =>
        `<div class="mark-item"><b>${time(m.start)}–${time(m.end)} s</b><span>${escape(m.receiver || "")} · ${m.stage === "blind" ? "Blind" : "Reference"} · ${escape(m.note)}</span>${i >= (r?.marks?.length || 0) && !r?.review ? `<button data-remove-mark="${i - (r?.marks?.length || 0)}" aria-label="Delete marker">×</button>` : ""}</div>`,
    )
    .join("");
  $$("[data-remove-mark]").forEach(
    (b) =>
      (b.onclick = () => {
        draft().marks.splice(Number(b.dataset.removeMark), 1);
        save();
        renderMarks();
      }),
  );
}
function addMark() {
  const start = Number($("#mark-start").value),
    end = Number($("#mark-end").value),
    note = $("#mark-note").value.trim();
  if (
    !note ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end < start ||
    end > state.scene.duration
  )
    throw Error("Enter a valid time interval and a specific reason.");
  draft().marks.push({
    start,
    end,
    note,
    stage: record()?.blind ? "review" : "blind",
    receiver: player.receiver,
    at: new Date().toISOString(),
  });
  $("#mark-note").value = "";
  save();
  renderMarks();
}
async function submitBlind() {
  needUser();
  collect();
  const d = draft(),
    b = d.blind;
  if (!b.audibility || !b.quality) throw Error("Complete both independent ratings.");
  if (!state.profile.calibration?.confirmed && !b.playback_failed)
    throw Error("Complete headphone and direction calibration first.");
  if (
    (["partial", "masked", "uncertain"].includes(b.audibility) ||
      b.quality !== "pass" ||
      b.playback_failed) &&
    !(b.notes || "").trim()
  )
    throw Error("Describe your concerns or why you are unable to judge.");
  const coverage = player.coverage();
  if (
    !b.playback_failed &&
    state.question.receiver_ids.some((id) => (coverage[id] || 0) < 0.95)
  )
    throw Error("Listen to each question receiver in full (at least 95%) before locking your ratings.");
  if (
    b.playback_failed &&
    (b.audibility !== "uncertain" || b.quality !== "uncertain")
  )
    throw Error("If playback fails, mark both audibility and audio quality as Unable to judge.");
  const entry = state.entry,
    plan = state.profile.plan,
    token = state.token;
  // Lock BEFORE fetching the answer. Even if reference download fails, this judgment persists.
  const r = {
    reviewer: state.user,
    plan_id: plan.id,
    phase: plan.phase,
    episode_id: entry.episode_id,
    sample_id: entry.sample_id,
    base_scene_id: entry.base,
    room_id: entry.room,
    mode: entry.mode,
    task: state.question.task,
    setting: state.question.setting,
    recording_ids: state.question.audio.map((a) => a.recording_id),
    audio_sha256: state.question.audio.map((a) => a.sha256),
    prior_exposure: state.profile.exposed.includes(entry.base),
    calibration: structuredClone(state.profile.calibration),
    decoder: state.decoder.id,
    blind: {
      ...structuredClone(b),
      coverage,
      volume: player.gain,
      locked_at: new Date().toISOString(),
    },
    marks: structuredClone(d.marks),
    review: null,
  };
  state.profile.records.push(r);
  if (!state.profile.exposed.includes(entry.base))
    state.profile.exposed.push(entry.base);
  d.marks = [];
  save();
  updateMetrics();
  const reference = await getJSON(`data/references/${entry.episode_id}.json`);
  if (token !== state.token) return;
  state.reference = reference;
  // Keep the active player/coverage; only add the reference and switch the form.
  renderSample();
  renderForm();
  drawMap(player.position);
  toast("Independent ratings locked. Check the source speech and switch between all receivers.");
  await loadAudio(token);
}
async function submitReview() {
  collect();
  const r = record(),
    d = draft(),
    v = d.review;
  for (const dim of ["quality", "text", "target", "spatial", "cross"])
    if (!v[dim])
      throw Error("Complete all reference checks. Select Unable to judge or Not applicable when needed.");
  if (
    Object.values(v).some((x) => x === "issue" || x === "uncertain") &&
    !(v.notes || "").trim()
  )
    throw Error("Describe the concerns or why you are unable to judge.");
  r.recording_ids = [
    ...new Set([
      ...r.recording_ids,
      ...currentAudio()
        .filter((a) => (player.coverage()[a.id] || 0) > 0)
        .map((a) => a.recording_id),
    ]),
  ];
  r.review = {
    ...structuredClone(v),
    coverage: player.coverage(),
    volume: player.gain,
    submitted_at: new Date().toISOString(),
  };
  r.marks.push(...d.marks);
  d.marks = [];
  save();
  updateMetrics();
  renderForm();
  toast("Sample complete. Your independent ratings are saved; remember to export.");
}
async function nextSample() {
  if (state.current + 1 < state.profile.plan.samples.length)
    await selectSample(state.current + 1);
  else toast("This is the last scene in the plan. Export your results.");
}
function referenceHTML() {
  const ref = state.reference;
  if (!ref) return "";
  const g = ref.questions[state.entry.sample_id];
  const sourceCards = ref.sources
    .map(
      (s) =>
        `<article class="source-card"><b>${escape(s.entity_id)} ${g.target_source_id === s.entity_id ? "· Question target" : ""} <span class="mono">Mixture ${time(s.start)}–${time(s.end)} s</span></b><p>${escape(s.text)}</p><audio controls preload="none" src="${escape(s.audio)}"></audio><div class="source-meta">Original source crop · ${escape(s.original_corpus_path)} · ${escape(s.license)}<br>Original sample interval [${s.crop_samples.join(", ")}) · Lossless FLAC</div></article>`,
    )
    .join("");
  return `<section class="reference-box"><div class="panel-title"><h2>Reference materials</h2><span class="badge">Revealed in stage 2 only</span></div><p>Target: <b>${escape(g.target_source_id)}</b> · ${escape(g.case || "")} · Reference answer below</p><pre class="reference-output">${escape(typeof g.output === "string" ? g.output : JSON.stringify(g.output, null, 2))}</pre><div class="ref-grid"><div><h3>Original speech and transcripts</h3>${sourceCards || "<p>No source speech is available.</p>"}</div><div><h3>Annotated trajectories · Synced to playback</h3><canvas id="scene-map" class="scene-map" aria-label="Reference scene trajectories"></canvas><p class="hint">Circles represent people; squares represent robots in a top-down world X / Z view. Dashed lines show full paths; positions follow playback time. This annotation plot is not independent validation evidence.</p><div class="callout">Record indiscernible speech separately from correspondence errors. Exact directions, distances and coordinates require geometric checks.</div></div></div></section>`;
}
function wireSourceAudio() {
  for (const audio of $$(".source-card audio"))
    audio.onplay = () => {
      player.pause();
      for (const other of $$(".source-card audio"))
        if (other !== audio) other.pause();
    };
}
function drawMap(t) {
  const c = $("#scene-map");
  if (!c || !state.reference) return;
  const entities = state.reference.entities.filter((e) => e.positions?.length);
  if (!entities.length) return;
  const rect = c.getBoundingClientRect(),
    dpr = devicePixelRatio || 1;
  c.width = rect.width * dpr;
  c.height = rect.height * dpr;
  const ctx = c.getContext("2d");
  ctx.scale(dpr, dpr);
  const pts = entities.flatMap((e) => e.positions),
    xs = pts.map((p) => p[1]),
    zs = pts.map((p) => p[3]);
  const minx = Math.min(...xs) - 1,
    maxx = Math.max(...xs) + 1,
    minz = Math.min(...zs) - 1,
    maxz = Math.max(...zs) + 1;
  const scale = Math.min(
      (rect.width - 40) / (maxx - minx),
      (rect.height - 35) / (maxz - minz),
    ),
    cx = (minx + maxx) / 2,
    cz = (minz + maxz) / 2;
  const xy = (p) => [
    rect.width / 2 + (p[1] - cx) * scale,
    rect.height / 2 + (p[3] - cz) * scale,
  ];
  ctx.font = "9px sans-serif";
  ctx.fillStyle = "#8d9b7d";
  ctx.fillText(`Annotation time ${t.toFixed(1)} s  ·  +X → / +Z ↓`, 12, 17);
  entities.forEach((e, i) => {
    const human = e.id.startsWith("H"),
      color = human ? ["#7a9b51", "#c89852", "#aa6f63"][i % 3] : "#486f83";
    ctx.strokeStyle = color;
    ctx.globalAlpha = 0.35;
    ctx.setLineDash([3, 4]);
    ctx.beginPath();
    e.positions.forEach((p, j) => {
      const [x, y] = xy(p);
      j ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
    });
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.globalAlpha = 1;
    let p = e.positions[0];
    for (let j = 1; j < e.positions.length; j++) {
      const a = e.positions[j - 1],
        b = e.positions[j];
      if (t >= b[0]) {
        p = b;
        continue;
      }
      const f = Math.max(0, (t - a[0]) / (b[0] - a[0]));
      p = [t, ...a.slice(1).map((x, k) => x + (b[k + 1] - x) * f)];
      break;
    }
    const [x, y] = xy(p);
    ctx.fillStyle = color;
    human
      ? (ctx.beginPath(), ctx.arc(x, y, 5, 0, Math.PI * 2), ctx.fill())
      : ctx.fillRect(x - 4, y - 4, 8, 8);
    ctx.fillText(e.id, x + 8, y + 3);
  });
}
function showView(id) {
  collect();
  if (id !== "workspace") player.pause();
  $$(".view").forEach((el) => (el.hidden = el.id !== id));
  $$(".nav").forEach((b) =>
    b.classList.toggle("active", b.dataset.view === id),
  );
  $("#crumb").textContent = {
    workspace: "Independent listening review",
    protocol: "Review protocol",
    summary: "Results & adjudication",
  }[id];
}
function renderSummary() {
  const expected = Number($("#expected-reviewers").value);
  if (!Number.isInteger(expected) || expected < 2 || expected > 20)
    throw Error("Expected reviewer count must be 2–20.");
  const report = summarize(state.summary, expected);
  $("#summary-body").innerHTML =
    `<div class="summary-numbers"><div><b>${report.scenes}</b>Formal scenes</div><div><b>${report.recordings}</b>Receiver recordings</div><div><b>${report.questions}</b>Formal questions</div><div><b>${report.records}</b>Independent records</div><div><b>${report.excluded}</b>Pilot / exposed / playback failed</div></div><table><thead><tr><th>Review dimension</th><th>Complete samples (${expected} reviewers)</th><th>Raw agreement</th><th>Nominal α</th><th>Concern flagged</th><th>Unable to judge</th><th>Not applicable</th></tr></thead><tbody>${Object.entries(
      report.dimensions,
    )
      .map(
        ([k, v]) =>
          `<tr><td>${DIMENSIONS[k]}</td><td>${v.complete} <small>(&ge;2 reviewers: ${v.pairable})</small></td><td>${v.unanimity === null ? "—" : (v.unanimity * 100).toFixed(1) + "%"}</td><td>${v.alpha === null ? "Undefined" : v.alpha.toFixed(3)}</td><td>${v.issues}</td><td>${v.uncertain} / ${v.ratings}${v.ratings ? " (" + ((100 * v.uncertain) / v.ratings).toFixed(1) + "%)" : ""}</td><td>${v.na}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table><p class="hint">Concern, uncertainty and not-applicable counts refer to individual ratings. Agreement is calculated for the same question in the same plan; different plans are not pooled as shared samples. α can use samples with at least 2 reviewers, which does not imply completion by all ${expected} expected reviewers. α is undefined for constant ratings or absent shared ratings.</p>`;
  const groups = new Map();
  for (const r of state.summary) {
    const key = r.plan_id + ":" + r.sample_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const issues = [...groups].filter(
    ([, rs]) =>
      rs.some((r) => r.review && Object.values(r.review).includes("issue")) ||
      Object.keys(DIMENSIONS).some(
        (k) =>
          new Set(
            rs
              .map((r) =>
                k === "audibility" ? r.blind.audibility : r.review?.[k],
              )
              .filter(Boolean),
          ).size > 1,
      ),
  );
  $("#adjudication").hidden = false;
  $("#adjudication").innerHTML =
    `<h2>Adjudication · ${issues.length} samples to inspect</h2><p>Decisions here are saved separately and do not change the original ratings or agreement statistics above. Use this section after all reviewers finish their independent ratings.</p>${
      issues
        .map(([key, rs]) => {
          const d = state.adjudications[key] || {};
          return `<article class="disagreement"><h3>${escape(rs[0].task)} · <span class="mono">${escape(rs[0].sample_id)} / ${escape(rs[0].plan_id)}</span></h3>${rs
            .map(
              (r) =>
                `<p><b>${escape(r.reviewer)}</b>:${Object.keys(DIMENSIONS)
                  .map(
                    (k) =>
                      `${DIMENSIONS[k]} ${LABELS[k === "audibility" ? r.blind.audibility : r.review?.[k]] || "Pending"}`,
                  )
                  .join(
                    " · ",
                  )}<br>${escape(r.review?.notes || r.blind.notes || "No notes")}</p>`,
            )
            .join(
              "",
            )}<div class="decision-row"><select data-decision="${escape(key)}"><option value="unresolved" ${d.status === "unresolved" ? "selected" : ""}>Unresolved</option><option value="confirmed" ${d.status === "confirmed" ? "selected" : ""}>Confirmed error</option><option value="corrected" ${d.status === "corrected" ? "selected" : ""}>Corrected</option><option value="difficulty" ${d.status === "difficulty" ? "selected" : ""}>Valid difficulty</option><option value="no_issue" ${d.status === "no_issue" ? "selected" : ""}>No confirmed issue</option></select><input data-reason="${escape(key)}" value="${escape(d.reason || "")}" placeholder="Reason, correction, version or unresolved issue"><button class="button small" data-save-decision="${escape(key)}">Save adjudication</button></div></article>`;
        })
        .join("") || "<p>No concerns or disagreements to adjudicate yet.</p>"
    }`;
  $$("[data-save-decision]").forEach(
    (b) =>
      (b.onclick = guard(() => {
        const key = b.dataset.saveDecision,
          reason = $$("[data-reason]")
            .find((e) => e.dataset.reason === key)
            .value.trim();
        const status = $$("[data-decision]").find(
          (e) => e.dataset.decision === key,
        ).value;
        if (!reason) throw Error("Enter the reason and action taken for this adjudication.");
        state.adjudications[key] = {
          status,
          reason,
          by: state.user || "coordinator",
          at: new Date().toISOString(),
        };
        localStorage.setItem(
          "dish-adjudications",
          JSON.stringify(state.adjudications),
        );
        toast("Adjudication saved separately.");
      })),
  );
}
async function calibrationSound(direction) {
  player.pause();
  await player.context();
  let b;
  const rate = 16000,
    n = rate;
  if (direction.startsWith("ear-")) {
    b = player.ctx.createBuffer(2, n, rate);
    const data = b.getChannelData(direction === "ear-left" ? 0 : 1);
    for (let i = 0; i < n; i++)
      data[i] =
        0.1 *
        Math.sin((2 * Math.PI * 440 * i) / rate) *
        Math.sin((Math.PI * i) / n) ** 2;
  } else {
    const angle =
        ({ front: 0, left: 90, right: -90, back: 180 }[direction] * Math.PI) /
        180,
      coeff = [1, Math.sin(angle), 0, Math.cos(angle)],
      rng = random("calibration");
    const noise = Float32Array.from(
      { length: n },
      (_, i) => (rng() * 2 - 1) * 0.15 * Math.sin((Math.PI * i) / n) ** 2,
    );
    b = await decodeFOA(
      { rate, length: n, data: coeff.map((c) => noise.map((x) => x * c)) },
      state.decoder,
    );
  }
  if (state.calSource) {
    try {
      state.calSource.stop();
    } catch {}
  }
  const src = player.ctx.createBufferSource();
  src.buffer = b;
  src.connect(player.volume);
  src.start();
  state.calSource = src;
}
async function init() {
  $("#seed").value = crypto.randomUUID().slice(0, 8);
  state.catalog = await getJSON("data/catalog.json");
  state.decoder = await getJSON("assets/decoder.json");
  const tasks = [
    ...new Set(
      state.catalog.scenes.flatMap((s) => s.questions.map((q) => q.task)),
    ),
  ].sort();
  $("#task").innerHTML =
    '<option value="all">All tasks</option>' +
    tasks.map((t) => `<option>${escape(t)}</option>`).join("");
  $$("[data-view]").forEach(
    (b) => (b.onclick = guard(() => showView(b.dataset.view))),
  );
  $("#set-reviewer").onclick = guard(enterUser);
  $("#reviewer").onkeydown = (e) => {
    if (e.key === "Enter") guard(enterUser)();
  };
  $("#sample").onclick = guard(sample);
  $("#pilot-preset").onclick = () => {
    $("#phase").value = "pilot";
    $("#count").value = 20;
    $("#mode").value = "balanced";
    $("#task").value = "all";
    toast("20-scene pilot selected. Click Draw samples to begin.");
  };
  $("#formal-preset").onclick = () => {
    $("#phase").value = "formal";
    $("#count").value = 200;
    $("#mode").value = "balanced";
    $("#task").value = "all";
    toast("100 static + 100 dynamic scenes selected. Draw samples, then export one plan for all three reviewers.");
  };
  $("#export-plan").onclick = guard(() => {
    needUser();
    if (!state.profile.plan) throw Error("Draw samples first.");
    download(
      "dish-plan-" + state.profile.plan.id + ".json",
      state.profile.plan,
    );
  });
  $("#import-plan").onchange = guard(async (e) => {
    needUser();
    const file = e.target.files[0];
    if (!file) return;
    collect();
    const plan = validatePlan(JSON.parse(await file.text()), state.catalog);
    state.entry = null;
    state.profile.plan = plan;
    save();
    await selectSample(0);
    toast("Shared plan loaded. All reviewers will use the same questions.");
    e.target.value = "";
  });
  $("#export-results").onclick = guard(() => {
    needUser();
    collect();
    download("dish-reviews-" + state.user + ".json", exportData());
  });
  $("#calibrate").onclick = () => {
    $("#headphones").value = state.profile.calibration?.headphones || "";
    $("#cal-check").checked = state.profile.calibration?.confirmed || false;
    $("#calibration").showModal();
  };
  $$("[data-cal]").forEach(
    (b) => (b.onclick = guard(() => calibrationSound(b.dataset.cal))),
  );
  $("#save-cal").onclick = guard(() => {
    needUser();
    if (!$("#cal-check").checked || !$("#headphones").value.trim())
      throw Error("Enter your playback device and confirm calibration.");
    state.profile.calibration = {
      headphones: $("#headphones").value.trim(),
      confirmed: true,
      at: new Date().toISOString(),
      decoder: state.decoder.id,
      user_agent: navigator.userAgent,
    };
    save();
    $("#calibration").close();
    toast("Headphone and direction settings saved.");
  });
  $("#calibration").onclose = () => {
    try {
      state.calSource?.stop();
    } catch {}
  };
  $("#import-results").onchange = guard(async (e) => {
    const exports = await Promise.all(
      [...e.target.files].map(async (f) => JSON.parse(await f.text())),
    );
    if (
      exports.some(
        (x) =>
          x.revision !== state.catalog.revision ||
          x.protocol !== state.catalog.protocol ||
          x.version !== VERSION,
      )
    )
      throw Error("The export does not match the current dataset or tool version.");
    state.summary = mergeExports(exports);
    renderSummary();
    toast(`Merged ${state.summary.length} independent records.`);
    e.target.value = "";
  });
  $("#my-summary").onclick = guard(() => {
    needUser();
    state.summary = state.profile.records;
    renderSummary();
  });
  $("#expected-reviewers").onchange = guard(renderSummary);
  $("#export-csv").onclick = guard(() =>
    download(
      "dish-review-records.csv",
      csv(state.summary),
      "text/csv;charset=utf-8",
    ),
  );
  $("#export-summary").onclick = guard(() =>
    download("dish-review-summary.json", {
      schema: "dish-summary-1",
      created_at: new Date().toISOString(),
      expected_reviewers: Number($("#expected-reviewers").value),
      statistics: summarize(
        state.summary,
        Number($("#expected-reviewers").value),
      ),
      adjudications: state.adjudications,
      independent_records: state.summary,
    }),
  );
  state.adjudications = JSON.parse(
    localStorage.getItem("dish-adjudications") || "{}",
  );
  updateMetrics();
  const last = localStorage.getItem("dish-user");
  if (last) {
    $("#reviewer").value = last;
    await enterUser();
  }
  window.addEventListener("resize", () => {
    drawWave();
    drawMap(player.position);
  });
  window.addEventListener("beforeunload", () => {
    try {
      collect();
    } catch {}
  });
}
init().catch((e) => {
  console.error(e);
  toast("Initialization failed: " + e.message, true);
  $("#save-status").textContent = "Loading failed. Refresh to try again.";
});
