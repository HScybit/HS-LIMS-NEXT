'use client';

import { cloneElement, useCallback, useLayoutEffect, useRef, useState } from 'react';
import { components } from 'react-select';
import { defaultRangeExtractor, useVirtualizer } from '@tanstack/react-virtual';

export default function WindowedSelectMenuList({ actions, ...props }) {
  'use no memo'; // Revisit when the adapter's mutable scroll methods support React Compiler.
  const { children, innerRef, maxHeight, options } = props;
  const menu = useRef(null); const body = useRef(null); const previousLayout = useRef(null);
  const [layout, setLayout] = useState({ offset: 0, left: 0, width: 0 });
  const { offset } = layout;
  const focusedIndex = children.findIndex(child => child.props.isFocused);
  const setMenu = useCallback(element => { menu.current = element; innerRef(element); }, [innerRef]);
  const getItemKey = useCallback(index => children[index].key, [children]);
  const rangeExtractor = useCallback(range => {
    const indexes = defaultRangeExtractor(range);
    if (focusedIndex >= 0 && !indexes.includes(focusedIndex)) indexes.push(focusedIndex);
    return indexes.sort((a, b) => a - b);
  }, [focusedIndex]);
  const virtualizer = useVirtualizer({ count: children.length, getScrollElement: () => menu.current,
    estimateSize: () => 76, overscan: 5, getItemKey, rangeExtractor, scrollMargin: offset, scrollPaddingStart: offset,
    initialRect: { width: 0, height: maxHeight },
    measureElement: (element, entry) => entry?.borderBoxSize?.[0]?.blockSize ?? element.getBoundingClientRect().height });

  useLayoutEffect(() => {
    let width;
    const measureLayout = () => {
      if (!menu.current || !body.current) return;
      const next = { offset: body.current.offsetTop, left: body.current.offsetLeft, width: body.current.getBoundingClientRect().width };
      setLayout(current => current.offset === next.offset && current.left === next.left && current.width === next.width ? current : next);
      if (width !== next.width) {
        width = next.width; virtualizer.measure();
        for (const element of body.current.children) virtualizer.measureElement(element);
      }
    };
    measureLayout(); const observer = new ResizeObserver(measureLayout); observer.observe(menu.current);
    const header = menu.current.querySelector('.smplfy-rselect__actions'); if (header) observer.observe(header);
    return () => observer.disconnect();
  }, [virtualizer, options]);
  useLayoutEffect(() => {
    if (previousLayout.current?.layout === layout && previousLayout.current.maxHeight === maxHeight) return;
    previousLayout.current = { layout, maxHeight };
    if (focusedIndex >= 0) virtualizer.scrollToIndex(focusedIndex, { align: 'auto', behavior: 'auto' });
  }, [focusedIndex, layout, maxHeight, virtualizer]);

  return <components.MenuList {...props} innerRef={setMenu}>
    {actions}
    <div ref={body} role="presentation" style={{ height: virtualizer.getTotalSize(), width: '100%' }}>
      {layout.width > 0 && virtualizer.getVirtualItems().map(item => {
        const child = children[item.index];
        return cloneElement(child, { innerRef: element => { virtualizer.measureElement(element); child.props.innerRef?.(element); },
          innerProps: { ...child.props.innerProps, 'data-index': item.index, 'aria-posinset': item.index + 1, 'aria-setsize': children.length,
            style: { ...child.props.innerProps.style, position: 'absolute', top: item.start, left: layout.left, width: layout.width } } });
      })}
    </div>
  </components.MenuList>;
}
