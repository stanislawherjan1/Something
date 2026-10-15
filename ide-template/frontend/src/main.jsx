import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App.jsx';
import { ThemeProvider } from './context/ThemeContext.jsx';
import { installAuthFetchInterceptor } from './lib/authFetch.js';
import './index.css';

function start() {
  installAuthFetchInterceptor();

  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ThemeProvider>
        <App />
      </ThemeProvider>
    </React.StrictMode>,
  );
}

// The public demo (VITE_DEMO=1) answers the API in the browser; a real build
// never includes it.
if (import.meta.env.VITE_DEMO === '1') import('./demo/install.js').then((m) => { m.installDemo(); start(); });
else start();
