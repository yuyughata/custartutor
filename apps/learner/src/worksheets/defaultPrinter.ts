import { Platform } from 'react-native';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';
import { printHtmlInBrowser } from './browserPrint';
import { createWorksheetPrinter, type WorksheetPrinter } from './printWorksheet';

/** The app's printer: `expo-print` and `expo-sharing` on a phone, a hidden print frame in a browser. */
export function createDefaultPrinter(): WorksheetPrinter {
  return createWorksheetPrinter({
    platform: Platform.OS === 'web' ? 'web' : 'native',
    print: Print,
    sharing: Sharing,
    printInBrowser: (html) => printHtmlInBrowser(html),
  });
}
