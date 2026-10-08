// Serialize host lifecycle changes so concurrent requests cannot create orphan Vite servers.
export class PreviewPool {
  #entries = new Map();
  #tail = Promise.resolve();
  #closed = false;
  constructor({ create, limit = 2 }) { this.create = create; this.limit = limit; }
  #serialize(operation) {
    const result = this.#tail.then(operation);
    this.#tail = result.catch(() => {});
    return result;
  }
  get(key, revision, options) {
    return this.#serialize(async () => {
      if (this.#closed) throw new Error('preview pool closed');
      const current = this.#entries.get(key);
      if (current?.revision === revision && await current.server.healthy()) return current;
      if (current) { this.#entries.delete(key); await current.server.close(); }
      if (this.#entries.size >= this.limit) {
        const [oldKey, old] = this.#entries.entries().next().value;
        this.#entries.delete(oldKey);
        await old.server.close();
      }
      const entry = { revision, server: await this.create(options) };
      this.#entries.set(key, entry);
      return entry;
    });
  }
  close() {
    this.#closed = true;
    return this.#serialize(async () => {
      const entries = [...this.#entries.values()];
      this.#entries.clear();
      const results = await Promise.allSettled(entries.map((entry) => entry.server.close()));
      for (const result of results) if (result.status === 'rejected') console.error('[preview close]', result.reason);
    });
  }
}
