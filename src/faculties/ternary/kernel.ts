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
 * Bundle-clean: WGSL strings only — no node: imports, no host-runtime globals.
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

/**
 * The batch dequant-matmul (the PREFILL profile — systemOne's logits-readback
 * scoring): Y[B,N] = X[B,K]·Wᵀ, tiled. Each workgroup computes a (bn rows ×
 * bm tokens) output tile; the k-reduction walks 128-column chunks (one LUT2
 * group per row per chunk); the token tile's x chunk stages in workgroup
 * memory as vec4s (bm × 32 vec4s = 16KB at bm=32 — the device's floor for
 * maxComputeWorkgroupStorageSize, verified live). The thread map: row slot =
 * lid/bm·4 … wait — the CONCRETE map: thread's row = row0 + lid/8, its tokens
 * = 4 (t0 + (lid%8)·4 + j); the row's words decode ONCE per thread and feed
 * 4 tokens × 4 quads of dots — the decode amortizes over the token tile (the
 * arithmetic intensity the prefill profile buys).
 *
 * v1-batch is the loop's starting point (the naive tiled body), same
 * discipline as the matvec: measure, then refine by bench rows.
 */
export const matmulV1 = (bm: 32 | 64, bn: 32 | 64): string => {
  const threadsPerRow = bm / 4 // 4 tokens per thread
  const xwSize = bm * 32 // tokens × (128 cols / 4) vec4s
  const rowsPerWg = bn
  return /* wgsl */ `
enable subgroups;
struct Params {
  tokens: u32,
  rows: u32,
  cols: u32,
  dummy: u32,
}
@group(0) @binding(0) var<storage, read> data: array<u32>;
@group(0) @binding(1) var<storage, read> scales: array<f32>;
@group(0) @binding(2) var<storage, read> x: array<vec4<f32>>;
@group(0) @binding(3) var<storage, read_write> y: array<f32>;
@group(0) @binding(4) var<uniform> params: Params;

var<workgroup> xw: array<vec4<f32>, ${xwSize}>;

fn q2q(word: u32, sh: u32) -> vec4<f32> {
  let v = word >> sh;
  let codes = (vec4<u32>(v) >> vec4<u32>(0u, 2u, 4u, 6u)) & vec4<u32>(3u, 3u, 3u, 3u);
  return bitcast<vec4<f32>>(codes | vec4<u32>(0x4b000000u)) - vec4<f32>(8388609.0, 8388609.0, 8388609.0, 8388609.0);
}

@compute @workgroup_size(256)
fn main(@builtin(workgroup_id) wid3: vec3<u32>, @builtin(local_invocation_id) lid3: vec3<u32>) {
  let row0 = wid3.x * ${rowsPerWg}u;
  let t0 = wid3.y * ${bm}u;
  let lid = lid3.x;
  let row = row0 + lid / ${threadsPerRow}u;
  let tokBase = t0 + (lid % ${threadsPerRow}u) * 4u;
  let groupsPerRow = params.cols / 128u;
  var acc0 = 0.0;
  var acc1 = 0.0;
  var acc2 = 0.0;
  var acc3 = 0.0;
  for (var g = 0u; g < groupsPerRow; g = g + 1u) {
    // cooperative x-chunk load: ${xwSize} vec4s, 4 per thread (token-major, 32 vec4s per token)
    for (var i = lid; i < ${xwSize}; i = i + 256u) {
      let token = i / 32u;
      let quad = i % 32u;
      xw[i] = x[(t0 + token) * (params.cols / 4u) + g * 32u + quad];
    }
    workgroupBarrier();
    let rowClamped = min(row, params.rows - 1u);
    let wordBase = rowClamped * (params.cols / 16u) + g * 8u;
    let scale = scales[rowClamped * groupsPerRow + g];
    let myTokBase = (lid % ${threadsPerRow}u) * 4u; // the thread's token slots in xw
    for (var w = 0u; w < 8u; w = w + 1u) {
      let word = data[wordBase + w];
      for (var q = 0u; q < 4u; q = q + 1u) {
        let t4 = q2q(word, q * 8u);
        // the x quad for (word w, quad q) is w·4 + q within the chunk — the
        // one-hot column sweep caught the missing w·4 (every word's quad q
        // was reading the first word's quad q: only the first 16 cols ever
        // contributed)
        acc0 = acc0 + scale * dot(t4, xw[(myTokBase + 0u) * 32u + w * 4u + q]);
        acc1 = acc1 + scale * dot(t4, xw[(myTokBase + 1u) * 32u + w * 4u + q]);
        acc2 = acc2 + scale * dot(t4, xw[(myTokBase + 2u) * 32u + w * 4u + q]);
        acc3 = acc3 + scale * dot(t4, xw[(myTokBase + 3u) * 32u + w * 4u + q]);
      }
    }
    workgroupBarrier();
  }
  if (row < params.rows && tokBase < params.tokens) {
    y[row * params.tokens + tokBase + 0u] = acc0;
    y[row * params.tokens + tokBase + 1u] = acc1;
    y[row * params.tokens + tokBase + 2u] = acc2;
    y[row * params.tokens + tokBase + 3u] = acc3;
  }
}
`
}

export const MATMUL_V1_WGSL = matmulV1(32, 32)
export const MATMUL_V1_B64 = matmulV1(64, 32)
export const MATMUL_V1_N64 = matmulV1(32, 64)

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
