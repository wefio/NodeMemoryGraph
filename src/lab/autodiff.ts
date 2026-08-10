type Shape = readonly [rows: number, columns: number];

const Op = {
  Add: "add",
  Broadcast: "broadcast",
  Constant: "constant",
  Exp: "exp",
  Index: "index",
  L2Normalize: "l2_normalize",
  L2NormalizeGradient: "l2_normalize_gradient",
  Log: "log",
  Matmul: "matmul",
  Multiply: "multiply",
  Negate: "negate",
  Parameter: "parameter",
  Reciprocal: "reciprocal",
  Scatter: "scatter",
  Sigmoid: "sigmoid",
  Softmax: "softmax",
  SoftmaxGradient: "softmax_gradient",
  Sqrt: "sqrt",
  Sum: "sum",
  SumN: "sum_n",
  Transpose: "transpose",
} as const;

type Op = (typeof Op)[keyof typeof Op];

class UOp {
  readonly op: Op;
  readonly shape: Shape;
  readonly sources: readonly UOp[];
  readonly argument: Float32Array | number | undefined;

  constructor(
    op: Op,
    shape: Shape,
    sources: readonly UOp[] = [],
    argument?: Float32Array | number,
  ) {
    this.op = op;
    this.shape = shape;
    this.sources = sources;
    this.argument = argument;
  }
}

const gradients = new WeakMap<UOp, Float32Array>();
const l2InvNorms = new WeakMap<UOp, number>();

function sizeOf(shape: Shape): number {
  return shape[0] * shape[1];
}

function sameShape(left: Shape, right: Shape): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function scalar(value: number): UOp {
  return new UOp(Op.Constant, [1, 1], [], Float32Array.of(value));
}

function isScalarConstant(node: UOp): node is UOp & { argument: Float32Array } {
  return node.op === Op.Constant && node.argument instanceof Float32Array && node.argument.length === 1;
}

function scalarValue(node: UOp): number {
  return (node.argument as Float32Array)[0]!;
}

function unary(op: Op, source: UOp, shape: Shape = source.shape, argument?: number): UOp {
  return new UOp(op, shape, [source], argument);
}

function binary(op: Op, left: UOp, right: UOp, shape: Shape): UOp {
  return new UOp(op, shape, [left, right]);
}

function add(left: UOp, right: UOp): UOp {
  // Fold scalar constants and zero identities.
  if (isScalarConstant(left) && isScalarConstant(right)) {
    return scalar(scalarValue(left) + scalarValue(right));
  }
  if (isScalarConstant(right) && scalarValue(right) === 0) return left;
  if (isScalarConstant(left) && scalarValue(left) === 0) return right;
  if (sameShape(left.shape, right.shape)) return binary(Op.Add, left, right, left.shape);
  if (sizeOf(left.shape) === 1)
    return binary(Op.Add, broadcast(left, right.shape), right, right.shape);
  if (sizeOf(right.shape) === 1)
    return binary(Op.Add, left, broadcast(right, left.shape), left.shape);
  throw new Error("add requires equal shapes or a scalar operand");
}

function sumN(inputs: UOp[]): UOp {
  if (inputs.length < 2) throw new Error("sumN requires at least two operands");
  const shape = inputs[0]!.shape;
  for (let i = 1; i < inputs.length; i++) {
    if (!sameShape(inputs[i]!.shape, shape)) throw new Error("sumN requires equal shapes");
  }
  return new UOp(Op.SumN, shape, inputs, undefined);
}

function multiply(left: UOp, right: UOp): UOp {
  if (isScalarConstant(left) && isScalarConstant(right)) {
    return scalar(scalarValue(left) * scalarValue(right));
  }
  // Fold: x * (-1) → negate(x)
  if (isScalarConstant(right) && scalarValue(right) === -1) return negate(left);
  if (isScalarConstant(left) && scalarValue(left) === -1) return negate(right);
  // Fold: x * 1 → x  (x * 0 deliberately NOT folded: NaN/Inf semantics)
  if (isScalarConstant(right) && scalarValue(right) === 1) return left;
  if (isScalarConstant(left) && scalarValue(left) === 1) return right;
  if (sameShape(left.shape, right.shape)) return binary(Op.Multiply, left, right, left.shape);
  if (sizeOf(left.shape) === 1) {
    return binary(Op.Multiply, broadcast(left, right.shape), right, right.shape);
  }
  if (sizeOf(right.shape) === 1) {
    return binary(Op.Multiply, left, broadcast(right, left.shape), left.shape);
  }
  throw new Error("multiply requires equal shapes or a scalar operand");
}

function negate(source: UOp): UOp {
  if (source.op === Op.Negate) return source.sources[0]!;
  if (isScalarConstant(source)) return scalar(-scalarValue(source));
  return unary(Op.Negate, source);
}

function l2Normalize(source: UOp): UOp {
  return unary(Op.L2Normalize, source);
}

function reciprocal(source: UOp): UOp {
  if (source.op === Op.Reciprocal) return source.sources[0]!;
  if (isScalarConstant(source)) return scalar(1 / scalarValue(source));
  return unary(Op.Reciprocal, source);
}

function broadcast(source: UOp, shape: Shape): UOp {
  if (sameShape(source.shape, shape)) return source;
  if (sizeOf(source.shape) !== 1) throw new Error("only scalar broadcasting is supported");
  return unary(Op.Broadcast, source, shape);
}

function reduceToShape(source: UOp, shape: Shape): UOp {
  if (sameShape(source.shape, shape)) return source;
  if (sizeOf(shape) !== 1) throw new Error("only scalar broadcast gradients are supported");
  return unary(Op.Sum, source, [1, 1]);
}

function topologicalSort(root: UOp): UOp[] {
  const visited = new Set<UOp>();
  const ordered: UOp[] = [];
  const visit = (operation: UOp) => {
    if (visited.has(operation)) return;
    visited.add(operation);
    operation.sources.forEach(visit);
    ordered.push(operation);
  };
  visit(root);
  return ordered;
}

function evaluate(root: UOp, cache = new Map<UOp, Float32Array>()): Float32Array {
  const existing = cache.get(root);
  if (existing) return existing;
  const sources = root.sources;
  const values = new Array<Float32Array>(sources.length);
  for (let i = 0; i < sources.length; i += 1) values[i] = evaluate(sources[i]!, cache);
  let result: Float32Array;
  switch (root.op) {
    case Op.Constant:
    case Op.Parameter:
      result = root.argument as Float32Array;
      break;
    case Op.Add: {
      const a = values[0]!;
      const b = values[1]!;
      result = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) result[i] = a[i]! + b[i]!;
      break;
    }
    case Op.Multiply: {
      const a = values[0]!;
      const b = values[1]!;
      result = new Float32Array(a.length);
      for (let i = 0; i < a.length; i++) result[i] = a[i]! * b[i]!;
      break;
    }
    case Op.Negate: {
      const src = values[0]!;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = -src[i]!;
      break;
    }
    case Op.Broadcast: {
      result = new Float32Array(sizeOf(root.shape));
      const fill = values[0]![0]!;
      for (let i = 0; i < result.length; i++) result[i] = fill;
    }
      break;
    case Op.Matmul:
      result = evaluateMatmul(
        values[0]!,
        root.sources[0]!.shape,
        values[1]!,
        root.sources[1]!.shape,
      );
      break;
    case Op.Sum: {
      const src = values[0]!;
      let total = 0;
      for (let i = 0; i < src.length; i++) total += src[i]!;
      result = Float32Array.of(total);
    }
      break;
    case Op.SumN: {
      const n = values.length;
      result = new Float32Array(values[0]!.length);
      for (let j = 0; j < n; j++) {
        const src = values[j]!;
        for (let i = 0; i < src.length; i++) result[i] += src[i]!;
      }
    }
      break;
    case Op.Exp: {
      const src = values[0]!;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = Math.exp(src[i]!);
      break;
    }
    case Op.Log: {
      const src = values[0]!;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = Math.log(src[i]! < 1e-7 ? 1e-7 : src[i]!);
      break;
    }
    case Op.Reciprocal: {
      const src = values[0]!;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = 1 / (src[i]! < 1e-7 ? 1e-7 : src[i]!);
      break;
    }
    case Op.Sigmoid: {
      const src = values[0]!;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = 1 / (1 + Math.exp(-src[i]!));
      break;
    }
    case Op.L2Normalize: {
      const src = values[0]!;
      let sumSq = 0;
      for (let i = 0; i < src.length; i++) sumSq += src[i]! * src[i]!;
      const norm = Math.sqrt(sumSq);
      const invNorm = norm === 0 ? 0 : 1 / norm;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = src[i]! * invNorm;
      l2InvNorms.set(root, invNorm);
      break;
    }
    case Op.L2NormalizeGradient: {
      const output = values[0]!;
      const grad = values[1]!;
      const invNorm = root.argument as number;
      let dot = 0;
      for (let i = 0; i < output.length; i++) dot += output[i]! * grad[i]!;
      result = new Float32Array(output.length);
      for (let i = 0; i < output.length; i++) {
        result[i] = (grad[i]! - output[i]! * dot) * invNorm;
      }
      break;
    }
    case Op.Softmax:
      result = evaluateSoftmax(values[0]!);
      break;
    case Op.SoftmaxGradient: {
      const prob = values[0]!;
      const grad = values[1]!;
      let weighted = 0;
      for (let i = 0; i < prob.length; i++) weighted += prob[i]! * grad[i]!;
      result = new Float32Array(prob.length);
      for (let i = 0; i < prob.length; i++) result[i] = prob[i]! * (grad[i]! - weighted);
      break;
    }
    case Op.Index:
      result = Float32Array.of(values[0]![root.argument as number]!);
      break;
    case Op.Scatter: {
      result = new Float32Array(sizeOf(root.shape));
      result[root.argument as number] = values[0]![0]!;
      break;
    }
    case Op.Transpose:
      result = evaluateTranspose(values[0]!, root.sources[0]!.shape);
      break;
    case Op.Sqrt: {
      const src = values[0]!;
      result = new Float32Array(src.length);
      for (let i = 0; i < src.length; i++) result[i] = Math.sqrt(Math.max(0, src[i]!));
      break;
    }
  }
  cache.set(root, result);
  return result;
}

function evaluateMatmul(
  left: Float32Array,
  leftShape: Shape,
  right: Float32Array,
  rightShape: Shape,
): Float32Array {
  const [leftRows, shared] = leftShape;
  const [, rightColumns] = rightShape;
  const result = new Float32Array(leftRows * rightColumns);
  for (let row = 0; row < leftRows; row += 1) {
    const leftOffset = row * shared;
    const resultOffset = row * rightColumns;
    for (let k = 0; k < shared; k += 1) {
      const a = left[leftOffset + k]!;
      const rightOffset = k * rightColumns;
      for (let col = 0; col < rightColumns; col += 1) {
        result[resultOffset + col] += a * right[rightOffset + col]!;
      }
    }
  }
  return result;
}

function evaluateTranspose(value: Float32Array, shape: Shape): Float32Array {
  const [rows, columns] = shape;
  const result = new Float32Array(value.length);
  for (let row = 0; row < rows; row += 1) {
    for (let column = 0; column < columns; column += 1) {
      result[column * rows + row] = value[row * columns + column]!;
    }
  }
  return result;
}

function evaluateSoftmax(value: Float32Array): Float32Array {
  let maximum = -Infinity;
  for (let i = 0; i < value.length; i++) {
    if (value[i]! > maximum) maximum = value[i]!;
  }
  const result = new Float32Array(value.length);
  let denominator = 0;
  for (let i = 0; i < value.length; i++) {
    result[i] = Math.exp(value[i]! - maximum);
    denominator += result[i]!;
  }
  const invDenom = 1 / denominator;
  for (let i = 0; i < value.length; i++) result[i]! *= invDenom;
  return result;
}

// ── Compiled execution: structure-reuse (“compile once, rerun”) ──────────────
// Enabled by NMG_AUTODIFF_COMPILE=1. When a graph topology repeats (the
// controller retraces an identical structure every training step — only leaf
// data changes), compile it once into a flat tape with preallocated result
// buffers, then each run rebinds leaf data and executes the tape. Removes
// per-step UOp build, Map-cache lookups, and intermediate allocations.
// Mirrors torch.compile / MLX “compile once, cache, rerun”.
interface FlatOp {
  op: Op;
  shape: Shape;
  sourceShapes: Shape[];
  sources: number[];
  argument: Float32Array | number | undefined;
  /** leaf slot for Constant/Parameter, else -1 */
  leaf: number;
}

interface GraphProgram {
  ops: FlatOp[];
  buffers: Float32Array[];
  leafData: (Float32Array | undefined)[];
  root: number;
  /** forward-node UOp → buffer index (needed to compile the backward tape) */
  forwardIndex?: Map<UOp, number>;
  /** parameter UOp → gradient buffer index (backward program only) */
  outputs?: Map<UOp, number>;
  /** forward nodes occupying buffers[0..forwardSize-1] (backward program only) */
  forwardSize?: number;
}

/** Forward tape + (lazily built) backward tape for one stable graph structure. */
interface CompiledSession {
  fwd: GraphProgram;
  bwd: GraphProgram | null;
  /** Parameter leaves recorded at compile time — identity guard against reuse
   *  across a different model that happens to share the same structure. */
  params: UOp[];
}

const COMPILE_ENABLED = /^(1|on|true)$/i.test(process.env.NMG_AUTODIFF_COMPILE ?? "");
let lastSession: CompiledSession | null = null;

const COMPILED_OPS = new Set<Op>([
  Op.Add,
  Op.Multiply,
  Op.Negate,
  Op.Broadcast,
  Op.Exp,
  Op.Log,
  Op.Reciprocal,
  Op.Sigmoid,
  Op.Sqrt,
  Op.Sum,
  Op.SumN,
  Op.Index,
  Op.Scatter,
  Op.Transpose,
  Op.Matmul,
  Op.Softmax,
  Op.SoftmaxGradient,
]);

function compileGraph(root: UOp): GraphProgram | null {
  const ordered = topologicalSort(root);
  const indexOf = new Map<UOp, number>();
  ordered.forEach((node, index) => indexOf.set(node, index));
  const ops: FlatOp[] = [];
  const buffers: Float32Array[] = [];
  const leafData: (Float32Array | undefined)[] = [];
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]!;
    if (node.op === Op.Constant || node.op === Op.Parameter) {
      const leaf = leafData.length;
      leafData.push(node.argument as Float32Array);
      buffers.push(node.argument as Float32Array);
      ops.push({ op: node.op, shape: node.shape, sourceShapes: [], sources: [], argument: leaf, leaf });
    } else {
      // Ops the flat tape cannot faithfully reproduce (L2Normalize carries a
      // runtime side-channel for backward) make the whole graph uncompilable.
      if (!COMPILED_OPS.has(node.op)) return null;
      ops.push({
        op: node.op,
        shape: node.shape,
        sourceShapes: node.sources.map((s) => s.shape),
        sources: node.sources.map((s) => indexOf.get(s)!),
        argument: node.argument,
        leaf: -1,
      });
      buffers.push(new Float32Array(sizeOf(node.shape)));
    }
  }
  return { ops, buffers, leafData, root: ordered.length - 1, forwardIndex: indexOf };
}

/** Rewire leaf data from a freshly traced graph of the same structure. */
function rebindGraph(program: GraphProgram, root: UOp, outParams?: UOp[]): boolean {
  const ordered = topologicalSort(root);
  const ops = program.ops;
  if (ordered.length !== ops.length) return false;
  for (let index = 0; index < ordered.length; index += 1) {
    const node = ordered[index]!;
    const op = ops[index]!;
    if (node.op !== op.op || node.shape[0] !== op.shape[0] || node.shape[1] !== op.shape[1]) {
      return false;
    }
    if (op.leaf >= 0) {
      program.leafData[op.leaf] = node.argument as Float32Array;
      if (outParams !== undefined && node.op === Op.Parameter) outParams.push(node);
    } else if (node.sources.length !== op.sources.length) {
      return false;
    }
  }
  return true;
}

/** One flat-tape instruction: compute op into buffers[outIndex]. */
function executeFlatOp(op: FlatOp, buffers: Float32Array[], outIndex: number): void {
  const a = buffers[op.sources[0]!]!;
  const b = op.sources.length > 1 ? buffers[op.sources[1]!]! : a;
  const result = buffers[outIndex];
  switch (op.op) {
    case Op.Add:
      for (let i = 0; i < a.length; i += 1) result[i] = a[i]! + b[i]!;
      break;
    case Op.Multiply:
      for (let i = 0; i < a.length; i += 1) result[i] = a[i]! * b[i]!;
      break;
    case Op.Negate:
      for (let i = 0; i < a.length; i += 1) result[i] = -a[i]!;
      break;
    case Op.Broadcast: {
      const fill = a[0]!;
      result.fill(fill);
      break;
    }
    case Op.Exp:
      for (let i = 0; i < a.length; i += 1) result[i] = Math.exp(a[i]!);
      break;
    case Op.Log:
      for (let i = 0; i < a.length; i += 1) result[i] = Math.log(a[i]! < 1e-7 ? 1e-7 : a[i]!);
      break;
    case Op.Reciprocal:
      for (let i = 0; i < a.length; i += 1) result[i] = 1 / (a[i]! < 1e-7 ? 1e-7 : a[i]!);
      break;
    case Op.Sigmoid:
      for (let i = 0; i < a.length; i += 1) result[i] = 1 / (1 + Math.exp(-a[i]!));
      break;
    case Op.Sqrt:
      for (let i = 0; i < a.length; i += 1) result[i] = Math.sqrt(Math.max(0, a[i]!));
      break;
    case Op.Sum: {
      let total = 0;
      for (let i = 0; i < a.length; i += 1) total += a[i]!;
      result[0] = total;
      break;
    }
    case Op.SumN: {
      result.fill(0);
      for (let j = 0; j < op.sources.length; j += 1) {
        const src = buffers[op.sources[j]!]!;
        for (let i = 0; i < src.length; i += 1) result[i] += src[i]!;
      }
      break;
    }
    case Op.Index:
      result[0] = a[op.argument as number]!;
      break;
    case Op.Scatter:
      result.fill(0);
      result[op.argument as number] = a[0]!;
      break;
    case Op.Transpose:
      result.set(evaluateTranspose(a, op.sourceShapes[0]!));
      break;
    case Op.Matmul:
      result.set(evaluateMatmul(a, op.sourceShapes[0]!, b, op.sourceShapes[1]!));
      break;
    case Op.Softmax:
      result.set(evaluateSoftmax(a));
      break;
    case Op.SoftmaxGradient: {
      const prob = a;
      const grad = b;
      let weighted = 0;
      for (let i = 0; i < prob.length; i += 1) weighted += prob[i]! * grad[i]!;
      for (let i = 0; i < prob.length; i += 1) result[i] = prob[i]! * (grad[i]! - weighted);
      break;
    }
    default:
      throw new Error(`compile: unsupported op ${op.op}`);
  }
}

/** Execute the flat tape with preallocated buffers (no Map, no per-node alloc). */
function runGraph(program: GraphProgram): Float32Array {
  const { ops, buffers, leafData } = program;
  for (let index = 0; index < ops.length; index += 1) {
    const op = ops[index]!;
    if (op.leaf >= 0) buffers[index] = leafData[op.leaf]!;
    else executeFlatOp(op, buffers, index);
  }
  return buffers[program.root]!;
}

/** Compile the gradient DAG into a tape reading forward buffers by position. */
function compileBackwardProgram(
  gradientGraph: Map<UOp, UOp>,
  forwardIndex: Map<UOp, number>,
  forwardSize: number,
): GraphProgram | null {
  // Gradient-expression nodes in dependency order (forward nodes are leaves).
  const visited = new Set<UOp>();
  const ordered: UOp[] = [];
  const visit = (operation: UOp): void => {
    if (visited.has(operation)) return;
    visited.add(operation);
    for (const source of operation.sources) {
      if (!forwardIndex.has(source)) visit(source);
    }
    ordered.push(operation);
  };
  for (const [operation, gradient] of gradientGraph) {
    if (operation.op === Op.Parameter) visit(gradient);
  }
  const indexOf = new Map<UOp, number>();
  ordered.forEach((node, position) => indexOf.set(node, forwardSize + position));
  const outputs = new Map<UOp, number>();
  const ops: FlatOp[] = [];
  const leafData: (Float32Array | undefined)[] = [];
  const gradBuffers: Float32Array[] = [];
  for (const [operation, gradient] of gradientGraph) {
    if (operation.op !== Op.Parameter) continue;
    const index = indexOf.get(gradient);
    if (index !== undefined) {
      outputs.set(operation, index);
    } else {
      const forward = forwardIndex.get(gradient);
      if (forward === undefined) return null;
      outputs.set(operation, forward);
    }
  }
  for (let position = 0; position < ordered.length; position += 1) {
    const node = ordered[position]!;
    if (node.op === Op.Constant || node.op === Op.Parameter) {
      const leaf = leafData.length;
      leafData.push(node.argument as Float32Array);
      gradBuffers.push(node.argument as Float32Array);
      ops.push({ op: node.op, shape: node.shape, sourceShapes: [], sources: [], argument: leaf, leaf });
    } else {
      if (!COMPILED_OPS.has(node.op)) return null;
      ops.push({
        op: node.op,
        shape: node.shape,
        sourceShapes: node.sources.map((s) => s.shape),
        sources: node.sources.map((s) => forwardIndex.get(s) ?? indexOf.get(s)!),
        argument: node.argument,
        leaf: -1,
      });
      gradBuffers.push(new Float32Array(sizeOf(node.shape)));
    }
  }
  const buffers = new Array<Float32Array>(forwardSize + ordered.length);
  for (let i = 0; i < gradBuffers.length; i += 1) buffers[forwardSize + i] = gradBuffers[i]!;
  return { ops, buffers, leafData, root: -1, outputs, forwardSize };
}

/** Run forward (fill buffers), then the gradient tape, then apply outputs. */
function runBackwardProgram(session: CompiledSession): void {
  const fwd = session.fwd;
  const bwd = session.bwd!;
  const forwardSize = bwd.forwardSize!;
  const fb = fwd.buffers;
  const bb = bwd.buffers;
  for (let i = 0; i < fb.length; i += 1) bb[i] = fb[i]!;
  for (let index = 0; index < bwd.ops.length; index += 1) {
    const op = bwd.ops[index]!;
    const outIndex = forwardSize + index;
    if (op.leaf >= 0) bb[outIndex] = bwd.leafData[op.leaf]!;
    else executeFlatOp(op, bb, outIndex);
  }
  for (const [parameter, index] of bwd.outputs!) {
    gradients.set(parameter, bb[index]!);
  }
}

function collectParameterLeaves(root: UOp): UOp[] {
  const result: UOp[] = [];
  for (const node of topologicalSort(root)) {
    if (node.op === Op.Parameter) result.push(node);
  }
  return result;
}

function sameParamSet(a: UOp[], b: UOp[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

/** Compiled backward: reuse the session when structure + params match. */
function runCompiledBackward(root: UOp): boolean {
  const session = lastSession;
  if (!session) return false;
  const currentParams: UOp[] = [];
  if (!rebindGraph(session.fwd, root, currentParams)) return false;
  if (!sameParamSet(currentParams, session.params)) return false;
  runGraph(session.fwd); // forward values (incl. intermediates) into buffers
  if (!session.bwd) {
    const gradientGraph = computeGradients(root);
    session.bwd = compileBackwardProgram(
      gradientGraph,
      session.fwd.forwardIndex!,
      session.fwd.ops.length,
    );
    if (!session.bwd) return false; // unsupported gradient op → baseline path
  }
  runBackwardProgram(session);
  return true;
}

function evaluateCompiled(root: UOp): Float32Array {
  // Leaf reads (parameter.data in gradientStep, plain constants) never touch the
  // session: evaluate directly, identical to the interpreter for a leaf.
  if (root.op === Op.Constant || root.op === Op.Parameter) {
    return root.argument as Float32Array;
  }
  // Reuse the compiled forward tape only when structure + parameter identity
  // match the session. Never replace the session here: the session is owned by
  // backward(), and leaf reads (e.g. parameter.data in gradientStep) must not
  // clobber the compiled forward+backward tapes.
  const session = lastSession;
  if (session) {
    const currentParams: UOp[] = [];
    if (rebindGraph(session.fwd, root, currentParams) && sameParamSet(currentParams, session.params)) {
      return runGraph(session.fwd);
    }
  }
  return evaluate(root);
}

function accumulate(target: Map<UOp, UOp>, operation: UOp, gradient: UOp): void {
  target.set(operation, target.has(operation) ? add(target.get(operation)!, gradient) : gradient);
}

function localGradients(operation: UOp, gradient: UOp): Array<readonly [UOp, UOp]> {
  const [left, right] = operation.sources;
  switch (operation.op) {
    case Op.Add:
      return [
        [left!, reduceToShape(gradient, left!.shape)],
        [right!, reduceToShape(gradient, right!.shape)],
      ];
    case Op.SumN:
      return operation.sources.map((s) => [s, reduceToShape(gradient, s.shape)] as const);
    case Op.Multiply:
      return [
        [left!, reduceToShape(multiply(gradient, right!), left!.shape)],
        [right!, reduceToShape(multiply(gradient, left!), right!.shape)],
      ];
    case Op.Negate:
      return [[left!, negate(gradient)]];
    case Op.L2Normalize:
      return [
        [
          left!,
          new UOp(
            Op.L2NormalizeGradient,
            left!.shape,
            [operation, gradient],
            l2InvNorms.get(operation) ?? 0,
          ),
        ],
      ];
    case Op.Broadcast:
      return [[left!, reduceToShape(gradient, left!.shape)]];
    case Op.Matmul:
      return [
        [
          left!,
          binary(
            Op.Matmul,
            gradient,
            unary(Op.Transpose, right!, [right!.shape[1], right!.shape[0]]),
            left!.shape,
          ),
        ],
        [
          right!,
          binary(
            Op.Matmul,
            unary(Op.Transpose, left!, [left!.shape[1], left!.shape[0]]),
            gradient,
            right!.shape,
          ),
        ],
      ];
    case Op.Sum:
      return [[left!, broadcast(gradient, left!.shape)]];
    case Op.Exp:
      return [[left!, multiply(gradient, operation)]];
    case Op.Log:
      return [[left!, multiply(gradient, reciprocal(left!))]];
    case Op.Reciprocal:
      return [[left!, multiply(multiply(gradient, operation), multiply(operation, scalar(-1)))]];
    case Op.Sigmoid:
      return [
        [
          left!,
          multiply(multiply(gradient, operation), add(scalar(1), multiply(operation, scalar(-1)))),
        ],
      ];
    case Op.Softmax:
      return [[left!, binary(Op.SoftmaxGradient, operation, gradient, operation.shape)]];
    case Op.Index:
      return [[left!, unary(Op.Scatter, gradient, left!.shape, operation.argument as number)]];
    case Op.Scatter:
      return [[left!, unary(Op.Index, gradient, [1, 1], operation.argument as number)]];
    case Op.Transpose:
      return [[left!, unary(Op.Transpose, gradient, left!.shape)]];
    case Op.Sqrt: {
      // y = sqrt(x), dy/dx = 1/(2*sqrt(x)) = 1/(2*y)
      const halfGrad = multiply(gradient, scalar(0.5));
      return [[left!, multiply(halfGrad, reciprocal(operation))]];
    }
    case Op.Constant:
    case Op.Parameter:
    case Op.SoftmaxGradient:
      return [];
    default:
      return [];
  }
}

function computeGradients(root: UOp): Map<UOp, UOp> {
  const result = new Map<UOp, UOp>([[root, scalar(1)]]);
  const ordered = topologicalSort(root);
  // Activity analysis: a node's adjoint is live only if it can reach a
  // Parameter (backward() materializes Parameter grads and nothing else).
  // Bottom-up DP in topological order (sources precede consumers): a node is
  // live iff it is a Parameter or any source is live. O(V) flat pass — no
  // per-backward recursion.
  const live = new Set<UOp>();
  for (const node of ordered) {
    if (node.op === Op.Parameter) {
      live.add(node);
      continue;
    }
    if (node.op === Op.Constant) continue;
    for (const source of node.sources) {
      if (live.has(source)) {
        live.add(node);
        break;
      }
    }
  }
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const operation = ordered[index]!;
    const gradient = result.get(operation);
    if (!gradient) continue;
    for (const [source, local] of localGradients(operation, gradient)) {
      if (!live.has(source)) continue;
      accumulate(result, source, local);
    }
  }
  return result;
}

export class Tensor {
  readonly #operation: UOp;

  private constructor(operation: UOp) {
    this.#operation = operation;
  }

  static scalar(value: number, requiresGrad = false): Tensor {
    return new Tensor(
      new UOp(requiresGrad ? Op.Parameter : Op.Constant, [1, 1], [], Float32Array.of(value)),
    );
  }

  static vector(values: ArrayLike<number>, requiresGrad = false): Tensor {
    if (values.length === 0) throw new Error("tensor vector must not be empty");
    return new Tensor(
      new UOp(
        requiresGrad ? Op.Parameter : Op.Constant,
        [values.length, 1],
        [],
        Float32Array.from(values),
      ),
    );
  }

  static matrix(
    values: ArrayLike<number>,
    rows: number,
    columns: number,
    requiresGrad = false,
  ): Tensor {
    const data = Float32Array.from(values);
    if (rows < 1 || columns < 1 || rows * columns !== data.length) {
      throw new Error("tensor shape does not match its data");
    }
    return new Tensor(
      new UOp(requiresGrad ? Op.Parameter : Op.Constant, [rows, columns], [], data),
    );
  }

  /** Takes ownership of the buffer (no copy). Caller must not mutate after. */
  static fromBuffer(data: Float32Array, rows: number, columns: number): Tensor {
    if (rows < 1 || columns < 1 || rows * columns !== data.length) {
      throw new Error("tensor shape does not match its data");
    }
    return new Tensor(new UOp(Op.Constant, [rows, columns], [], data));
  }

  get data(): Float32Array {
    if (!COMPILE_ENABLED) return evaluate(this.#operation);
    return evaluateCompiled(this.#operation);
  }

  get grad(): Float32Array {
    return gradients.get(this.#operation) ?? new Float32Array(sizeOf(this.#operation.shape));
  }

  get shape(): Shape {
    return this.#operation.shape;
  }

  get scalarValue(): number {
    if (sizeOf(this.shape) !== 1) throw new Error("tensor is not scalar");
    return this.data[0]!;
  }

  zeroGrad(): void {
    gradients.set(this.#operation, new Float32Array(sizeOf(this.shape)));
  }

  add(other: Tensor): Tensor {
    return new Tensor(add(this.#operation, other.#operation));
  }

  static sumN(inputs: Tensor[]): Tensor {
    return new Tensor(sumN(inputs.map((t) => t.#operation)));
  }

  multiply(other: Tensor): Tensor {
    return new Tensor(multiply(this.#operation, other.#operation));
  }

  matmul(other: Tensor): Tensor {
    if (this.shape[1] !== other.shape[0]) throw new Error("matmul inner dimensions must match");
    return new Tensor(
      binary(Op.Matmul, this.#operation, other.#operation, [this.shape[0], other.shape[1]]),
    );
  }

  sum(): Tensor {
    return new Tensor(unary(Op.Sum, this.#operation, [1, 1]));
  }

  mean(): Tensor {
    return this.sum().multiply(Tensor.scalar(1 / sizeOf(this.shape)));
  }

  dot(other: Tensor): Tensor {
    return this.multiply(other).sum();
  }

  norm(): Tensor {
    return this.dot(this).sqrt();
  }

  exp(): Tensor {
    return new Tensor(unary(Op.Exp, this.#operation));
  }

  log(): Tensor {
    return new Tensor(unary(Op.Log, this.#operation));
  }

  sigmoid(): Tensor {
    return new Tensor(unary(Op.Sigmoid, this.#operation));
  }

  softmax(): Tensor {
    return new Tensor(unary(Op.Softmax, this.#operation));
  }

  negate(): Tensor {
    return new Tensor(negate(this.#operation));
  }

  sqrt(): Tensor {
    return new Tensor(unary(Op.Sqrt, this.#operation));
  }

  subtract(other: Tensor): Tensor {
    return this.add(other.negate());
  }

  divide(other: Tensor): Tensor {
    return this.multiply(new Tensor(unary(Op.Reciprocal, other.#operation)));
  }

  multiplyScalar(value: number): Tensor {
    return this.multiply(Tensor.scalar(value));
  }

  l2Normalize(): Tensor {
    return new Tensor(l2Normalize(this.#operation));
  }

  transpose(): Tensor {
    return new Tensor(unary(Op.Transpose, this.#operation, [this.shape[1], this.shape[0]]));
  }

  at(index: number): Tensor {
    if (!Number.isInteger(index) || index < 0 || index >= sizeOf(this.shape)) {
      throw new Error("tensor index is out of bounds");
    }
    return new Tensor(unary(Op.Index, this.#operation, [1, 1], index));
  }

  static stack(vectors: readonly Tensor[]): Tensor {
    if (vectors.length === 0) throw new Error("cannot stack empty tensor list");
    const rows = vectors[0]!.shape[0];
    if (vectors[0]!.shape[1] !== 1) throw new Error("stack requires column vectors [n, 1]");
    const cols = vectors.length;
    const data = new Float32Array(rows * cols);
    for (let col = 0; col < cols; col++) {
      const src = vectors[col]!.data;
      if (src.length !== rows) throw new Error("all stacked tensors must have the same shape");
      for (let row = 0; row < rows; row++) data[row + col * rows] = src[row]!;
    }
    return Tensor.matrix(data, rows, cols);
  }

  backward(): void {
    if (sizeOf(this.shape) !== 1) throw new Error("backward requires a scalar output");
    // Compiled path: reuse the forward+backward tapes when the trace structure
    // and parameter set match the cached session (online training loops).
    if (COMPILE_ENABLED && runCompiledBackward(this.#operation)) return;
    // Ensure forward pass populates any lazy caches (e.g., L2Normalize invNorm)
    void this.data;
    const gradientGraph = computeGradients(this.#operation);
    const cache = new Map<UOp, Float32Array>();
    for (const [operation, gradient] of gradientGraph) {
      if (operation.op === Op.Parameter) gradients.set(operation, evaluate(gradient, cache));
    }
    // Prepare a compiled session so the next identical trace skips the
    // per-backward UOp build + Map-cache evaluate entirely.
    if (COMPILE_ENABLED) {
      const program = compileGraph(this.#operation);
      const bwd = program
        ? compileBackwardProgram(gradientGraph, program.forwardIndex!, program.ops.length)
        : null;
      if (program && bwd) {
        lastSession = { fwd: program, bwd, params: collectParameterLeaves(this.#operation) };
      }
    }
  }
}

export function gradientStep(parameters: readonly Tensor[], learningRate: number): void {
  if (!(learningRate > 0)) throw new Error("learning rate must be positive");
  for (const parameter of parameters) {
    const values = parameter.data;
    const parameterGradient = parameter.grad;
    for (let index = 0; index < values.length; index += 1) {
      values[index]! -= learningRate * parameterGradient[index]!;
    }
  }
}
