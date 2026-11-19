#!/usr/bin/env node
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");
const { syncSubtitles, speechFromBuffer, FRAME_S } = require("../src");

const USAGE = `Usage: cueshift <video-or-audio> <subtitles.srt|.vtt> [-o out.srt] [--speech file.speech] [--keep-speech file.speech]

  -o              where to write the synced subtitles (default: <subtitles>.synced.srt)
  --speech        use a speech track made earlier instead of reading the audio
  --keep-speech   save the speech track so later runs can skip the audio step
  --json          print the full report as JSON`;

function take(args, name, hasValue = true) {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, hasValue ? 2 : 1);
  return hasValue ? value : true;
}

function speechTrack(media) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cueshift-"));
  const pcm = path.join(dir, "audio.pcm");
  const speech = path.join(dir, "audio.speech");
  try {
    execFileSync(
      "ffmpeg",
      ["-v", "error", "-i", media, "-vn", "-ac", "1", "-ar", "16000", "-af", "aresample=async=1:first_pts=0", "-f", "s16le", "-y", pcm],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
    execFileSync("python3", [path.join(__dirname, "../tools/speech.py"), pcm, speech], { stdio: "inherit" });
    return fs.readFileSync(speech);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function main() {
  const args = process.argv.slice(2);
  const out = take(args, "-o");
  const speechFile = take(args, "--speech");
  const keep = take(args, "--keep-speech");
  const json = take(args, "--json", false);
  const [media, subtitles] = args;
  if (!subtitles || !fs.existsSync(subtitles) || (!speechFile && !fs.existsSync(media || ""))) {
    console.error(USAGE);
    process.exit(2);
  }

  const bytes = speechFile ? fs.readFileSync(speechFile) : speechTrack(media);
  if (keep) fs.writeFileSync(keep, bytes);
  const speech = speechFromBuffer(bytes);
  const duration = speech.length * FRAME_S;
  const text = fs.readFileSync(subtitles, "utf8");
  const result = syncSubtitles(text, speech, { endLimit: duration - 90 });
  const target = out || subtitles.replace(/\.(srt|vtt)$/i, "") + ".synced.srt";

  if (json) console.log(JSON.stringify(result.report, null, 2));
  if (!result.changed) {
    console.log(`Left alone: ${result.report.reason || "already in time"}`);
    return;
  }
  fs.writeFileSync(target, result.srt);
  const { mode, offset, ratio, changes } = result.report;
  const how =
    mode === "drift"
      ? `frame rate ×${ratio}, offset ${offset}s`
      : changes?.length
        ? `${offset}s, then ${changes.map(([at, shift]) => `${shift}s from ${at}s`).join(", ")}`
        : `${offset}s`;
  console.log(`Moved (${how}) → ${target}`);
}

main();
