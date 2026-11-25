import { NavLink, useParams } from 'react-router';

/** Keep Claude settings together while preserving existing deep links. */
export function ClaudeNavigation() {
  const { id } = useParams();
  const base = `/installations/${id}`;
  return (
    <nav aria-label="Claude settings" className="flex flex-wrap gap-2 border-b border-border pb-3">
      {[
        { to: `${base}/claude`, label: 'Subscription' },
        { to: `${base}/routines`, label: 'Scheduled tasks' },
      ].map(({ to, label }) => (
        <NavLink key={to} to={to} className={({ isActive }) =>
          `rounded-lg px-3 py-2 text-sm font-medium ${isActive ? 'bg-muted text-foreground' : 'auth-link'}`
        }>{label}</NavLink>
      ))}
    </nav>
  );
}
