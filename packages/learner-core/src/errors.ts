/**
 * Typed errors that callers branch on. Everything else is a plain `Error`.
 * Each class sets `name` so `error.name` survives minification in release builds.
 */

/** Not enough free disk space to start a download. Nothing was written. */
export class DiskSpaceError extends Error {
  readonly neededBytes: number;
  readonly freeBytes: number;

  constructor(neededBytes: number, freeBytes: number) {
    super(
      `Not enough free space: need ${neededBytes} bytes (including the safety margin), ${freeBytes} free.`,
    );
    this.name = 'DiskSpaceError';
    this.neededBytes = neededBytes;
    this.freeBytes = freeBytes;
  }
}

/** A downloaded file's hash does not match the manifest, or the manifest itself is inconsistent. */
export class IntegrityError extends Error {
  readonly path: string;
  readonly expected?: string;
  readonly actual?: string;

  constructor(
    path: string,
    message: string,
    expected?: string,
    actual?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'IntegrityError';
    this.path = path;
    if (expected !== undefined) this.expected = expected;
    if (actual !== undefined) this.actual = actual;
  }
}

/** The pack needs a newer app build than this one. Update the app; do not retry. */
export class PackTooNewError extends Error {
  readonly minAppVersion: string;
  readonly appVersion: string;

  constructor(minAppVersion: string, appVersion: string) {
    super(`This lesson needs app version ${minAppVersion} or newer (this app is ${appVersion}).`);
    this.name = 'PackTooNewError';
    this.minAppVersion = minAppVersion;
    this.appVersion = appVersion;
  }
}

/** The grown-up PIN is locked after too many wrong attempts. */
export class LockedOutError extends Error {
  readonly retryAfterMs: number;
  readonly lockedUntil: number;

  constructor(lockedUntil: number, retryAfterMs: number) {
    super(`Too many wrong PIN attempts. Try again in ${Math.ceil(retryAfterMs / 1000)} seconds.`);
    this.name = 'LockedOutError';
    this.lockedUntil = lockedUntil;
    this.retryAfterMs = retryAfterMs;
  }
}

/** A PIN that is not 4 to 6 digits. */
export class PinFormatError extends Error {
  constructor() {
    super('The PIN must be 4 to 6 digits.');
    this.name = 'PinFormatError';
  }
}

/** The network policy forbids this download right now (offline, or Wi-Fi only on a metered link). */
export class NetworkPolicyError extends Error {
  readonly reason: 'offline' | 'metered';

  constructor(reason: 'offline' | 'metered') {
    super(
      reason === 'offline'
        ? 'You are offline. Connect to the internet to download lessons.'
        : 'Wi-Fi only is on, and this is not a Wi-Fi connection.',
    );
    this.name = 'NetworkPolicyError';
    this.reason = reason;
  }
}

/** A file could not be downloaded (bad HTTP status, expired URL after a retry, or a transport failure). */
export class DownloadError extends Error {
  readonly path: string;
  readonly status?: number;

  constructor(path: string, message: string, status?: number, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'DownloadError';
    this.path = path;
    if (status !== undefined) this.status = status;
  }
}

/** The local database was written by a newer build of the app. */
export class DatabaseTooNewError extends Error {
  readonly found: number;
  readonly supported: number;

  constructor(found: number, supported: number) {
    super(`Database schema v${found} is newer than this app supports (v${supported}).`);
    this.name = 'DatabaseTooNewError';
    this.found = found;
    this.supported = supported;
  }
}

/** The lesson pack for a unit is not on this device (not downloaded, or removed). */
export class PackNotFoundError extends Error {
  readonly unitId: string;

  constructor(unitId: string) {
    super(`No downloaded lesson for unit ${unitId}.`);
    this.name = 'PackNotFoundError';
    this.unitId = unitId;
  }
}

/** A session was asked about a question that is not in the unit. */
export class UnknownQuestionError extends Error {
  readonly questionId: string;

  constructor(questionId: string) {
    super(`Question "${questionId}" is not in this unit.`);
    this.name = 'UnknownQuestionError';
    this.questionId = questionId;
  }
}

/** A session was asked about a section that is not in the unit. */
export class UnknownSectionError extends Error {
  readonly sectionId: string;

  constructor(sectionId: string) {
    super(`Section "${sectionId}" is not in this unit.`);
    this.name = 'UnknownSectionError';
    this.sectionId = sectionId;
  }
}
