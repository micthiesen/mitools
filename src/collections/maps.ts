export class BetterMap<K, V> extends Map<K, V> {
  public getOrThrow(key: K): V {
    if (!this.has(key)) throw new Error(`Key not found: ${key}`);
    return this.get(key)!;
  }

  public getOrSet(key: K, factory: () => V): V {
    if (!this.has(key)) this.set(key, factory());
    return this.get(key)!;
  }

  public map<T>(fn: (value: V, key: K) => T): BetterMap<K, T> {
    const result = new BetterMap<K, T>();
    for (const [key, value] of this) {
      result.set(key, fn(value, key));
    }
    return result;
  }

  public reduce<T>(fn: (acc: T, value: V, key: K) => T, initial: T): T {
    let acc = initial;
    for (const [key, value] of this) {
      acc = fn(acc, value, key);
    }
    return acc;
  }

  public toObject(): Record<string, V> {
    return Object.fromEntries(this.entries()) as Record<string, V>;
  }
}

export class DefaultMap<K, V> extends BetterMap<K, V> {
  private readonly factory: () => V;

  public constructor(factory: () => V, initial: [K, V][] = []) {
    super(initial);
    this.factory = factory;
  }

  public get(key: K): V {
    if (!this.has(key)) this.set(key, this.factory());
    return super.get(key)!;
  }
}
