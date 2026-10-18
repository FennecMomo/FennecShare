import type { ReactNode } from 'react';

interface StatusPanelProps {
  icon: ReactNode;
  title: string;
  text?: string;
  actions?: ReactNode;
}

export function StatusPanel({ icon, title, text, actions }: StatusPanelProps) {
  return (
    <div className="panel" role="status">
      <div className="panel-icon" aria-hidden="true">
        {icon}
      </div>
      <p className="panel-title">{title}</p>
      {text ? <p className="panel-text">{text}</p> : null}
      {actions ? <div className="panel-actions">{actions}</div> : null}
    </div>
  );
}
