"use strict";

function parseTime(text) {
  const match = /(?:(\d+):)?(\d{1,2}):(\d{1,2})[.,](\d{1,3})/.exec(text);
  if (!match) return null;
  const [, h = "0", m, s, ms] = match;
  return Number(h) * 3600 + Number(m) * 60 + Number(s) + Number(ms.padEnd(3, "0")) / 1000;
}

const VECTOR_PATH = /(?:^|\s)[mblcqs]\s+-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){3,}/i;
const KARAOKE_FRAGMENT = /^[A-Za-z0-9]{1,3}$/;

function cleanCueText(input) {
  return String(input || "")
    .replace(/<[^>]*>/g, "")
    .replace(/\{\\[^}]*\}/g, "")
    .replace(/\\N/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\h/g, " ")
    .split("\n")
    .map((line) => (VECTOR_PATH.test(line) ? "" : line.trim()))
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isTypesetNoise(raw, text, top) {
  if (!text) return true;
  if (/face\s*=\s*["']Stars["']/i.test(raw)) return true;
  if (top && /size\s*=\s*["']?(?:[5-9]\d|\d{3,})/i.test(raw)) return true;
  if (KARAOKE_FRAGMENT.test(text) && (top || /\{\\[^}]*\\k[fo]?\d/i.test(raw))) return true;
  if (!/[A-Za-z0-9\u00c0-\u024f\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)) return true;
  if (VECTOR_PATH.test(text) && text.replace(VECTOR_PATH, "").trim().length < 2) return true;
  return false;
}

function parseCues(body) {
  const text = String(body || "").replace(/^﻿/, "").replace(/\r/g, "");
  const cues = [];
  for (const block of text.split(/\n{2,}/)) {
    const lines = block.split("\n");
    const at = lines.findIndex((line) => line.includes("-->"));
    if (at < 0) continue;
    const [left, right] = lines[at].split("-->");
    const start = parseTime(left);
    const end = parseTime(right);
    if (start === null || end === null || end < start) continue;
    const raw = lines.slice(at + 1).join("\n").trim();
    const words = cleanCueText(raw);
    const top = /\{\\an(7|8|9)\}/i.test(raw);
    if (isTypesetNoise(raw, words, top)) continue;
    cues.push({ start, end, text: words });
  }
  return cues.length ? cues : null;
}

function srtTime(seconds) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const pad = (n, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms % 1000, 3)}`;
}

function toSrt(cues) {
  return cues
    .map((cue, i) => `${i + 1}\n${srtTime(cue.start)} --> ${srtTime(cue.end)}\n${cue.text}\n`)
    .join("\n");
}

module.exports = { parseCues, toSrt };
