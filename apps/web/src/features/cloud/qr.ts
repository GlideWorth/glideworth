/**
 * A small QR Code encoder (ISO/IEC 18004: byte mode, error correction level M, versions 1 to 10, best of
 * the eight masks by the standard penalty rules). The two-factor setup draws the authenticator link with
 * it, so the secret is never sent to a QR image service and the page makes no network call for it.
 * Capacity at level M is 213 bytes, far more than an `otpauth://` link needs.
 */

const VERSION_MAX = 10;
/** Error correction codewords per block, and number of blocks, level M, versions 1..10. */
const ECC_PER_BLOCK = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26];
const NUM_BLOCKS = [1, 1, 1, 2, 2, 4, 4, 4, 5, 5];

const size = (version: number) => version * 4 + 17;

function rawDataModules(version: number): number {
  let n = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const align = Math.floor(version / 7) + 2;
    n -= (25 * align - 10) * align - 55;
    if (version >= 7) n -= 36;
  }
  return n;
}
const dataCodewords = (v: number) =>
  Math.floor(rawDataModules(v) / 8) - ECC_PER_BLOCK[v - 1]! * NUM_BLOCKS[v - 1]!;

// ------------------------------------------------------------------------------------ Reed-Solomon
function gfMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z;
}
function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMultiply(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMultiply(root, 0x02);
  }
  return result;
}
function rsRemainder(data: number[], divisor: number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((c, i) => (result[i]! ^= gfMultiply(c, factor)));
  }
  return result;
}

// ------------------------------------------------------------------------------------------ encode
function dataBits(bytes: number[], version: number): number[] {
  const bits: number[] = [];
  const push = (value: number, len: number) => {
    for (let i = len - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, version < 10 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  const capacity = dataCodewords(version) * 8;
  push(0, Math.min(4, capacity - bits.length));
  while (bits.length % 8) bits.push(0);
  for (let pad = 0xec; bits.length < capacity; pad ^= 0xec ^ 0x11) push(pad, 8);
  return bits;
}

function interleave(data: number[], version: number): number[] {
  const blocks = NUM_BLOCKS[version - 1]!;
  const eccLen = ECC_PER_BLOCK[version - 1]!;
  const raw = Math.floor(rawDataModules(version) / 8);
  const short = blocks - (raw % blocks);
  const shortLen = Math.floor(raw / blocks);
  const div = rsDivisor(eccLen);
  const out: number[][] = [];
  for (let i = 0, k = 0; i < blocks; i++) {
    const dat = data.slice(k, k + shortLen - eccLen + (i < short ? 0 : 1));
    k += dat.length;
    const ecc = rsRemainder(dat, div);
    if (i < short) dat.push(0);
    out.push(dat.concat(ecc));
  }
  const result: number[] = [];
  for (let i = 0; i < out[0]!.length; i++)
    out.forEach((block, j) => {
      if (i !== shortLen - eccLen || j >= short) result.push(block[i]!);
    });
  return result;
}

// ------------------------------------------------------------------------------------------- matrix
class Matrix {
  readonly n: number;
  readonly dark: boolean[][];
  readonly fixed: boolean[][];
  constructor(readonly version: number) {
    this.n = size(version);
    this.dark = Array.from({ length: this.n }, () => new Array<boolean>(this.n).fill(false));
    this.fixed = Array.from({ length: this.n }, () => new Array<boolean>(this.n).fill(false));
    this.drawFunctionPatterns();
  }
  private set(x: number, y: number, dark: boolean) {
    this.dark[y]![x] = dark;
    this.fixed[y]![x] = true;
  }
  private drawFunctionPatterns() {
    const n = this.n;
    for (let i = 0; i < n; i++) {
      this.set(6, i, i % 2 === 0);
      this.set(i, 6, i % 2 === 0);
    }
    for (const [cx, cy] of [
      [3, 3],
      [n - 4, 3],
      [3, n - 4],
    ] as const)
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx;
          const y = cy + dy;
          if (x >= 0 && x < n && y >= 0 && y < n) this.set(x, y, dist !== 2 && dist !== 4);
        }
    const pos = this.alignmentPositions();
    pos.forEach((px, i) =>
      pos.forEach((py, j) => {
        const corner =
          (i === 0 && j === 0) ||
          (i === 0 && j === pos.length - 1) ||
          (i === pos.length - 1 && j === 0);
        if (corner) return;
        for (let dy = -2; dy <= 2; dy++)
          for (let dx = -2; dx <= 2; dx++)
            this.set(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }),
    );
    this.formatBits(0);
    this.versionBits();
  }
  private alignmentPositions(): number[] {
    if (this.version === 1) return [];
    const count = Math.floor(this.version / 7) + 2;
    const step = Math.ceil((this.version * 4 + 4) / (count * 2 - 2)) * 2;
    const result = [6];
    for (let p = this.n - 7; result.length < count; p -= step) result.splice(1, 0, p);
    return result;
  }
  formatBits(mask: number) {
    const n = this.n;
    const data = (0 << 3) | mask; // level M has format bits 00
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412;
    const bit = (i: number) => ((bits >>> i) & 1) !== 0;
    for (let i = 0; i <= 5; i++) this.set(8, i, bit(i));
    this.set(8, 7, bit(6));
    this.set(8, 8, bit(7));
    this.set(7, 8, bit(8));
    for (let i = 9; i < 15; i++) this.set(14 - i, 8, bit(i));
    for (let i = 0; i < 8; i++) this.set(n - 1 - i, 8, bit(i));
    for (let i = 8; i < 15; i++) this.set(8, n - 15 + i, bit(i));
    this.set(8, n - 8, true);
  }
  private versionBits() {
    if (this.version < 7) return;
    let rem = this.version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (this.version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const d = ((bits >>> i) & 1) !== 0;
      const a = this.n - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.set(a, b, d);
      this.set(b, a, d);
    }
  }
  placeCodewords(codewords: number[]) {
    const n = this.n;
    let i = 0;
    for (let right = n - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < n; vert++)
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? n - 1 - vert : vert;
          if (!this.fixed[y]![x] && i < codewords.length * 8) {
            this.dark[y]![x] = ((codewords[i >>> 3]! >>> (7 - (i & 7))) & 1) !== 0;
            i++;
          }
        }
    }
  }
  applyMask(mask: number) {
    for (let y = 0; y < this.n; y++)
      for (let x = 0; x < this.n; x++) {
        const flip = [
          (x + y) % 2 === 0,
          y % 2 === 0,
          x % 3 === 0,
          (x + y) % 3 === 0,
          (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
          ((x * y) % 2) + ((x * y) % 3) === 0,
          (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
          (((x + y) % 2) + ((x * y) % 3)) % 2 === 0,
        ][mask]!;
        if (!this.fixed[y]![x] && flip) this.dark[y]![x] = !this.dark[y]![x];
      }
  }
  penalty(): number {
    const n = this.n;
    const g = this.dark;
    let score = 0;
    const lineScore = (get: (i: number) => boolean) => {
      let s = 0;
      let run = 1;
      for (let i = 1; i < n; i++) {
        if (get(i) === get(i - 1)) run++;
        else {
          if (run >= 5) s += run - 2;
          run = 1;
        }
      }
      if (run >= 5) s += run - 2;
      // 1:1:3:1:1 finder-like pattern with a light run of 4 on either side
      for (let i = 0; i + 11 <= n; i++) {
        const w = (k: number) => get(i + k);
        const core = w(0) && !w(1) && w(2) && w(3) && w(4) && !w(5) && w(6);
        if (core && !w(7) && !w(8) && !w(9) && !w(10)) s += 40;
        const core2 = w(4) && !w(5) && w(6) && w(7) && w(8) && !w(9) && w(10);
        if (core2 && !w(0) && !w(1) && !w(2) && !w(3)) s += 40;
      }
      return s;
    };
    for (let i = 0; i < n; i++) {
      score += lineScore((k) => g[i]![k]!);
      score += lineScore((k) => g[k]![i]!);
    }
    for (let y = 0; y < n - 1; y++)
      for (let x = 0; x < n - 1; x++) {
        const c = g[y]![x];
        if (c === g[y]![x + 1] && c === g[y + 1]![x] && c === g[y + 1]![x + 1]) score += 3;
      }
    const total = n * n;
    const dark = g.reduce((a, row) => a + row.filter(Boolean).length, 0);
    score += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return score;
  }
}

/** The dark modules of the QR code for `text` (UTF-8), as rows of booleans. Throws when it does not fit. */
export function encodeQr(text: string): boolean[][] {
  const bytes = [...new TextEncoder().encode(text)];
  let version = 1;
  // mode (4) + count (8 or 16) + data, in bits
  while (
    version <= VERSION_MAX &&
    4 + (version < 10 ? 8 : 16) + bytes.length * 8 > dataCodewords(version) * 8
  )
    version++;
  if (version > VERSION_MAX) throw new Error("Too long for a QR code");
  const codewords = interleave(
    dataBits(bytes, version).reduce<number[]>((acc, bit, i) => {
      if (i % 8 === 0) acc.push(0);
      acc[acc.length - 1] = (acc[acc.length - 1]! << 1) | bit;
      return acc;
    }, []),
    version,
  );
  let best: Matrix | null = null;
  let bestScore = Infinity;
  for (let mask = 0; mask < 8; mask++) {
    const m = new Matrix(version);
    m.placeCodewords(codewords);
    m.applyMask(mask);
    m.formatBits(mask);
    const score = m.penalty();
    if (score < bestScore) {
      best = m;
      bestScore = score;
    }
  }
  return best!.dark;
}
