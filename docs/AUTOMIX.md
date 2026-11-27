# BitConnection AutoMix

## Architecture and model choice

AutoMix is a pipeline, not a claim that one neural network can be a DJ. A reliable system needs separate audio analysis, DJ decisions, a transition plan, and a player/DSP implementation.

The strongest full-featured reference implementation found during research is [ClubCraft](https://github.com/beneaze/ClubCraft). It combines beat/downbeat and phrase grids, key and energy analysis, structural sections and cue points, harmonic set planning, two-deck synchronization, EQ, filters, crossfading and effects. It is a desktop application and reference architecture, not a server-side ONNX model that can simply be embedded into BitConnection.

For the first server-side ONNX model, BitConnection uses [Beat This! final0](https://huggingface.co/nilsbc/beat-this-onnx), a dedicated beat and downbeat tracker with an ONNX log-mel frontend. This is a better-scoped and auditable first model than trying to use a music-generation network as a DJ.

The model card identifies the model as MIT-licensed and publishes the final0 ONNX weights and frontend. It also warns that some sources in the training data may have copyright or limited Creative Commons terms. Review that model card and relevant training-data terms before commercial redistribution.

## Current analysis pipeline

- Input: mono, little-endian Float32 PCM at 22,050 Hz.
- Limit: 8 minutes per analyzed track.
- Frontend: ONNX log-mel transform, 128 mel bands and 50 frames per second.
- Main model: Beat This! final0, producing beat and downbeat activations.
- Inference: overlapping 1,500-frame windows with a six-frame overlap border.
- Trust: downloaded ONNX files are pinned to an expected byte count and SHA-256 digest before they are loaded.
- Runtime: onnxruntime-node on Deplexo CPU by default, with thread count configurable through BITCONNECTION_AUTOMIX_THREADS.
- Additional DSP: approximate musical key/Camelot estimate, RMS energy, rough build/drop/break cues and mix-in/mix-out suggestions.
- Planner: harmonic queue ordering, tempo compatibility, phrase-aligned 16/32-beat transition proposals, crossfader/gain automation, bass swap, EQ, filter and echo/reverb envelopes.

The key and section estimates in this initial version are heuristic DSP, not additional trained neural models. Treat the confidence values accordingly. The planner is a useful starting point, not a substitute for listening tests or experienced DJ review.

## Model research and recommended next stage

A serious DJ stack is a collection of specialized components, not one model. The most useful complete-system reference is [ClubCraft](https://github.com/beneaze/ClubCraft), which combines analysis with two-deck sync and real EQ, filter, crossfader and FX control. It is a system reference, not a single embeddable ONNX file.

For a lightweight second ONNX model, evaluate [LinkSeg 7-class ONNX](https://huggingface.co/elicwhite/linkseg-7c-onnx). It labels intro, verse, chorus, bridge, instrumental, outro and silence from the full mix. It uses the Beat This! beat grid, requires no stem separation, and its ONNX graph is about 1.5 MB. Its model weights are CC-BY 4.0, so preserve the attribution to M. Buisson, B. McFee and S. Essid, *Using Pairwise Link Prediction and Graph Attention Networks for Music Structure Analysis*, ISMIR 2024. The port code is MIT, but that does not change the model-weights license. This is the recommended next ONNX addition for better semantic transition cues.

For a larger structural-analysis option, evaluate the ONNX All-In-One exports used by [LightCut's music-analysis model pack](https://huggingface.co/azstorm/lightcut-music-analysis-models) or the [allinone-DLL-ONNX reference](https://github.com/zukky/allinone-DLL-ONNX). The full arrangement uses eight fold models and analyzes tempo, beats/downbeats and functional sections. It is more involved than LinkSeg: its reference pipeline expects source-separated stems and additional spectrogram/DBN postprocessing, so it is not currently wired into this Node API.

For vocal-aware transitions, evaluate [HTDemucs FT ONNX](https://github.com/StemSplit/demucs-onnx). The complete specialist bag is approximately 1.26 GB FP32 or 660 MB with the published FP16-weight variant; a single specialist is substantially smaller. This enables vocal, drums, bass and other-stem awareness, but costs more storage, RAM and offline CPU/GPU time. It should be an optional model pack, not a mandatory first download.

Do not choose [SongFormer](https://huggingface.co/) as the default for this project without a separate licensing decision: its strongest published checkpoint has non-commercial restrictions. Model benchmark performance is not enough if the weights cannot be used for the product's intended distribution.

Recommended progression: Beat This! for beat/downbeat grids, LinkSeg for full-mix semantic sections, a validated trained key/loudness model for harmonic and gain matching, then optional HTDemucs/All-In-One analysis for vocal-aware and finer structural transitions. Finally, the player bridge must execute the automation. These analysis models alone cannot make a complete live DJ.

## API flow

1. Host calls POST /rooms/{roomId}/automix/prepare. This begins downloading and verifying the pinned model files.
2. Host polls GET /rooms/{roomId}/automix/status.
3. Host submits each queued track for analysis with POST /rooms/{roomId}/automix/analyze/{queueItemId}.
4. After at least two queue entries have been analyzed, host calls POST /rooms/{roomId}/automix/plan.

Analysis uploads use Content-Type: application/vnd.bitconnection.pcm-f32le and the X-Audio-Sample-Rate: 22050 header. Include mono Float32 PCM in little-endian byte order at exactly 22,050 Hz. The endpoint is host-only, requires the existing BitConnection/BitCider session and CSRF rules, and does not store the raw PCM. Only analysis metadata is attached to the queue item.

The current browser-to-browser party music stream remains direct WebRTC. Audio sent to the analysis endpoint is a separate upload to Deplexo for inference; Deplexo is not turned into an audio relay.

## What remains before it can behave like a live DJ

The current player bridge is not connected. The party's playback controls still cannot load and control two real music decks or execute the generated automation curves. The current host tab-capture code also does not yet tap PCM and submit track audio to the analysis endpoint. Consequently, the server-side inference and planner are implemented as an API foundation, but the user-facing AutoMix switch remains disabled and the service descriptor reports live execution as unavailable.

To complete live mixing, BitChord needs a controlled player adapter with at least load/seek/play/pause, beat-grid synchronization, tempo/pitch adjustment, EQ/filter gains, crossfader and FX automation. The host web player must also provide a permitted PCM analysis tap or a source-level audio fetch path for each queued track. Only after those controls and audio input are integrated should AutoMix be enabled in the room.

## Next model stages

- Structure and richer cue points: evaluate [All-In-One Music Structure Analyzer](https://github.com/mir-aidj/all-in-one). It predicts BPM, beats, downbeats, segment boundaries and semantic labels such as intro, verse, chorus, bridge and outro under an MIT-licensed project. The published implementation depends on PyTorch and NATTEN, however, and no verified compatible ONNX export is currently wired into this Node service. Keep it as the leading structure-model candidate until an ONNX conversion is validated. The current section detector is a coarse energy heuristic.
- Vocal/instrumental awareness: evaluate [HTDemucs FT ONNX](https://github.com/StemSplit/demucs-onnx) for four stems (its full specialist bag is about 1.26 GB FP32 or 660 MB in the published FP16-weight distribution), with a single HTDemucs model as the lighter alternative. This is useful for vocal-aware blends, bass swaps and drum transitions, but it is offline/background work rather than an audio-callback model. These large models should be opt-in downloads with explicit CPU/RAM/disk requirements. They are not installed by the current implementation.
- Loudness matching: replace the basic RMS estimate with EBU R128 integrated loudness and true-peak measurement.
- Key accuracy: evaluate trained key-estimation weights only after their redistribution licenses are verified. The current implementation intentionally avoids depending on weights with unclear commercial terms.
- Quality gates: build an offline test set and compare beat/downbeat timing, BPM, key, cue usefulness and transition quality against human-labelled mixes before turning on automatic playback.

## Current model artifacts

| Artifact | Approximate size | SHA-256 |
| --- | ---: | --- |
| Beat This! final0 | 83.16 MB | a7e2c68b27f9db6a73416017f784ea8551a01373f4955a98db018827760c4a14 |
| log-mel frontend | 4.47 MB | f5afa499f5a42b05ea89a214561170cd4b76f92d67d3227f7c9833e8d79bbb43 |
