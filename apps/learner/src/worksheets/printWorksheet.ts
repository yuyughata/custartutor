/**
 * Printing and sharing a worksheet. The platform pieces are passed in (`PrintDeps`), so the decisions and the wording
 * of every failure are tested without a phone:
 *
 *  - Android and iOS: "Print" opens the system print dialog (which can also save a PDF); "Share as PDF" makes a PDF
 *    file with `expo-print` and hands it to `expo-sharing` (WhatsApp, email, Drive, a print service ...);
 *  - a browser: "Print" prints the sheet in a hidden frame; the browser's dialog offers "Save as PDF". There is no
 *    separate share button.
 *
 * Every function RESOLVES with a result and never throws: the screen shows `message`.
 */

/** A4 in points (1/72 inch), the page size `expo-print` takes. */
export const A4_WIDTH = 595;
export const A4_HEIGHT = 842;

export type PrintResult = { ok: true; message: string } | { ok: false; message: string };

export interface PrintDeps {
  platform: 'web' | 'native';
  /** `expo-print`. */
  print: {
    printAsync(options: { html: string; width: number; height: number }): Promise<void>;
    printToFileAsync(options: {
      html: string;
      width: number;
      height: number;
    }): Promise<{ uri: string; numberOfPages: number }>;
  };
  /** `expo-sharing`. */
  sharing: {
    isAvailableAsync(): Promise<boolean>;
    shareAsync(
      uri: string,
      options: { mimeType: string; UTI: string; dialogTitle: string },
    ): Promise<void>;
  };
  /** Prints HTML in a browser (see `browserPrint.ts`). */
  printInBrowser(html: string): Promise<void>;
}

export interface WorksheetPrinter {
  /** True when a separate "Share as PDF" makes sense (phones; not a browser). */
  canShare: boolean;
  print(html: string): Promise<PrintResult>;
  share(html: string, title: string): Promise<PrintResult>;
}

function reason(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** iOS rejects the print promise when the person closes the print dialog; that is not a failure. */
function wasCancelled(error: unknown): boolean {
  return /cancel|did not complete|dismiss/i.test(reason(error));
}

export function createWorksheetPrinter(deps: PrintDeps): WorksheetPrinter {
  const web = deps.platform === 'web';
  return {
    canShare: !web,

    async print(html) {
      try {
        if (web) {
          await deps.printInBrowser(html);
          return {
            ok: true,
            message: 'The print window is open. Choose a printer, or "Save as PDF".',
          };
        }
        await deps.print.printAsync({ html, width: A4_WIDTH, height: A4_HEIGHT });
        return { ok: true, message: 'Sent to the print screen.' };
      } catch (error) {
        if (wasCancelled(error)) return { ok: true, message: 'Printing was cancelled.' };
        return {
          ok: false,
          message: web
            ? 'This browser could not open the print window. Try another browser, or use the browser menu to print this page.'
            : 'Could not open the print screen. Check that this phone has a printing service turned on, then try again.',
        };
      }
    },

    async share(html, title) {
      if (web) {
        return {
          ok: false,
          message:
            'Sharing a PDF is not available in a browser. Use Print and choose "Save as PDF".',
        };
      }
      let uri: string;
      try {
        ({ uri } = await deps.print.printToFileAsync({ html, width: A4_WIDTH, height: A4_HEIGHT }));
      } catch {
        return {
          ok: false,
          message:
            'Could not make the PDF. Please try again. If it keeps failing, free some space on this phone.',
        };
      }
      try {
        if (!(await deps.sharing.isAvailableAsync())) {
          return {
            ok: false,
            message:
              'This phone cannot share files from the app. Use Print instead, and choose "Save as PDF".',
          };
        }
        await deps.sharing.shareAsync(uri, {
          mimeType: 'application/pdf',
          UTI: 'com.adobe.pdf',
          dialogTitle: title,
        });
        return { ok: true, message: 'The PDF is ready to share.' };
      } catch (error) {
        if (wasCancelled(error)) return { ok: true, message: 'Sharing was cancelled.' };
        return { ok: false, message: 'Could not share the PDF. Please try again.' };
      }
    },
  };
}
