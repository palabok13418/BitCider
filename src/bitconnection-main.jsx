import React from 'react';
import { createRoot } from 'react-dom/client';
import BitConnection from './BitConnection.jsx';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <BitConnection />
  </React.StrictMode>
);
