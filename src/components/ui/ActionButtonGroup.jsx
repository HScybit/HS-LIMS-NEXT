'use client';

import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import "../../styles/action-button-group.scss";

function getItemLabel(item) {
  if (item.tooltip) return String(item.tooltip);
  if (item.label) return String(item.label);
  if (item.title) return String(item.title);
  if (typeof item.children === "string" || typeof item.children === "number") {
    return String(item.children);
  }
  return "";
}

export default function ActionButtonGroup({
  label,
  items = [],
  size = "sm",
  variant = "primary",
}) {
  const dropdownId = useId();
  const buttonRef = useRef(null);
  const menuRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState(null);

  const updateMenuPosition = useCallback(() => {
    const button = buttonRef.current;
    if (!button) return;

    const rect = button.getBoundingClientRect();
    const menuWidth = menuRef.current?.offsetWidth || rect.width;
    const menuHeight = menuRef.current?.offsetHeight || 0;
    const left = Math.max(
      8,
      Math.min(rect.left, window.innerWidth - menuWidth - 8),
    );
    // Drop upwards when the trigger sits low enough that the menu would open
    // past the bottom edge, where a fixed-position menu cannot be scrolled to.
    const below = rect.bottom + 4;
    const above = rect.top - menuHeight - 4;
    const flip = menuHeight > 0 && below + menuHeight + 8 > window.innerHeight && above >= 8;

    setMenuStyle({
      position: "fixed",
      top: `${flip ? above : below}px`,
      left: `${left}px`,
      minWidth: `${rect.width}px`,
    });
  }, []);

  useLayoutEffect(() => {
    if (!open) return undefined;

    updateMenuPosition();
    const frame = window.requestAnimationFrame(updateMenuPosition);

    return () => window.cancelAnimationFrame(frame);
  }, [open, updateMenuPosition]);

  useEffect(() => {
    if (!open) return undefined;

    const handlePointerDown = (event) => {
      if (
        buttonRef.current?.contains(event.target) ||
        menuRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };

    const handleKeyDown = (event) => {
      if (event.key === "Escape") {
        setOpen(false);
        buttonRef.current?.focus();
      }
    };

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);
    window.addEventListener("resize", updateMenuPosition);
    window.addEventListener("scroll", updateMenuPosition, true);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
      window.removeEventListener("resize", updateMenuPosition);
      window.removeEventListener("scroll", updateMenuPosition, true);
    };
  }, [open, updateMenuPosition]);

  const handleItemClick = (event, item) => {
    // The menu is portaled, but React still bubbles its events through the
    // owning tree, so an ancestor's click handler would run after the item's.
    event.stopPropagation();
    item.onClick?.(event);
    setOpen(false);
  };

  const menu = open && typeof document !== "undefined"
    ? createPortal(
        <div
          ref={menuRef}
          className="dropdown-menu action-dropdown-menu show"
          style={menuStyle || undefined}
          id={`action-dropdown-menu-${dropdownId}`}
          role="menu"
        >
          {items.map((item) => {
            const itemLabel = getItemLabel(item);
            const iconOnly = Boolean(item.icon);

            return (
              <button
                key={item.key}
                type="button"
                onClick={(event) => handleItemClick(event, item)}
                disabled={item.disabled}
                className={[
                  "dropdown-item",
                  iconOnly ? "action-dropdown-menu__item--icon-only" : "",
                  item.danger ? "text-danger" : "",
                ]
                  .filter(Boolean)
                  .join(" ")}
                role="menuitem"
                title={itemLabel || undefined}
                aria-label={itemLabel || undefined}
              >
                {item.icon ? (
                  <span className="action-dropdown-menu__icon" aria-hidden="true">
                    {item.icon}
                  </span>
                ) : (
                  item.children
                )}
              </button>
            );
          })}
        </div>,
        document.body,
      )
    : null;

  return (
    <span className="action-dropdown d-inline-flex">
      <button
        ref={buttonRef}
        type="button"
        className={[
          "btn",
          `btn-${variant}`,
          size ? `btn-${size}` : "",
          "dropdown-toggle",
          "action-dropdown-toggle",
        ]
          .filter(Boolean)
          .join(" ")}
        id={`action-dropdown-${dropdownId}`}
        aria-expanded={open}
        aria-controls={`action-dropdown-menu-${dropdownId}`}
        aria-haspopup="menu"
        onClick={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen((current) => !current);
        }}
      >
        {label}
      </button>
      {menu}
    </span>
  );
}
