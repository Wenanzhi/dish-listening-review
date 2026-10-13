export const VERSION = "dish-review-1.0";
export const DIMENSIONS = {
  audibility: "Blind audibility",
  quality: "Audio & rendering",
  text: "Speech & transcript",
  target: "Question & target",
  spatial: "Space & time",
  cross: "Cross-receiver match",
};
export const LABELS = {
  clear: "Clearly discernible",
  partial: "Partly discernible",
  masked: "Indiscernible",
  empty: "No target in queried region",
  uncertain: "Unable to judge",
  pass: "No anomaly found",
  issue: "Concern flagged",
  na: "Not applicable",
};
export function hash(s) {
  let h = 2166136261;
  for (const c of s) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return (h >>> 0).toString(16).padStart(8, "0");
}
export function random(seed) {
  let n = parseInt(hash(seed), 16);
  return () => {
    n += 0x6d2b79f5;
    let t = n;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function shuffle(xs, rng) {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
export function makePlan(
  catalog,
  {
    seed,
    count = 12,
    mode = "balanced",
    phase = "pilot",
    task = "all",
    excluded = [],
  },
) {
  if (!Number.isInteger(count) || count < 1 || count > 800)
    throw Error("Scene count must be 1–800.");
  const rng = random(seed),
    used = new Set(excluded),
    picks = [];
  const eligible = catalog.scenes.filter(
    (s) =>
      !used.has(s.base) &&
      s.questions.some((q) => task === "all" || q.task === task),
  );
  const targets =
    mode === "balanced"
      ? { static: Math.ceil(count / 2), dynamic: Math.floor(count / 2) }
      : { [mode]: count };
  for (const [m, n] of Object.entries(targets)) {
    const rooms = new Map();
    for (const s of shuffle(
      eligible.filter((s) => s.mode === m),
      rng,
    )) {
      if (!rooms.has(s.room)) rooms.set(s.room, []);
      rooms.get(s.room).push(s);
    }
    let taken = 0;
    while (taken < n) {
      let progress = false;
      for (const room of shuffle([...rooms.keys()], rng)) {
        const list = rooms.get(room);
        let s;
        while (list.length) {
          const x = list.pop();
          if (!used.has(x.base)) {
            s = x;
            break;
          }
        }
        if (!s) continue;
        const q = shuffle(
          s.questions.filter((q) => task === "all" || q.task === task),
          rng,
        )[0];
        picks.push({
          episode_id: s.id,
          sample_id: q.id,
          mode: s.mode,
          base: s.base,
          room: s.room,
        });
        used.add(s.base);
        taken++;
        progress = true;
        if (taken === n) break;
      }
      if (!progress)
        throw Error(
          `Fewer than ${n} unexposed ${m} scenes are available. Reduce the count, change the filter or import a shared plan.`,
        );
    }
  }
  const samples = shuffle(picks, rng),
    id = hash(catalog.revision + phase + JSON.stringify(samples));
  return {
    schema: "dish-plan-1",
    id,
    revision: catalog.revision,
    protocol: catalog.protocol,
    phase,
    seed,
    task,
    sampling: "mode quotas; randomized room round robin; unique base scenes",
    samples,
  };
}
export function validatePlan(plan, catalog) {
  if (
    plan.schema !== "dish-plan-1" ||
    plan.revision !== catalog.revision ||
    plan.protocol !== catalog.protocol ||
    !["pilot", "formal"].includes(plan.phase) ||
    !Array.isArray(plan.samples) ||
    !plan.samples.length
  )
    throw Error("Sample plan version, protocol or dataset does not match.");
  const ids = new Set();
  for (const p of plan.samples) {
    const s = catalog.scenes.find((x) => x.id === p.episode_id);
    if (
      !s ||
      !s.questions.some((q) => q.id === p.sample_id) ||
      ids.has(p.sample_id) ||
      p.base !== s.base ||
      p.mode !== s.mode ||
      p.room !== s.room
    )
      throw Error("The sample plan contains invalid, duplicate or mismatched samples.");
    ids.add(p.sample_id);
  }
  if (
    plan.id !==
    hash(catalog.revision + plan.phase + JSON.stringify(plan.samples))
  )
    throw Error("Sample plan ID verification failed.");
  return plan;
}
export function nominalAlpha(units) {
  // Krippendorff coincidence weighting: each pairable unit contributes n_u values.
  const pairable = units.filter((u) => u.length >= 2),
    counts = new Map();
  let n = 0,
    disagreement = 0;
  for (const u of pairable) {
    let diff = 0;
    for (const a of u) {
      counts.set(a, (counts.get(a) || 0) + 1);
      for (const b of u) if (a !== b) diff++;
    }
    n += u.length;
    disagreement += diff / (u.length - 1);
  }
  if (n < 2) return null;
  const expected =
    (n * n - [...counts.values()].reduce((a, v) => a + v * v, 0)) /
    (n * (n - 1));
  if (expected === 0) return null; // constant ratings: alpha undefined, not automatically 1.
  return 1 - disagreement / n / expected;
}
export function mergeExports(exports) {
  const records = new Map();
  let signature;
  for (const x of exports) {
    if (
      x.schema !== "dish-reviews-1" ||
      !x.reviewer ||
      !Array.isArray(x.records)
    )
      throw Error("This is not a valid review export.");
    const sig = [x.revision, x.protocol, x.version].join(":");
    if (signature && signature !== sig)
      throw Error("Cannot merge exports from different datasets, protocols or tool versions.");
    signature = sig;
    for (const r of x.records) {
      if (
        r.reviewer !== x.reviewer ||
        !r.sample_id ||
        !r.blind ||
        !r.plan_id ||
        !["pilot", "formal"].includes(r.phase)
      )
        throw Error("A record is missing independent ratings or has a mismatched reviewer ID.");
      const key = [r.reviewer, r.plan_id, r.sample_id].join(":");
      const old = records.get(key);
      if (old && JSON.stringify(old) !== JSON.stringify(r))
        throw Error("Conflicting records exist for the same reviewer and question. Import only their latest complete export.");
      records.set(key, r);
    }
  }
  return [...records.values()];
}
export function summarize(records, expected = 3) {
  const formal = records.filter(
    (r) =>
      r.phase === "formal" && !r.prior_exposure && !r.blind.playback_failed,
  );
  const report = {
    records: formal.length,
    excluded: records.length - formal.length,
    scenes: new Set(formal.map((r) => r.episode_id)).size,
    recordings: new Set(formal.flatMap((r) => r.recording_ids || [])).size,
    questions: new Set(formal.map((r) => r.sample_id)).size,
    dimensions: {},
  };
  for (const dim of Object.keys(DIMENSIONS)) {
    const groups = new Map();
    let uncertain = 0,
      na = 0,
      issues = 0,
      total = 0;
    for (const r of formal) {
      const v = dim === "audibility" ? r.blind.audibility : r.review?.[dim];
      if (!v) continue;
      total++;
      if (v === "uncertain") uncertain++;
      if (v === "na") {
        na++;
        continue;
      }
      if (v === "issue") issues++;
      const k = [r.plan_id, r.sample_id].join(":");
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(v);
    }
    // Uncertain is retained as a nominal category, and also explicitly reported.
    const units = [...groups.values()],
      complete = units.filter((u) => u.length === expected);
    report.dimensions[dim] = {
      ratings: total,
      issues,
      uncertain,
      na,
      complete: complete.length,
      pairable: units.filter((u) => u.length >= 2).length,
      unanimity: complete.length
        ? complete.filter((u) => new Set(u).size === 1).length / complete.length
        : null,
      alpha: nominalAlpha(units),
    };
  }
  return report;
}
export function csv(records) {
  const keys = [
    "reviewer",
    "plan_id",
    "phase",
    "episode_id",
    "sample_id",
    "mode",
    "prior_exposure",
    "audibility",
    "quality",
    "text",
    "target",
    "spatial",
    "cross",
    "notes",
  ];
  const quote = (x) => '"' + String(x ?? "").replaceAll('"', '""') + '"';
  return (
    "\ufeff" +
    [
      keys,
      ...records.map((r) =>
        keys.map((k) =>
          k === "audibility"
            ? r.blind?.audibility
            : k === "notes"
              ? JSON.stringify({
                  blind: r.blind?.notes,
                  review: r.review?.notes,
                  marks: r.marks,
                })
              : (r.review?.[k] ?? r[k]),
        ),
      ),
    ]
      .map((a) => a.map(quote).join(","))
      .join("\r\n")
  );
}
