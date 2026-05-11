export interface StyleOptions {
  readonly pretty?: boolean;
}

export const color = {
  reset: "\u001b[0m",
  dim: "\u001b[2m",
  bold: "\u001b[1m",
  cyan: "\u001b[36m",
  green: "\u001b[32m",
  yellow: "\u001b[33m",
  red: "\u001b[31m",
  magenta: "\u001b[35m",
} as const;

export const paint = (options: StyleOptions, code: string, value: string) =>
  options.pretty ? `${code}${value}${color.reset}` : value;

export const link = (options: StyleOptions, url: string | null, value: string) =>
  options.pretty && url ? `\u001b]8;;${url}\u0007${value}\u001b]8;;\u0007` : value;
