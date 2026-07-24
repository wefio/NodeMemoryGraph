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

function unary(op: Op, source: UOp, shape: Shape = source.shape, argument?: number): UOp {
  return new UOp(op, shape, [source], argument);
}

function binary(op: Op, left: UOp, right: UOp, shape: Shape): UOp {
  return new UOp(op, shape, [left, right]);
}

function add(left: UOp, right: UOp): UOp {
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
  // Fold: x * (-1) → negate(x)
  if (
    right.op === Op.Constant &&
    right.argument instanceof Float32Array &&
    right.argument.length === 1 &&
    right.argument[0] === -1
  ) {
    return negate(left);
  }
  if (
    left.op === Op.Constant &&
    left.argument instanceof Float32Array &&
    left.argument.length === 1 &&
    left.argument[0] === -1
  ) {
    return negate(right);
  }
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
  return unary(Op.Negate, source);
}

function l2Normalize(source: UOp): UOp {
  return unary(Op.L2Normalize, source);
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
  const values = root.sources.map((source) => evaluate(source, cache));
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
      break;
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
      return [[left!, multiply(gradient, unary(Op.Reciprocal, left!))]];
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
      return [[left!, multiply(halfGrad, unary(Op.Reciprocal, operation))]];
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
  for (let index = ordered.length - 1; index >= 0; index -= 1) {
    const operation = ordered[index]!;
    const gradient = result.get(operation);
    if (!gradient) continue;
    for (const [source, local] of localGradients(operation, gradient)) {
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
    return evaluate(this.#operation);
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
    // Ensure forward pass populates any lazy caches (e.g., L2Normalize invNorm)
    this.data;
    const gradientGraph = computeGradients(this.#operation);
    const cache = new Map<UOp, Float32Array>();
    for (const [operation, gradient] of gradientGraph) {
      if (operation.op === Op.Parameter) gradients.set(operation, evaluate(gradient, cache));
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
