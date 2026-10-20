/**
 * Workspace pick/add flow. WorkspacePickFlow is the reusable core (menu +
 * path error dialog) consumed directly by WorkspaceBrowser (same package) and
 * wrapped by WorkspacePicker for the conversation empty-state slot
 * registration. Directory picking itself lives in the composed flow package's
 * slot occupant (see the contract module doc): this core only opens the flow,
 * adopts the picked path, and owns the error surface. Adding a workspace has
 * exactly one route — pick a host directory, new or existing — because the
 * occupant's own create-folder affordance already covers creating one.
 */
import type { ReactNode, RefObject } from 'react'
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  Button, IconFolderCloseRegular, IconPlusOutlineRegular, Menu, Modal, type MenuEntry,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type {
  WorkspaceId, WorkspaceSnapshot, WorkspaceView,
} from '@deepseek-ai/dsh-api-workspace-controller/client'
import { workspaceDisplayTitle } from '@deepseek-ai/dsh-api-workspace-controller/default-workspace'
import type { SnapshotSelectorHook } from '@deepseek-ai/dsh-client-ui-slots'
import type { DirectoryFlowOwnerProps, WorkspacePickerProps } from './contract/slots.ts'
import css from './WorkspacePicker.module.css'

const ADD_WORKSPACE = '::add-workspace'
const IMPORT_CODE_WORKSPACE = '::import-code-workspace'

/** Core flow props: the owner supplies popover control and pick semantics. */
export interface WorkspacePickFlowProps {
  /** The standard locale seat, forwarded by whichever slot entry hosts the flow. */
  t: WorkspacePickerProps['t']
  /** Popover visibility (anchor button toggle state, owner-local). */
  open: boolean
  /** The anchor button element — the popover's placement anchor. */
  anchorRef?: RefObject<HTMLElement | null> | undefined
  /** Selector hook over the workspace list (framework standard hook). */
  useWorkspaces: <S>(selector: (state: WorkspaceSnapshot) => S) => S
  /** Adopt a picked host directory as a real Workspace. */
  createWorkspace: (input: { path: string }) => Promise<WorkspaceView>
  /** Bound occupancy selector hook for this surface's directory-flow hole (empty leaves the surface with no add action). */
  useDirectoryFlow: SnapshotSelectorHook<boolean>
  /** Render this surface's directory-flow hole with the owner conversation (the entry's narrowed renderSlot). */
  renderDirectoryFlow: (owner: DirectoryFlowOwnerProps) => ReactNode
  /** A real Workspace was picked or created. */
  onPick: (workspaceId: WorkspaceId) => void
  /** Close the popover (outside click / Escape / post-pick). */
  onClose: () => void
  /** Report the picking interaction and adoption occupancy. */
  onBusyChange?: (busy: boolean) => void
  /** Only offer the add action, hide existing workspaces. */
  addOnly?: boolean
  /** Menu opening direction relative to the anchor. */
  side?: 'bottom' | 'top' | 'right'
  /** Currently active workspace (trailing check in the picker list). */
  selectedId?: WorkspaceId | undefined
  /**
   * Multi-root target: when set (with `addProject`), a picked directory joins
   * this Workspace as a member instead of creating a new Workspace.
   */
  projectTarget?: WorkspaceId | null | undefined
  /** Add one member directory to a Workspace; its rejection may carry a Host failure code. */
  addProject?: ((workspaceId: WorkspaceId, path: string) => Promise<void>) | undefined
  /** Release the add-project target at explicit flow endpoints (picked, cancelled, error dismissed). */
  onClearProjectTarget?: (() => void) | undefined
  /**
   * Import one `.code-workspace` document as a Workspace; the rejection may
   * carry a Host failure code (`workspace/import-*`). Absent hides the import entry.
   */
  importCodeWorkspace?: ((path: string) => Promise<unknown>) | undefined
}

/**
 * Render the pick menu plus the adoption error dialog.
 * @param props - owner-controlled flow props.
 * @returns menu + dialog elements.
 */
export function WorkspacePickFlow({
  t,
  open,
  anchorRef,
  useWorkspaces,
  createWorkspace,
  useDirectoryFlow,
  renderDirectoryFlow,
  onPick,
  onClose,
  addOnly = false,
  onBusyChange,
  side = 'bottom',
  selectedId,
  projectTarget = null,
  addProject,
  onClearProjectTarget,
  importCodeWorkspace,
}: WorkspacePickFlowProps) {
  const workspaceSnapshot = useWorkspaces(state => state)
  const workspaces = workspaceSnapshot.items
  const getAnchorRect = useCallback(
    () => anchorRef?.current?.getBoundingClientRect() ?? null,
    [anchorRef],
  )
  const [errorOpen, setErrorOpen] = useState(false)
  const [modalError, setModalError] = useState<string | null>(null)
  const [flowOpen, setFlowOpen] = useState(false)
  const [pickingFolder, setPickingFolder] = useState(false)
  // .code-workspace import: the document flow reuses the directory-flow hole
  // with `document: true`; the typed-path modal is the fallback when the
  // occupant has no document chooser.
  const [importOpen, setImportOpen] = useState(false)
  const [importPath, setImportPath] = useState('')
  const [importPending, setImportPending] = useState(false)
  const [importFlowOpen, setImportFlowOpen] = useState(false)
  const [importPicking, setImportPicking] = useState(false)
  /** True when the folder-error dialog answers for a failed import, so its retry reopens the import flow. */
  const [importRetry, setImportRetry] = useState(false)
  // One picking interaction at a time: while the flow is open (native chooser
  // pending, browse dialog up) or its pick is being adopted, every other
  // menu action stays disabled — a late outcome must not race a concurrent
  // selection or adoption.
  const flowBusy = flowOpen || pickingFolder || importFlowOpen || importPicking
  useEffect(() => { onBusyChange?.(flowBusy) }, [flowBusy, onBusyChange])
  // The add-project target is released only at explicit flow endpoints
  // (picked, cancelled, error dismissed) or when the pick menu is dismissed
  // without the flow ever opening — tracked by flowOpenedRef, because the
  // menu's onClose ALSO fires for the internal transition into the directory
  // dialog, and a time/state-based clear races it: the store-driven menu
  // close and setFlowOpen(true) do not land in the same render, so a
  // `!open && !flowOpen` effect clears the target right before the dialog
  // opens and the pick falls back to creating a new Workspace.
  const flowOpenedRef = useRef(false)

  // The occupied hole gates the picking affordance: with no composed flow the
  // entry simply is not there (the seam's documented no-flow default). The
  // framework-bound hook keeps occupancy live: flow plugins activate (and
  // HMR-reload) independently of this menu's renders.
  const flowAvailable = useDirectoryFlow(occupied => occupied)
  // An occupant that unloads mid-interaction leaves nobody to cancel: an
  // open flow over an empty hole withdraws so the menu actions come back.
  // flowOpen is a dependency because the flow can also OPEN over an already
  // empty hole (Choose again after the occupant unloaded with the error
  // dialog up) — that transition must snap back too, not just occupancy loss.
  useEffect(() => {
    if (flowOpen && !flowAvailable) setFlowOpen(false)
  }, [flowOpen, flowAvailable])
  const addEntries: MenuEntry[] = flowAvailable
    ? [
      { id: ADD_WORKSPACE, label: t('menu.addWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy },
      ...importCodeWorkspace === undefined ? [] : [{ id: IMPORT_CODE_WORKSPACE, label: t('menu.importCodeWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }],
    ]
    : importCodeWorkspace === undefined ? [] : [{ id: IMPORT_CODE_WORKSPACE, label: t('menu.importCodeWorkspace'), icon: <IconPlusOutlineRegular size={16} />, disabled: flowBusy }]
  // With workspaces listed, the add action pins below the scroll region
  // (divider + always visible); otherwise it IS the menu.
  const pinAdd = !addOnly && workspaces.length > 0
  const items: MenuEntry[] = pinAdd
    ? workspaces.map(workspace => ({
      id: workspace.workspaceId,
      label: workspaceDisplayTitle(workspace.title, t('workspace.defaultName')),
      icon: <IconFolderCloseRegular size={16} />,
      disabled: flowBusy,
    }))
    : addEntries
  // Nothing listed and nothing to add with (a composition that mounts this
  // package without any directory-picker): an empty popover would claim a
  // choice that does not exist, so the anchor gesture shows nothing at all.
  const menuIsEmpty = items.length === 0

  const closeModal = (): void => {
    setErrorOpen(false)
    setModalError(null)
    setImportRetry(false)
    // Giving up after a failed adopt releases the target; "Choose again"
    // goes through openDirectoryFlow, which keeps it.
    onClearProjectTarget?.()
  }

  /**
   * Adopt a picked directory; failures land in the folder-error dialog
   * (Choose again reopens the flow). With a project target the directory
   * joins that Workspace as a member instead of creating a new one.
   */
  const adoptDirectory = (path: string): Promise<void> => {
    const adopting = addProject !== undefined && projectTarget !== null
      ? { add: addProject, target: projectTarget }
      : null
    const action = adopting === null
      ? createWorkspace({ path }).then(workspace => workspace.workspaceId)
      : adopting.add(adopting.target, path).then(() => adopting.target)
    return action.then((workspaceId) => {
      setFlowOpen(false)
      flowOpenedRef.current = false
      onClearProjectTarget?.()
      onPick(workspaceId)
    }).catch((reason: unknown) => {
      const code = typeof reason === 'object' && reason !== null && 'code' in reason
        ? reason.code
        : undefined
      setModalError(code === 'workspace/path-exists'
        ? t('folderError.exists')
        : reason instanceof Error ? reason.message : String(reason))
      setFlowOpen(false)
      flowOpenedRef.current = false
      setErrorOpen(true)
    })
  }

  const openDirectoryFlow = useCallback((): void => {
    flowOpenedRef.current = true
    onClose()
    setErrorOpen(false)
    setModalError(null)
    setFlowOpen(true)
  }, [onClose])

  /**
   * Adopt an imported `.code-workspace` document: the Host registers or merges
   * the Workspace and the result enters through onPick like a picked folder.
   */
  const adoptImport = (path: string): Promise<void> => {
    if (importCodeWorkspace === undefined) return Promise.resolve()
    return importCodeWorkspace(path).then((result) => {
      setImportFlowOpen(false)
      setImportOpen(false)
      setImportPath('')
      flowOpenedRef.current = false
      const workspace = (result as { workspace?: WorkspaceView }).workspace
      if (workspace !== undefined) onPick(workspace.workspaceId)
    }).catch((reason: unknown) => {
      setImportFlowOpen(false)
      setImportOpen(false)
      flowOpenedRef.current = false
      setModalError(importErrorText(reason))
      setImportRetry(true)
      setErrorOpen(true)
    })
  }

  const openImportFlow = (): void => {
    flowOpenedRef.current = true
    onClose()
    if (flowAvailable) setImportFlowOpen(true)
    else setImportOpen(true)
  }

  const closeImport = (): void => {
    setImportOpen(false)
    setImportPath('')
  }

  /** Map an import failure to a localized line; unknown failures show the Host message. */
  const importErrorText = (reason: unknown): string => {
    const code = typeof reason === 'object' && reason !== null && 'code' in reason
      ? (reason as { code?: unknown }).code
      : undefined
    if (code === 'workspace/import-not-found') return t('import.error.notFound')
    if (code === 'workspace/import-no-document') return t('import.error.noDocument')
    if (code === 'workspace/import-invalid') return t('import.error.invalid')
    if (code === 'workspace/import-empty') return t('import.error.empty')
    return reason instanceof Error ? reason.message : String(reason)
  }

  const submitImport = (): void => {
    if (importPending) return
    setImportPending(true)
    void adoptImport(importPath).catch(() => undefined).finally(() => { setImportPending(false) })
  }

  // A menu exists to disambiguate between targets. With no workspaces listed
  // and the add action the only entry left, the anchor gesture IS that action:
  // a one-row popover would cost a click and offer nothing to choose between.
  // The owner's open request is consumed the same way selecting the entry
  // would consume it (close the popover, raise the flow). An empty list is
  // only final once the baseline lands — until then the menu stays up with its
  // loading status instead of jumping into a flow the arriving list would have
  // made unnecessary; the add-only surface lists nothing and never waits.
  const listSettled = addOnly || workspaceSnapshot.phase === 'ready'
  const addIsTheOnlyEntry = !pinAdd && listSettled && addEntries.length === 1
  // `flowBusy` gates this exactly as it disables the equivalent menu entry: a
  // pick still being adopted owns the surface until it settles.
  useEffect(() => {
    if (open && addIsTheOnlyEntry && !flowBusy) openDirectoryFlow()
  }, [open, addIsTheOnlyEntry, flowBusy, openDirectoryFlow])

  /** Owner side of the flow conversation: adopt keeps the flow open (busy) until the Host answers. */
  const flowOwner: DirectoryFlowOwnerProps = {
    open: flowOpen || importFlowOpen,
    document: importFlowOpen,
    busy: pickingFolder || importPicking,
    onPicked: (path) => {
      if (importFlowOpen) {
        setImportPicking(true)
        void adoptImport(path).finally(() => { setImportPicking(false) })
        return
      }
      setPickingFolder(true)
      void adoptDirectory(path).finally(() => { setPickingFolder(false) })
    },
    onCancel: () => {
      if (importFlowOpen) {
        // Cancelling the document chooser is a plain dismiss; the typed-path
        // modal is only the fallback for a MISSING chooser (onError), never a
        // second dialog after an operator decision.
        setImportFlowOpen(false)
        flowOpenedRef.current = false
        return
      }
      setFlowOpen(false)
      flowOpenedRef.current = false
      onClearProjectTarget?.()
    },
    onError: (message) => {
      if (importFlowOpen) {
        // No document chooser (or a chooser failure): fall back to the typed path.
        setImportFlowOpen(false)
        flowOpenedRef.current = false
        setImportOpen(true)
        return
      }
      setFlowOpen(false)
      flowOpenedRef.current = false
      setModalError(message)
      setErrorOpen(true)
    },
  }

  const handleSelect = (id: string): void => {
    if (id === ADD_WORKSPACE) {
      openDirectoryFlow()
      return
    }
    if (id === IMPORT_CODE_WORKSPACE) {
      openImportFlow()
      return
    }
    onPick(id as WorkspaceId)
  }

  return (
    <>
      <Menu
        open={open && !addIsTheOnlyEntry && !menuIsEmpty}
        anchor={null}
        items={items}
        {...pinAdd ? { footer: addEntries } : {}}
        selectedId={selectedId}
        onSelect={handleSelect}
        onClose={() => {
          onClose()
          // Dismissed without the flow ever opening releases the target; the
          // internal menu→dialog transition has the ref set and keeps it.
          if (!flowOpenedRef.current) onClearProjectTarget?.()
        }}
        side={side}
        portal
        getAnchorRect={getAnchorRect}
      />
      {open && !addIsTheOnlyEntry && !menuIsEmpty && workspaceSnapshot.phase === 'pending' && <div className={css.menuStatus} role="status">{t('picker.loading')}</div>}
      {renderDirectoryFlow(flowOwner)}
      <Modal
        open={errorOpen}
        onClose={closeModal}
        closeLabel={t('close')}
        title={t('folderError.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} onClick={closeModal}>{t('cancel')}</Button>
            {/* Retrying needs an occupant to serve the flow; without one the
              * button would open a flow nobody can answer or cancel. Import
              * failures retry through the import flow instead. */}
            <Button variant="primary" className={css.modalAction} disabled={!importRetry && !flowAvailable} onClick={importRetry ? openImportFlow : openDirectoryFlow}>{importRetry ? t('import.retry') : t('folderError.retry')}</Button>
          </>
        )}
      >
        <div className={css.modalError} role="alert">{modalError}</div>
      </Modal>
      <Modal
        open={importOpen}
        onClose={closeImport}
        closeLabel={t('close')}
        title={t('import.title')}
        footer={(
          <>
            <Button variant="outline" className={css.modalAction} disabled={importPending} onClick={closeImport}>{t('cancel')}</Button>
            <Button variant="primary" className={css.modalAction} disabled={importPending || importPath.trim() === ''} onClick={submitImport}>{t('import.confirm')}</Button>
          </>
        )}
      >
        <div className={css.modalError}>{t('import.desc')}</div>
        <input
          className={css.modalAction}
          value={importPath}
          placeholder={t('import.placeholder')}
          aria-label={t('import.title')}
          disabled={importPending}
          onChange={(event) => { setImportPath(event.target.value) }}
          onKeyDown={(event) => { if (event.key === 'Enter') submitImport() }}
        />
        {importPending && <div className={css.modalError} role="status">{t('import.pending')}</div>}
      </Modal>
    </>
  )
}

/**
 * The conversation empty-state registration: adapts the owner share to the
 * core flow (all state and semantics live in the flow / the owner).
 * @param props - empty-state slot props (owner share + injected creation callback).
 * @returns the flow element.
 */
export function WorkspacePicker({
  open,
  anchorRef,
  useWorkspaces,
  selectedId,
  onPick,
  onClose,
  createWorkspace,
  useDirectoryFlow,
  renderSlot,
  t,
  importCodeWorkspace,
}: WorkspacePickerProps) {
  return (
    <WorkspacePickFlow
      t={t}
      open={open}
      anchorRef={anchorRef}
      useWorkspaces={useWorkspaces}
      createWorkspace={createWorkspace}
      useDirectoryFlow={useDirectoryFlow}
      renderDirectoryFlow={owner => renderSlot('conversation.hero.workspace.directoryFlow', owner)}
      selectedId={selectedId}
      onPick={onPick}
      onClose={onClose}
      importCodeWorkspace={importCodeWorkspace}
    />
  )
}
