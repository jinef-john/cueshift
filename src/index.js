"use strict";

const { alignCues, NOTHING_TO_DO_S } = require("./align");
const { parseCues, toSrt } = require("./subtitles");

const FRAME_S = 0.05;

function speechFromBuffer(bytes, heardSeconds) {
  const shares = new Int16Array(bytes.buffer, bytes.byteOffset, Math.floor(bytes.length / 2));
  const frames = new Float64Array(shares.length).fill(NaN);
  const heard = heardSeconds ? Math.min(shares.length, Math.round(heardSeconds / FRAME_S)) : shares.length;
  for (let f = 0; f < heard; f += 1) frames[f] = shares[f] / 256;
  return frames;
}

function syncSubtitles(text, speech, options = {}) {
  const cues = parseCues(text);
  if (!cues) return { changed: false, srt: null, report: { reason: "unsupported format" } };
  const { shifts, report } = alignCues(cues, speech, options.cache ?? null, options);
  delete report.matcher;
  if (!shifts || shifts.every((shift) => Math.abs(shift) < NOTHING_TO_DO_S)) {
    return { changed: false, srt: null, report };
  }
  const moved = cues.map((cue, i) => ({
    start: cue.start + shifts[i],
    end: cue.end + shifts[i],
    text: cue.text,
  }));
  return { changed: true, srt: toSrt(moved), report };
}

module.exports = { syncSubtitles, speechFromBuffer, parseCues, toSrt, FRAME_S };
