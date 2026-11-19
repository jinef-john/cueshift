"use strict";

const FRAME_S = 0.05;
const SEARCH_RANGE_S = 60;
const STEP_FRAMES = 2;
const WINDOW_S = 40;
const MIN_HEARD_S = 30;
const ANCHOR_Z = 2.5;
const MAX_Z = 6;
const MIN_MIX = 0.05;
const MIN_Z = -1.5;
const CHANGE_COST = 7;
const TIERS = [
  { upTo: 3, z: 4.5, anchors: 3, handicap: 0 },
  { upTo: 15, z: 4.8, anchors: 3, handicap: 0.4 },
  { upTo: Infinity, z: 5.2, anchors: 3, handicap: 0.8 },
];
const EDGE_S = 1;
const NOTHING_TO_DO_S = 0.5;
const DRIFT_RATIOS = [25 / 23.976, 23.976 / 25, 25 / 24, 24 / 25];
const DRIFT_MIN_SPAN_S = 300;
const DRIFT_MIN_ANCHORS = 5;
const DRIFT_Z = 6;
const BOUNDARY_GAP_S = 1.5;

const tierOf = (shiftS) => TIERS.find((tier) => Math.abs(shiftS) <= tier.upTo);

const SHIFTS = [];
{
  const range = Math.round(SEARCH_RANGE_S / FRAME_S);
  for (let shift = -range; shift <= range; shift += STEP_FRAMES) SHIFTS.push(shift);
}
const ZERO = SHIFTS.indexOf(0);
const PAD = Math.round(SEARCH_RANGE_S / FRAME_S) + 1;

function cueFrames(cues, frames) {
  const on = new Uint8Array(frames + 2 * PAD);
  for (const cue of cues) {
    const from = Math.max(0, Math.round(cue.start / FRAME_S) + PAD);
    const to = Math.min(on.length, Math.round(cue.end / FRAME_S) + PAD);
    for (let f = from; f < to; f += 1) on[f] = 1;
  }
  return on;
}

function scoreWindow(energy, on, from, to) {
  const heard = [];
  for (let f = from; f < to; f += 1) if (Number.isFinite(energy[f])) heard.push(f);
  const n = heard.length;
  if (n < MIN_HEARD_S / FRAME_S) return null;
  let sy = 0;
  let syy = 0;
  for (const f of heard) {
    sy += energy[f];
    syy += energy[f] * energy[f];
  }
  const vy = syy - (sy * sy) / n;
  if (vy <= 0) return null;

  const r = new Float32Array(SHIFTS.length);
  const telling = new Uint8Array(SHIFTS.length);
  let mean = 0;
  for (let k = 0; k < SHIFTS.length; k += 1) {
    const offset = PAD - SHIFTS[k];
    let sx = 0;
    let sxy = 0;
    for (const f of heard) {
      if (on[f + offset]) {
        sx += 1;
        sxy += energy[f];
      }
    }
    const vx = sx - (sx * sx) / n;
    r[k] = vx > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : 0;
    telling[k] = sx >= n * MIN_MIX && sx <= n * (1 - MIN_MIX) ? 1 : 0;
    mean += r[k];
  }
  mean /= r.length;
  let spread = 0;
  for (const value of r) spread += (value - mean) ** 2;
  spread = Math.sqrt(spread / r.length);
  if (spread < 1e-6) return null;
  for (let k = 0; k < r.length; k += 1) r[k] = (r[k] - mean) / spread;
  return { z: r, telling };
}

function scoreWindows(cues, energy, scores, tag, endLimit) {
  const on = cueFrames(cues, energy.length);
  const size = Math.round(WINDOW_S / FRAME_S);
  const windows = [];
  for (let index = 0; index * size < energy.length; index += 1) {
    const from = index * size;
    const to = Math.min(energy.length, from + size);
    const centre = ((from + to) / 2) * FRAME_S;
    if (endLimit && centre >= endLimit) continue;
    let heard = 0;
    for (let f = from; f < to; f += 1) if (Number.isFinite(energy[f])) heard += 1;
    if (heard < MIN_HEARD_S / FRAME_S) continue;
    const key = `v2:${tag}:${index}:${heard}`;
    let scored = scores?.get(key);
    if (scored === undefined) {
      scored = scoreWindow(energy, on, from, to);
      scores?.set(key, scored);
    }
    if (scored) windows.push({ centre, from: from * FRAME_S, to: to * FRAME_S, z: scored.z, telling: scored.telling });
  }
  return windows;
}

const clamp = (z) => Math.min(MAX_Z, Math.max(MIN_Z, z));

function choosePath(windows) {
  const n = SHIFTS.length;
  const handicap = SHIFTS.map((shift) => tierOf(shift * FRAME_S).handicap);
  const emit = (w, k) => clamp(w.z[k]) - handicap[k];
  let score = new Float64Array(n);
  for (let k = 0; k < n; k += 1) score[k] = emit(windows[0], k);
  const back = [];
  for (let i = 1; i < windows.length; i += 1) {
    let top = 0;
    for (let k = 1; k < n; k += 1) if (score[k] > score[top]) top = k;
    const moved = score[top] - CHANGE_COST;
    const from = new Int32Array(n);
    const next = new Float64Array(n);
    for (let k = 0; k < n; k += 1) {
      from[k] = score[k] >= moved ? k : top;
      next[k] = Math.max(score[k], moved) + emit(windows[i], k);
    }
    back.push(from);
    score = next;
  }
  let k = 0;
  for (let j = 1; j < n; j += 1) if (score[j] > score[k]) k = j;
  const picks = new Array(windows.length);
  for (let i = windows.length - 1; i >= 0; i -= 1) {
    picks[i] = k;
    if (i > 0) k = back[i - 1][k];
  }
  return picks;
}

function evidence(windows, from, to, k) {
  let sum = 0;
  let count = 0;
  let anchors = 0;
  let first = null;
  let last = null;
  for (let i = from; i < to; i += 1) {
    if (!windows[i].telling[k]) continue;
    const z = windows[i].z[k];
    sum += clamp(z);
    count += 1;
    if (z >= ANCHOR_Z) {
      anchors += 1;
      first ??= windows[i];
      last = windows[i];
    }
  }
  return { z: count ? sum / Math.sqrt(count) : 0, anchors, count, span: first ? last.to - first.from : 0, sum };
}

function bestNear(windows, from, to, around, reach) {
  let best = around;
  let bestSum = -Infinity;
  for (let k = Math.max(0, around - reach); k <= Math.min(SHIFTS.length - 1, around + reach); k += 1) {
    let sum = 0;
    for (let i = from; i < to; i += 1) sum += clamp(windows[i].z[k]);
    if (sum > bestSum) {
      bestSum = sum;
      best = k;
    }
  }
  return best;
}

function segments(windows) {
  const picks = choosePath(windows);
  const out = [];
  let i = 0;
  while (i < windows.length) {
    let j = i + 1;
    while (j < windows.length && picks[j] === picks[i]) j += 1;
    const k = bestNear(windows, i, j, picks[i], 3);
    const shift = SHIFTS[k] * FRAME_S;
    const found = evidence(windows, i, j, k);
    const tier = tierOf(shift);
    out.push({
      first: i,
      last: j - 1,
      from: windows[i].from,
      to: windows[j - 1].to,
      k,
      shift,
      ...found,
      trusted: found.z >= tier.z && found.anchors >= tier.anchors && Math.abs(shift) <= SEARCH_RANGE_S - EDGE_S,
    });
    i = j;
  }
  return out;
}

function boundary(cues, energy, earlier, later) {
  const audioFrom = Math.max(0, earlier.lastAnchorTo - WINDOW_S);
  const audioTo = later.firstAnchorFrom + WINDOW_S;
  const lo = earlier.lastAnchorTo - WINDOW_S / 2 - earlier.shift;
  const hi = later.firstAnchorFrom + WINDOW_S / 2 - later.shift;
  const fromFrame = Math.round(audioFrom / FRAME_S);
  const toFrame = Math.min(energy.length, Math.round(audioTo / FRAME_S));

  const fit = (split) => {
    const on = new Uint8Array(toFrame - fromFrame);
    for (const cue of cues) {
      const shift = cue.start < split ? earlier.shift : later.shift;
      const a = Math.max(fromFrame, Math.round((cue.start + shift) / FRAME_S));
      const b = Math.min(toFrame, Math.round((cue.end + shift) / FRAME_S));
      for (let f = a; f < b; f += 1) on[f - fromFrame] = 1;
    }
    let n = 0;
    let sx = 0;
    let sy = 0;
    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let f = fromFrame; f < toFrame; f += 1) {
      const y = energy[f];
      if (!Number.isFinite(y)) continue;
      const x = on[f - fromFrame];
      n += 1;
      sx += x;
      sy += y;
      sxx += x * x;
      syy += y * y;
      sxy += x * y;
    }
    const vx = sxx - (sx * sx) / n;
    const vy = syy - (sy * sy) / n;
    return n && vx > 0 && vy > 0 ? (sxy - (sx * sy) / n) / Math.sqrt(vx * vy) : -1;
  };

  let best = null;
  for (let i = 1; i < cues.length; i += 1) {
    const gap = cues[i].start - cues[i - 1].end;
    if (cues[i].start < lo || cues[i].start > hi || gap < BOUNDARY_GAP_S) continue;
    const score = fit(cues[i].start);
    if (!best || score > best.score + 0.01 || (score > best.score - 0.01 && gap > best.gap)) {
      best = { score, gap, time: cues[i].start };
    }
  }
  return best ? best.time : (lo + hi) / 2;
}

function describe(list) {
  return list.map((s) => ({
    from: Math.round(s.from),
    to: Math.round(s.to),
    shift: Math.round(s.shift * 10) / 10,
    z: Math.round(s.z * 10) / 10,
    anchors: s.anchors,
    of: s.count,
    trusted: s.trusted,
  }));
}

function anchorList(windows, trusted) {
  const out = [];
  for (const s of trusted) {
    for (let i = s.first; i <= s.last; i += 1) {
      if (windows[i].z[s.k] >= ANCHOR_Z) {
        out.push([Math.round(windows[i].centre), Math.round(s.shift * 10) / 10, Math.round(windows[i].z[s.k] * 10) / 10]);
      }
    }
  }
  return out;
}

function alignSteps(cues, energy, windows) {
  const all = segments(windows);
  const trusted = all.filter((s) => s.trusted);
  const report = {
    windows: anchorList(windows, trusted),
    segments: describe(all),
    coverage: Math.round((trusted.reduce((n, s) => n + s.last - s.first + 1, 0) / windows.length) * 100) / 100,
    score: Math.round(trusted.reduce((sum, s) => sum + s.sum, 0) * 10) / 10,
  };
  if (!trusted.length) {
    const best = all.reduce((a, b) => (b.z > a.z ? b : a));
    const tier = tierOf(best.shift);
    return {
      shifts: null,
      report: {
        ...report,
        mode: "none",
        confident: false,
        reason:
          `no shift has enough evidence: best ${best.shift.toFixed(1)}s has z ${best.z.toFixed(1)} from ` +
          `${best.anchors} windows, needs z ${tier.z} from ${tier.anchors}`,
      },
    };
  }

  const runs = [];
  for (const s of trusted) {
    const previous = runs[runs.length - 1];
    if (previous && Math.abs(previous.shift - s.shift) < NOTHING_TO_DO_S) {
      previous.last = s.last;
      previous.to = s.to;
      continue;
    }
    runs.push({ ...s });
  }
  for (const run of runs) {
    let first = null;
    let last = null;
    for (let i = run.first; i <= run.last; i += 1) {
      if (windows[i].z[run.k] < ANCHOR_Z) continue;
      first ??= windows[i];
      last = windows[i];
    }
    run.firstAnchorFrom = first.from;
    run.lastAnchorTo = last.to;
  }
  const starts = [-Infinity];
  for (let i = 1; i < runs.length; i += 1) starts.push(boundary(cues, energy, runs[i - 1], runs[i]));
  const firstFrom = runs[0].from - runs[0].shift;
  const shiftFor = (time) => {
    if (time < firstFrom) return 0;
    let shift = runs[0].shift;
    for (let i = 1; i < runs.length; i += 1) if (time >= starts[i]) shift = runs[i].shift;
    return shift;
  };
  const shifts = cues.map((cue) => Math.round(shiftFor(cue.start) * 100) / 100);
  const inTime = runs.every((run) => Math.abs(run.shift) < NOTHING_TO_DO_S);
  return {
    shifts,
    report: {
      ...report,
      mode: inTime ? "in-time" : runs.length > 1 ? "steps" : "offset",
      confident: true,
      offset: Math.round(runs[0].shift * 10) / 10,
      from: Math.max(0, Math.round(firstFrom)),
      steps: runs.length - 1,
      changes: starts.slice(1).map((time, i) => [Math.round(time), Math.round(runs[i + 1].shift * 10) / 10]),
    },
  };
}

function alignDrift(cues, energy, scores, endLimit) {
  let best = null;
  for (const ratio of DRIFT_RATIOS) {
    const scaled = cues.map((cue) => ({ start: cue.start * ratio, end: cue.end * ratio }));
    const windows = scoreWindows(scaled, energy, scores, ratio.toFixed(5), endLimit);
    if (windows.length < DRIFT_MIN_ANCHORS) continue;
    let k = 0;
    let top = -Infinity;
    for (let j = 0; j < SHIFTS.length; j += 1) {
      let sum = 0;
      for (const w of windows) sum += clamp(w.z[j]);
      if (sum > top) {
        top = sum;
        k = j;
      }
    }
    const found = evidence(windows, 0, windows.length, k);
    if (found.z < DRIFT_Z || found.anchors < DRIFT_MIN_ANCHORS || found.span < DRIFT_MIN_SPAN_S) continue;
    if (!best || found.z > best.z) best = { ...found, ratio, k, offset: SHIFTS[k] * FRAME_S, windows };
  }
  return best;
}

function alignCues(cues, energy, scores, options = {}) {
  const endLimit = Number(options.endLimit) || 0;
  const windows = scoreWindows(cues, energy, scores, "1", endLimit);
  if (!windows.length) {
    return { shifts: null, report: { matcher: "v2", mode: "none", confident: false, coverage: 0, score: 0, windows: [], reason: "not enough audio heard yet" } };
  }
  const steps = alignSteps(cues, energy, windows);
  steps.report.matcher = "v2";

  const heardSpan = windows[windows.length - 1].to - windows[0].from;
  if (heardSpan >= DRIFT_MIN_SPAN_S && (!steps.shifts || steps.report.coverage < 0.5)) {
    const drift = alignDrift(cues, energy, scores, endLimit);
    if (drift && drift.sum > steps.report.score * 1.5) {
      return {
        shifts: cues.map((cue) => Math.round((cue.start * (drift.ratio - 1) + drift.offset) * 100) / 100),
        scale: drift.ratio,
        report: {
          matcher: "v2",
          mode: "drift",
          confident: true,
          ratio: Math.round(drift.ratio * 100000) / 100000,
          offset: Math.round(drift.offset * 10) / 10,
          steps: 0,
          coverage: Math.round((drift.anchors / drift.windows.length) * 100) / 100,
          score: Math.round(drift.sum * 10) / 10,
          windows: drift.windows
            .filter((w) => w.z[drift.k] >= ANCHOR_Z)
            .map((w) => [Math.round(w.centre), Math.round(drift.offset * 10) / 10, Math.round(w.z[drift.k] * 10) / 10]),
        },
      };
    }
  }
  return steps;
}

module.exports = { alignCues, NOTHING_TO_DO_S };
