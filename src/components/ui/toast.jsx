'use client';

import { createRoot } from 'react-dom/client';
import ToastNotification from './ToastNotification.jsx';

const TOAST_TIMEOUT = 3000;
const toastRoots = new Map();
let toastSequence = 0;

function canUseDom() {
  return typeof window !== "undefined" && typeof document !== "undefined";
}

function getToastShelf() {
  if (!canUseDom()) return null;

  let shelf = document.getElementById("sampleify-toast-shelf");
  if (!shelf) {
    shelf = document.createElement("div");
    shelf.id = "sampleify-toast-shelf";
    shelf.className = "position-fixed bottom-0 start-0 p-4 d-flex flex-column gap-2";
    shelf.style.zIndex = "var(--smplfy-toast-z-index)";
    document.body.appendChild(shelf);
  }

  return shelf;
}

function removeToast(toastId) {
  const entry = toastRoots.get(toastId);
  if (!entry) return;

  entry.root.unmount();
  entry.node.remove();
  toastRoots.delete(toastId);
}

export function showToast(message, tone = "success") {
  const shelf = getToastShelf();
  if (!shelf) return;

  const toastId = `toast-${Date.now()}-${toastSequence += 1}`;
  const node = document.createElement("div");
  const root = createRoot(node);

  toastRoots.set(toastId, { node, root });
  shelf.appendChild(node);

  root.render(
    <ToastNotification
      tone={tone}
      message={String(message || "")}
      onClose={() => removeToast(toastId)}
    />,
  );

  window.setTimeout(() => removeToast(toastId), TOAST_TIMEOUT);
}
