# Independent listening review protocol v1

Purpose: sample-check render integrity, correspondence between questions/targets/references, and perceptual accessibility in mixtures. This is not a scored human benchmark for DOA, distance or ASR performance.

## Sampling and independence

A unit is a physical realization (episode). One question is sampled within each selected episode. Exported plans fix both episode and question IDs, dataset commit, protocol, pilot/formal stage, seed and sampling method. The catalog covers all accepted V3 scenes and tasks. Balanced sampling sets explicit static/dynamic quotas, randomizes room order, takes a scene from each room on each pass, and disallows repeated base scenes across the plan. It does not promise exhaustive factorial coverage. Room, base, mode and task IDs are exportable for coverage checks.

Pilot and formal records are separate. The formal shortcut produces 100 static and 100 dynamic scenes across distinct bases. Twenty pilot scenes precede rule fixing; pilots are not evidence from the formal sample. Three reviewers should review the same exported plan independently, ideally including someone not involved in generation. Do not inspect others' results until all independent ratings have been submitted. Exposure to any variant from the same base is recorded and excludes new ratings from the formal analysis.

## Stage 1: no reference information

The interface presents the original prompt verbatim (including allowed robot poses and playback text), task-bound receiver mixtures and a W-channel waveform. It does not fetch the per-scene reference shard before submission. Public sampling metadata is not a hidden-label security boundary; participants should not inspect source code.

Reviewers first listen to all task-bound receivers at original speed. The app measures unique played time bins and requires at least 95% coverage per receiver before locking stage 1; seeking alone adds no coverage. It records gain, decoder, headphones, timestamp, initial audibility and audio quality, optional first-pass response, notes and time intervals. A technical playback failure must be marked uncertain and is excluded from formal statistics. A reviewer cannot claim successful listening by marking a failure as pass.

Audibility: clear / partial / masked / region empty / uncertain. Audio quality: no anomaly observed / suspected issue / uncertain. Suspected issues and non-clear judgments require an explanation. Region-empty is a perception judgment, not the fact that all audio is silent.

## Stage 2: reference-assisted independent inspection

The initial judgment becomes immutable within the UI. The interface then loads the exact reference output and target ID, displays dry original source crops and transcripts, and offers all scene receivers for correspondence checks. The visualized trajectories are the annotations being inspected. The dry source audio does not include room propagation; missing isolated receiver stems cannot be assumed to exist.

Five fields are recorded independently: render quality, speech/text correspondence, question/target correspondence, spatial/time continuity, cross-receiver correspondence. Each accepts no anomaly observed / suspected issue / uncertain / not applicable. At least a brief reason is required for issues or uncertainty. Cross-receiver non-applicability is appropriate when only one receiver exists. Normal noise, reverberation, masking and occlusion are not automatically defects. A mixed-speech masking problem and a reference assigned to the wrong speaker have different meanings and must be distinguished in notes.

## Decoder and calibration

MIT KEMAR HRIRs are projected on the real FOA basis `[1,sin(az)cos(el),sin(el),cos(az)cos(el)]` by regularized least squares (ridge fraction 1e-6). Filters are resampled from 44.1 to 16 kHz; output ear order is checked from SOFA receiver coordinates. Eight mono FIR convolutions map the four channels to two ears, without Web Audio convolver normalization. No reference target trajectory is used in decoding. The app preserves the full FIR tail, scene time origin and interaural differences.

Numeric left/right plane-wave energy checks are included. Listening calibration offers isolated ear tones plus front/left/right/back FOA probes through the same filter bank. These checks are not a certification of a person's localization accuracy. Users document the headphones and confirm a comfortable level and correct left/right channels. Generic HRTFs, limited FOA order and listening equipment can affect front/back and elevation. Precision geometric claims require separate validation.

## Agreement and adjudication

The nominal alpha implementation uses ordered coincidence disagreement: each pairable unit contributes `sum(a != b)/(n_u - 1)`, divided by total ratings across pairable units. Expected disagreement is computed from pooled category counts without replacement, `1 - sum(n_c(n_c-1))/(N(N-1))`. Alpha is `1 - D_o/D_e`; it is undefined when fewer than two pairable ratings exist or `D_e = 0`. Single-reviewer units do not affect alpha. All dimensions are nominal; audibility is not assumed to have equal interval distances.

The unit key includes fixed-plan ID and sample ID. Duplicate identical exports are deduplicated; conflicting records for the same reviewer/key are rejected. Different dataset, task-protocol and app versions cannot be merged. Original unanimity is reported only for units having exactly the expected number of reviewers. Alpha uses all units with at least two ratings and displays their count. Pilot, prior-exposure and playback-failure records are excluded. “Uncertain” is an explicit category and its count/proportion is reported; “not applicable” is omitted from reliability but counted separately. Complete agreement on uncertainty is not validation success. Empty statistics never become a quality claim.

After independence ends, a coordinator records issue disposition and reason in a separate object. The export retains raw independent opinions, dispositions and unresolved cases. Resolved consensus never replaces or inflates the independent agreement figures.

References: [Krippendorff alpha resources](https://www.asc.upenn.edu/krippendorffs-alpha-reliability), [IEM's alternative binaural decoding method](https://plugins.iem.at/docs/plugindescriptions/#binauraldecoder), [KEMAR measurements and usage terms](https://sound.media.mit.edu/resources/KEMAR.html).
