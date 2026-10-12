/**
 * Everything the worksheet prints comes from lesson content, so every piece of text goes through here before it
 * reaches the HTML: nothing in a lesson can add a tag, an attribute or a script to a printed page.
 */

const ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/** Escapes text for use as HTML content or inside a quoted attribute. */
export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (char) => ESCAPES[char] ?? char);
}

/**
 * Escapes text, then turns `**bold**` spans into `<strong>`. An odd number of `**` markers (an unbalanced one) is left
 * as literal text, the same rule the on-screen renderer uses.
 */
export function richHtml(text: string): string {
  const parts = text.split('**');
  if (parts.length % 2 === 0) return escapeHtml(text);
  return parts
    .map((part, index) =>
      index % 2 === 1 ? `<strong>${escapeHtml(part)}</strong>` : escapeHtml(part),
    )
    .join('');
}
