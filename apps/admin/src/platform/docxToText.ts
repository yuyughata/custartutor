/** Word files are converted in the browser; other platforms do not have mammoth's browser build. */
export async function docxToText(_data: ArrayBuffer): Promise<string> {
  throw new Error('Reading Word files is only available in the browser. Paste the text instead.');
}
