/**
 * A Claude Code command: the trimmed text starts with `/` and its first word
 * is a command name (`/clear`, `/model opus`, `/review:pr`), not a path
 * (`/Users/me/shot.png look`). Its own module so the outbox, which send.ts
 * imports, can ask too (#240).
 */
export function isSlashCommand(body: string): boolean {
  const first = body.trim().split(/\s+/, 1)[0] ?? '';
  return /^\/[A-Za-z][\w:-]*$/.test(first);
}
