import {
  LoroList,
  LoroMap,
  LoroText,
  type LoroDoc,
  type LoroEventBatch,
  type LoroEvent,
  type Delta,
  type Container,
  type Value,
} from 'loro-crdt'
import { getLoroNode, getLoroText, getLoroParentList, safeGet } from '../utils'
import {
  Text,
  Element,
  Node,
  Editor,
  type Operation,
  type Descendant,
  type Path,
  Transforms,
} from 'slate'

export interface LoroEditor {
  doc: LoroDoc
  disconnect: () => void
}

export interface LoroEditorOptions {
  doc: LoroDoc

  /**
   * The node to use for empty lines. This is used to ensure the editor always has at least one valid child.
   */
  emptyLine: Node
}

/**
 * Data model mapping:
 *
 *   Slate Element  →  LoroMap { type: "paragraph", children: LoroList [...] }
 *   Slate Text     →  LoroMap { text: LoroText, bold: true, ... }
 *   Editor.children →  doc.getList("children")
 */
export function withLoro<T extends Editor>(
  e: T,
  options: LoroEditorOptions,
): T & LoroEditor {
  const _e = e as T & LoroEditor
  const { doc, emptyLine } = options
  _e.doc = doc

  let isRemote = false
  let pendingCommit = false
  const { apply, normalizeNode } = e

  // Ensure editor always has at least 1 valid child
  e.normalizeNode = (entry, options) => {
    const [node] = entry
    if (!Editor.isEditor(node) || node.children.length > 0) {
      return normalizeNode(entry, options)
    }
    Transforms.insertNodes(e, emptyLine, { at: [0] })
  }

  _e.apply = (op: Operation) => {
    if (op.type === 'set_selection' || isRemote) {
      apply(op)
      return
    }

    applySlateOpToLoro(doc, op)
    apply(op)

    if (!pendingCommit) {
      pendingCommit = true
      queueMicrotask(() => {
        doc.commit()
        pendingCommit = false
      })
    }
  }

  const unsub = doc.subscribe((batch: LoroEventBatch) => {
    console.debug('subscribe', batch)
    if (batch.by === 'local') return

    isRemote = true
    const savedNormalize = _e.normalizeNode
    _e.normalizeNode = () => {}
    try {
      Editor.withoutNormalizing(_e, () => {
        applyLoroEventsToSlate(_e, batch.events)
      })
    } catch (error) {
      console.error('Error applying Loro events to Slate', error)
      throw error
    } finally {
      _e.normalizeNode = savedNormalize
      isRemote = false
    }
  })

  _e.disconnect = () => {
    unsub()
    _e.apply = apply
  }
  return _e
}

// ────────────────────────────────────────────────────────────
// Slate → Loro
// ────────────────────────────────────────────────────────────

function applySlateOpToLoro(doc: LoroDoc, op: Operation): void {
  switch (op.type) {
    case 'insert_text': {
      const lt = getLoroText(doc, op.path)
      lt.insert(op.offset, op.text)
      break
    }
    case 'remove_text': {
      const lt = getLoroText(doc, op.path)
      lt.delete(op.offset, op.text.length)
      break
    }
    case 'insert_node': {
      const parentList = getLoroParentList(doc, op.path)
      const index = op.path[op.path.length - 1]!
      insertSlateNodeIntoLoroList(parentList, index, op.node as Descendant)
      break
    }
    case 'remove_node': {
      const parentList = getLoroParentList(doc, op.path)
      const index = op.path[op.path.length - 1]!
      parentList.delete(index, 1)
      break
    }
    case 'set_node': {
      if (op.path.length === 0) break
      const lm = getLoroNode(doc, op.path)
      const newProps = op.newProperties as Record<string, unknown>
      for (const [key, value] of Object.entries(newProps)) {
        if (key === 'children' || key === 'text') continue
        if (value == null) {
          lm.delete(key)
        } else {
          lm.set(key, value as Exclude<Value, undefined>)
        }
      }
      const oldProps = op.properties as Record<string, unknown>
      for (const key of Object.keys(oldProps)) {
        if (key === 'children' || key === 'text') continue
        if (!(key in newProps)) {
          lm.delete(key)
        }
      }
      break
    }
    case 'split_node': {
      applySplitNodeToLoro(doc, op)
      break
    }
    case 'merge_node': {
      applyMergeNodeToLoro(doc, op)
      break
    }
    case 'move_node': {
      applyMoveNodeToLoro(doc, op)
      break
    }
    case 'set_selection':
      break
  }
}

function applySplitNodeToLoro(
  doc: LoroDoc,
  op: Extract<Operation, { type: 'split_node' }>,
): void {
  const parentList = getLoroParentList(doc, op.path)
  const index = op.path[op.path.length - 1]!
  const lm = getLoroNode(doc, op.path)
  const textContainer = safeGet(lm, 'text')

  if (textContainer instanceof LoroText) {
    // ── text node split ──
    const full = textContainer.toString()
    const after = full.slice(op.position)
    if (after.length > 0) textContainer.delete(op.position, after.length)

    const newMap = parentList.insertContainer(index + 1, new LoroMap())
    const newText = newMap.setContainer('text', new LoroText())
    if (after.length > 0) newText.insert(0, after)
    writePropsToLoroMap(newMap, op.properties as Record<string, unknown>)
  } else {
    // ── element node split ──
    const childList = safeGet(lm, 'children') as LoroList
    const len = childList.length

    const moved: Descendant[] = []
    for (let i = op.position; i < len; i++) {
      moved.push(loroMapToSlateNode(childList.get(i) as LoroMap))
    }
    if (len > op.position) childList.delete(op.position, len - op.position)

    const newMap = parentList.insertContainer(index + 1, new LoroMap())
    writePropsToLoroMap(newMap, op.properties as Record<string, unknown>)
    const newChildList = newMap.setContainer('children', new LoroList())
    moved.forEach((child, i) =>
      insertSlateNodeIntoLoroList(newChildList, i, child),
    )
  }
}

function applyMergeNodeToLoro(
  doc: LoroDoc,
  op: Extract<Operation, { type: 'merge_node' }>,
): void {
  const parentList = getLoroParentList(doc, op.path)
  const index = op.path[op.path.length - 1]!
  const lm = getLoroNode(doc, op.path)
  const prevMap = getLoroNode(doc, [...op.path.slice(0, -1), index - 1])
  const textContainer = safeGet(lm, 'text')

  if (textContainer instanceof LoroText) {
    const prevText = safeGet(prevMap, 'text') as LoroText
    const txt = textContainer.toString()
    if (txt.length > 0) prevText.insert(prevText.length, txt)
  } else {
    const childList = safeGet(lm, 'children') as LoroList
    const prevChildList = safeGet(prevMap, 'children') as LoroList
    const len = childList.length

    const children: Descendant[] = []
    for (let i = 0; i < len; i++) {
      children.push(loroMapToSlateNode(childList.get(i) as LoroMap))
    }
    const base = prevChildList.length
    children.forEach((child, i) =>
      insertSlateNodeIntoLoroList(prevChildList, base + i, child),
    )
  }

  parentList.delete(index, 1)
}

function applyMoveNodeToLoro(
  doc: LoroDoc,
  op: Extract<Operation, { type: 'move_node' }>,
): void {
  const nodeData = loroMapToSlateNode(getLoroNode(doc, op.path))

  const oldParentList = getLoroParentList(doc, op.path)
  oldParentList.delete(op.path[op.path.length - 1]!, 1)

  const adjusted = adjustPathAfterRemoval(op.path, op.newPath)
  const newParentList = getLoroParentList(doc, adjusted)
  insertSlateNodeIntoLoroList(
    newParentList,
    adjusted[adjusted.length - 1]!,
    nodeData,
  )
}

/**
 * After removing the node at `removedPath`, compute where `targetPath`
 * ends up (indices may shift down by 1 at the divergence level).
 */
function adjustPathAfterRemoval(removedPath: Path, targetPath: Path): Path {
  const result = [...targetPath]
  const minLen = Math.min(removedPath.length, targetPath.length)
  let d = 0
  while (d < minLen && removedPath[d] === targetPath[d]) d++

  if (
    d < removedPath.length &&
    d < targetPath.length &&
    d === removedPath.length - 1 &&
    removedPath[d]! < targetPath[d]!
  ) {
    result[d]!--
  }
  return result
}

function writePropsToLoroMap(
  map: LoroMap,
  props: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(props)) {
    if (key === 'children' || key === 'text') continue
    if (value != null) map.set(key, value as Exclude<Value, undefined>)
  }
}

// ────────────────────────────────────────────────────────────
// Loro → Slate
// ────────────────────────────────────────────────────────────

function applyLoroEventsToSlate(editor: Editor, events: LoroEvent[]): void {
  const handled = new Set<string>()

  const sorted = [...events].sort((a, b) => a.path.length - b.path.length)

  for (const event of sorted) {
    if (handled.has(event.target)) continue
    if (event.path.length > 0 && event.path[0] !== 'children') continue

    const { slatePath, target } = parseLoroEventPath(event.path)

    switch (event.diff.type) {
      case 'text':
        if (target === 'text') {
          applyTextDiffToSlate(editor, slatePath, event.diff.diff)
        }
        break
      case 'list':
        applyListDiffToSlate(editor, slatePath, event.diff.diff, handled)
        break
      case 'map':
        if (slatePath.length > 0) {
          applyMapDiffToSlate(editor, slatePath, event.diff.updated)
        }
        break
    }
  }
}

interface ParsedPath {
  slatePath: Path
  target: 'text' | 'children' | 'node'
}

function parseLoroEventPath(
  loroPath: (number | string | unknown)[],
): ParsedPath {
  const slatePath: number[] = []
  for (const item of loroPath) {
    if (typeof item === 'number') slatePath.push(item)
  }

  if (loroPath.length === 0) return { slatePath, target: 'node' }

  const last = loroPath[loroPath.length - 1]
  if (last === 'text') return { slatePath, target: 'text' }
  if (last === 'children') return { slatePath, target: 'children' }

  return { slatePath, target: 'node' }
}

function applyTextDiffToSlate(
  editor: Editor,
  slatePath: Path,
  deltas: Delta<string>[],
): void {
  let currentText = Node.leaf(editor, slatePath).text
  let offset = 0

  for (const d of deltas) {
    if (d.retain != null) {
      offset += d.retain
    } else if (d.insert != null) {
      editor.apply({
        type: 'insert_text',
        path: slatePath,
        offset,
        text: d.insert,
      })
      currentText =
        currentText.slice(0, offset) + d.insert + currentText.slice(offset)
      offset += d.insert.length
    } else if (d.delete != null) {
      const removed = currentText.slice(offset, offset + d.delete)
      editor.apply({
        type: 'remove_text',
        path: slatePath,
        offset,
        text: removed,
      })
      currentText =
        currentText.slice(0, offset) + currentText.slice(offset + d.delete)
    }
  }
}

function applyListDiffToSlate(
  editor: Editor,
  parentPath: Path,
  deltas: Delta<(Value | Container)[]>[],
  handled: Set<string>,
): void {
  let adjIdx = 0

  for (const d of deltas) {
    if (d.retain != null) {
      adjIdx += d.retain
    } else if (d.insert != null) {
      for (let i = 0; i < d.insert.length; i++) {
        const item = d.insert[i]
        if (item instanceof LoroMap) {
          editor.apply({
            type: 'insert_node',
            path: [...parentPath, adjIdx],
            node: loroMapToSlateNode(item),
          })
          collectContainerIds(item, handled)
        }
        adjIdx++
      }
    } else if (d.delete != null) {
      for (let i = 0; i < d.delete; i++) {
        const path = [...parentPath, adjIdx]
        editor.apply({
          type: 'remove_node',
          path,
          node: Node.get(editor, path) as Descendant,
        })
      }
    }
  }
}

function applyMapDiffToSlate(
  editor: Editor,
  slatePath: Path,
  updated: Record<string, Value | Container | undefined>,
): void {
  const node = Node.get(editor, slatePath)
  const oldProps: Record<string, unknown> = {}
  const newProps: Record<string, unknown> = {}

  for (const [key, value] of Object.entries(updated)) {
    if (key === 'children' || key === 'text') continue
    if (
      value instanceof LoroText ||
      value instanceof LoroMap ||
      value instanceof LoroList
    )
      continue

    oldProps[key] = (node as unknown as Record<string, unknown>)[key]
    newProps[key] = value
  }

  if (Object.keys(newProps).length === 0) return

  editor.apply({
    type: 'set_node',
    path: slatePath,
    properties: oldProps as Partial<Node>,
    newProperties: newProps as Partial<Node>,
  })
}

// ────────────────────────────────────────────────────────────
// Data conversion: Slate ↔ Loro
// ────────────────────────────────────────────────────────────

function insertSlateNodeIntoLoroList(
  list: LoroList,
  index: number,
  node: Descendant,
): void {
  const map = list.insertContainer(index, new LoroMap())

  if (Text.isText(node)) {
    const lt = map.setContainer('text', new LoroText())
    if (node.text) lt.insert(0, node.text)
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'text') map.set(key, value as Exclude<Value, undefined>)
    }
  } else if (Element.isElement(node)) {
    for (const [key, value] of Object.entries(node)) {
      if (key !== 'children') map.set(key, value as Exclude<Value, undefined>)
    }
    const childList = map.setContainer('children', new LoroList())
    node.children.forEach((child, i) =>
      insertSlateNodeIntoLoroList(childList, i, child),
    )
  }
}

function loroMapToSlateNode(map: LoroMap): Descendant {
  const result: Record<string, unknown> = {}
  for (const [key, value] of map.entries()) {
    if (value instanceof LoroText) {
      result.text = value.toString()
    } else if (value instanceof LoroList) {
      result.children = loroListToSlateChildren(value)
    } else if (value instanceof LoroMap) {
      // unexpected nested map — skip
    } else {
      result[key] = value
    }
  }
  return result as unknown as Descendant
}

function loroListToSlateChildren(list: LoroList): Descendant[] {
  const out: Descendant[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list.get(i)
    if (item instanceof LoroMap) out.push(loroMapToSlateNode(item))
  }
  return out
}

function collectContainerIds(container: Container, ids: Set<string>): void {
  if ('id' in container && typeof container.id === 'string') {
    ids.add(container.id)
  }
  if (container instanceof LoroMap) {
    for (const [, v] of container.entries()) {
      if (
        v instanceof LoroMap ||
        v instanceof LoroList ||
        v instanceof LoroText
      )
        collectContainerIds(v, ids)
    }
  } else if (container instanceof LoroList) {
    for (let i = 0; i < container.length; i++) {
      const v = container.get(i)
      if (
        v instanceof LoroMap ||
        v instanceof LoroList ||
        v instanceof LoroText
      )
        collectContainerIds(v as Container, ids)
    }
  }
}

// ────────────────────────────────────────────────────────────
// Public utilities
// ────────────────────────────────────────────────────────────

export function loroDocToSlateValue(doc: LoroDoc): Descendant[] {
  return loroListToSlateChildren(doc.getList('children'))
}

export function syncSlateValueToLoro(doc: LoroDoc, value: Descendant[]): void {
  const list = doc.getList('children')
  if (list.length > 0) list.delete(0, list.length)
  value.forEach((node, i) => insertSlateNodeIntoLoroList(list, i, node))
  doc.commit()
}
