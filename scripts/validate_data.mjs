import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import assert from "node:assert/strict";
const root = path.resolve("web");
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), "utf8"));
const hash = (f) =>
  crypto
    .createHash("sha256")
    .update(fs.readFileSync(path.join(root, f)))
    .digest("hex");
const catalog = read("data/catalog.json"),
  ids = new Set(),
  recordings = new Set(),
  sources = new Map();
let count = 0;
for (const entry of catalog.scenes) {
  const pub = read(`data/scenes/${entry.id}.json`),
    ref = read(`data/references/${entry.id}.json`);
  assert.equal(pub.id, ref.id);
  assert.equal(pub.id, entry.id);
  assert.equal(pub.questions.length, entry.questions.length);
  for (const q of pub.questions) {
    assert(!ids.has(q.id));
    ids.add(q.id);
    count++;
    const g = ref.questions[q.id];
    assert(g);
    assert.equal(g.episode_id, entry.id);
    assert.equal(g.sample_id, q.id);
    assert.equal(g.task_id, q.task);
    assert.equal(g.setting, q.setting);
    assert.equal(g.base_scene_id, entry.base);
    assert.equal(g.mode, entry.mode);
    assert(q.prompt.includes("ACN/SN3D"));
    assert.deepEqual(
      q.receiver_ids,
      q.audio.map((a) => a.id),
    );
    for (const a of q.audio) {
      assert.match(a.sha256, /^[a-f0-9]{64}$/);
      assert(a.path.startsWith(`${entry.mode}/public/audio/test/${entry.id}/`));
      assert(!a.path.includes(".."));
      recordings.add(a.recording_id);
    }
  }
  for (const source of ref.sources) {
    assert(source.audio.startsWith("assets/sources/"));
    assert(!source.audio.includes(".."));
    assert.equal(
      source.crop_samples[1] - source.crop_samples[0],
      source.samples,
    );
    assert(Math.abs(source.end - source.start - source.samples / 16000) < 1e-6);
    assert(source.license === "CC BY 4.0");
    sources.set(source.audio, source.sha256);
  }
}
for (const [file, digest] of sources) assert.equal(hash(file), digest, file);
assert.equal(count, 39999);
assert.equal(recordings.size, 4761);
assert.equal(catalog.scenes.length, 2400);
assert.equal(sources.size, 2005);
const decoder = read("assets/decoder.json");
assert.equal(decoder.rate, 16000);
assert.equal(decoder.filters.length, 2);
assert(decoder.filters.every((e) => e.length === 4));
for (const sign of [1, -1]) {
  const powers = decoder.filters.map((ear) =>
    ear[0].reduce((sum, v, i) => sum + (v + sign * ear[1][i]) ** 2, 0),
  );
  assert(sign === 1 ? powers[0] > powers[1] : powers[1] > powers[0]);
}
console.log(
  `Validated ${count} questions, ${catalog.scenes.length} scenes, ${recordings.size} recording bindings, ${sources.size} lossless crops (all SHA-256 checked), and decoder left/right energy.`,
);
