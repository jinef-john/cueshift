"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { syncSubtitles, parseCues, toSrt, FRAME_S } = require("../src");

function episode(speechShift) {
  const cues = [];
  let t = 30;
  let seed = 7;
  const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  while (t < 1180) {
    const length = 1 + random() * 3;
    cues.push({ start: t, end: t + length, text: `line ${cues.length}` });
    t += length + 0.5 + random() * 4;
  }
  const energy = new Float64Array(Math.round(1200 / FRAME_S));
  for (let f = 0; f < energy.length; f += 1) energy[f] = random() * 0.5;
  for (const cue of cues) {
    const shift = speechShift(cue.start);
    for (let f = Math.round((cue.start + shift) / FRAME_S); f < Math.round((cue.end + shift) / FRAME_S); f += 1) {
      if (f >= 0 && f < energy.length) energy[f] += 3;
    }
  }
  return { srt: toSrt(cues), cues, energy };
}

test("drops typeset drawings and karaoke syllables", () => {
  const srt = [
    "1\n00:00:10,000 --> 00:00:12,000\nHello there.",
    '2\n00:00:12,000 --> 00:00:12,100\n<font face="Stars">{\\an8}<font color="#b1d1b8">m 28 0 b 26 22 22 26 0 28 b 22 30 26 34 28 56 b 30 34 34 30 56 28</font></font>',
    '3\n00:00:12,000 --> 00:00:14,000\n<font face="Stars">{\\an8}i</font>',
    '4\n00:00:14,000 --> 00:00:16,000\n<font face="Candara">Second line.</font>',
  ].join("\n\n");
  assert.deepEqual(parseCues(srt).map((cue) => cue.text), ["Hello there.", "Second line."]);
});

test("parses SRT and WebVTT, and writes SRT back", () => {
  const vtt = "WEBVTT\n\n00:01.500 --> 00:03.000\nHello\n\n01:02:03.250 --> 01:02:04.000\nBye\n";
  assert.deepEqual(parseCues(vtt), [
    { start: 1.5, end: 3, text: "Hello" },
    { start: 3723.25, end: 3724, text: "Bye" },
  ]);
  const srt = toSrt([{ start: 1.5, end: 3, text: "Hello" }]);
  assert.equal(srt, "1\n00:00:01,500 --> 00:00:03,000\nHello\n");
  assert.equal(parseCues("not subtitles"), null);
});

test("leaves subtitles that are already in time alone", () => {
  const { srt, energy } = episode(() => 0);
  assert.equal(syncSubtitles(srt, energy).changed, false);
});

test("moves subtitles that are early by a fixed amount", () => {
  const { srt, cues, energy } = episode(() => 1.5);
  const result = syncSubtitles(srt, energy);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  moved.forEach((cue, i) => assert.ok(Math.abs(cue.start - (cues[i].start + 1.5)) < 0.15));
});

test("follows a step part way through, as when one cut has a longer scene", () => {
  const { srt, cues, energy } = episode((t) => (t < 600 ? 1 : 2));
  const result = syncSubtitles(srt, energy);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  const shiftAt = (i) => moved[i].start - cues[i].start;
  const early = cues.findIndex((cue) => cue.start > 200);
  const late = cues.findIndex((cue) => cue.start > 900);
  assert.ok(Math.abs(shiftAt(early) - 1) < 0.15, `early shift ${shiftAt(early)}`);
  assert.ok(Math.abs(shiftAt(late) - 2) < 0.15, `late shift ${shiftAt(late)}`);
});

test("keeps the original when the audio doesn't match the subtitles", () => {
  const { srt } = episode(() => 0);
  const noise = new Float64Array(Math.round(1200 / FRAME_S)).map(() => Math.random());
  assert.equal(syncSubtitles(srt, noise).changed, false);
});

test("acts on part of an episode, as the first viewer's player reports it", () => {
  const { srt, cues, energy } = episode((t) => (t < 600 ? 1 : 2));
  const heard = new Float64Array(energy.length).fill(NaN);
  for (let f = Math.round(200 / FRAME_S); f < Math.round(320 / FRAME_S); f += 1) heard[f] = energy[f];
  const result = syncSubtitles(srt, heard);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  const i = cues.findIndex((cue) => cue.start > 250);
  assert.ok(Math.abs(moved[i].start - cues[i].start - 1) < 0.15);
});

test("finds a large offset, and a different one after the opening song", () => {
  const { srt, cues, energy } = episode((t) => (t < 150 ? 10.1 : 11.9));
  const result = syncSubtitles(srt, energy);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  const shiftAt = (i) => moved[i].start - cues[i].start;
  const early = cues.findIndex((cue) => cue.start > 60);
  const late = cues.findIndex((cue) => cue.start > 600);
  assert.ok(Math.abs(shiftAt(early) - 10.1) < 0.15, `early shift ${shiftAt(early)}`);
  assert.ok(Math.abs(shiftAt(late) - 11.9) < 0.15, `late shift ${shiftAt(late)}`);
});

test("keeps a correctly timed opening when a later scene is longer", () => {
  const { srt, cues, energy } = episode((t) => (t < 150 ? 0 : 20));
  const result = syncSubtitles(srt, energy);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  const early = cues.findIndex((cue) => cue.start > 60);
  const late = cues.findIndex((cue) => cue.start > 600);
  assert.ok(Math.abs(moved[early].start - cues[early].start) < 0.15, `opening shift ${moved[early].start - cues[early].start}`);
  assert.ok(Math.abs(moved[late].start - cues[late].start - 20) < 0.15, `later shift ${moved[late].start - cues[late].start}`);
});

test("finds subtitles out by 25 seconds", () => {
  const { srt, cues, energy } = episode(() => -25);
  const result = syncSubtitles(srt, energy);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  const i = cues.findIndex((cue) => cue.start > 600);
  assert.ok(Math.abs(moved[i].start - cues[i].start + 25) < 0.15);
});

test("ignores a stretch that only looks like a match somewhere else", () => {
  const { srt, cues, energy } = episode((t) => (t >= 500 && t < 545 ? -20 : 1));
  const result = syncSubtitles(srt, energy);
  assert.equal(result.changed, true);
  const moved = parseCues(result.srt);
  cues.forEach((cue, i) => assert.ok(Math.abs(moved[i].start - cue.start - 1) < 0.15, `cue at ${cue.start}`));
});
