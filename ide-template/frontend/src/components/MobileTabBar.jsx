import React from 'react';

const MobileTabBar = ({ activeTab, onTabChange }) => {
    return (
        <div className="mobile-tab-bar">
            <button
                className={`mobile-tab ${activeTab === 'files' ? 'active' : ''}`}
                onClick={() => onTabChange('files')}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span>Files</span>
            </button>
            <button
                className={`mobile-tab ${activeTab === 'editor' ? 'active' : ''}`}
                onClick={() => onTabChange('editor')}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <polyline points="16 18 22 12 16 6"></polyline>
                    <polyline points="8 6 2 12 8 18"></polyline>
                </svg>
                <span>Code</span>
            </button>
            <button
                className={`mobile-tab ${activeTab === 'claude' ? 'active' : ''}`}
                onClick={() => onTabChange('claude')}
            >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>Claude</span>
            </button>
        </div>
    );
};

export default MobileTabBar;
