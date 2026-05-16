type Entry<V> = { value: V; expiresAt: number };

export class TTLCache<V> {
  private store = new Map<string, Entry<V>>();
  constructor(private ttlMs: number) {}

  get(key: string): V | undefined {
    const e = this.store.get(key);
    if (!e) return undefined;
    if (e.expiresAt < Date.now()) {
      this.store.delete(key);
      return undefined;
    }
    return e.value;
  }

  set(key: string, value: V): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }
}
