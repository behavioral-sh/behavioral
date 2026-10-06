/**
 * The ternary fused dequant-matmul WGSL kernels — the ONE custom kernel the
 * shader strategy needs. The kernels consume the LUT2 group layout from
 * packing.ts (2 bits/weight, 16 weights per uint32, per-128-group f32 scale)
 * and dequantize IN-REGISTER via the value = trit+1 identity — never
 * materializing dequantized weights (memory bandwidth is the binding
 * constraint at 2bpw; the fused contract).
 *
 * Profiles (the same body serves both per the one-model ruling):
 * - matvec (decode-bound, systemTwo chat): one thread per output row.
 * - batch matmul (prefill-bound, systemOne logits-readback): slice 3.
 *
 * v1 is deliberately the NAIVE correct body — the autoresearch loop's
 * starting point, not the destination (each refinement is a bench row, not a
 * rewrite from imagination).
 *
 * Bundle-clean: WGSL strings only — no node:, no Bun.
 *
 * @packageDocumentation
 */

/**
 * The read-bandwidth probe — the DIAGNOSTIC row, not a matvec: threads stride
 * the whole buffer doing the cheapest possible dependent read (`acc += word
 * & 3`), one u32 atomicAdd per workgroup. It measures the achievable
 * read bandwidth of the LUT2 buffer shape on this device — the ceiling every
 * matvec variant is judged against (measure the ceiling before optimizing
 * toward a guess).
 */
export const BW_PROBE_WGSL = /* wgsl */ `
struct Params {
  words: u32,
  stride: u32,
  dummy: u32,
  dummy2: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> sink: array<atomic<u32>>;
@group(0) @binding(2) var<uniform> params: Params;

var<workgroup> bwPartials: array<u32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(local_invocation_id) lid3: vec3<u32>, @builtin(workgroup_id) wid: vec3<u32>) {
  let lid = lid3.x;
  var acc = 0u;
  let base = wid.x * params.stride;
  for (var i = lid; i < params.stride; i = i + 256u) {
    acc = acc + (data[base + i] & 3u);
  }
  bwPartials[lid] = acc;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (lid < s) { bwPartials[lid] = bwPartials[lid] + bwPartials[lid + s]; }
    workgroupBarrier();
  }
  if (lid == 0u) { atomicAdd(&sink[wid.x % 64u], bwPartials[0]); }
}
`

/**
 * The barrier-free bandwidth probe: every thread reads a contiguous chunk
 * (`acc += data[i] & 3`) and writes ONE plain store — no workgroup sync, no
 * atomics in the hot path. The upper bound for the read shape.
 */
export const BW2_PROBE_WGSL = /* wgsl */ `
struct Params {
  words: u32,
  chunk: u32,
  dummy: u32,
  dummy2: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read_write> sink: array<u32>;
@group(0) @binding(2) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let tid = gid.x;
  var acc = 0u;
  let base = tid * params.chunk;
  for (var i = 0u; i < params.chunk; i = i + 1u) {
    acc = acc + (data[base + i] & 3u);
  }
  sink[tid] = acc;
}
`

/**
 * The matvec v5 — the stock engine's decode shape, read off its baked op
 * templates and applied to our LUT2 layout: 64-thread workgroup PER ROW;
 * threads stride 32-weight blocks (2 words); the x binding is vec4-f32
 * (eight vec4 loads per block, no scalar construction); the decode uses the
 * engine's magic-number trick (bitcast (code | 2^23) − (2^23+1) → the trit as
 * f32 with no integer→float conversion); per-block scale factored outside the
 * dots; the two words' dots interleaved (two independent FMA chains — ILP);
 * the reduce is a subgroup ladder + one cross-subgroup fold (no 8-step
 * barrier tree — the v2 bench row's measured killer).
 */
/**
 * The v5 body templated by workgroup size (the bench's lever; the cross
 * fold's width follows). Returns the WGSL source.
 */
export const matvecV5 = (wgSize: 32 | 64 | 128 | 256): string => {
  const sgCount = wgSize / 32
  const fold =
    sgCount === 1
      ? 'y[row] = crossPartials[0];'
      : `var t = crossPartials[0]; for (var i = 1u; i < ${sgCount}u; i++) { t = t + crossPartials[i]; } y[row] = t;`
  return /* wgsl */ `
enable subgroups;
struct Params {
  rows: u32,
  groupsPerRow: u32,
  wordsPerRow: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> crossPartials: array<f32, ${sgCount}>;

fn q2q(word: u32, sh: u32) -> vec4<f32> {
  let v = word >> sh;
  let codes = (vec4<u32>(v) >> vec4<u32>(0u, 2u, 4u, 6u)) & vec4<u32>(3u, 3u, 3u, 3u);
  return bitcast<vec4<f32>>(codes | vec4<u32>(0x4b000000u)) - vec4<f32>(8388609.0, 8388609.0, 8388609.0, 8388609.0);
}

@compute @workgroup_size(${wgSize})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>, @builtin(subgroup_invocation_id) sg_lid: u32, @builtin(subgroup_id) sg_id: u32) {
  let row = wid.x;
  let lid = lid3.x;
  if (row >= params.rows) { return; }
  let blocksPerRow = params.wordsPerRow / 2u;
  var acc = 0.0;
  for (var b = lid; b < blocksPerRow; b = b + ${wgSize}u) {
    let wordBase = row * params.wordsPerRow + b * 2u;
    let wa = data[wordBase];
    let wb = data[wordBase + 1u];
    let scale = scales[row * params.groupsPerRow + (b >> 2u)];
    let xBase = b * 8u;
    acc = acc + scale * (
      dot(x[xBase], q2q(wa, 0u)) + dot(x[xBase + 4u], q2q(wb, 0u))
      + dot(x[xBase + 1u], q2q(wa, 8u)) + dot(x[xBase + 5u], q2q(wb, 8u))
      + dot(x[xBase + 2u], q2q(wa, 16u)) + dot(x[xBase + 6u], q2q(wb, 16u))
      + dot(x[xBase + 3u], q2q(wa, 24u)) + dot(x[xBase + 7u], q2q(wb, 24u)));
  }
  let sg = subgroupAdd(acc);
  if (sg_lid == 0u) { crossPartials[sg_id] = sg; }
  workgroupBarrier();
  if (lid == 0u) { ${fold} }
}
`
}

export const MATVEC_V5_WGSL = matvecV5(64)
export const MATVEC_V5_W128 = matvecV5(128)
export const MATVEC_V5_W256 = matvecV5(256)

/**
 * The matvec v6 — v5 plus the engine's wRows amortization: WROWS weight-rows
 * per workgroup share every x load (the v5 bench row's diagnosis: x vec4
 * loads outnumber weight loads 32:1 — 356MB of x traffic vs 11MB of weights
 * per dispatch; halving/quartering the x loads is the only remaining lever
 * before bandwidth). The x vec4s load once per (thread, block); each feeds
 * WROWS rows' dots from separate accumulators (WROWS independent FMA chains
 * — more ILP too). Subgroup ladder per row; cross fold per row.
 */
export const matvecV6 = (wgSize: 32 | 64 | 128, wRows: 1 | 2 | 4 | 8): string => {
  const sgCount = wgSize / 32
  const foldRows = Array.from({ length: wRows }, (_, w) => {
    const fold =
      sgCount === 1
        ? `y[rowBase + ${w}u] = cross[${w}u][0];`
        : `var t${w} = cross[${w}u][0]; for (var i = 1u; i < ${sgCount}u; i++) { t${w} = t${w} + cross[${w}u][i]; } y[rowBase + ${w}u] = t${w};`
    return `  if (lid == 0u) { ${fold} }`
  }).join('\n')
  return /* wgsl */ `
enable subgroups;
struct Params {
  rows: u32,
  groupsPerRow: u32,
  wordsPerRow: u32,
  wrows: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> cross: array<array<f32, ${sgCount}>, ${wRows}>;

fn q2q(word: u32, sh: u32) -> vec4<f32> {
  let v = word >> sh;
  let codes = (vec4<u32>(v) >> vec4<u32>(0u, 2u, 4u, 6u)) & vec4<u32>(3u, 3u, 3u, 3u);
  return bitcast<vec4<f32>>(codes | vec4<u32>(0x4b000000u)) - vec4<f32>(8388609.0, 8388609.0, 8388609.0, 8388609.0);
}

@compute @workgroup_size(${wgSize})
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>, @builtin(subgroup_invocation_id) sg_lid: u32, @builtin(subgroup_id) sg_id: u32) {
  let rowBase = wid.x * ${wRows}u;
  let lid = lid3.x;
  if (rowBase >= params.rows) { return; }
  let blocksPerRow = params.wordsPerRow / 2u;
  var acc0 = 0.0;
${Array.from({ length: wRows - 1 }, (_, i) => `  var acc${i + 1} = 0.0;`).join('\n')}
  for (var b = lid; b < blocksPerRow; b = b + ${wgSize}u) {
    let x0 = x[b * 8u];
    let x1 = x[b * 8u + 1u];
    let x2 = x[b * 8u + 2u];
    let x3 = x[b * 8u + 3u];
    let x4 = x[b * 8u + 4u];
    let x5 = x[b * 8u + 5u];
    let x6 = x[b * 8u + 6u];
    let x7 = x[b * 8u + 7u];
${Array.from(
  { length: wRows },
  (_, w) => `    {
      let wordBase = (rowBase + ${w}u) * params.wordsPerRow + b * 2u;
      let wa = data[wordBase];
      let wb = data[wordBase + 1u];
      let scale = scales[(rowBase + ${w}u) * params.groupsPerRow + (b >> 2u)];
      acc${w} = acc${w} + scale * (
        dot(x0, q2q(wa, 0u)) + dot(x4, q2q(wb, 0u))
        + dot(x1, q2q(wa, 8u)) + dot(x5, q2q(wb, 8u))
        + dot(x2, q2q(wa, 16u)) + dot(x6, q2q(wb, 16u))
        + dot(x3, q2q(wa, 24u)) + dot(x7, q2q(wb, 24u)));
    }`,
).join('\n')}
  }
${Array.from(
  { length: wRows },
  (_, w) => `  let sg${w} = subgroupAdd(acc${w});
  if (sg_lid == 0u) { cross[${w}u][sg_id] = sg${w}; }`,
).join('\n')}
  workgroupBarrier();
${foldRows}
}
`
}

export const MATVEC_V6_WGSL = matvecV6(64, 4)
export const MATVEC_V6_W128_R2 = matvecV6(128, 2)
export const MATVEC_V6_W128_R8 = matvecV6(128, 8)
export const MATVEC_V6_W64_R2 = matvecV6(64, 2)
export const MATVEC_V6_W64_R1 = matvecV6(64, 1)
export const MATVEC_V6_W128_R4 = matvecV6(128, 4)

/**
 * The matvec v7 — the stock engine's DECODE GEMV shape (read off its
 * `lut2_decode_gemv_mr2` variant, priority 110), applied to our LUT2 layout:
 * the mapping is the INVERSE of v1–v6 — a workgroup of 128 threads (four
 * 32-lane clusters) owns EIGHT output rows; each cluster owns two rows and
 * its 32 lanes SPLIT the K reduction (row-paired, so the two rows' words and
 * x vec4s align and every x load feeds both rows' dots); each lane walks its
 * K-slice with two independent accumulators (ILP); the reduce is one
 * subgroupAdd per row — zero barriers, zero workgroup-memory traffic.
 * Grid = rows/8 workgroups (v6's occupancy diagnosis: rows/4 × 64 starved
 * the qkv-shaped tensors at 37 GB/s while ffn_up hit 100 — the cluster shape
 * keeps the thread count at rows × 16 regardless of rows).
 */
export const matvecV7 = (regRows: 1 | 2 | 4): string => {
  const rowsPerWg = (32 / 32) * 4 * regRows // 4 clusters × regRows
  const guards = Array.from({ length: regRows }, (_, r) => (r > 0 ? `  let ok${r} = col${r} < params.rows;` : ''))
    .filter(Boolean)
    .join('\n')
  const accs = Array.from({ length: regRows }, (_, r) => `  var acc${r} = 0.0;`).join('\n')
  const loads = Array.from(
    { length: regRows },
    (_, r) => `    let word${r} = data[(colC${r}) * params.wordsPerRow + w];`,
  ).join('\n')
  const scaleLoads = Array.from(
    { length: regRows },
    (_, r) => `    let scale${r} = scales[(colC${r}) * params.groupsPerRow + (w >> 3u)];`,
  ).join('\n')
  // the x vec4 load is SHARED across the cluster's rows (the same w → same x quad);
  // each row's dot lands in its own accumulator (independent FMA chains)
  const quadBlock = Array.from({ length: 4 }, (_, q) =>
    Array.from(
      { length: regRows },
      (_, r) => `    acc${r} = acc${r} + dot(x[xBase + ${q}u], q2q(word${r}, ${q * 8}u)) * scale${r};`,
    ).join('\n'),
  ).join('\n')
  return /* wgsl */ `
enable subgroups;
struct Params {
  rows: u32,
  groupsPerRow: u32,
  wordsPerRow: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

fn q2q(word: u32, sh: u32) -> vec4<f32> {
  let v = word >> sh;
  let codes = (vec4<u32>(v) >> vec4<u32>(0u, 2u, 4u, 6u)) & vec4<u32>(3u, 3u, 3u, 3u);
  return bitcast<vec4<f32>>(codes | vec4<u32>(0x4b000000u)) - vec4<f32>(8388609.0, 8388609.0, 8388609.0, 8388609.0);
}

@compute @workgroup_size(128)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(subgroup_invocation_id) sg_lid: u32, @builtin(subgroup_id) sg_id: u32) {
  let lane = sg_lid;
  let rowBase = wid.x * ${rowsPerWg}u;
  let col0 = rowBase + sg_id * ${regRows}u;
${Array.from({ length: regRows - 1 }, (_, r) => `  let col${r + 1} = col0 + ${r + 1}u;`).join('\n')}
${guards}
  // trailing rows clamp to a valid column — the garbage sums are simply never written
${Array.from({ length: regRows }, (_, r) => `  let colC${r} = min(col${r}, params.rows - 1u);`).join('\n')}
  let wordsPerLane = params.wordsPerRow / 32u;
  let wStart = lane * wordsPerLane;
${accs}
  for (var i = 0u; i < wordsPerLane; i = i + 1u) {
    let w = wStart + i;
    let xBase = w * 4u;
${loads}
${scaleLoads}
${quadBlock}
  }
  let sum0 = subgroupAdd(acc0);
  if (col0 < params.rows && lane == 0u) { y[col0] = sum0; }
${Array.from(
  { length: regRows - 1 },
  (_, r) => `  let sum${r + 1} = subgroupAdd(acc${r + 1});
  if (ok${r + 1} && lane == 0u) { y[col${r + 1}] = sum${r + 1}; }`,
).join('\n')}
}
`
}

export const MATVEC_V7_WGSL = matvecV7(2)
export const MATVEC_V7_R4 = matvecV7(4)

/** The matvec kernel: y[r] = Σ_c trit(W[r,c])·scale·x[c], one thread per row. */
export const MATVEC_WGSL = /* wgsl */ `
struct Params {
  rows: u32,
  groupsPerRow: u32,
  repeats: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= params.rows) { return; }
  let rowWordBase = r * params.groupsPerRow * 8u;
  var acc = 0.0;
  for (var g = 0u; g < params.groupsPerRow; g = g + 1u) {
    let scale = scales[r * params.groupsPerRow + g];
    let wordBase = rowWordBase + g * 8u;
    let colBase = g * 128u;
    for (var w = 0u; w < 8u; w = w + 1u) {
      let word = data[wordBase + w];
      let col = colBase + w * 16u;
      for (var k = 0u; k < 16u; k = k + 1u) {
        let v = (word >> (k * 2u)) & 3u;
        acc = acc + (f32(v) - 1.0) * scale * x[col + k];
      }
    }
  }
  y[r] = acc;
}
`

/**
 * The matvec v2 — the same math, the parallel-K shape the stock engine's own
 * decode ops use (one WORKGROUP per row; threads stride the row's 16-weight
 * words; partials tree-fold in workgroup memory) with a vectorized decode:
 * four 2-bit lanes per shift+mask, the trit as f32(v)−1, one vec4 dot per
 * quad — ~2.5 ALU ops/weight vs v1's ~6 (v1 measured ALU-bound at 33–36 GB/s,
 * 3.5× under the stock decode's effective bandwidth — the loop's first signal).
 */
export const MATVEC_V2_WGSL = /* wgsl */ `
struct Params {
  rows: u32,
  groupsPerRow: u32,
  wordsPerRow: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> partials: array<f32, 256>;

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let row = wid.x;
  let lid = lid3.x;
  if (row >= params.rows) { return; }
  let rowBase = row * params.wordsPerRow;
  var acc = 0.0;
  for (var w = lid; w < params.wordsPerRow; w = w + 256u) {
    let word = data[rowBase + w];
    let scale = scales[row * params.groupsPerRow + (w >> 3u)];
    let col = w * 16u;
    for (var q = 0u; q < 4u; q = q + 1u) {
      let shifts = vec4<u32>(q * 8u, q * 8u + 2u, q * 8u + 4u, q * 8u + 6u);
      let v4 = (vec4<u32>(word) >> shifts) & vec4<u32>(3u, 3u, 3u, 3u);
      let t4 = vec4<f32>(v4) - vec4<f32>(1.0, 1.0, 1.0, 1.0);
      let x4 = vec4<f32>(x[col + q * 4u], x[col + q * 4u + 1u], x[col + q * 4u + 2u], x[col + q * 4u + 3u]);
      acc = acc + scale * dot(t4, x4);
    }
  }
  partials[lid] = acc;
  workgroupBarrier();
  for (var s = 128u; s > 0u; s = s >> 1u) {
    if (lid < s) { partials[lid] = partials[lid] + partials[lid + s]; }
    workgroupBarrier();
  }
  if (lid == 0u) { y[row] = partials[0]; }
}
`

/**
 * The matvec v4 — v1's mapping with the x binding as `array<vec4<f32>>`
 * (true 16-byte vector loads — the v3 bench row showed the scalar-loaded vec4
 * construction LOSES to v1's scalar loop, 30/21 vs 33–36 GB/s: four separate
 * x loads + register moves per quad ate the ALU win) and the group-major
 * loop (one scale fetch per 128-weight group). The quad decode itself stays:
 * four 2-bit lanes per shift+mask, one vec4 dot per quad.
 * x MUST be 16-byte aligned (cols a multiple of 128 — the format's invariant).
 */
export const MATVEC_V4_WGSL = /* wgsl */ `
struct Params {
  rows: u32,
  groupsPerRow: u32,
  wordsPerRow: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= params.rows) { return; }
  let rowWordBase = r * params.wordsPerRow;
  var acc = 0.0;
  for (var g = 0u; g < params.groupsPerRow; g = g + 1u) {
    let scale = scales[r * params.groupsPerRow + g];
    let wBase = rowWordBase + g * 8u;
    for (var w = 0u; w < 8u; w = w + 1u) {
      let word = data[wBase + w];
      let xBase = (g * 8u + w) * 4u;
      for (var q = 0u; q < 4u; q = q + 1u) {
        let shifts = vec4<u32>(q * 8u, q * 8u + 2u, q * 8u + 4u, q * 8u + 6u);
        let v4 = (vec4<u32>(word) >> shifts) & vec4<u32>(3u, 3u, 3u, 3u);
        let t4 = vec4<f32>(v4) - vec4<f32>(1.0, 1.0, 1.0, 1.0);
        acc = acc + scale * dot(t4, x[xBase + q]);
      }
    }
  }
  y[r] = acc;
}
`

/**
 * The matvec v3 — v1's mapping (one thread per row, zero barriers) with the
 * vectorized decode: four 2-bit lanes per shift+mask, one vec4 dot per quad.
 * The v2 bench row (18–21 GB/s — slower than v1's 33–36) ruled OUT the
 * parallel-K workgroup shape at these row counts: the fold's 8 barrier steps
 * over ~320-word rows cost more than the ALU they save. v3 keeps the ALU win,
 * drops the barriers.
 */
export const MATVEC_V3_WGSL = /* wgsl */ `
struct Params {
  rows: u32,
  groupsPerRow: u32,
  wordsPerRow: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<f32>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let r = gid.x;
  if (r >= params.rows) { return; }
  let rowWordBase = r * params.wordsPerRow;
  var acc = 0.0;
  for (var w = 0u; w < params.wordsPerRow; w = w + 1u) {
    let word = data[rowWordBase + w];
    let scale = scales[r * params.groupsPerRow + (w >> 3u)];
    let col = w * 16u;
    for (var q = 0u; q < 4u; q = q + 1u) {
      let shifts = vec4<u32>(q * 8u, q * 8u + 2u, q * 8u + 4u, q * 8u + 6u);
      let v4 = (vec4<u32>(word) >> shifts) & vec4<u32>(3u, 3u, 3u, 3u);
      let t4 = vec4<f32>(v4) - vec4<f32>(1.0, 1.0, 1.0, 1.0);
      let x4 = vec4<f32>(x[col + q * 4u], x[col + q * 4u + 1u], x[col + q * 4u + 2u], x[col + q * 4u + 3u]);
      acc = acc + scale * dot(t4, x4);
    }
  }
  y[r] = acc;
}
`
