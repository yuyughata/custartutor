export interface SelectOption {
  value: string;
  label: string;
}

export interface SelectProps {
  label: string;
  value: string;
  options: readonly SelectOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
  /** Hide the visible label (the accessible name stays). */
  hideLabel?: boolean;
  placeholder?: string;
  hint?: string | undefined;
}
