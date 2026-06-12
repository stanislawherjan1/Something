import React, { useState, useRef, useEffect } from 'react';

const IdeFrame = ({ url, activeTab }) => {
    const [isLoading, setIsLoading] = useState(true);
    const iframeRef = useRef(null);

    // Send postMessage to code-server when mobile tab changes.
    // Both the SPA and code-server are served by the same Caddy/nginx, so the
    // target origin is always our own — never use '*' (would leak the message
    // if the iframe ever navigates to an attacker-controlled origin).
    useEffect(() => {
        if (!activeTab || !iframeRef.current) return;
        try {
            iframeRef.current.contentWindow.postMessage({ ide: activeTab }, window.location.origin);
        } catch (e) { /* cross-origin, ignore */ }
    }, [activeTab]);

    return (
        <div className="ide-wrapper">
            {isLoading && (
                <div className="loader-overlay">
                    <div className="spinner"></div>
                </div>
            )}
            <iframe
                ref={iframeRef}
                src={url}
                title="Workspace (legacy editor)"
                className="ide-iframe"
                onLoad={() => setIsLoading(false)}
                allow="clipboard-read; clipboard-write"
                style={{ touchAction: 'manipulation' }}
            />
        </div>
    );
};

export default IdeFrame;
