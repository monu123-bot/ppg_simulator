import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { initWorker } from './state/store';
import './styles/global.css';

initWorker();

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
