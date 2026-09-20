'use client';

import React from 'react';
import cx from 'classnames';
import '../../styles/Stepper.scss';


function StepperItem({ label, state, position, onClick }) {
  const content = (
    <>
      {position !== 'first' ? (
        <span className="smplfy-stepper-connector smplfy-stepper-connector-before" />
      ) : null}
      {position !== 'last' ? (
        <span className="smplfy-stepper-connector smplfy-stepper-connector-after" />
      ) : null}
      <span className="smplfy-stepper-indicator" />
      <span className="smplfy-stepper-label">{label}</span>
    </>
  );

  return (
    <li
      className={cx(
        'smplfy-stepper-item',
        state === 'active' && 'active',
        state === 'completed' && 'smplfy-stepper-completed',
        position === 'first' && 'first',
        position === 'last' && 'last',
        onClick && 'smplfy-stepper-interactive',
      )}
    >
      {onClick ? (
        <button type="button" className="btn smplfy-stepper-button" onClick={onClick}>
          {content}
        </button>
      ) : (
        content
      )}
    </li>
  );
}

export default function Stepper({ items, onItemClick }) {
  return (
    <ol className="smplfy-stepper">
      {items.map((item, index) => {
        let position = 'middle';
        if (index === 0) position = 'first';
        if (index === items.length - 1) position = 'last';

        return (
          <StepperItem
            key={`${item.label}-${index}`}
            label={item.label}
            state={item.state}
            position={position}
            onClick={onItemClick ? () => onItemClick(index) : undefined}
          />
        );
      })}
    </ol>
  );
}
