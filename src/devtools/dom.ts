/** Patch the inspector in place so background updates keep focus and native UI state. */
export function patchChildren(parent: Node, next: Node): void {
  let cursor: Node | null = parent.firstChild;
  for (const desired of [...next.childNodes]) {
    const key = nodeKey(desired);
    let current: Node | null = cursor;
    if (key) {
      current = [...parent.childNodes].find(node => nodeKey(node) === key) ?? null;
    } else if (current && nodeKey(current)) {
      current = null;
    }
    if (!current || !sameKind(current, desired)) {
      current = desired.cloneNode(true);
      parent.insertBefore(current, cursor);
    } else {
      if (current !== cursor) parent.insertBefore(current, cursor);
      patchNode(current, desired);
    }
    cursor = current.nextSibling;
  }
  while (cursor) {
    const next = cursor.nextSibling;
    parent.removeChild(cursor);
    cursor = next;
  }
}

function nodeKey(node: Node): string | null {
  return node instanceof Element ? node.id || node.getAttribute('data-ui-key') : null;
}

function sameKind(left: Node, right: Node): boolean {
  return left.nodeType === right.nodeType && (!(left instanceof Element) || right instanceof Element && left.tagName === right.tagName);
}

function patchNode(current: Node, desired: Node): void {
  if (!(current instanceof Element) || !(desired instanceof Element)) {
    if (current.nodeValue !== desired.nodeValue) current.nodeValue = desired.nodeValue;
    return;
  }
  for (const attribute of [...current.attributes]) {
    // The user owns disclosure state, including across status/preview updates.
    if (current instanceof HTMLDetailsElement && attribute.name === 'open') continue;
    if (!desired.hasAttribute(attribute.name)) current.removeAttribute(attribute.name);
  }
  for (const attribute of [...desired.attributes]) {
    if (current.getAttribute(attribute.name) !== attribute.value) current.setAttribute(attribute.name, attribute.value);
  }
  if (current instanceof HTMLTextAreaElement && desired instanceof HTMLTextAreaElement) {
    if (current.value !== desired.value) current.value = desired.value;
    return;
  }
  patchChildren(current, desired);
  if (current instanceof HTMLInputElement && desired instanceof HTMLInputElement) {
    if (current.value !== desired.value) current.value = desired.value;
    current.checked = desired.checked;
  }
}
