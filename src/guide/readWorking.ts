/**
 * The working-tree side of one file, as the Review Guide reads it: the text on
 * disk, or null when the file does not exist. Shared by the Guide pane and the
 * review gate (gate.ts), which read the branch the same way.
 */
export async function readWorkingFile(worktreePath: string, rel: string): Promise<string | null> {
  const fs = await import('@tauri-apps/plugin-fs');
  const absolute = `${worktreePath.replace(/\/+$/, '')}/${rel}`;
  try {
    return await fs.readTextFile(absolute);
  } catch (err) {
    if (!(await fs.exists(absolute).catch(() => true))) return null;
    throw err;
  }
}
