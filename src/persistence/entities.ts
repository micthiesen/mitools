import { getDoc, upsertDoc } from "./docstore.js";

export class Entity<
  Data extends GetPkArg,
  GetPkProps extends keyof Data,
  GetPkArg extends Pick<Data, GetPkProps> = Pick<Data, GetPkProps>,
> {
  public readonly name: string;
  public readonly getPk: (arg: GetPkArg) => string;

  public constructor(name: string, getPk: (arg: GetPkArg) => string) {
    this.name = name;
    this.getPk = getPk;
  }

  public get(arg: GetPkArg): Data | undefined {
    return getDoc(this.getPk(arg));
  }

  public upsert(data: Data): void {
    upsertDoc(this.getPk(data), data);
  }
}
