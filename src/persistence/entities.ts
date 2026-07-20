import { Decoder } from "cbor";
import { Logger } from "../logging/Logger.js";
import { kebabToTitleCase } from "../utils/strings.js";
import {
  cleanupExpired,
  countByEntity,
  type DocMeta,
  deleteDoc,
  deleteDocsByEntity,
  getDoc,
  getDocsByEntity,
  getRawRow,
  getRawRowsByPrefix,
  hasDoc,
  touchDoc,
  transaction,
  upsertDoc,
} from "./docstore.js";

const logger = new Logger("Entities");

/** A primary-key component value. Anything else throws when a key is built. */
export type PKValue = string | number | boolean;

/**
 * Encodes one primary-key component so distinct values never collide. Strings
 * are length-prefixed (so an embedded "#" is unambiguous) and every type is
 * tagged, so 1 !== "1" and true !== "true" at the key level.
 */
function encodeKeyPart(value: unknown): string {
  if (typeof value === "string") return `s${value.length}:${value}`;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`Non-finite PK value: ${value}`);
    return `n${value}`;
  }
  if (typeof value === "boolean") return `b${value ? 1 : 0}`;
  throw new Error(`Invalid primary-key value (${typeof value}): ${String(value)}`);
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
  /** Validates/parses data on the way in (e.g. a zod schema's parse). */
  validate?: (data: unknown) => Data;
  /** Default TTL (ms) applied to upserts that don't specify their own. */
  defaultTtlMs?: number;
}

/**
 * A class representing an entity in the database
 *
 * Heavily inspired by ElectroDB except:
 *   - It's stupidly simple
 *   - It uses a local SQLite database
 *   - It does not support any kind of query besides getting by primary key
 *
 * Migration model: this is not a lazy/dual-read store. Reads assume the current
 * on-disk representation. After upgrading the library, run `Entity.migrateAll()`
 * once at startup (after `Injector.configure`) to rewrite existing rows into the
 * current key encoding, payload version, and metadata columns. Reading data that
 * predates that migration is undefined behavior.
 */
export class Entity<Data, PKProps extends readonly (keyof Data)[]> {
  private static readonly registry: Entity<unknown, readonly never[]>[] = [];

  private readonly logger: Logger;
  private readonly version: number;
  private readonly migrateFn?: (data: unknown, fromVersion: number) => Data;
  private readonly validateFn?: (data: unknown) => Data;
  private readonly defaultTtlMs?: number;

  public readonly name: string;
  public readonly pkProps: PKProps;
  public readonly getPk: (arg: Pick<Data, PKProps[number]>) => string;

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
    this.logger = logger.extend(kebabToTitleCase(this.name));
    this.getPk = (arg: Pick<Data, PKProps[number]>) =>
      `$${this.name}#${this.pkProps.map((prop) => encodeKeyPart(arg[prop])).join("#")}`;

    Entity.registry.push(this as unknown as Entity<unknown, readonly never[]>);
  }

  private meta(expiresAt: number | null): DocMeta {
    return {
      entity: this.name,
      version: this.version,
      expiresAt,
      updatedAt: Date.now(),
    };
  }

  private resolveExpiry(options?: UpsertOptions): number | null {
    if (options?.expiresAt !== undefined) return options.expiresAt;
    if (options?.ttlMs !== undefined) return Date.now() + options.ttlMs;
    if (this.defaultTtlMs !== undefined) return Date.now() + this.defaultTtlMs;
    return null;
  }

  // Expiry for a modify (patch/update): an explicit option wins, otherwise the
  // row's current expiry is preserved. Unlike resolveExpiry, a modify never
  // silently applies defaultTtlMs — that would reset a TTL the caller didn't ask
  // to touch.
  private nextExpiry(current: number | null, options?: UpsertOptions): number | null {
    if (options?.expiresAt !== undefined) return options.expiresAt;
    if (options?.ttlMs !== undefined) return Date.now() + options.ttlMs;
    return current;
  }

  public get(arg: Pick<Data, PKProps[number]>): Data | undefined {
    const doc = getDoc<Data>(this.getPk(arg));
    if (doc) {
      this.logger.debug(`Found "${this.getPk(arg)}" in docstore`, doc);
    } else {
      this.logger.debug(`"${this.getPk(arg)}" not found in docstore`);
    }
    return doc;
  }

  public getAll(): Data[] {
    const docs = getDocsByEntity<Data>(this.name);
    this.logger.debug(`Found ${docs.length} "${this.name}" entities`);
    return docs;
  }

  public upsert(data: Data, options?: UpsertOptions): void {
    const validated = this.validateFn ? this.validateFn(data) : data;
    const pk = this.getPk(validated as Pick<Data, PKProps[number]>);
    upsertDoc(pk, validated, this.meta(this.resolveExpiry(options)));
    this.logger.debug(`Upserted "${pk}" in docstore`, validated);
  }

  public delete(arg: Pick<Data, PKProps[number]>): boolean {
    const pk = this.getPk(arg);
    const deleted = deleteDoc(pk);
    this.logger.debug(`${deleted ? "Deleted" : "Not found"} "${pk}"`);
    return deleted;
  }

  public deleteAll(): number {
    const count = deleteDocsByEntity(this.name);
    this.logger.debug(`Deleted ${count} "${this.name}" entities`);
    return count;
  }

  public has(arg: Pick<Data, PKProps[number]>): boolean {
    return hasDoc(this.getPk(arg));
  }

  public count(): number {
    return countByEntity(this.name);
  }

  /**
   * Extends (or clears) the expiry of an existing entity without rewriting its
   * payload. Returns true if a live row was touched.
   */
  public touch(arg: Pick<Data, PKProps[number]>, options: UpsertOptions = {}): boolean {
    return touchDoc(this.getPk(arg), this.resolveExpiry(options));
  }

  /**
   * Shallow read-modify-write. Primary-key fields are re-asserted from `arg`
   * afterwards, so an untyped caller cannot move the row by passing pk fields
   * in `partial`. Existing expiry is preserved unless `options` overrides it.
   * Not atomic across processes; prefer `update` under contention.
   */
  public patch(
    arg: Pick<Data, PKProps[number]>,
    partial: Partial<Omit<Data, PKProps[number]>>,
    options?: UpsertOptions,
  ): Data | undefined {
    const pk = this.getPk(arg);
    const existing = getRawRow(pk);
    if (!existing) {
      this.logger.debug(`Cannot patch "${pk}", not found`);
      return undefined;
    }
    const current = Decoder.decodeFirstSync(existing.data) as Data;
    const updated = { ...current, ...partial, ...arg } as Data;
    upsertDoc(pk, updated, this.meta(this.nextExpiry(existing.expires_at, options)));
    this.logger.debug(`Patched "${pk}" in docstore`, updated);
    return updated;
  }

  /**
   * Transactional read-modify-write. The callback receives the current value
   * and returns the next one; the whole cycle runs in a single SQLite
   * transaction. Existing expiry is preserved unless `options` overrides it.
   * Returns undefined (and does nothing) if the row is absent.
   */
  public update(
    arg: Pick<Data, PKProps[number]>,
    fn: (current: Data) => Data,
    options?: UpsertOptions,
  ): Data | undefined {
    const pk = this.getPk(arg);
    return transaction(() => {
      const existing = getRawRow(pk);
      if (!existing) {
        this.logger.debug(`Cannot update "${pk}", not found`);
        return undefined;
      }
      const current = Decoder.decodeFirstSync(existing.data) as Data;
      const next = { ...fn(current), ...arg } as Data;
      upsertDoc(pk, next, this.meta(this.nextExpiry(existing.expires_at, options)));
      this.logger.debug(`Updated "${pk}" in docstore`, next);
      return next;
    });
  }

  /** Returns the primary-key objects of all live entities. */
  public keys(): Pick<Data, PKProps[number]>[] {
    return this.getAll().map((doc) => {
      const key = {} as Pick<Data, PKProps[number]>;
      for (const prop of this.pkProps) key[prop] = doc[prop];
      return key;
    });
  }

  /** Physically removes expired rows across the whole store (all entities). */
  public cleanupExpired(limit?: number): number {
    return cleanupExpired(limit);
  }

  /**
   * Rewrites every stored row for this entity into the current representation:
   * new key encoding, current payload version (via `migrate`), and the
   * entity/version/updated_at columns. Idempotent and safe to re-run. Existing
   * expiry is preserved.
   */
  public migrate(): number {
    const rows = getRawRowsByPrefix(`$${this.name}#`);
    let migrated = 0;
    let skipped = 0;
    // Keys that already hold a row we intend to keep: every existing pk, plus
    // any target we write this pass. A row re-keying onto one of these is a
    // collision — we skip it (leaving its source row intact) rather than
    // overwrite live data and lose it.
    const claimed = new Set(rows.map((row) => row.pk));
    transaction(() => {
      for (const row of rows) {
        // A single unreadable row (corrupt CBOR, or a payload the migrate fn or
        // key builder rejects) must never abort the whole migration: that would
        // roll back every sibling row and, since migrateAll() runs at startup,
        // crash-loop the process. Isolate the failure — warn, leave the row
        // untouched (so it stays visible and repairable), and carry on.
        try {
          let data = Decoder.decodeFirstSync(row.data) as unknown;
          if (this.migrateFn && row.version < this.version) {
            data = this.migrateFn(data, row.version);
          }
          const newPk = this.getPk(data as Pick<Data, PKProps[number]>);

          const unchanged =
            newPk === row.pk &&
            row.entity === this.name &&
            row.version === this.version;
          if (unchanged) continue;

          if (newPk !== row.pk && claimed.has(newPk)) {
            this.logger.warn(
              `Skipping migration of "${row.pk}": target key "${newPk}" is already occupied`,
            );
            skipped++;
            continue;
          }
          claimed.add(newPk);

          upsertDoc(newPk, data, {
            entity: this.name,
            version: this.version,
            expiresAt: row.expires_at,
            updatedAt: row.updated_at || Date.now(),
          });
          if (newPk !== row.pk) deleteDoc(row.pk);
          migrated++;
        } catch (err) {
          skipped++;
          this.logger.warn(
            `Skipping migration of "${row.pk}": ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
    });
    this.logger.debug(
      `Migrated ${migrated} "${this.name}" entities${skipped ? ` (skipped ${skipped})` : ""}`,
    );
    return migrated;
  }

  /**
   * Runs `migrate()` for every Entity constructed in this process. Call once at
   * startup, after `Injector.configure`. Returns the total rows rewritten.
   */
  public static migrateAll(): number {
    let total = 0;
    for (const entity of Entity.registry) total += entity.migrate();
    logger.debug(
      `migrateAll rewrote ${total} rows across ${Entity.registry.length} entities`,
    );
    return total;
  }
}
