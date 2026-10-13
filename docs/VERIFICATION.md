# Verification record — 2026-10-12

This record concerns **software and data binding checks**, not human listening judgments. No real participant results have been generated or claimed.

- Seven Node test groups cover the frozen dataset counts, deterministic 100/100 sampling, distinct bases/room coverage, exclusion of exposed bases, tampered manifests, nominal alpha with variable/missing/constant ratings, deduplication and conflicting imports, summary exclusions, and preservation of four FLOAT WAV channels, and two-channel WAV export with clipping rejection.
- Chromium exercised real frozen mixture bytes and local lossless source FLACs: calibration, randomized scene selection, at-least-95% listening gate, locked first-stage judgment, reference reveal, interval notes, second-stage completion, reload, JSON export, individual profile isolation, imported fixed plans, playback-failure gating and mobile overflow. Test records were explicitly marked TEST ONLY and confined to disposable browser storage.
- Browser-side FIR impulse tests confirmed left directional input produces greater left-ear energy and right directional input produces greater right-ear energy (approximately 0.13762 vs 0.02626 in each case).
- The immutable Hugging Face release API responded successfully. A public mixture was fetched through its production URL, returned `Access-Control-Allow-Origin: *`, and matched the local original SHA-256 (2,688,056 bytes). Local browser workflow tests intercepted these URLs with byte-identical frozen local WAVs; that tests the app independently of this host's proxy setup, not every end user's network connection.
- Desktop and mobile layouts were rendered; Chinese UI glyphs are self-hosted. The repository screenshot shows an unreviewed sample, not fabricated quality evidence.

The local full validation passed: **39,999 question joins, 2,400 scene pairs, 4,761 recording bindings, and all 2,005 lossless source SHA-256 values**. A delayed-reference browser check also confirmed that switching to a new blind sample cannot expose a previous sample’s reference.

The publisher script executes `node scripts/validate_data.mjs` before deployment. It checks every public/reference question join, all recording bindings, source crop sample boundaries, every lossless source-file hash, release counts, and the decoder's numeric left/right contract. The `gh-pages` deployment commit contains the exact validated `web/` tree; the repository includes an optional Actions template.

Remaining evidence must come from actual reviewers: independent judgments, disagreement analysis, confirmed defects and repairs. The manuscript's pending independent-human-review claim remains pending until that study is conducted.

## English interface update — 2026-10-13

All interface copy, protocol instructions, calibration labels, reference panels, summary/adjudication labels and application error messages are now in English, with document language `en`. The seven existing Node test groups and the complete Chromium review workflow passed. Workspace, protocol, calibration, reference checks and populated statistics were inspected at 320, 390, 768 and 1440 pixels, with no Chinese interface text, page overflow or JavaScript errors. The updated screenshot contains an unreviewed sample. Audio/data assets, rating values, export schemas and local storage keys are unchanged.
