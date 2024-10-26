import type { BaseConfig } from "./base.js";

export interface InjectorDeps {
  config: BaseConfig;
}

export class Injector {
  private static deps_: InjectorDeps | null = null;

  public static configure(deps: InjectorDeps) {
    if (Injector.deps_) throw new Error("Injector already configured");
    Injector.deps_ = deps;
  }

  public static get deps(): InjectorDeps {
    if (!Injector.deps_) throw new Error("Injector not configured");
    return Injector.deps_;
  }

  public static get config(): BaseConfig {
    return Injector.deps.config;
  }
}
