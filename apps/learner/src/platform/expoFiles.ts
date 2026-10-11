import { Directory, File, Paths } from 'expo-file-system';
import type { DownloadResult, Downloader, FileStore } from '@custar/learner-core';

/** All learner files live under one app-private directory inside the document directory. */
const ROOT_NAME = 'custar';

function root(): Directory {
  return new Directory(Paths.document, ROOT_NAME);
}

function fileAt(path: string): File {
  return new File(root(), path);
}

function ensureDirectory(directory: Directory): void {
  if (!directory.exists) directory.create({ intermediates: true });
}

function ensureParent(path: string): void {
  const slash = path.lastIndexOf('/');
  if (slash > 0) ensureDirectory(new Directory(root(), path.slice(0, slash)));
}

export function createExpoFileStore(): FileStore {
  ensureDirectory(root());

  async function writeAtomically(path: string, content: string | Uint8Array): Promise<void> {
    ensureParent(path);
    const temp = fileAt(`${path}.tmp`);
    temp.create({ intermediates: true, overwrite: true });
    temp.write(content);
    // Rename only after the full write, so a crash never leaves a half-written file at `path`.
    await temp.move(fileAt(path), { overwrite: true });
  }

  return {
    exists: async (path) => fileAt(path).exists,
    readText: (path) => fileAt(path).text(),
    readBytes: async (path) => new Uint8Array(await fileAt(path).bytes()),
    writeText: (path, text) => writeAtomically(path, text),
    writeBytes: (path, bytes) => writeAtomically(path, bytes),
    move: async (from, to) => {
      ensureParent(to);
      await fileAt(from).move(fileAt(to), { overwrite: true });
    },
    remove: async (path) => {
      const file = fileAt(path);
      if (file.exists) file.delete();
    },
    size: async (path) => {
      const file = fileAt(path);
      return file.exists ? file.size : null;
    },
    freeDiskBytes: async () => Paths.availableDiskSpace,
  };
}

/**
 * Downloads one file to disk. The platform API has no byte-range append, so a retry fetches the whole
 * file again; packs are made of many small files (images, audio clips, one JSON), and per-file state in the
 * `pack_file` table gives resumability at file granularity (ADR 0004). The `resume` option is accepted for
 * the port contract but a partial file is discarded and re-fetched.
 */
export function createExpoDownloader(): Downloader {
  return {
    async download(url, destPath, options): Promise<DownloadResult> {
      ensureParent(destPath);
      const part = fileAt(`${destPath}.part`);
      if (part.exists) part.delete();
      try {
        await File.downloadFileAsync(url, part, {
          idempotent: true,
          ...(options?.signal ? { signal: options.signal } : {}),
        });
      } catch (error) {
        // An expired signed URL surfaces as an HTTP 401/403 error; the core re-signs and retries once.
        const message = error instanceof Error ? error.message : String(error);
        const status = /\b(401|403)\b/.exec(message)?.[1];
        if (status) return { status: Number(status), bytesOnDisk: 0 };
        throw error;
      }
      const target = fileAt(destPath);
      await part.move(target, { overwrite: true });
      return { status: 200, bytesOnDisk: target.size };
    },
  };
}
