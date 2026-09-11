'use client';

import { useEffect, useImperativeHandle, useRef, useState } from 'react';

export default function Offcanvas({ ref, title, subtitle, className, onClose, children }) {
  const element = useRef(null);
  const close = useRef(onClose);
  const controller = useRef(null);
  const afterHide = useRef(null);
  const [failed, setFailed] = useState(false);
  function hide(after) {
    if (!controller.current) { (after ?? close.current)(); return; }
    afterHide.current = after ?? null;
    controller.current.hide();
  }
  useImperativeHandle(ref, () => ({ hide }), []);
  useEffect(() => { close.current = onClose; }, [onClose]);
  useEffect(() => {
    let active = true;
    let instance;
    const node = element.current;
    const hidden = () => {
      const next = afterHide.current;
      afterHide.current = null;
      (next ?? close.current)();
    };
    node.addEventListener('hidden.bs.offcanvas', hidden);
    import('bootstrap').then(({ Offcanvas: BootstrapOffcanvas }) => {
      if (!active) return;
      instance = BootstrapOffcanvas.getOrCreateInstance(node);
      controller.current = instance;
      instance.show();
    }).catch(() => { if (active) setFailed(true); });
    return () => {
      active = false;
      controller.current = null;
      node.removeEventListener('hidden.bs.offcanvas', hidden);
      if (!instance) return;
      if (['show', 'showing', 'hiding'].some((name) => node.classList.contains(name))) {
        node.addEventListener('hidden.bs.offcanvas', () => instance.dispose(), { once: true });
        instance.hide();
      } else instance.dispose();
    };
  }, []);
  return <div ref={element} tabIndex={-1} className={`offcanvas offcanvas-end ${className}${failed ? ' show' : ''}`} role={failed ? 'dialog' : undefined} aria-label={title}>
    <div className={`offcanvas-header ${className}__header`}><div><p>{subtitle}</p><h5 className="offcanvas-title">{title}</h5></div>
      <button type="button" className="btn-close text-reset" onClick={() => hide()} aria-label="Close" />
    </div>
    <div className={`offcanvas-body ${className}__body`}>{failed ? <div className="alert alert-danger" role="alert">The panel could not load. Close it and reload the page.</div> : children}</div>
  </div>;
}
