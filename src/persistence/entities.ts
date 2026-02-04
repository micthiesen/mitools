import { Logger } from "../logging/Logger.js";
import { kebabToTitleCase } from "../utils/strings.js";
import { getDoc, getDocsByPrefix, upsertDoc } from "./docstore.js";

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
}
