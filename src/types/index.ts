export type Brand<K, T> = K & { __brand: T };

export type Prettify<T> = { [P in keyof T]: T[P] };
