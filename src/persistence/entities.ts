import { getDoc, upsertDoc } from "./docstore.js";

/**
 * A class representing an entity in the database
 *
 * Heavily inspired by ElectroDB except:
 *   - It's stupidly simple
 *   - It uses a local SQLite database
 *   - It does not support any kind of query besides getting by primary key
 */
export class Entity<Data, PKProps extends readonly (keyof Data)[]> {
  public readonly name: string;
  public readonly pkProps: PKProps;
  public readonly getPk: (arg: Pick<Data, PKProps[number]>) => string;

  public constructor(name: string, pkProps: PKProps) {
    this.name = name;
    this.pkProps = pkProps;
    this.getPk = (arg: Pick<Data, PKProps[number]>) =>
      `$${name}#${pkProps.map((prop) => arg[prop]).join("#")}`;
  }

  public get(arg: Pick<Data, PKProps[number]>): Data | undefined {
    return getDoc(this.getPk(arg));
  }

  public upsert(data: Data): void {
    upsertDoc(this.getPk(data), data);
  }
}
