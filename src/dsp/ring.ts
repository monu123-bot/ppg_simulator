/** Fixed-capacity circular buffer over a Float64Array, newest-last on read. */
export class RingF64 {
  private buf: Float64Array;
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Float64Array(capacity);
  }

  push(v: number): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  get length(): number {
    return this.size;
  }

  /** Oldest-to-newest copy of the last `n` values (all of them by default). */
  toArray(n = this.size): Float64Array {
    const count = Math.min(n, this.size);
    const out = new Float64Array(count);
    const start = (this.head - count + this.capacity * 2) % this.capacity;
    for (let i = 0; i < count; i++) out[i] = this.buf[(start + i) % this.capacity];
    return out;
  }

  /** Value `i` positions back from newest (0 = newest). */
  at(i: number): number {
    if (i >= this.size) return 0;
    return this.buf[(this.head - 1 - i + this.capacity * 2) % this.capacity];
  }

  clear(): void {
    this.buf.fill(0);
    this.head = 0;
    this.size = 0;
  }
}

/** Same idea for arbitrary objects, used for beat records. */
export class RingArray<T> {
  private buf: (T | undefined)[];
  private head = 0;
  private size = 0;

  constructor(readonly capacity: number) {
    this.buf = new Array(capacity);
  }

  push(v: T): void {
    this.buf[this.head] = v;
    this.head = (this.head + 1) % this.capacity;
    if (this.size < this.capacity) this.size++;
  }

  get length(): number {
    return this.size;
  }

  toArray(): T[] {
    const out: T[] = [];
    const start = (this.head - this.size + this.capacity * 2) % this.capacity;
    for (let i = 0; i < this.size; i++) out.push(this.buf[(start + i) % this.capacity] as T);
    return out;
  }

  clear(): void {
    this.buf = new Array(this.capacity);
    this.head = 0;
    this.size = 0;
  }
}
