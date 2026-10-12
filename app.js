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
      toast(e.message || "操作失败，请重试", true);
    }
  };
}
async function getJSON(url) {
  const r = await fetch(url);
  if (!r.ok) throw Error(`无法读取 ${url} (${r.status})`);
  return r.json();
}
function save() {
  try {
    localStorage.setItem(
      "dish-profile:" + state.user,
      JSON.stringify(state.profile),
    );
    localStorage.setItem("dish-user", state.user);
    $("#save-status").textContent = "✓ 已保存在此浏览器";
  } catch (e) {
    $("#save-status").textContent = "保存失败，请立即导出";
    throw Error("浏览器存储空间不足或不可用。请导出结果后再继续。");
  }
}
function needUser() {
  if (!state.user) throw Error("请先输入审阅者代号并点击进入");
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
    ? `审阅者 ${state.user}`
    : "请先设置审阅者代号";
  $("#plan-mode").textContent = plan
    ? `${plan.phase === "pilot" ? "试审" : "正式"} · ${plan.samples.filter((s) => s.mode === "static").length} 静态 / ${plan.samples.filter((s) => s.mode === "dynamic").length} 动态`
    : "等待抽样";
  $("#plan-id").textContent = plan ? "清单 " + plan.id : "独立随机 / 共享清单";
  $("#queue-progress").textContent =
    completed + " / " + (plan?.samples.length || 0);
  $("#progress-fill").style.width =
    (plan ? (100 * completed) / plan.samples.length : 0) + "%";
  if (!plan) {
    $("#queue").innerHTML =
      '<div class="empty-queue">设置条件并抽取样本，<br>开始独立听审。</div>';
    return;
  }
  $("#queue").innerHTML = plan.samples
    .map((p, i) => {
      const r = records.find((x) => x.sample_id === p.sample_id),
        q = state.catalog.scenes
          .find((s) => s.id === p.episode_id)
          .questions.find((q) => q.id === p.sample_id);
      return `<button class="queue-item ${i === state.current ? "active" : ""}" data-index="${i}"><div class="queue-top"><span><span class="index">${String(i + 1).padStart(2, "0")}</span>${p.mode === "static" ? "静态场景" : "动态场景"}</span><span class="${r?.review ? "done" : ""}">${r?.review ? "✓" : r?.blind ? "◐" : "○"}</span></div><small>${escape(q.task)} · ${q.setting === "edge" ? "端侧" : "云端"}</small></button>`;
    })
    .join("");
  $$(".queue-item").forEach(
    (b) => (b.onclick = guard(() => selectSample(Number(b.dataset.index)))),
  );
}
async function enterUser() {
  const id = $("#reviewer").value.trim();
  if (!id) throw Error("请填写审阅者代号");
  if (id.length > 40) throw Error("代号过长");
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
      '<div class="empty-state"><div class="empty-icon">◖◗</div><h2>已进入个人工作台</h2><p>完成耳机校准，然后随机抽取一组场景。</p></div>';
  }
  toast(`已进入 ${id} 的独立记录`);
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
  toast(`已抽取 ${plan.samples.length} 个场景，清单 ${plan.id}`);
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
      .map(([k, v]) => `${k} 已听 ${Math.round(v * 100)}%`)
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
    '<div class="empty-state"><h2>正在加载场景…</h2><p>读取原始题目与音频绑定。</p></div>';
  $("#form-panel").hidden = true;
  updateMetrics();
  const scene = await getJSON(`data/scenes/${state.entry.episode_id}.json`);
  if (token !== state.token) return;
  state.scene = scene;
  state.question = scene.questions.find((q) => q.id === state.entry.sample_id);
  if (!state.question) throw Error("题目与场景不匹配");
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
    `<div class="sample-head"><div><div class="eyebrow">SAMPLE ${String(state.current + 1).padStart(2, "0")} / ${state.profile.plan.samples.length}</div><h2>${p.mode === "static" ? "静态" : "动态"}场景 <span class="mono">${p.episode_id.slice(0, 8)}</span></h2><p>${q.setting === "edge" ? "端侧视角" : "云端视角"} · ${escape(q.task)} · ${state.scene.duration.toFixed(1)} 秒 · ${q.receiver_ids.length} 个题目接收端</p></div><span class="badge">${state.profile.plan.phase === "pilot" ? "试审样本" : "正式样本"}</span></div><div class="stage-tabs"><span class="${second ? "" : "active"}">01 无提示盲听 ${second ? "✓" : ""}</span><span class="line"></span><span class="${second ? "active" : ""}">02 参考核验 ${second ? "" : "⌑"}</span><span class="line"></span><span>03 ${r?.review ? "已完成 ✓" : "保存记录"}</span></div>${seen ? '<div class="exposure">此前已看过同基础场景的答案。这条记录会标记为已曝光，不计入正式独立统计。</div>' : ""}<div class="prompt"><h3>本题要求</h3><pre>${escape(shortPrompt(q.prompt))}</pre><details><summary>展开完整原始题目与允许使用的信息</summary><pre>${escape(q.prompt)}</pre></details></div><div class="audio-deck"><div class="deck-top"><div class="receiver-buttons">${currentAudio()
      .map(
        (a, i) =>
          `<button class="receiver ${i === 0 ? "active" : ""}" data-receiver="${escape(a.id)}">◉ ${escape(a.id)}</button>`,
      )
      .join(
        "",
      )}</div><span class="decoder-label">FOA → KEMAR 双耳 · 固定头朝向</span><button id="download-binaural" class="button small" disabled>↓ 双耳 WAV</button></div><div class="wave-wrap" id="wave-wrap"><canvas id="waveform"></canvas><div id="playhead" class="playhead"></div></div><div class="time-ruler">${[0, 0.25, 0.5, 0.75, 1].map((t) => `<span>${time(t * state.scene.duration)} s</span>`).join("")}</div><div class="transport"><button id="play" class="play-button" aria-label="播放 / 暂停" disabled>▶</button><button id="restart" class="icon-button" aria-label="从头播放">↺</button><time id="clock">00.0 / ${time(state.scene.duration)} s</time><button id="mark-now" class="button small">＋ 标记此刻</button><label>音量<input id="volume" type="range" min="0" max="1" step="0.05" value="${player.gain}" aria-label="音量"></label></div><input id="seek" type="range" min="0" max="${state.scene.duration}" step="0.05" value="0" aria-label="播放位置" style="width:100%;accent-color:#789359"><div id="deck-status" class="deck-status">正在加载并校验原始 FOA…</div><div id="coverage" class="coverage"></div></div><p class="hint">切换接收端保留时间位置。波形取自原始 W 通道；所有接收端采用同一播放增益。请先听完整段，再核查局部。</p><div id="reference-area">${second ? referenceHTML() : `<div class="locked">⌑ 参考答案与源语音将在提交独立判断后解锁。</div>`}</div>`;
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
    if (!buffer) throw Error("请先加载当前接收端音频");
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
          toast("此接收端仍在加载或加载失败");
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
        throw Error("SHA-256 与冻结发布不一致");
      const wav = parseWav(bytes);
      if (wav.length / wav.rate !== state.scene.duration)
        throw Error("音频长度与场景不一致");
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
        `${player.buffers.size} / ${audio.length} 接收端已就绪 · 原始 SHA-256 已核验${peak > 1 ? " · 解码峰值 > 1，请降低音量" : ""}`;
    } catch (e) {
      if (token !== state.token) return;
      state.loadErrors.push(a.id + ": " + e.message);
      $("#deck-status").innerHTML =
        `<span class="error">${escape(state.loadErrors.join("；"))}。可重试，或记录播放失败。</span> <button id="retry-audio" class="button small">重试</button>`;
      $("#retry-audio").onclick = guard(() => loadAudio(++state.token));
    }
  }
  if (token !== state.token) return;
  if (player.buffers.size) {
    $("#play").disabled = false;
      $("#download-binaural").disabled = false;
    drawWave();
    $("#deck-status").textContent =
      `${player.buffers.size} / ${audio.length} 接收端已就绪 · 原始 SHA-256 已核验`;
  }
  if (state.loadErrors.length)
    $("#deck-status").innerHTML =
      `<span class="error">${escape(state.loadErrors.join("；"))}</span> <button id="retry-audio" class="button small">重试加载</button>`;
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
    `<div class="form-heading"><h2>${second ? "02 · 对照参考，核验疑点" : "01 · 独立听辨，不看答案"}</h2><span class="badge">${finished ? "已完成并锁定" : second ? "盲听记录已锁定" : "请独立判断"}</span></div>${second ? `<div class="locked">第一阶段：${escape(LABELS[r.blind.audibility])} · 音频：${escape(LABELS[r.blind.quality])}<br>${escape(r.blind.notes || "未填写额外疑点")}${r.blind.response ? "<br>无提示回答：" + escape(r.blind.response) : ""}</div>` : ""}<div id="ratings">${second ? ["quality", "text", "target", "spatial", "cross"].map((dim) => radio(dim, DIMENSIONS[dim], ["pass", "issue", "uncertain", "na"], values[dim], finished, dim === "cross" ? "场景只有一个接收端时可选不适用" : "")).join("") : radio("audibility", "目标在混音中是否可辨？", ["clear", "partial", "masked", "empty", "uncertain"], values.audibility) + radio("quality", "音频与渲染是否有异常？", ["pass", "issue", "uncertain"], values.quality)}</div><div class="notes-grid"><label>${second ? "核验依据与疑点（有疑点 / 无法判断时必填）" : "独立听辨疑点（有疑点 / 无法辨认时必填）"}<textarea name="notes" placeholder="例如：8–11 秒目标被覆盖，无法核验这几个词。" ${finished ? "disabled" : ""}>${escape(values.notes || "")}</textarea></label><label>${second ? "建议处理（可选）" : "你听到的内容或判断依据（可选）"}<textarea name="response" placeholder="保留自己的判断，不需要猜测。" ${finished ? "disabled" : ""}>${escape(values.response || "")}</textarea></label></div>${!second ? `<label class="check-row"><input id="playback-failed" type="checkbox" ${values.playback_failed ? "checked" : ""}>播放失败 / 无法完成听审（记录为缺失，不计为通过）</label>` : ""}<div class="marks"><h3>时间点与证据 <span class="mono">${second ? "核验阶段" : "独立阶段"}</span></h3>${finished ? "" : `<div class="mark-fields"><label>起点 / 秒<input id="mark-start" type="number" min="0" max="${state.scene.duration}" step="0.1" value="0"></label><label>终点 / 秒<input id="mark-end" type="number" min="0" max="${state.scene.duration}" step="0.1" value="1"></label><label>原因<input id="mark-note" maxlength="1000" placeholder="记录听到的问题、受影响的词或接收端"></label><button id="add-mark" class="button small">添加</button></div>`}<div id="mark-list"></div></div><div class="form-footer"><span class="quiet">${finished ? "结果已保存在此浏览器，记得导出。" : second ? "本阶段仍为独立意见；集中复核结果另存。" : "提交后锁定第一阶段，再解锁答案。"}</span><button id="submit-stage" class="button primary">${finished ? "下一个场景 →" : second ? "完成此样本 ✓" : "锁定独立判断，查看参考 →"}</button></div>`;
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
        `<div class="mark-item"><b>${time(m.start)}–${time(m.end)} s</b><span>${escape(m.receiver || "")} · ${m.stage === "blind" ? "盲听" : "核验"} · ${escape(m.note)}</span>${i >= (r?.marks?.length || 0) && !r?.review ? `<button data-remove-mark="${i - (r?.marks?.length || 0)}" aria-label="删除标记">×</button>` : ""}</div>`,
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
    throw Error("请填写有效时间区间与具体原因");
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
  if (!b.audibility || !b.quality) throw Error("请完成两个独立判断");
  if (!state.profile.calibration?.confirmed && !b.playback_failed)
    throw Error("请先完成耳机与方向校准");
  if (
    (["partial", "masked", "uncertain"].includes(b.audibility) ||
      b.quality !== "pass" ||
      b.playback_failed) &&
    !(b.notes || "").trim()
  )
    throw Error("请记录具体疑点或无法判断的原因");
  const coverage = player.coverage();
  if (
    !b.playback_failed &&
    state.question.receiver_ids.some((id) => (coverage[id] || 0) < 0.95)
  )
    throw Error("请先完整试听每个题目接收端（至少 95%），再锁定判断");
  if (
    b.playback_failed &&
    (b.audibility !== "uncertain" || b.quality !== "uncertain")
  )
    throw Error("播放失败时，请将可辨程度与音频质量都标记为“无法判断”");
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
  toast("独立判断已锁定。可对照源语音，并切换全部接收端核验。");
  await loadAudio(token);
}
async function submitReview() {
  collect();
  const r = record(),
    d = draft(),
    v = d.review;
  for (const dim of ["quality", "text", "target", "spatial", "cross"])
    if (!v[dim])
      throw Error("请完成全部核验项；无法核验时选择“无法判断”或“不适用”");
  if (
    Object.values(v).some((x) => x === "issue" || x === "uncertain") &&
    !(v.notes || "").trim()
  )
    throw Error("请写明疑点或无法判断的原因");
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
  toast("此样本已完成。独立意见已保存，记得导出。");
}
async function nextSample() {
  if (state.current + 1 < state.profile.plan.samples.length)
    await selectSample(state.current + 1);
  else toast("已到本轮最后一个场景，请导出结果。");
}
function referenceHTML() {
  const ref = state.reference;
  if (!ref) return "";
  const g = ref.questions[state.entry.sample_id];
  const sourceCards = ref.sources
    .map(
      (s) =>
        `<article class="source-card"><b>${escape(s.entity_id)} ${g.target_source_id === s.entity_id ? "· 本题目标" : ""} <span class="mono">混音 ${time(s.start)}–${time(s.end)} s</span></b><p>${escape(s.text)}</p><audio controls preload="none" src="${escape(s.audio)}"></audio><div class="source-meta">原始源片段 · ${escape(s.original_corpus_path)} · ${escape(s.license)}<br>原片采样区间 [${s.crop_samples.join(", ")}）· 无损 FLAC</div></article>`,
    )
    .join("");
  return `<section class="reference-box"><div class="panel-title"><h2>参考核验资料</h2><span class="badge">仅在第二阶段显示</span></div><p>目标：<b>${escape(g.target_source_id)}</b> · ${escape(g.case || "")} · 参考答案如下</p><pre class="reference-output">${escape(typeof g.output === "string" ? g.output : JSON.stringify(g.output, null, 2))}</pre><div class="ref-grid"><div><h3>原始语音与对应转写</h3>${sourceCards || "<p>未提供源语音。</p>"}</div><div><h3>标注轨迹 · 随播放时间显示</h3><canvas id="scene-map" class="scene-map" aria-label="参考场景轨迹"></canvas><p class="hint">圆点为人，方块为机器人；俯视图为世界 X / Z。虚线为完整轨迹，当前位置随时间变化。此图来自标注，不能作为独立验证证据。</p><div class="callout">“听不清”与“对应错误”分别记录。精确方向、距离与坐标需通过几何检查。</div></div></div></section>`;
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
  ctx.fillText(`标注时间 ${t.toFixed(1)} s  ·  +X → / +Z ↓`, 12, 17);
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
    workspace: "独立人工听审",
    protocol: "审查规则",
    summary: "汇总与复核",
  }[id];
}
function renderSummary() {
  const expected = Number($("#expected-reviewers").value);
  if (!Number.isInteger(expected) || expected < 2 || expected > 20)
    throw Error("预期人数应为 2–20");
  const report = summarize(state.summary, expected);
  $("#summary-body").innerHTML =
    `<div class="summary-numbers"><div><b>${report.scenes}</b>正式场景</div><div><b>${report.recordings}</b>题目接收端录音</div><div><b>${report.questions}</b>正式问题</div><div><b>${report.records}</b>独立记录</div><div><b>${report.excluded}</b>试审 / 已曝光 / 播放失败</div></div><table><thead><tr><th>审查维度</th><th>${expected} 人完整共同样本</th><th>原始一致率</th><th>名义 α</th><th>发现疑点</th><th>无法判断</th><th>不适用</th></tr></thead><tbody>${Object.entries(
      report.dimensions,
    )
      .map(
        ([k, v]) =>
          `<tr><td>${DIMENSIONS[k]}</td><td>${v.complete} <small>（≥2 人：${v.pairable}）</small></td><td>${v.unanimity === null ? "—" : (v.unanimity * 100).toFixed(1) + "%"}</td><td>${v.alpha === null ? "未定义" : v.alpha.toFixed(3)}</td><td>${v.issues}</td><td>${v.uncertain} / ${v.ratings}${v.ratings ? " (" + ((100 * v.uncertain) / v.ratings).toFixed(1) + "%)" : ""}</td><td>${v.na}</td></tr>`,
      )
      .join(
        "",
      )}</tbody></table><p class="hint">疑点、无法判断、不适用以审阅意见条数计。同一清单、同一题作为一致性单位；不同清单不混为共同样本。α 可使用 ≥2 人的样本，不代表已完成预期 ${expected} 人审查。恒定评分或缺少共同评分时 α 未定义。</p>`;
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
    `<h2>集中复核 · ${issues.length} 个待查看样本</h2><p>这里的结论单独保存，不改变原始意见和上表的一致性统计。请在审阅者全部完成独立判断后使用。</p>${
      issues
        .map(([key, rs]) => {
          const d = state.adjudications[key] || {};
          return `<article class="disagreement"><h3>${escape(rs[0].task)} · <span class="mono">${escape(rs[0].sample_id)} / ${escape(rs[0].plan_id)}</span></h3>${rs
            .map(
              (r) =>
                `<p><b>${escape(r.reviewer)}</b>：${Object.keys(DIMENSIONS)
                  .map(
                    (k) =>
                      `${DIMENSIONS[k]} ${LABELS[k === "audibility" ? r.blind.audibility : r.review?.[k]] || "待完成"}`,
                  )
                  .join(
                    " · ",
                  )}<br>${escape(r.review?.notes || r.blind.notes || "无备注")}</p>`,
            )
            .join(
              "",
            )}<div class="decision-row"><select data-decision="${escape(key)}"><option value="unresolved" ${d.status === "unresolved" ? "selected" : ""}>待复核</option><option value="confirmed" ${d.status === "confirmed" ? "selected" : ""}>确认错误</option><option value="corrected" ${d.status === "corrected" ? "selected" : ""}>已修正</option><option value="difficulty" ${d.status === "difficulty" ? "selected" : ""}>合理困难</option><option value="no_issue" ${d.status === "no_issue" ? "selected" : ""}>未确认异常</option></select><input data-reason="${escape(key)}" value="${escape(d.reason || "")}" placeholder="具体原因、修正内容、版本或未解决事项"><button class="button small" data-save-decision="${escape(key)}">保存复核</button></div></article>`;
        })
        .join("") || "<p>尚无可集中复核的疑点或分歧。</p>"
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
        if (!reason) throw Error("请填写复核原因与处理说明");
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
        toast("复核意见已单独保存");
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
    '<option value="all">全部任务</option>' +
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
    toast("已设置 20 场景试审，点击随机抽取开始。");
  };
  $("#formal-preset").onclick = () => {
    $("#phase").value = "formal";
    $("#count").value = 200;
    $("#mode").value = "balanced";
    $("#task").value = "all";
    toast("已设置静态 100 + 动态 100。抽取后导出固定清单供三人共用。");
  };
  $("#export-plan").onclick = guard(() => {
    needUser();
    if (!state.profile.plan) throw Error("请先抽取样本");
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
    toast("已载入固定清单，题目与其他审阅者完全一致");
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
      throw Error("请填写播放设备并确认校准");
    state.profile.calibration = {
      headphones: $("#headphones").value.trim(),
      confirmed: true,
      at: new Date().toISOString(),
      decoder: state.decoder.id,
      user_agent: navigator.userAgent,
    };
    save();
    $("#calibration").close();
    toast("耳机与方向设置已保存");
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
      throw Error("导出文件与当前数据或工具版本不匹配");
    state.summary = mergeExports(exports);
    renderSummary();
    toast(`已合并 ${state.summary.length} 条独立记录`);
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
  toast("初始化失败：" + e.message, true);
  $("#save-status").textContent = "加载失败，请刷新重试";
});
