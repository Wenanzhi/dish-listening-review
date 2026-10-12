import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  makePlan,
  validatePlan,
  nominalAlpha,
  mergeExports,
  summarize,
  csv,
} from "../web/core.js";
import { parseWav, encodeStereoWav } from "../web/audio.js";
const catalog = JSON.parse(
  fs.readFileSync(new URL("../web/data/catalog.json", import.meta.url)),
);
test("frozen dataset cardinality and reproducible room-balanced 100/100 sampling", () => {
  assert.deepEqual(
    [
      catalog.counts.scenes,
      catalog.counts.recordings,
      catalog.counts.questions,
    ],
    [2400, 4761, 39999],
  );
  const opts = { seed: "three-reviewers", count: 200, phase: "formal" },
    a = makePlan(catalog, opts),
    b = makePlan(catalog, opts);
  assert.deepEqual(a, b);
  assert.equal(a.samples.filter((s) => s.mode === "static").length, 100);
  assert.equal(a.samples.filter((s) => s.mode === "dynamic").length, 100);
  assert.equal(new Set(a.samples.map((s) => s.base)).size, 200);
  assert.equal(new Set(a.samples.map((s) => s.room)).size, 100);
  validatePlan(a, catalog);
  const next = makePlan(catalog, {
    ...opts,
    excluded: a.samples.map((s) => s.base),
  });
  assert(next.samples.every((s) => !a.samples.some((t) => s.base === t.base)));
});
test("tampered plans and unsupported task/mode combinations fail clearly", () => {
  const p = makePlan(catalog, { seed: "x" });
  p.samples[0].sample_id = "bad";
  assert.throws(() => validatePlan(p, catalog));
  assert.throws(() =>
    makePlan(catalog, { seed: "x", mode: "static", task: "DOA_TRAJECTORY" }),
  );
});
test("nominal alpha handles chance disagreement, variable raters, missing and constants", () => {
  assert.equal(
    nominalAlpha([
      ["a", "a"],
      ["b", "b"],
    ]),
    1,
  );
  assert.equal(
    nominalAlpha([
      ["a", "b"],
      ["a", "b"],
    ]),
    -0.5,
  );
  assert.ok(
    Math.abs(
      nominalAlpha([
        ["a", "a", "b"],
        ["b", "b"],
      ]) -
        1 / 3,
    ) < 1e-12,
  );
  assert.equal(nominalAlpha([["a"], ["b"]]), null);
  assert.equal(
    nominalAlpha([
      ["uncertain", "uncertain"],
      ["uncertain", "uncertain"],
    ]),
    null,
  );
});
const base = {
  reviewer: "r1",
  plan_id: "p",
  sample_id: "q",
  episode_id: "e",
  phase: "formal",
  recording_ids: ["a"],
  blind: { audibility: "clear" },
  review: {
    quality: "pass",
    text: "uncertain",
    target: "pass",
    spatial: "na",
    cross: "na",
  },
};
test("agreement counts shared questions only; uncertainty is not pass; pilot and exposed excluded", () => {
  const other = { ...base, reviewer: "r2" },
    third = { ...base, reviewer: "r3" };
  const s = summarize([
    base,
    other,
    third,
    { ...base, sample_id: "pilot", phase: "pilot" },
    { ...base, sample_id: "exposed", prior_exposure: true },
  ]);
  assert.equal(s.scenes, 1);
  assert.equal(s.questions, 1);
  assert.equal(s.recordings, 1);
  assert.equal(s.excluded, 2);
  assert.equal(s.dimensions.quality.unanimity, 1);
  assert.equal(s.dimensions.text.uncertain, 3);
  assert.equal(s.dimensions.spatial.complete, 0);
  assert.equal(
    summarize([base, { ...other, plan_id: "different" }]).dimensions.quality
      .pairable,
    0,
  );
});
test("merge deduplicates exact exports and refuses conflicting reviewer records", () => {
  const x = {
    schema: "dish-reviews-1",
    version: "1",
    revision: "v",
    protocol: "t",
    reviewer: "r1",
    records: [base],
  };
  assert.equal(mergeExports([x, x]).length, 1);
  assert.throws(() =>
    mergeExports([
      x,
      { ...x, records: [{ ...base, review: { quality: "issue" } }] },
    ]),
  );
  assert.throws(() => mergeExports([x, { ...x, revision: "other" }]));
  assert.match(csv([base]), /audibility/);
});
test("four-channel FLOAT WAV parsing preserves channel order and rejects stereo", () => {
  const buf = new ArrayBuffer(44 + 4 * 4 * 3),
    d = new DataView(buf);
  const put = (p, s) =>
    [...s].forEach((c, i) => d.setUint8(p + i, c.charCodeAt(0)));
  put(0, "RIFF");
  d.setUint32(4, buf.byteLength - 8, true);
  put(8, "WAVE");
  put(12, "fmt ");
  d.setUint32(16, 16, true);
  d.setUint16(20, 3, true);
  d.setUint16(22, 4, true);
  d.setUint32(24, 16000, true);
  d.setUint16(32, 16, true);
  d.setUint16(34, 32, true);
  put(36, "data");
  d.setUint32(40, 48, true);
  for (let i = 0; i < 12; i++) d.setFloat32(44 + i * 4, i / 16, true);
  const x = parseWav(buf);
  assert.equal(x.length, 3);
  assert.equal(x.data[1][1], 5 / 16);
  assert.equal(x.data[3][2], 11 / 16);
  d.setUint16(22, 2, true);
  assert.throws(() => parseWav(buf));
});

test("binaural download keeps left/right samples and rejects clipping", () => {
  const channels = [new Float32Array([1, -1, 0]), new Float32Array([0, 0.5, -0.5])];
  const buffer = {numberOfChannels: 2, length: 3, sampleRate: 16000,
    getChannelData: c => channels[c]};
  const wav = new DataView(encodeStereoWav(buffer, 0.5));
  assert.equal(wav.getUint16(22, true), 2);
  assert.equal(wav.getUint32(24, true), 16000);
  assert.equal(wav.getUint32(40, true), 12);
  assert.equal(wav.getInt16(44, true), 16384);
  assert.equal(wav.getInt16(46, true), 0);
  assert.equal(wav.getInt16(48, true), -16384);
  assert.equal(wav.getInt16(50, true), 8192);
  assert.throws(() => encodeStereoWav(buffer, 2));
  assert.throws(() => encodeStereoWav({...buffer, numberOfChannels: 4}));
});
