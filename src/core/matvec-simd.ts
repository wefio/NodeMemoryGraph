const WASM_PAGE_BYTES = 65_536;
const WORKSPACE_PAGES = 64;
const WORKSPACE_FLOATS = (WORKSPACE_PAGES * WASM_PAGE_BYTES) / Float32Array.BYTES_PER_ELEMENT;
const RESULT_FLOATS = 2;
const MIN_COLUMNS = 128;
const MIN_MULTIPLY_ADDS = 131_072;

interface MatvecKernel {
  memory: WebAssembly.Memory;
  dotPair(left: number, right: number, vector: number, rowBytes: number, result: number): void;
}

let kernel: MatvecKernel | null | undefined;

/**
 * Write a row-major Float32 matrix-vector product when the shape amortizes
 * WebAssembly dispatch and copying. Supply a separate result buffer. The two
 * SIMD lanes compute rows in the scalar Float32 kernel's accumulation order.
 */
export function tryMatvecSimd(
  matrix: Float32Array,
  vector: Float32Array,
  result: Float32Array,
): boolean {
  const rows = result.length;
  const columns = vector.length;
  if (rows < 2 || columns < MIN_COLUMNS || matrix.length !== rows * columns) return false;
  if (matrix.length < MIN_MULTIPLY_ADDS || RESULT_FLOATS + 2 * columns > WORKSPACE_FLOATS)
    return false;

  if (kernel === undefined) kernel = createKernel();
  if (!kernel) return false;
  const rowsPerBlock = Math.min(
    rows,
    Math.floor((WORKSPACE_FLOATS - RESULT_FLOATS - columns) / columns),
  );
  const work = reserve(kernel.memory, RESULT_FLOATS + (rowsPerBlock + 1) * columns);
  if (!work) return false;

  work.set(vector, RESULT_FLOATS);
  const matrixOffset = RESULT_FLOATS + columns;
  const floatBytes = Float32Array.BYTES_PER_ELEMENT;
  for (let start = 0; start < rows; start += rowsPerBlock) {
    const count = Math.min(rowsPerBlock, rows - start);
    work.set(matrix.subarray(start * columns, (start + count) * columns), matrixOffset);
    for (let row = 0; row < count; row += 2) {
      const first = (matrixOffset + row * columns) * floatBytes;
      const second = row + 1 < count ? first + columns * floatBytes : first;
      kernel.dotPair(first, second, RESULT_FLOATS * floatBytes, columns * floatBytes, 0);
      result[start + row] = work[0]!;
      if (row + 1 < count) result[start + row + 1] = work[1]!;
    }
  }
  return true;
}

function reserve(memory: WebAssembly.Memory, floats: number): Float32Array | null {
  const extra = floats * Float32Array.BYTES_PER_ELEMENT - memory.buffer.byteLength;
  try {
    if (extra > 0) memory.grow(Math.ceil(extra / WASM_PAGE_BYTES));
    return new Float32Array(memory.buffer);
  } catch {
    return null;
  }
}

function createKernel(): MatvecKernel | null {
  if (typeof WebAssembly === "undefined") return null;
  try {
    // Construct only on first use. Runtimes without SIMD or dynamic Wasm fall back.
    const module = new WebAssembly.Module(dotPairModule());
    return new WebAssembly.Instance(module).exports as unknown as MatvecKernel;
  } catch {
    return null;
  }
}

function uleb(value: number): number[] {
  const bytes: number[] = [];
  do {
    const low = value & 0x7f;
    value >>>= 7;
    bytes.push(value ? low | 0x80 : low);
  } while (value);
  return bytes;
}

function section(id: number, contents: number[]): number[] {
  return [id, ...uleb(contents.length), ...contents];
}

function exportName(name: string): number[] {
  return [name.length, ...Array.from(name, (character) => character.charCodeAt(0))];
}

function dotPairModule(): Uint8Array<ArrayBuffer> {
  const i32 = 0x7f;
  const v128 = 0x7b;
  const voidBlock = 0x40;
  const block = 0x02,
    loop = 0x03,
    end = 0x0b,
    branch = 0x0c,
    branchIf = 0x0d;
  const i32Const = 0x41,
    i32Add = 0x6a,
    i32GeUnsigned = 0x4f;
  const f32Load = 0x2a,
    f32Store = 0x38,
    promoteF32 = 0xbb,
    demoteF64 = 0xb6;
  const f64x2Splat = 0x14,
    f64x2ExtractLane = 0x21,
    f64x2ReplaceLane = 0x22;
  const f32x4DemoteLow = 0x5e,
    f64x2PromoteLow = 0x5f,
    f64x2Add = 0xf0,
    f64x2Multiply = 0xf2;
  const get = (local: number) => [0x20, local];
  const set = (local: number) => [0x21, local];
  const simd = (opcode: number) => [0xfd, ...uleb(opcode)];
  const [firstRow, secondRow, query, rowBytes, result, offset, sum] = [
    0, 1, 2, 3, 4, 5, 6,
  ] as const;
  const loadCoefficient = (address: number) => [
    ...get(address),
    ...get(offset),
    i32Add,
    f32Load,
    2,
    0,
    promoteF32,
  ];
  const storeLane = (lane: number) => [
    ...get(result),
    ...get(sum),
    ...simd(f64x2ExtractLane),
    lane,
    demoteF64,
    f32Store,
    2,
    lane * 4,
  ];
  const body = [
    2,
    1,
    i32,
    1,
    v128, // byte offset and two Float64 accumulators
    block,
    voidBlock,
    loop,
    voidBlock,
    ...get(offset),
    ...get(rowBytes),
    i32GeUnsigned,
    branchIf,
    1,
    ...get(sum),
    ...loadCoefficient(firstRow),
    ...simd(f64x2Splat),
    ...loadCoefficient(secondRow),
    ...simd(f64x2ReplaceLane),
    1,
    ...loadCoefficient(query),
    ...simd(f64x2Splat),
    ...simd(f64x2Multiply),
    ...simd(f64x2Add),
    // Match JS number multiplication/addition and the Float32 store after every add.
    ...simd(f32x4DemoteLow),
    ...simd(f64x2PromoteLow),
    ...set(sum),
    ...get(offset),
    i32Const,
    4,
    i32Add,
    ...set(offset),
    branch,
    0,
    end,
    end,
    ...storeLane(0),
    ...storeLane(1),
    end,
  ];
  return Uint8Array.from([
    0x00,
    0x61,
    0x73,
    0x6d,
    1,
    0,
    0,
    0, // Wasm v1 header
    ...section(1, [1, 0x60, 5, i32, i32, i32, i32, i32, 0]),
    ...section(3, [1, 0]), // single function of type 0
    ...section(5, [1, 1, 1, WORKSPACE_PAGES]), // one memory, initial and maximum pages
    ...section(7, [2, ...exportName("dotPair"), 0, 0, ...exportName("memory"), 2, 0]),
    ...section(10, [1, ...uleb(body.length), ...body]),
  ]);
}
