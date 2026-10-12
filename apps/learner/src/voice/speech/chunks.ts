/**
 * Splits text into pieces a speech engine can take: at most `maxLen` characters each, cut at the end of a
 * sentence when possible, otherwise at a comma, semicolon or colon, otherwise at a space. Android refuses
 * input longer than about 4000 characters, and some browsers stop speaking a long utterance after about 15
 * seconds, so a section is read as a short run of pieces, one after the other.
 *
 * Joining the pieces with single spaces gives back the text with its whitespace collapsed.
 */
export function splitForSpeech(text: string, maxLen = 400): string[] {
  const clean = text.replace(/\s+/g, ' ').trim();
  if (clean === '') return [];
  const limit = Math.max(20, Math.floor(maxLen));

  const chunks: string[] = [];
  let current = '';
  const flush = (): void => {
    if (current !== '') chunks.push(current);
    current = '';
  };

  for (const sentence of clean.split(/(?<=[.!?])\s+/)) {
    for (const piece of breakLong(sentence, limit)) {
      if (current !== '' && current.length + 1 + piece.length > limit) flush();
      current = current === '' ? piece : `${current} ${piece}`;
    }
  }
  flush();
  return chunks;
}

/** Cuts one over-long sentence at clause marks, then spaces, then (for a single huge word) anywhere. */
function breakLong(sentence: string, limit: number): string[] {
  if (sentence.length <= limit) return [sentence];
  const pieces: string[] = [];
  let rest = sentence;
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    let cut = Math.max(window.lastIndexOf(','), window.lastIndexOf(';'), window.lastIndexOf(':'));
    if (cut <= 0) cut = window.lastIndexOf(' ');
    // Break after a clause mark (keeping it), or at the space (dropping it); a long word is cut hard.
    const end = cut <= 0 ? limit : window[cut] === ' ' ? cut : cut + 1;
    pieces.push(rest.slice(0, end).trim());
    rest = rest.slice(end).trim();
  }
  if (rest !== '') pieces.push(rest);
  return pieces.filter((piece) => piece !== '');
}
