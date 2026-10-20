/** Workspace command implementation and stable Remote failure mapping. */

import type { Context } from '@deepseek-ai/cordis'
import { mkdir, readdir, readFile, realpath, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, normalize } from 'node:path'
import type { Workspace } from '@deepseek-ai/dsh-workspace'
import {
  realpathNormalize,
  WorkspaceActiveSessionError,
  WorkspaceArchivedSessionPinError,
  WorkspaceId,
  WorkspaceMoveInvalidError,
  WorkspaceOrderInvalidError,
  WorkspaceUnknownSessionError,
} from '@deepseek-ai/dsh-workspace'
import { RemoteError, remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import { workspaceView } from './feed.ts'
import type {
  WorkspaceAddProjectRequest,
  WorkspaceArchiveSessionRequest,
  WorkspaceArchiveValue,
  WorkspaceCreateRequest,
  WorkspaceCreateValue,
  WorkspaceDeleteRequest,
  WorkspaceDeleteValue,
  WorkspaceImportCodeWorkspaceRequest,
  WorkspaceImportCodeWorkspaceValue,
  WorkspaceInsertBeforeRequest,
  WorkspaceInsertSessionBeforeRequest,
  WorkspaceOrderValue,
  WorkspacePinSessionRequest,
  WorkspacePinValue,
  WorkspaceRemoveProjectRequest,
  WorkspaceRenameRequest,
  WorkspaceUnarchiveSessionRequest,
  WorkspaceUnpinSessionRequest,
  WorkspaceValue,
} from './types.ts'

/** Implements Workspace mutations against the authoritative registry. */
export class WorkspaceCommands {
  private operationTail = Promise.resolve()

  /** @param ctx - Host context containing the Workspace registry. */
  constructor(private readonly ctx: Context) {}

  /**
   * Create one Workspace over an existing directory — always a new
   * registration, even when the directory already heads or belongs to another
   * Workspace (directories are shareable; adding is an explicit user act).
   * @param request - directory path to register.
   * @returns the Workspace and whether this call created it.
   */
  create(request: WorkspaceCreateRequest): Promise<WorkspaceCreateValue> {
    return this.enqueue(async () => {
      try {
        const workspace = await this.ctx.workspaceRegistry.create(request.path)
        return { workspace: workspaceView(workspace), created: true }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/invalid-path',
          `cannot create a Workspace at "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  /**
   * Rename one Workspace after serializing title ownership checks.
   * @param request - Workspace identity and proposed title.
   * @returns the updated Workspace projection.
   */
  rename(request: WorkspaceRenameRequest): Promise<WorkspaceValue> {
    const title = request.title.trim()
    if (title === '') {
      return Promise.reject(new RemoteError('gateway/bad-request', 'Workspace rename requires a non-blank title', {}))
    }
    return this.enqueue(async () => {
      const workspace = this.requireWorkspace(request.workspaceId)
      if (title !== workspace.title) {
        if (this.ctx.workspaceRegistry.list().some(candidate =>
          candidate.id !== workspace.id && candidate.title === title)) {
          throw new RemoteError(
            'workspace/name-conflict',
            `Workspace name '${title}' is already in use`,
            { name: title },
          )
        }
        await workspace.setTitle(title)
      }
      return { workspace: workspaceView(workspace) }
    })
  }

  /**
   * Delete one Workspace registration without deleting its directory or Sessions.
   * @param request - Workspace identity to remove.
   * @returns deletion confirmation.
   */
  delete(request: WorkspaceDeleteRequest): Promise<WorkspaceDeleteValue> {
    return this.enqueue(async () => {
      if (!await this.ctx.workspaceRegistry.delete(WorkspaceId(request.workspaceId))) {
        throw workspaceNotFound(request.workspaceId)
      }
      return { deleted: true }
    })
  }

  /**
   * Move one Workspace within the durable registry order.
   * @param request - moved Workspace and optional anchor.
   * @returns the complete resulting Workspace order.
   */
  async insertBefore(request: WorkspaceInsertBeforeRequest): Promise<WorkspaceOrderValue> {
    try {
      const workspaceIds = await this.ctx.workspaceRegistry.insertBefore(
        WorkspaceId(request.workspaceId),
        request.beforeWorkspaceId === undefined
          ? undefined
          : WorkspaceId(request.beforeWorkspaceId),
      )
      return { workspaceIds: [...workspaceIds] }
    } catch (error) {
      if (!(error instanceof WorkspaceOrderInvalidError)) throw error
      throw workspaceNotFound(error.workspaceId)
    }
  }

  /**
   * Move one accounted Session within a Workspace's manual order.
   * @param request - Workspace, Session, and optional anchor identities.
   * @returns the updated Workspace projection.
   */
  async insertSessionBefore(request: WorkspaceInsertSessionBeforeRequest): Promise<WorkspaceValue> {
    const workspace = this.requireWorkspace(request.workspaceId)
    try {
      await workspace.insertSessionBefore(request.sessionId, request.beforeSessionId)
    } catch (error) {
      if (!(error instanceof WorkspaceMoveInvalidError)) throw error
      throw new RemoteError(
        'workspace/move-invalid',
        error.message,
        {
          workspaceId: request.workspaceId,
          sessionId: request.sessionId,
          ...request.beforeSessionId === undefined
            ? {}
            : { beforeSessionId: request.beforeSessionId },
        },
        { cause: error },
      )
    }
    return { workspace: workspaceView(workspace) }
  }

  /**
   * Add one known Session to the registry-global archive set. Without
   * `stopActivity` a Session with running work is refused as
   * `workspace/session-active` with the activity the registry's providers
   * reported; with it, the providers stop that work first.
   * @param request - Session identity to archive and whether to stop its work.
   * @returns the complete resulting archive set.
   */
  async archiveSession(request: WorkspaceArchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    try {
      await this.ctx.workspaceRegistry.archiveSession(
        request.sessionId,
        request.stopActivity === true ? { stopActivity: true } : {},
      )
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceActiveSessionError) {
        throw new RemoteError(
          'workspace/session-active',
          error.message,
          { sessionId: request.sessionId, activity: error.activity },
          { cause: error },
        )
      }
      throw error
    }
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global archive set. An id that is not
   * archived is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unarchive.
   * @returns the complete resulting archive set.
   */
  async unarchiveSession(request: WorkspaceUnarchiveSessionRequest): Promise<WorkspaceArchiveValue> {
    await this.ctx.workspaceRegistry.unarchiveSession(request.sessionId)
    return { archivedSessionIds: [...this.ctx.workspaceRegistry.archivedSessionIds] }
  }

  /**
   * Add one known unarchived Session to the registry-global pin set.
   * @param request - Session identity to pin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async pinSession(request: WorkspacePinSessionRequest): Promise<WorkspacePinValue> {
    try {
      await this.ctx.workspaceRegistry.pinSession(request.sessionId)
    } catch (error) {
      if (error instanceof WorkspaceUnknownSessionError) {
        throw new RemoteError('session/not-found', error.message, { sessionId: request.sessionId }, { cause: error })
      }
      if (error instanceof WorkspaceArchivedSessionPinError) {
        throw new RemoteError('gateway/bad-request', error.message, {}, { cause: error })
      }
      throw error
    }
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Drop one Session from the registry-global pin set. An id that is not
   * pinned is not an error: the call is idempotent, so a lost race with
   * another surface resolves as a no-op.
   * @param request - Session identity to unpin.
   * @returns the complete resulting pin set, most recently pinned first.
   */
  async unpinSession(request: WorkspaceUnpinSessionRequest): Promise<WorkspacePinValue> {
    await this.ctx.workspaceRegistry.unpinSession(request.sessionId)
    return { pinnedSessionIds: [...this.ctx.workspaceRegistry.pinnedSessionIds] }
  }

  /**
   * Add one member directory to a Workspace (multi-root widening).
   * @param request - Workspace identity and directory path.
   * @returns the updated Workspace projection.
   */
  addProject(request: WorkspaceAddProjectRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      try {
        // Duplicate adds reach the UI as an explicit refusal, not a silent
        // no-op: the pick flow can then say "already in the workspace"
        // instead of pretending the folder was adopted. The registry's own
        // addPath stays an idempotent no-op for its non-UI callers.
        const workspace = this.requireWorkspace(request.workspaceId)
        let canonical: string | undefined
        try {
          canonical = await realpathNormalize(request.path)
        } catch {
          canonical = undefined
        }
        if (canonical !== undefined && workspace.paths.includes(canonical)) {
          throw new RemoteError(
            'workspace/path-exists',
            `project path "${canonical}" is already a member of Workspace "${request.workspaceId}"`,
            { workspaceId: request.workspaceId, path: canonical },
          )
        }
        await this.ctx.workspaceRegistry.addPath(WorkspaceId(request.workspaceId), request.path)
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/path-invalid',
          `cannot add project path "${request.path}" to Workspace "${request.workspaceId}": ${errorMessage(error)}`,
          { workspaceId: request.workspaceId, path: request.path },
          { cause: error },
        )
      }
      return { workspace: workspaceView(this.requireWorkspace(request.workspaceId)) }
    })
  }

  /**
   * Remove one member directory from a Workspace. The primary path cannot be
   * removed; removing a non-member is an idempotent no-op.
   * @param request - Workspace identity and member path.
   * @returns the updated Workspace projection.
   */
  removeProject(request: WorkspaceRemoveProjectRequest): Promise<WorkspaceValue> {
    return this.enqueue(async () => {
      try {
        await this.ctx.workspaceRegistry.removePath(WorkspaceId(request.workspaceId), request.path)
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/path-invalid',
          `cannot remove project path "${request.path}" from Workspace "${request.workspaceId}": ${errorMessage(error)}`,
          { workspaceId: request.workspaceId, path: request.path },
          { cause: error },
        )
      }
      return { workspace: workspaceView(this.requireWorkspace(request.workspaceId)) }
    })
  }

  /**
   * Import one `.code-workspace` document as a Workspace: the document's first
   * existing folder becomes the primary path, every other existing folder a
   * member, and the file basename (minus the suffix) the title. When a
   * Workspace already owns that first folder the document folds into it
   * instead (import is a merge, never a duplicate registration). The document
   * is appended to the shared ledger so the code-workspace auto-sync plugin
   * keeps watching it across restarts.
   * @param request - document path, or a directory holding exactly one.
   * @returns the Workspace projection, whether this call created it, and the canonical document path.
   */
  importCodeWorkspace(request: WorkspaceImportCodeWorkspaceRequest): Promise<WorkspaceImportCodeWorkspaceValue> {
    return this.enqueue(async () => {
      try {
        const input = request.path.trim()
        if (input === '') {
          throw new RemoteError('workspace/import-invalid', 'import requires a .code-workspace document path', { path: request.path })
        }
        const expanded = input === '~' ? homedir() : input.startsWith('~/') ? join(homedir(), input.slice(2)) : input
        let info
        try {
          info = await stat(expanded)
        } catch {
          throw new RemoteError('workspace/import-not-found', `no such file or directory: "${expanded}"`, { path: expanded })
        }
        let document: string
        if (info.isDirectory()) {
          const names = (await readdir(expanded, { withFileTypes: true }))
            .filter(entry => entry.isFile() && entry.name.endsWith('.code-workspace'))
            .map(entry => entry.name)
          if (names.length === 0) {
            throw new RemoteError('workspace/import-no-document', `no .code-workspace document in "${expanded}"`, { path: expanded })
          }
          if (names.length > 1) {
            throw new RemoteError(
              'workspace/import-ambiguous',
              `"${expanded}" holds ${names.length} .code-workspace documents; name one explicitly: ${names.join(', ')}`,
              { path: expanded, names },
            )
          }
          const [only] = names
          if (only === undefined) throw new RemoteError('workspace/import-no-document', `no .code-workspace document in "${expanded}"`, { path: expanded })
          document = join(expanded, only)
        } else {
          if (!expanded.endsWith('.code-workspace')) {
            throw new RemoteError('workspace/import-invalid', `"${expanded}" is not a .code-workspace document`, { path: expanded })
          }
          document = expanded
        }
        const canonicalDocument = await realpath(document)
        const folders = await codeWorkspaceFolders(canonicalDocument)
        // codeWorkspaceFolders rejects an empty document, so the primary is
        // always present here; the explicit check keeps the invariant local.
        const primary = folders.at(0)
        if (primary === undefined) throw new RemoteError('workspace/import-empty', `"${canonicalDocument}" lists no existing folder`, { path: canonicalDocument })
        const registry = this.ctx.workspaceRegistry
        let workspace = registry.list().find(candidate => candidate.path === primary)
        let created = false
        if (workspace === undefined) {
          workspace = await registry.create(primary, basename(canonicalDocument, '.code-workspace'))
          created = true
        }
        for (const path of folders.slice(1)) await registry.addPath(workspace.id, path)
        await rememberCodeWorkspaceDocument(canonicalDocument)
        return { workspace: workspaceView(this.requireWorkspace(workspace.id)), created, document: canonicalDocument }
      } catch (error) {
        if (remoteErrorOf(error) !== undefined) throw error
        throw new RemoteError(
          'workspace/import-failed',
          `cannot import .code-workspace document "${request.path}": ${errorMessage(error)}`,
          { path: request.path },
          { cause: error },
        )
      }
    })
  }

  private requireWorkspace(workspaceId: WorkspaceId): Workspace {
    const workspace = this.ctx.workspaceRegistry.get(WorkspaceId(workspaceId))
    if (workspace === undefined) throw workspaceNotFound(workspaceId)
    return workspace
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.operationTail.then(operation)
    this.operationTail = result.then(() => undefined, () => undefined)
    return result
  }
}

function workspaceNotFound(workspaceId: WorkspaceId): RemoteError<'workspace/not-found'> {
  return new RemoteError(
    'workspace/not-found',
    `Workspace "${workspaceId}" not found`,
    { workspaceId },
  )
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Ledger file shared with the code-workspace auto-sync plugin: every GUI
 * import is remembered here so the plugin keeps watching across restarts.
 */
function codeWorkspaceStateFile(): string {
  return join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'storages', 'code-workspace-auto-sync.json')
}

/**
 * Existing folder members of one `.code-workspace` document, canonicalized,
 * deduped, in document order. Missing members are skipped; a document with no
 * existing folder rejects.
 * @param document - canonical document path.
 */
async function codeWorkspaceFolders(document: string): Promise<string[]> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await readFile(document, 'utf8'))
  } catch (error) {
    throw new RemoteError(
      'workspace/import-parse',
      `cannot parse "${document}": ${errorMessage(error)}`,
      { path: document },
      { cause: error },
    )
  }
  const list = parsed !== null && typeof parsed === 'object' && Array.isArray((parsed as { folders?: unknown }).folders)
    ? (parsed as { folders: unknown[] }).folders
    : []
  const base = dirname(document)
  const seen = new Set<string>()
  const folders: string[] = []
  for (const folder of list) {
    if (folder === null || typeof folder !== 'object' || typeof (folder as { path?: unknown }).path !== 'string') continue
    const rawPath = (folder as { path: string }).path
    if (rawPath.trim() === '') continue
    const raw = isAbsolute(rawPath) ? normalize(rawPath) : join(base, rawPath)
    let canonical: string
    try {
      canonical = await realpath(raw)
      if (!(await stat(canonical)).isDirectory()) continue
    } catch {
      continue
    }
    if (seen.has(canonical)) continue
    seen.add(canonical)
    folders.push(canonical)
  }
  if (folders.length === 0) {
    throw new RemoteError('workspace/import-empty', `"${document}" lists no existing folder`, { path: document })
  }
  return folders
}

/**
 * Remember one GUI-imported document in the shared ledger (best effort; the
 * bump of `revision` clears the sync plugin's suppression list). A ledger
 * write failure never fails the import itself.
 * @param document - canonical document path.
 */
async function rememberCodeWorkspaceDocument(document: string): Promise<void> {
  try {
    const file = codeWorkspaceStateFile()
    let revision = 0
    let documents: string[] = []
    try {
      const parsed = JSON.parse(await readFile(file, 'utf8')) as { revision?: unknown; documents?: unknown } | null
      if (parsed !== null && typeof parsed === 'object') {
        if (Number.isInteger(parsed.revision)) revision = parsed.revision as number
        if (Array.isArray(parsed.documents)) documents = (parsed.documents as unknown[]).filter((p): p is string => typeof p === 'string')
      }
    } catch {
      // A missing or unreadable ledger starts fresh; the write below recreates it.
    }
    if (!documents.includes(document)) documents.push(document)
    revision += 1
    await mkdir(dirname(file), { recursive: true })
    await writeFile(file, JSON.stringify({ revision, documents }, null, 2))
  } catch {
    // Best effort: the import itself already succeeded; the sync plugin just
    // misses this document until the next explicit import.
  }
}
