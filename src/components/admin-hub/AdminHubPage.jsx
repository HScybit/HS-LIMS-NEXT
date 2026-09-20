'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AppIcon from '../ui/AppIcon.jsx';
import SecondaryButton from '../ui/SecondaryButton.jsx';
import { apiRequest, notifySessionChange } from '../../lib/api-client.js';
import { adminHubGridColumns, adminHubSections } from '../../lib/admin-hub-links.js';

const SEARCH_DEBOUNCE_MS = 300;
const searchItems = adminHubSections.flatMap((section) => section.links.map((link) => ({ ...link, category: section.title })));

function HubLink({ item, onSelect }) {
  if (!item.available) return <span className="smplfy-admin-hub-link is-disabled" aria-disabled="true" title="This module is not available yet">{item.label}<small>Not available</small></span>;
  return <Link className="smplfy-admin-hub-link" href={item.path} onClick={onSelect}>{item.label}</Link>;
}

function ModuleGroup({ section }) {
  return <section className="smplfy-admin-hub-group" aria-labelledby={`admin-hub-${section.title.replaceAll(' ', '-')}`}>
    <div className="smplfy-admin-hub-group__heading"><span aria-hidden="true"><AppIcon name={section.icon} size={20} /></span>
      <h2 id={`admin-hub-${section.title.replaceAll(' ', '-')}`}>{section.title}</h2></div>
    <div className="smplfy-admin-hub-group__links">{section.links.map((link) => <HubLink key={link.label} item={link} />)}</div>
  </section>;
}

export default function AdminHubPage({ identity }) {
  const router = useRouter();
  const [query, setQuery] = useState(''); const [appliedQuery, setAppliedQuery] = useState('');
  const [menuOpen, setMenuOpen] = useState(false); const [signingOut, setSigningOut] = useState(false);
  const searchRef = useRef(null); const menuRef = useRef(null);
  const sectionMap = useMemo(() => Object.fromEntries(adminHubSections.map((section) => [section.title, section])), []);
  const results = useMemo(() => {
    const term = appliedQuery.trim().toLowerCase();
    return term ? searchItems.filter((item) => item.label.toLowerCase().includes(term)) : [];
  }, [appliedQuery]);
  const showResults = appliedQuery.trim() && appliedQuery.trim() === query.trim();

  useEffect(() => {
    const handleShortcut = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === '/') { event.preventDefault(); searchRef.current?.focus(); }
    };
    window.addEventListener('keydown', handleShortcut);
    return () => window.removeEventListener('keydown', handleShortcut);
  }, []);
  useEffect(() => {
    const term = query.trim();
    if (!term) return undefined;
    const timeout = window.setTimeout(() => setAppliedQuery(term), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timeout);
  }, [query]);
  useEffect(() => {
    if (!menuOpen) return undefined;
    const closeOutside = (event) => { if (!menuRef.current?.contains(event.target)) setMenuOpen(false); };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [menuOpen]);

  async function logout() {
    if (signingOut) return; setSigningOut(true);
    try {
      await apiRequest('/api/auth/logout', { method: 'POST', body: {} });
      notifySessionChange(); router.replace('/login'); router.refresh();
    } catch (error) { if (error.status === 401) { router.replace('/login'); router.refresh(); } }
    finally { setSigningOut(false); }
  }

  return <div className="smplfy-admin-hub-page">
    <header><div className="container-fluid"><div className="row align-items-center g-3">
      <div className="col-12 col-lg"><Link className="smplfy-admin-hub-dashboard" href="/dashboard"><AppIcon name="home" size={18} /><span>Dashboard</span></Link></div>
      <div className="col-12 col-lg-4"><form className="smplfy-admin-hub-search" role="search"
        onSubmit={(event) => { event.preventDefault(); setAppliedQuery(query.trim()); }}>
        <label><AppIcon name="search" size={16} /><input ref={searchRef} type="search" value={query} placeholder="Search by Module/Setting Name"
            role="combobox" aria-autocomplete="list" aria-controls="admin-hub-search-results" aria-expanded={Boolean(showResults)}
            onChange={(event) => setQuery(event.target.value)} /><span className="smplfy-admin-hub-shortcut"><kbd>Ctrl</kbd><span>+</span><kbd>/</kbd></span></label>
        {showResults ? <div id="admin-hub-search-results" className="smplfy-admin-hub-results" role="listbox" aria-label="Admin Hub search results">
          <div>{results.length} {results.length === 1 ? 'Setting' : 'Settings'} found</div>
          {results.length ? results.map((item) => <div className="smplfy-admin-hub-result" key={`${item.category}-${item.label}`}>
            <HubLink item={item} onSelect={() => { setQuery(''); setAppliedQuery(''); }} /><small>{item.category}</small>
          </div>) : <p role="status">No Settings found</p>}
        </div> : null}
      </form></div>
      <div className="col-12 col-lg d-flex justify-content-lg-end">
        <div className="header-profile-shell smplfy-admin-profile-shell" ref={menuRef}>
          <SecondaryButton size="large" tone="neutral" leftIcon="user" className="header-profile" aria-expanded={menuOpen} aria-haspopup="true" aria-label="User profile"
            onClick={() => setMenuOpen((value) => !value)}>{identity.displayName}</SecondaryButton>
          {menuOpen ? <div className="user-dropdown" role="menu">
            <div className="user-dropdown__profile"><span className="header-user-avatar header-user-avatar--lg" aria-hidden="true"><AppIcon name="user" size={18} /></span>
              <div className="user-dropdown__info"><div className="user-dropdown__name">{identity.displayName}</div>
                {identity.roles?.length ? <div className="user-dropdown__role">{identity.roles.join(', ')}</div> : null}
                <div className="user-dropdown__username">{identity.username}</div></div></div>
            <div className="user-dropdown__divider" />
            <Link href="/me" role="menuitem" className="user-dropdown__item" onClick={() => setMenuOpen(false)}><span className="user-dropdown__item-icon"><AppIcon name="user" /></span>
              <span><span className="user-dropdown__item-label">My Profile</span><span className="user-dropdown__item-sub">Account and security settings</span></span></Link>
            <div className="user-dropdown__divider" />
            <button type="button" role="menuitem" className="user-dropdown__item user-dropdown__item--danger" onClick={logout} disabled={signingOut}>
              <span className="user-dropdown__item-icon"><AppIcon name="logout" /></span><span className="user-dropdown__item-label">Log out</span></button>
          </div> : null}
        </div>
      </div>
    </div></div></header>
    <main className="container-fluid">
      <section className="smplfy-admin-hub-intro" aria-labelledby="admin-hub-title">
        <div><AppIcon name="admin-hub" size={32} stroke={2.4} /><h1 id="admin-hub-title">Admin Hub</h1></div>
        <p>Manage all system configurations and data from panels below.</p>
      </section>
      <section className="smplfy-admin-hub-grid" aria-label="Admin Hub modules">
        {adminHubGridColumns.map((column) => <div className="smplfy-admin-hub-column" key={column.join('-')}>
          {column.map((title) => <ModuleGroup key={title} section={sectionMap[title]} />)}
        </div>)}
      </section>
    </main>
  </div>;
}
