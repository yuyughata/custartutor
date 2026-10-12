export interface TextEditorProps {
  /** Visible label and accessible name. */
  label: string;
  value: string;
  onChange: (value: string) => void;
  /** A multi-line box (grows with the text). One line otherwise. */
  multiline?: boolean;
  /** Allows `**bold**`: shows the Bold button (Ctrl+B), a live rendered preview and the counts. */
  rich?: boolean;
  /** Minimum visible lines of a multi-line box. */
  rows?: number;
  hint?: string | undefined;
  readOnly?: boolean;
  /** Where the field lives, for "jump to field" (`data-field`). */
  fieldKey: string;
  invalid?: boolean;
  /** Fixed-width font (ids, JSON-like text). */
  mono?: boolean;
  /** Show a character and word count under the box. */
  counts?: boolean;
  hideLabel?: boolean;
}
