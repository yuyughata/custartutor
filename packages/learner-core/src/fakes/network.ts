import type { Network } from '../ports';

/** `Network` whose state tests (and the demo's settings screen) can flip. */
export class FakeNetwork implements Network {
  constructor(
    public online = true,
    public unmetered = true,
  ) {}

  isOnline(): Promise<boolean> {
    return Promise.resolve(this.online);
  }

  isUnmetered(): Promise<boolean> {
    return Promise.resolve(this.online && this.unmetered);
  }
}
