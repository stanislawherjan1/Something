import React, { useState, useEffect, useRef } from 'react';
import { useAuth } from '../context/AuthContext';
import { useBranding, BrandedImage } from './workspace/identity';

const topbarLogoHeight = import.meta.env.VITE_LOGO_SIZE_TOPBAR || '22px'

const TopBar = () => {
    const { user, signOut } = useAuth();
    const { logoUrl, hideIdeText, title } = useBranding();
    const [isDropdownOpen, setIsDropdownOpen] = useState(false);
    const dropdownRef = useRef(null);
    const avatarRef = useRef(null);

    // Derive initials from user's name or email
    const initials = (() => {
        if (!user) return '?';
        const name = user.name || '';
        if (name) {
            const parts = name.trim().split(' ');
            return parts.length >= 2
                ? (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
                : parts[0].slice(0, 2).toUpperCase();
        }
        return user.email ? user.email.slice(0, 2).toUpperCase() : '?';
    })();

    const avatarUrl = user?.picture;

    // Close dropdown when clicking outside
    useEffect(() => {
        function handleClickOutside(event) {
            if (
                dropdownRef.current &&
                !dropdownRef.current.contains(event.target) &&
                avatarRef.current &&
                !avatarRef.current.contains(event.target)
            ) {
                setIsDropdownOpen(false);
            }
        }
        document.addEventListener("mousedown", handleClickOutside);
        return () => document.removeEventListener("mousedown", handleClickOutside);
    }, []);

    return (
        <div className="top-bar">
            <div className="top-bar-left">
                <a href={import.meta.env.BASE_URL} className="logo-link" style={{ display: 'flex', alignItems: 'center', gap: '8px', textDecoration: 'none' }}>
                    <BrandedImage
                        src={logoUrl}
                        alt={title || 'Logo'}
                        style={{ height: topbarLogoHeight, display: 'block' }}
                    />
                    {!hideIdeText && <span className="ide-text">{title || 'Workspace'}</span>}
                </a>
            </div>
            <div className="top-bar-right">
                {/* User avatar circle */}
                <div className="user-menu-container">
                    <div
                        className={`user-avatar ${isDropdownOpen ? 'active' : ''}`}
                        onClick={() => setIsDropdownOpen(!isDropdownOpen)}
                        ref={avatarRef}
                        title={user?.email}
                    >
                        {avatarUrl
                            ? <img src={avatarUrl} alt={initials} style={{ width: '100%', height: '100%', borderRadius: '50%', objectFit: 'cover' }} />
                            : <span>{initials}</span>
                        }
                    </div>

                    {/* Small Dropdown Menu */}
                    <div
                        className={`user-dropdown ${isDropdownOpen ? 'open' : ''}`}
                        ref={dropdownRef}
                    >
                        {/* User info header */}
                        <div className="dropdown-header">
                            <h3>{user?.name || 'User'}</h3>
                            <p className="dropdown-email">{user?.email}</p>
                        </div>
                        <div className="dropdown-actions">
                            <button className="dropdown-btn danger-btn" onClick={() => { setIsDropdownOpen(false); signOut(); }}>
                                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                                <span>Log Out</span>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

export default TopBar;
