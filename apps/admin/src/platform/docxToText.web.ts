import mammoth from 'mammoth';

/** Raw text of a .docx, extracted in the browser: the file itself never leaves the machine. */
export async function docxToText(data: ArrayBuffer): Promise<string> {
  const result = await mammoth.extractRawText({ arrayBuffer: data });
  return result.value;
}
