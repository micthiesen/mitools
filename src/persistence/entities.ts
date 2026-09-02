import { Clock, Data, Effect, Option } from "effect";
import { causeMessage, type OperationError } from "../errors/index.js";
import { kebabToTitleCase } from "../utils/strings.js";
import {
  CorruptRowError,
  type DocMeta,
  Docstore,
  type DocstoreShape,
  decodeDoc,
} from "./docstore.js";

/** A primary-key component value. Anything else fails with `InvalidKeyError`. */
export type PKValue = string | number | boolean;

/** A primary-key component was not a finite number, a string or a boolean. */
export class InvalidKeyError extends Data.TaggedError("InvalidKeyError")<{
  readonly entity: string;
  readonly property: string;
  readonly value: unknown;
}> {
  override get message(): string {
    return `Invalid primary-key value for "${this.entity}.${this.property}" (${typeof this.value}): ${String(this.value)}`;
  }
}

/** The entity's `validate` function rejected a payload on the way in. */
export class EntityValidationError extends Data.TaggedError("EntityValidationError")<{
  readonly entity: string;
  readonly cause: unknown;
}> {
  override get message(): string {
    return `Invalid "${this.entity}" payload: ${causeMessage(this.cause)}`;
  }
}

/**
 * Encodes one primary-key component so distinct values never collide. Strings
 * are length-prefixed (so an embedded "#" is unambiguous) and every type is
 * tagged, so 1 !== "1" and true !== "true" at the key level.
 */
function encodeKeyPart(entity: string, property: string, value: unknown): string {
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n${value}`;
  if (typeof value === "boolean") return `b${value ? 1 : 0}`;
  throw new InvalidKeyError({ entity, property, value });
}

export interface UpsertOptions {
  /** Time-to-live in ms from now. Overridden by `expiresAt`. */
  ttlMs?: number;
  /** Absolute expiry (epoch ms). Takes precedence over `ttlMs`. */
  expiresAt?: number;
}

export interface EntityOptions<Data, PKProps extends readonly (keyof Data)[]> {
  name: string;
  pk: PKProps;
  /** Current payload schema version. Defaults to 0. */
  version?: number;
  /** Upgrades a stored payload to the current version. Run by migrateAll(). */
  migrate?: (data: unknown, fromVersion: number) => Data;
  /**
   * Validates/parses data on the way in; throw to reject. Pair with
   * `Schema.decodeUnknownSync(MySchema)`. A rejection fails the upsert with
   * `EntityValidationError`.
   */
  validate?: (data: unknown) => Data;
  /** Default TTL (ms) applied to upserts that don't specify their own. */
  defaultTtlMs?: number;
}

type PK<Data, PKProps extends readonly (keyof Data)[]> = Pick<Data, PKProps[number]>;

/**
 * A class representing an entity in the database
 *
 * Heavily inspired by ElectroDB except:
 *   - It's stupidly simple
 *   - It uses a local SQLite database
 *   - It does not support any kind of query besides getting by primary key
 *
 * Construct entities at module level: the constructor touches no database,
 * it only records the entity in a process-wide registry that
 * `Entity.migrateAll()` walks. Every operation is an `Effect` that requires
 * the `Docstore` service.
 *
 * Migration model: this is not a lazy/dual-read store. Reads assume the current
 * on-disk representation. After upgrading the library, run `Entity.migrateAll()`
 * once at startup to rewrite existing rows into the current key encoding,
 * payload version, and metadata columns. Reading data that predates that
 * migration is undefined behavior.
 */
export class Entity<Data, PKProps extends readonly (keyof Data)[]> {
  private static readonly registry: Entity<unknown, readonly never[]>[] = [];

  private readonly version: number;
  private readonly migrateFn?: (data: unknown, fromVersion: number) => Data;
  private readonly validateFn?: (data: unknown) => Data;
  private readonly defaultTtlMs?: number;

  public readonly name: string;
  public readonly pkProps: PKProps;

  public constructor(name: string, pkProps: PKProps);
  public constructor(options: EntityOptions<Data, PKProps>);
  public constructor(
    nameOrOptions: string | EntityOptions<Data, PKProps>,
    pkProps?: PKProps,
  ) {
    const options: EntityOptions<Data, PKProps> =
      typeof nameOrOptions === "string"
        ? { name: nameOrOptions, pk: pkProps as PKProps }
        : nameOrOptions;

    // "#" delimits the entity prefix from key parts; allowing it in the name
    // would let one entity's key alias another (e.g. name "a#n5" vs pk [n:5]).
    if (options.name.includes("#")) {
      throw new Error(`Entity name may not contain "#": "${options.name}"`);
    }

    this.name = options.name;
    this.pkProps = options.pk;
    this.version = options.version ?? 0;
    this.migrateFn = options.migrate;
    this.validateFn = options.validate;
    this.defaultTtlMs = options.defaultTtlMs;

    Entity.registry.push(this as unknown as Entity<unknown, readonly never[]>);
  }

  /** Builds the storage key for a primary key; throws `InvalidKeyError` on a bad component. */
  public getPk(arg: PK<Data, PKProps>): string {
    const parts = this.pkProps.map((prop) =>
      encodeKeyPart(this.name, String(prop), arg[prop]),
    );
    return `$${this.name}#${parts.join("#")}`;
  }

  private readonly pk = (arg: PK<Data, PKProps>) =>
    Effect.try({
      try: () => this.getPk(arg),
      catch: (cause) =>
        cause instanceof InvalidKeyError
          ? cause
          : new InvalidKeyError({ entity: this.name, property: "?", value: cause }),
    });

  private readonly validate = (data: Data) =>
    this.validateFn
      ? Effect.try({
          try: () => this.validateFn!(data),
          catch: (cause) => new EntityValidationError({ entity: this.name, cause }),
        })
      : Effect.succeed(data);

  private meta(expiresAt: number | null, now: number): DocMeta {
    return { entity: this.name, version: this.version, expiresAt, updatedAt: now };
  }

  private resolveExpiry(now: number, options?: UpsertOptions): number | null {
    if (options?.expiresAt !== undefined) return options.expiresAt;
    if (options?.ttlMs !== undefined) return now + options.ttlMs;
    if (this.defaultTtlMs !== undefined) return now + this.defaultTtlMs;
    return null;
  }

  // Expiry for a modify (patch/update): an explicit option wins, otherwise the
  // row's current expiry is preserved. Unlike resolveExpiry, a modify never
  // silently applies defaultTtlMs; that would reset a TTL the caller didn't ask
  // to touch.
  private nextExpiry(
    current: number | null,
    now: number,
    options?: UpsertOptions,
  ): number | null {
    if (options?.expiresAt !== undefined) return options.expiresAt;
    if (options?.ttlMs !== undefined) return now + options.ttlMs;
    return current;
  }

  private readonly annotate = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.annotateLogs(effect, { logger: `Entity:${kebabToTitleCase(this.name)}` });

  public get(
    arg: PK<Data, PKProps>,
  ): Effect.Effect<
    Option.Option<Data>,
    OperationError | CorruptRowError | InvalidKeyError,
    Docstore
  > {
    const self = this;
    return self
      .annotate(
        Effect.gen(function* () {
          const pk = yield* self.pk(arg);
          const doc = yield* Docstore.use((s) => s.getDoc<Data>(pk));
          yield* Effect.logDebug(
            Option.isSome(doc) ? `Found "${pk}"` : `"${pk}" not found`,
          );
          return doc;
        }),
      )
      .pipe(Effect.withSpan("Entity.get"));
  }

  public getAll(): Effect.Effect<Data[], OperationError, Docstore> {
    const self = this;
    return self
      .annotate(
        Effect.gen(function* () {
          const docs = yield* Docstore.use((s) => s.getDocsByEntity<Data>(self.name));
          yield* Effect.logDebug(`Found ${docs.length} "${self.name}" entities`);
          return docs;
        }),
      )
      .pipe(Effect.withSpan("Entity.getAll"));
  }

  public upsert(
    data: Data,
    options?: UpsertOptions,
  ): Effect.Effect<
    void,
    OperationError | InvalidKeyError | EntityValidationError,
    Docstore
  > {
    const self = this;
    return self
      .annotate(
        Effect.gen(function* () {
          const validated = yield* self.validate(data);
          const pk = yield* self.pk(validated as PK<Data, PKProps>);
          const now = yield* Clock.currentTimeMillis;
          yield* Docstore.use((s) =>
            s.upsertDoc(
              pk,
              validated,
              self.meta(self.resolveExpiry(now, options), now),
            ),
          );
          yield* Effect.logDebug(`Upserted "${pk}"`);
        }),
      )
      .pipe(Effect.withSpan("Entity.upsert"));
  }

  public delete(
    arg: PK<Data, PKProps>,
  ): Effect.Effect<boolean, OperationError | InvalidKeyError, Docstore> {
    const self = this;
    return self
      .annotate(
        Effect.gen(function* () {
          const pk = yield* self.pk(arg);
          const deleted = yield* Docstore.use((s) => s.deleteDoc(pk));
          yield* Effect.logDebug(`${deleted ? "Deleted" : "Not found"} "${pk}"`);
          return deleted;
        }),
      )
      .pipe(Effect.withSpan("Entity.delete"));
  }

  public deleteAll(): Effect.Effect<number, OperationError, Docstore> {
    const self = this;
    return self
      .annotate(
        Effect.gen(function* () {
          const count = yield* Docstore.use((s) => s.deleteDocsByEntity(self.name));
          yield* Effect.logDebug(`Deleted ${count} "${self.name}" entities`);
          return count;
        }),
      )
      .pipe(Effect.withSpan("Entity.deleteAll"));
  }

  public has(
    arg: PK<Data, PKProps>,
  ): Effect.Effect<boolean, OperationError | InvalidKeyError, Docstore> {
    return this.pk(arg).pipe(
      Effect.flatMap((pk) => Docstore.use((s) => s.hasDoc(pk))),
      Effect.withSpan("Entity.has"),
    );
  }

  public count(): Effect.Effect<number, OperationError, Docstore> {
    return Docstore.use((s) => s.countByEntity(this.name)).pipe(
      Effect.withSpan("Entity.count"),
    );
  }

  /**
   * Extends (or clears) the expiry of an existing entity without rewriting its
   * payload. Resolves true if a live row was touched.
   */
  public touch(
    arg: PK<Data, PKProps>,
    options: UpsertOptions = {},
  ): Effect.Effect<boolean, OperationError | InvalidKeyError, Docstore> {
    const self = this;
    return Effect.gen(function* () {
      const pk = yield* self.pk(arg);
      const now = yield* Clock.currentTimeMillis;
      return yield* Docstore.use((s) =>
        s.touchDoc(pk, self.resolveExpiry(now, options)),
      );
    }).pipe(Effect.withSpan("Entity.touch"));
  }

  /**
   * Shallow read-modify-write in one transaction (`validate` runs on the
   * result). Primary-key fields are re-asserted from `arg` afterwards, so an untyped caller cannot move the row
   * by passing pk fields in `partial`. Existing expiry is preserved unless
   * `options` overrides it. Resolves `None` (and writes nothing) if the row is
   * absent.
   */
  public patch(
    arg: PK<Data, PKProps>,
    partial: Partial<Omit<Data, PKProps[number]>>,
    options?: UpsertOptions,
  ): Effect.Effect<
    Option.Option<Data>,
    OperationError | InvalidKeyError | CorruptRowError | EntityValidationError,
    Docstore
  > {
    return this.update(arg, (current) => ({ ...current, ...partial }), options).pipe(
      Effect.withSpan("Entity.patch"),
    );
  }

  /**
   * Transactional read-modify-write. The callback receives the current value
   * and returns the next one; the whole cycle runs in a single SQLite
   * transaction, so keep it synchronous; `validate` runs on the result.
   * Existing expiry is preserved unless
   * `options` overrides it. Resolves `None` (and does nothing) if the row is
   * absent.
   */
  public update(
    arg: PK<Data, PKProps>,
    fn: (current: Data) => Data,
    options?: UpsertOptions,
  ): Effect.Effect<
    Option.Option<Data>,
    OperationError | InvalidKeyError | CorruptRowError | EntityValidationError,
    Docstore
  > {
    const self = this;
    type Outcome =
      | { readonly kind: "missing" }
      | { readonly kind: "corrupt"; readonly cause: unknown }
      | { readonly kind: "invalid"; readonly cause: unknown }
      | { readonly kind: "updated"; readonly next: Data };
    return self
      .annotate(
        Effect.gen(function* () {
          const pk = yield* self.pk(arg);
          const now = yield* Clock.currentTimeMillis;
          // The callback is synchronous (one SQLite transaction), so the typed
          // failures are carried out as values and raised afterwards.
          const outcome = yield* Docstore.use((s) =>
            s.transaction(`Entity.update ${pk}`, (tx): Outcome => {
              const existing = tx.getRawRow(pk, now);
              if (!existing) return { kind: "missing" };
              let current: Data;
              try {
                current = decodeDoc<Data>(existing.data);
              } catch (cause) {
                return { kind: "corrupt", cause };
              }
              let next = { ...fn(current), ...arg } as Data;
              if (self.validateFn) {
                try {
                  next = { ...self.validateFn(next), ...arg } as Data;
                } catch (cause) {
                  return { kind: "invalid", cause };
                }
              }
              tx.upsertDoc(
                pk,
                next,
                self.meta(self.nextExpiry(existing.expires_at, now, options), now),
                now,
              );
              return { kind: "updated", next };
            }),
          );
          switch (outcome.kind) {
            case "missing":
              yield* Effect.logDebug(`Cannot update "${pk}", not found`);
              return Option.none<Data>();
            case "corrupt":
              return yield* new CorruptRowError({ pk, cause: outcome.cause });
            case "invalid":
              return yield* new EntityValidationError({
                entity: self.name,
                cause: outcome.cause,
              });
            case "updated":
              yield* Effect.logDebug(`Updated "${pk}"`);
              return Option.some(outcome.next);
          }
        }),
      )
      .pipe(Effect.withSpan("Entity.update"));
  }

  /** The primary-key objects of all live entities. */
  public keys(): Effect.Effect<PK<Data, PKProps>[], OperationError, Docstore> {
    return this.getAll().pipe(
      Effect.map((docs) =>
        docs.map((doc) => {
          const key = {} as PK<Data, PKProps>;
          for (const prop of this.pkProps) key[prop] = doc[prop];
          return key;
        }),
      ),
      Effect.withSpan("Entity.keys"),
    );
  }

  /** Physically removes expired rows across the whole store (all entities). */
  public cleanupExpired(
    limit?: number,
  ): Effect.Effect<number, OperationError, Docstore> {
    return Docstore.use((s) => s.cleanupExpired(limit));
  }

  /**
   * Rewrites every stored row for this entity into the current representation:
   * new key encoding, current payload version (via `migrate`), and the
   * entity/version/updated_at columns. Idempotent and safe to re-run. Existing
   * expiry is preserved. Resolves the number of rows rewritten.
   */
  public migrate(): Effect.Effect<number, OperationError, Docstore> {
    const self = this;
    return self
      .annotate(
        Effect.gen(function* () {
          const docstore = yield* Docstore;
          const now = yield* Clock.currentTimeMillis;
          const rows = yield* docstore.getRawRowsByPrefix(`$${self.name}#`);
          const result = yield* docstore.transaction(
            `Entity.migrate ${self.name}`,
            (tx) => self.migrateRows(tx, rows, now),
          );
          for (const warning of result.warnings) yield* Effect.logWarning(warning);
          yield* Effect.logDebug(
            `Migrated ${result.migrated} "${self.name}" entities${
              result.skipped ? ` (skipped ${result.skipped})` : ""
            }`,
          );
          return result.migrated;
        }),
      )
      .pipe(Effect.withSpan("Entity.migrate"));
  }

  private migrateRows(
    tx: Parameters<Parameters<DocstoreShape["transaction"]>[1]>[0],
    rows: ReturnType<typeof tx.getRawRowsByPrefix>,
    now: number,
  ): { migrated: number; skipped: number; warnings: string[] } {
    let migrated = 0;
    let skipped = 0;
    const warnings: string[] = [];
    // Keys that already hold a row we intend to keep: every existing pk, plus
    // any target we write this pass. A row re-keying onto one of these is a
    // collision; skip it (leaving its source row intact) rather than overwrite
    // live data and lose it.
    const claimed = new Set(rows.map((row) => row.pk));
    for (const row of rows) {
      // A single unreadable row (corrupt CBOR, or a payload the migrate fn or
      // key builder rejects) must never abort the whole migration: that would
      // roll back every sibling row and, since migrateAll() runs at startup,
      // crash-loop the process. Isolate the failure: warn, leave the row
      // untouched (so it stays visible and repairable), and carry on.
      try {
        let data = decodeDoc<unknown>(row.data);
        if (this.migrateFn && row.version < this.version) {
          data = this.migrateFn(data, row.version);
        }
        const newPk = this.getPk(data as PK<Data, PKProps>);

        const unchanged =
          newPk === row.pk && row.entity === this.name && row.version === this.version;
        if (unchanged) continue;

        if (newPk !== row.pk && claimed.has(newPk)) {
          warnings.push(
            `Skipping migration of "${row.pk}": target key "${newPk}" is already occupied`,
          );
          skipped++;
          continue;
        }
        claimed.add(newPk);

        tx.upsertDoc(
          newPk,
          data,
          {
            entity: this.name,
            version: this.version,
            expiresAt: row.expires_at,
            updatedAt: row.updated_at || now,
          },
          now,
        );
        if (newPk !== row.pk) tx.deleteDoc(row.pk);
        migrated++;
      } catch (err) {
        skipped++;
        warnings.push(`Skipping migration of "${row.pk}": ${causeMessage(err)}`);
      }
    }
    return { migrated, skipped, warnings };
  }

  /**
   * Runs `migrate()` for every Entity constructed in this process. Call once at
   * startup. Resolves the total rows rewritten.
   */
  public static migrateAll(): Effect.Effect<number, OperationError, Docstore> {
    return Effect.gen(function* () {
      let total = 0;
      for (const entity of Entity.registry) total += yield* entity.migrate();
      yield* Effect.logDebug(
        `migrateAll rewrote ${total} rows across ${Entity.registry.length} entities`,
      );
      return total;
    }).pipe(Effect.withSpan("Entity.migrateAll"));
  }
}
