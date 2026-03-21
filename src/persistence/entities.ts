import { Logger } from "../logging/Logger.js";
import { kebabToTitleCase } from "../utils/strings.js";
import {
  countByPrefix,
  deleteDoc,
  deleteDocsByPrefix,
  getDoc,
  getDocsByPrefix,
  getKeysByPrefix,
  hasDoc,
  upsertDoc,
} from "./docstore.js";

const logger = new Logger("Entities");

/**
 * A class representing an entity in the database
 *
 * Heavily inspired by ElectroDB except:
 *   - It's stupidly simple
 *   - It uses a local SQLite database
 *   - It does not support any kind of query besides getting by primary key
 */
export class Entity<Data, PKProps extends readonly (keyof Data)[]> {
  private readonly logger: Logger;
  public readonly name: string;
  public readonly pkProps: PKProps;
  public readonly getPk: (arg: Pick<Data, PKProps[number]>) => string;

  public constructor(name: string, pkProps: PKProps) {
    this.logger = logger.extend(kebabToTitleCase(name));
    this.name = name;
    this.pkProps = pkProps;
    this.getPk = (arg: Pick<Data, PKProps[number]>) =>
      `$${name}#${pkProps.map((prop) => arg[prop]).join("#")}`;
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
    const docs = getDocsByPrefix<Data>(`$${this.name}#`);
    this.logger.debug(`Found ${docs.length} "${this.name}" entities`);
    return docs;
  }

  public upsert(data: Data): void {
    upsertDoc(this.getPk(data), data);
    this.logger.debug(`Upserted "${this.getPk(data)}" in docstore`, data);
  }

  public delete(arg: Pick<Data, PKProps[number]>): boolean {
    const pk = this.getPk(arg);
    const deleted = deleteDoc(pk);
    this.logger.debug(`${deleted ? "Deleted" : "Not found"} "${pk}"`);
    return deleted;
  }

  public deleteAll(): number {
    const count = deleteDocsByPrefix(`$${this.name}#`);
    this.logger.debug(`Deleted ${count} "${this.name}" entities`);
    return count;
  }

  public has(arg: Pick<Data, PKProps[number]>): boolean {
    return hasDoc(this.getPk(arg));
  }

  public count(): number {
    return countByPrefix(`$${this.name}#`);
  }

  public patch(arg: Pick<Data, PKProps[number]>, partial: Partial<Omit<Data, PKProps[number]>>): Data | undefined {
    const pk = this.getPk(arg);
    const existing = getDoc<Data>(pk);
    if (!existing) {
      this.logger.debug(`Cannot patch "${pk}", not found`);
      return undefined;
    }
    const updated = { ...existing, ...partial } as Data;
    upsertDoc(pk, updated);
    this.logger.debug(`Patched "${pk}" in docstore`, updated);
    return updated;
  }

  public keys(): string[] {
    return getKeysByPrefix(`$${this.name}#`);
  }
}
