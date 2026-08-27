/**
 * Project slug used to isolate per-project long-term memory and trace files.
 * Mirrors the directory naming rule used by session.ts so memory/trace
 * storage stays aligned with session persistence.
 */
export function projectSlug(cwd: string): string {
  return cwd.replace(/[/\\:]+/g, '-').replace(/^-+/, '')
}
