import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import { isEnoentError } from '../utils/errors.js'
import { chunkText, type Chunk } from './chunker.js'
import type { MemoryKind, MemoryMetadata, MemoryScope } from './types.js'

/**
 * Local file knowledge base: scan a directory, read supported text files,
 * chunk them (built-in markdown-aware chunker), and store each chunk as a
 * memory entry with scope 'kb'. Vectorization is handled by the caller
 * (LongTermMemory) via the configured embedding provider.
 */

export type KnowledgeBaseOptions = {
  extensions?: string[]
  ignoreDirs?: string[]
  maxFileChars?: number
  maxCharsPerChunk?: number
  chunkOverlap?: number
  kbName?: string
}

/** Only business document formats are indexed: markdown and plain text. Source code files are intentionally excluded — they stay on the existing read_file tool. */
const DEFAULT_EXTENSIONS = ['.md', '.txt']
const DEFAULT_IGNORE_DIRS = ['.git', '.svn', 'node_modules', '.mini-code', '.claude', 'dist', 'build', 'out', 'coverage', '.idea', '.vscode']
const DEFAULT_MAX_FILE_CHARS = 300_000

export type KnowledgeFile = {
  absPath: string
  relPath: string
  content: string
}

/** Recursively scan a directory for supported knowledge files. */
export async function scanKnowledgeFiles(
  dir: string,
  options: KnowledgeBaseOptions = {},
): Promise<KnowledgeFile[]> {
  const extensions = options.extensions ?? DEFAULT_EXTENSIONS
  const ignoreDirs = new Set(options.ignoreDirs ?? DEFAULT_IGNORE_DIRS)
  const maxFileChars = options.maxFileChars ?? DEFAULT_MAX_FILE_CHARS
  const files: KnowledgeFile[] = []
  const root = path.resolve(dir)

  async function walk(current: string): Promise<void> {
    let entries
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch (error) {
      if (isEnoentError(error)) return
      throw error
    }
    entries.sort((a, b) => a.name.localeCompare(b.name))
    for (const entry of entries) {
      const absPath = path.join(current, entry.name)
      if (entry.isDirectory()) {
        if (ignoreDirs.has(entry.name)) continue
        await walk(absPath)
        continue
      }
      if (!entry.isFile()) continue
      const ext = path.extname(entry.name).toLowerCase()
      if (!extensions.includes(ext)) continue
      try {
        const info = await stat(absPath)
        if (info.size > maxFileChars) continue
        const content = await readFile(absPath, 'utf8')
        if (!content.trim()) continue
        files.push({
          absPath,
          relPath: path.relative(root, absPath).split(path.sep).join('/'),
          content,
        })
      } catch {
        // Skip unreadable / binary-looking files.
      }
    }
  }

  await walk(root)
  return files
}

export type ImportResult = {
  kbName: string
  fileCount: number
  chunkCount: number
  added: number
  skippedExisting: number
  chunks: Chunk[]
  files: KnowledgeFile[]
}

/**
 * Chunk a scanned knowledge file into kb-scope entries. Each chunk keeps the
 * source path and chunk index in metadata so re-imports can replace old
 * chunks instead of duplicating them.
 */
export function chunkKnowledgeFile(file: KnowledgeFile, options: KnowledgeBaseOptions = {}): Chunk[] {
  return chunkText(file.content, {
    maxChars: options.maxCharsPerChunk,
    overlap: options.chunkOverlap,
  })
}

/** Build kb-scope entry drafts (before embedding) for a set of files. */
export function buildKbEntries(args: {
  files: KnowledgeFile[]
  kbName: string
  cwd: string
  maxCharsPerChunk?: number
  chunkOverlap?: number
}): Array<{ scope: MemoryScope; content: string; kind: MemoryKind; metadata: MemoryMetadata }> {
  const entries: Array<{ scope: MemoryScope; content: string; kind: MemoryKind; metadata: MemoryMetadata }> = []
  for (const file of args.files) {
    const chunks = chunkKnowledgeFile(file, {
      maxCharsPerChunk: args.maxCharsPerChunk,
      chunkOverlap: args.chunkOverlap,
    })
    for (const chunk of chunks) {
      entries.push({
        scope: 'kb',
        content: chunk.text,
        kind: 'kb-doc',
        metadata: {
          cwd: args.cwd,
          kbName: args.kbName,
          sourcePath: file.absPath,
          sourceRelPath: file.relPath,
          chunkIndex: chunk.index,
        },
      })
    }
  }
  return entries
}
