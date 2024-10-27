export type Brand<K, T> = K & { __brand: T };

export type Prettyify<T> = { [P in keyof T]: T[P] };
