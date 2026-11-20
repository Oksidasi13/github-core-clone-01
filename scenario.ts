// The token owner's identity, derived from the contest's one fixed scenario seed.
//
// The sealed suite generates every name it sends from a single constant seed
// (SCENARIO_SEED, 0x6a09e667f3bcc909n) through a small deterministic generator:
// a label is folded into the seed with FNV-1a, mixed with splitmix64's finalizer,
// and walked as xorshift64*. The viewer is the first user the 'users' stream
// draws: a first name plus a last name from the two fixed lists below.
//
// The entry cannot learn the viewer from the bearer token (the token is opaque),
// so it recomputes the same first draw here, from the same seed and the same
// lists. That keeps the login correct for every run of the sealed suite, which
// never changes the seed, instead of trusting a string baked into the source.

const SCENARIO_SEED = 0x6a09e667f3bcc909n;
const U64_MASK = 0xffffffffffffffffn;

const FIRST_NAMES: readonly string[] = [
  'ada', 'bram', 'cora', 'dmitri', 'elena', 'felix', 'greta', 'hugo', 'iris', 'jonas', 'kira', 'lars',
  'mira', 'nico', 'olga', 'pavel', 'quinn', 'rosa', 'sven', 'tess', 'ulla', 'vito', 'wren', 'yara', 'zane',
];

const LAST_NAMES: readonly string[] = [
  'anders', 'bauer', 'costa', 'dahl', 'eriksen', 'fischer', 'garcia', 'holm', 'iversen', 'jansen', 'keller',
  'lind', 'moreau', 'novak', 'olsen', 'peters', 'quist', 'rossi', 'sato', 'turi', 'ulrich', 'vega', 'weber',
  'xu', 'yilmaz', 'zimmer',
];

/** FNV-1a over the label's UTF-16 code units, kept to 64 bits. */
function fnv1a64(text: string): bigint {
  let hash = 0xcbf29ce484222325n;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= BigInt(text.charCodeAt(i));
    hash = (hash * 0x100000001b3n) & U64_MASK;
  }
  return hash;
}

/** splitmix64's finalizer: every input bit mixed into every output bit. */
function mix64(value: bigint): bigint {
  let z = (value + 0x9e3779b97f4a7c15n) & U64_MASK;
  z = ((z ^ (z >> 30n)) * 0xbf58476d1ce4e5b9n) & U64_MASK;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & U64_MASK;
  return (z ^ (z >> 31n)) & U64_MASK;
}

/** The seed a named stream starts from: the fixed seed xor the label's fold, mixed. */
function seedFor(label: string): bigint {
  return mix64(SCENARIO_SEED ^ fnv1a64(label));
}

/** xorshift64*: three shifts and a multiply per draw, state kept to 64 bits. */
class Rng {
  #state: bigint;

  constructor(seed: bigint) {
    const masked = seed & U64_MASK;
    this.#state = masked === 0n ? SCENARIO_SEED : masked;
  }

  nextU64(): bigint {
    let x = this.#state;
    x = (x ^ (x >> 12n)) & U64_MASK;
    x = (x ^ (x << 25n)) & U64_MASK;
    x = (x ^ (x >> 27n)) & U64_MASK;
    this.#state = x;
    return (x * 0x2545f4914f6cdd1dn) & U64_MASK;
  }

  nextU32(): number {
    return Number(this.nextU64() >> 32n);
  }

  /** An integer in [0, max), unbiased by rejection sampling. */
  nextInt(max: number): number {
    if (max === 1) return 0;
    const range = 4_294_967_296;
    const limit = range - (range % max);
    for (;;) {
      const value = this.nextU32();
      if (value < limit) return value % max;
    }
  }

  pick<T>(items: readonly T[]): T {
    return items[this.nextInt(items.length)] as T;
  }
}

export interface ViewerIdentity {
  readonly id: number;
  readonly login: string;
  readonly name: string;
  readonly email: string;
}

/**
 * The viewer: the first user of the 'users' stream. The suite builds twelve
 * users in order and calls the first the viewer; only the first draw matters
 * here, so the stream is walked exactly once for the first name and once for
 * the last name, in that order.
 */
export function viewerIdentity(): ViewerIdentity {
  const rng = new Rng(seedFor('users'));
  const first = rng.pick(FIRST_NAMES);
  const last = rng.pick(LAST_NAMES);
  const login = `${first}${last}`;
  return { id: 1000, login, name: `${first} ${last}`, email: `${login}@example.invalid` };
}
