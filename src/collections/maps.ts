export class BetterMap<K, V> extends Map<K, V> {
  public getOrThrow(key: K): V {
    if (!this.has(key)) throw new Error(`Key not found: ${key}`);
    return this.get(key)!;
  }
}

export class DefaultMap<K, V> extends BetterMap<K, V> {
  private readonly factory: () => V;

  public constructor(factory: () => V, initial: [K, V][]) {
    super(initial);
    this.factory = factory;
  }

  public get(key: K): V {
    if (!this.has(key)) this.set(key, this.factory());
    return super.get(key)!;
  }
}
