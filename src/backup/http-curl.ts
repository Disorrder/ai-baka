export const CURL_EXECUTABLE = "/usr/bin/curl";

/** Credentials and all request configuration stay on stdin, never in argv. */
export function curlConfigQuote(value: string): string {
  if (/[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("HTTP curl: control characters are forbidden in config values");
  }
  return `"${value.replaceAll("\\", "\\\\").replaceAll('"', '\\"')}"`;
}

export function curlChildEnvironment(): Record<string, string> {
  return Object.fromEntries(
    ["PATH", "LANG", "LC_ALL", "TMPDIR"]
      .map((name) => [name, process.env[name]])
      .filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}
