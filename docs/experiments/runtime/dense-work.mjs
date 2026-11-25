export function heavyDenseWork(seed, rounds) {
  let acc = seed * 0.137 + 1;
  for (let i = 0; i < rounds; i += 1) {
    acc = Math.sin(acc * 1.00013 + i * 0.001) + Math.cos(acc * 0.9997);
  }
  return acc;
}

export function execute(inputs) {
  const { seed, rounds } = inputs.default;
  return heavyDenseWork(seed, rounds);
}
