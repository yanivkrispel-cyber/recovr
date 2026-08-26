import React, { useState } from 'react';

interface TabsProps {
  defaultValue: string;
  children: React.ReactElement | React.ReactElement[];
  onChange?: (value: string) => void;
}

export function Tabs({ defaultValue, children, onChange }: TabsProps) {
  const [active, setActive] = useState(defaultValue);
  const tabs = Array.isArray(children) ? children : [children];

  return (
    <div>
      <div
        role="tablist"
        style={{
          display: 'flex',
          gap: 4,
          borderBottom: '1px solid var(--line)',
          fontFamily: 'var(--font-ui)',
        }}
      >
        {tabs.map(child => {
          const value = child.props.value;
          const isActive = value === active;
          return (
            <button
              key={value}
              role="tab"
              aria-selected={isActive}
              onClick={() => {
                setActive(value);
                onChange?.(value);
              }}
              style={{
                padding: '12px 18px',
                background: 'transparent',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--gold)' : '2px solid transparent',
                cursor: 'pointer',
                fontFamily: 'var(--font-ui)',
                fontSize: 14,
                fontWeight: 600,
                color: isActive ? 'var(--navy)' : 'var(--muted)',
                transition: 'var(--motion-hover)',
              }}
            >
              {child.props.label}
            </button>
          );
        })}
      </div>
      {tabs.map(child => {
        if (child.props.value !== active) return null;
        return <div key={child.props.value}>{child.props.children}</div>;
      })}
    </div>
  );
}

interface TabProps {
  value: string;
  label: string;
  children: React.ReactNode;
}

export function Tab({ value: _value, label: _label, children: _children }: TabProps) {
  // Rendered by parent Tabs; this is a type-only marker.
  return null;
}

interface TabPanelProps {
  value: string;
  label: string;
  children: React.ReactNode;
}

export function TabPanel({ value, label, children }: TabPanelProps) {
  return <div data-tab={value} data-label={label}>{children}</div>;
}
