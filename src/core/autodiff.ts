type Shape = readonly [rows: number, columns: number];

const Op = {
  Add: "add",
  Broadcast: "broadcast",
  Constant: "constant",
  Exp: "exp",
  Index: "index",
  Log: "log",
  Matmul: "matmul",
  Multiply: "multiply",
  Parameter: "parameter",
  Reciprocal: "reciprocal",
  Scatter: "scatter",
  Sigmoid: "sigmoid",
  Softmax: "softmax",
  SoftmaxGradient: "softmax_gradient",
  Sum: "sum",
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

function multiply(left: UOp, right: UOp): UOp {
  if (sameShape(left.shape, right.shape)) return binary(Op.Multiply, left, right, left.shape);
  if (sizeOf(left.shape) === 1) {
    return binary(Op.Multiply, broadcast(left, right.shape), right, right.shape);
  }
  if (sizeOf(right.shape) === 1) {
    return binary(Op.Multiply, left, broadcast(right, left.shape), left.shape);
  }
  throw new Error("multiply requires equal shapes or a scalar operand");
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
    case Op.Add:
      result = Float32Array.from(values[0]!, (value, index) => value + values[1]![index]!);
      break;
    case Op.Multiply:
      result = Float32Array.from(values[0]!, (value, index) => value * values[1]![index]!);
      break;
    case Op.Broadcast:
      result = new Float32Array(sizeOf(root.shape)).fill(values[0]![0]!);
      break;
    case Op.Matmul:
      result = evaluateMatmul(
        values[0]!,
        root.sources[0]!.shape,
        values[1]!,
        root.sources[1]!.shape,
      );
      break;
    case Op.Sum:
      result = Float32Array.of(values[0]!.reduce((total, value) => total + value, 0));
      break;
    case Op.Exp:
      result = Float32Array.from(values[0]!, (value) => Math.exp(value));
      break;
    case Op.Log:
      result = Float32Array.from(values[0]!, (value) => Math.log(Math.max(1e-7, value)));
      break;
    case Op.Reciprocal:
      result = Float32Array.from(values[0]!, (value) => 1 / Math.max(1e-7, value));
      break;
    case Op.Sigmoid:
      result = Float32Array.from(values[0]!, (value) => 1 / (1 + Math.exp(-value)));
      break;
    case Op.Softmax:
      result = evaluateSoftmax(values[0]!);
      break;
    case Op.SoftmaxGradient: {
      const probability = values[0]!;
      const gradient = values[1]!;
      const weighted = probability.reduce(
        (total, value, index) => total + value * gradient[index]!,
        0,
      );
      result = Float32Array.from(
        probability,
        (value, index) => value * (gradient[index]! - weighted),
      );
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
    for (let column = 0; column < rightColumns; column += 1) {
      let value = 0;
      for (let index = 0; index < shared; index += 1) {
        value += left[row * shared + index]! * right[index * rightColumns + column]!;
      }
      result[row * rightColumns + column] = value;
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
  const maximum = Math.max(...value);
  const exponentials = Float32Array.from(value, (item) => Math.exp(item - maximum));
  const denominator = exponentials.reduce((total, item) => total + item, 0);
  return Float32Array.from(exponentials, (item) => item / denominator);
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
    case Op.Multiply:
      return [
        [left!, reduceToShape(multiply(gradient, right!), left!.shape)],
        [right!, reduceToShape(multiply(gradient, left!), right!.shape)],
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
    case Op.Constant:
    case Op.Parameter:
    case Op.SoftmaxGradient:
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

  at(index: number): Tensor {
    if (!Number.isInteger(index) || index < 0 || index >= sizeOf(this.shape)) {
      throw new Error("tensor index is out of bounds");
    }
    return new Tensor(unary(Op.Index, this.#operation, [1, 1], index));
  }

  backward(): void {
    if (sizeOf(this.shape) !== 1) throw new Error("backward requires a scalar output");
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
