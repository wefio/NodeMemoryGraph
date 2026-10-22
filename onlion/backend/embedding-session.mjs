// An embedding call must not keep a SQLite session alive across network I/O.
// A miss unwinds the private, uncommitted image; runPart fetches the missing
// vectors after closing it, then repeats against the same durable snapshot.
export class EmbeddingPreparation extends Error {
  constructor(prepare) {
    super('Document embeddings must be prepared outside SQLite');
    this.prepare = prepare;
  }
}

export function deferredDocuments(fetchDocuments) {
  const vectors = new Map();
  return inputs => {
    const missing = [...new Set(inputs)].filter(text => !vectors.has(text));
    if (missing.length) throw new EmbeddingPreparation(async () => {
      const batch = await fetchDocuments(missing);
      if (batch.length !== missing.length || batch.some(vector => !vector?.length))
        throw new Error('Embedding provider returned an invalid document batch');
      missing.forEach((text, i) => vectors.set(text, batch[i]));
    });
    return Promise.resolve(inputs.map(text => vectors.get(text)));
  };
}
