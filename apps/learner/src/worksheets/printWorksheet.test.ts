import { describe, expect, it, vi } from 'vitest';
import { A4_HEIGHT, A4_WIDTH, createWorksheetPrinter, type PrintDeps } from './printWorksheet';

function deps(overrides: Partial<PrintDeps> = {}, platform: PrintDeps['platform'] = 'native') {
  const calls = {
    printAsync: vi.fn(() => Promise.resolve()),
    printToFileAsync: vi.fn(() =>
      Promise.resolve({ uri: 'file:///cache/sheet.pdf', numberOfPages: 2 }),
    ),
    isAvailableAsync: vi.fn(() => Promise.resolve(true)),
    shareAsync: vi.fn(() => Promise.resolve()),
    printInBrowser: vi.fn(() => Promise.resolve()),
  };
  const value: PrintDeps = {
    platform,
    print: { printAsync: calls.printAsync, printToFileAsync: calls.printToFileAsync },
    sharing: { isAvailableAsync: calls.isAvailableAsync, shareAsync: calls.shareAsync },
    printInBrowser: calls.printInBrowser,
    ...overrides,
  };
  return { value, calls };
}

const HTML = '<!doctype html><p>Sheet</p>';

describe('worksheet printer on a phone', () => {
  it('offers sharing', () => {
    expect(createWorksheetPrinter(deps().value).canShare).toBe(true);
  });

  it('prints through expo-print on A4', async () => {
    const { value, calls } = deps();
    const result = await createWorksheetPrinter(value).print(HTML);
    expect(result.ok).toBe(true);
    expect(calls.printAsync).toHaveBeenCalledWith({
      html: HTML,
      width: A4_WIDTH,
      height: A4_HEIGHT,
    });
    expect(A4_WIDTH / A4_HEIGHT).toBeCloseTo(210 / 297, 2);
    expect(calls.printInBrowser).not.toHaveBeenCalled();
  });

  it('shares a PDF: makes the file with expo-print, then hands it to expo-sharing', async () => {
    const { value, calls } = deps();
    const result = await createWorksheetPrinter(value).share(HTML, 'Worksheet');
    expect(result).toEqual({ ok: true, message: 'The PDF is ready to share.' });
    expect(calls.printToFileAsync).toHaveBeenCalledWith({
      html: HTML,
      width: A4_WIDTH,
      height: A4_HEIGHT,
    });
    expect(calls.shareAsync).toHaveBeenCalledWith('file:///cache/sheet.pdf', {
      mimeType: 'application/pdf',
      UTI: 'com.adobe.pdf',
      dialogTitle: 'Worksheet',
    });
  });

  it('says so, in plain words, when the PDF cannot be made', async () => {
    const { value, calls } = deps();
    calls.printToFileAsync.mockRejectedValueOnce(new Error('ENOSPC'));
    const result = await createWorksheetPrinter(value).share(HTML, 'Worksheet');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Could not make the PDF/);
    expect(result.message).not.toContain('ENOSPC');
    expect(calls.shareAsync).not.toHaveBeenCalled();
  });

  it('says so when this phone cannot share files, and points to Print', async () => {
    const { value, calls } = deps();
    calls.isAvailableAsync.mockResolvedValueOnce(false);
    const result = await createWorksheetPrinter(value).share(HTML, 'Worksheet');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/cannot share files/);
    expect(result.message).toMatch(/Print/);
    expect(calls.shareAsync).not.toHaveBeenCalled();
  });

  it('treats a closed share sheet or print dialog as a cancel, not a failure', async () => {
    const a = deps();
    a.calls.shareAsync.mockRejectedValueOnce(new Error('User cancelled the share'));
    expect(await createWorksheetPrinter(a.value).share(HTML, 'W')).toEqual({
      ok: true,
      message: 'Sharing was cancelled.',
    });
    const b = deps();
    b.calls.printAsync.mockRejectedValueOnce(new Error('Printing did not complete'));
    expect(await createWorksheetPrinter(b.value).print(HTML)).toEqual({
      ok: true,
      message: 'Printing was cancelled.',
    });
  });

  it('reports a real print failure and a real share failure with a plain message', async () => {
    const a = deps();
    a.calls.printAsync.mockRejectedValueOnce(new Error('native module not found'));
    const printed = await createWorksheetPrinter(a.value).print(HTML);
    expect(printed.ok).toBe(false);
    expect(printed.message).toMatch(/printing service/);
    const b = deps();
    b.calls.shareAsync.mockRejectedValueOnce(new Error('boom'));
    const shared = await createWorksheetPrinter(b.value).share(HTML, 'W');
    expect(shared).toEqual({ ok: false, message: 'Could not share the PDF. Please try again.' });
  });

  it('never throws, whatever the platform pieces do', async () => {
    const { value } = deps({
      print: {
        printAsync: () => {
          throw new Error('sync throw');
        },
        printToFileAsync: () => {
          throw new Error('sync throw');
        },
      },
    });
    const printer = createWorksheetPrinter(value);
    await expect(printer.print(HTML)).resolves.toMatchObject({ ok: false });
    await expect(printer.share(HTML, 'W')).resolves.toMatchObject({ ok: false });
  });
});

describe('worksheet printer in a browser', () => {
  it('prints in a frame (not through expo-print, which would print the whole app page) and offers no share', async () => {
    const { value, calls } = deps({}, 'web');
    const printer = createWorksheetPrinter(value);
    expect(printer.canShare).toBe(false);
    const result = await printer.print(HTML);
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/Save as PDF/);
    expect(calls.printInBrowser).toHaveBeenCalledWith(HTML);
    expect(calls.printAsync).not.toHaveBeenCalled();
  });

  it('explains a browser that refuses to print', async () => {
    const { value, calls } = deps({}, 'web');
    calls.printInBrowser.mockRejectedValueOnce(new Error('blocked'));
    const result = await createWorksheetPrinter(value).print(HTML);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/could not open the print window/);
  });

  it('share on the web points to Print and does not touch the file system', async () => {
    const { value, calls } = deps({}, 'web');
    const result = await createWorksheetPrinter(value).share(HTML, 'W');
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/Save as PDF/);
    expect(calls.printToFileAsync).not.toHaveBeenCalled();
  });
});
