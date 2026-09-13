import { roleBadges } from '../../roles/capabilities.js';
import '../../styles/permission-badges.css';

export default function RoleBadges({ role, settings }) {
  // Source PERN system-role metadata implies the displayed admin flag, independently of API grants.
  const keys = role.protected ? [...role.capabilityKeys, 'can_admin'] : role.capabilityKeys;
  const badges = roleBadges(keys, settings);
  return badges.length ? <div className="permission-badges">{badges.map((badge) => <span className="permission-badges__badge" key={badge.key}>{badge.badgeLabel}</span>)}</div> : <span>-</span>;
}
