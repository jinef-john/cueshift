# cueshift

Puts subtitles back in time with the speech in a video.

Most sync tools find one offset for the whole file. Releases often need more than that: a recap or a longer scene in one cut pushes everything after it by a few seconds. cueshift finds those steps, and frame-rate drift (23.976 ↔ 25 fps). When it isn't sure, it leaves the file alone.

## Requirements

- Node 18+
- ffmpeg
- Python 3 with `pip install webrtcvad-wheels numpy`

## Usage

```sh
node bin/cueshift.js episode.mkv episode.srt
# Moved (22.2s, then 30.2s from 537s) → episode.synced.srt
```

| Option | |
|---|---|
| `-o out.srt` | where to write the result |
| `--keep-speech file` | save the detected speech so the next run skips the audio |
| `--speech file` | use saved speech instead of reading the audio |
| `--json` | print the full report |

As a library:

```js
const { syncSubtitles, speechFromBuffer } = require("cueshift");

const result = syncSubtitles(srtText, speechFromBuffer(speechBytes));
if (result.changed) save(result.srt);
else console.log(result.report.reason);
```

`speech` is one number per 50 ms: the share of that slice with speech in it (0 to 1), or `NaN` where the audio wasn't heard. Part of a file works too, so a player can sync from what it has played so far.

## How it works

1. WebRTC voice detection marks where people speak, in 50 ms frames.
2. The audio is cut into 40 s windows. Each window is scored against the subtitle timing at every shift within ±60 s.
3. A path through the windows picks one shift per stretch, paying a cost for every change, so a single noisy window can't start a new step.
4. A shift is used only when several windows agree strongly. Big shifts need more evidence than small ones.
5. Where two stretches meet, the cut is placed in the silence between lines.
6. If no steady offset fits, common frame-rate ratios are tried as drift.

## Results

Three anime episodes whose subtitles drift in steps of 10–32 s, compared with [alass](https://github.com/kaegi/alass) and [ffsubsync](https://github.com/smacke/ffsubsync):

| Episode | Tool | Median error | Lines within 1 s |
|---|---|---|---|
| s2e7 | cueshift | 0.00 s | 91% |
| | alass | 0.01 s | 91% |
| | ffsubsync | 8.04 s | 34% |
| s2e8 | cueshift | 0.05 s | 79% |
| | alass | 2.65 s | 23% |
| | ffsubsync | 0.05 s | 93% |
| s2e9 | cueshift | 0.03 s | 98% |
| | alass | 3.06 s | 18% |
| | ffsubsync | 7.84 s | 40% |

## Tests

```sh
npm test
```
